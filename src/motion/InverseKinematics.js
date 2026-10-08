import * as THREE from 'three';

// Inverse kinematics for any rig: finds joint values that put a tool point on a target.
//
// Nothing here knows about a vendor or a robot type. It works on whatever chain of joints the
// user rigged in Joint Setup: arms, gantries, SCARAs, pan-tilt heads, linkages with follower
// joints, redundant arms. See docs/IK_PLAN.md for the research behind each choice.
//
// A tool (stored in the rig definition) is a point and a pointing direction fixed to one joint:
//   { id, name, joint, frame: 'model' | 'part', point: [x, y, z], direction: [x, y, z] }
// Coordinates are in the model frame (or the joint's first part's frame) at the rest pose,
// exactly like joint pivots.
//
// Method: damped least squares on the tool's position (and, if asked, its pointing direction),
// computed in natural units (radians, metres) so rotating and sliding joints mix correctly.

const D2R = Math.PI / 180;
const ORIENTATION_TOLERANCE_DEG = 0.5;
const MAX_ROTATION_STEP_DEG = 10;
const MAX_SLIDE_STEP_FRACTION = 0.1;
const BIG_MOVE_DEG = 120;

function toVector(values, fallback) {
  return Array.isArray(values) && values.length === 3 ? new THREE.Vector3(...values) : fallback.clone();
}

// Small deterministic random generator, so retries are repeatable.
function seededRandom(seed) {
  let state = seed | 0;
  return () => {
    state = (state + 0x6D2B79F5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- Tool ------------------------------------------------------------------------------

// Everything that can move a joint: the joints it is mounted on and, for followers among them,
// the joints they follow (and what those are mounted on). Returned in rig order (parents first).
export function chainFor(rig, jointId) {
  const found = new Set();
  const visit = (joint) => {
    for (let current = joint; current && !found.has(current); current = rig.jointsById.get(current.definition.parent)) {
      found.add(current);
      const link = current.definition.aim || current.definition.stretch;
      if (link) visit(rig.jointsById.get(link.joint));
    }
  };
  visit(rig.jointsById.get(jointId));
  return rig.joints.filter((joint) => found.has(joint));
}

// Prepares a tool for solving. Returns null if its joint no longer exists.
export function resolveTool(rig, tool) {
  const joint = rig.jointsById.get(tool?.joint);
  if (!joint || joint.kind !== 'joint') return null;
  let localPoint;
  let localDirection;
  rig.withRestPose(() => {
    const frame = tool.frame === 'part' && joint.parts[0] ? joint.parts[0].matrixWorld : rig.content.matrixWorld;
    const worldPoint = toVector(tool.point, new THREE.Vector3()).applyMatrix4(frame);
    const worldDirection = toVector(tool.direction, new THREE.Vector3(0, -1, 0)).transformDirection(frame);
    localPoint = joint.group.worldToLocal(worldPoint);
    localDirection = worldDirection.transformDirection(joint.group.matrixWorld.clone().invert());
  });
  const chain = chainFor(rig, joint.id);
  const size = new THREE.Box3().setFromObject(rig.root).getSize(new THREE.Vector3()).length() || 1;
  return {
    tool,
    joint,
    chain,
    active: chain.filter((item) => !item.driven),
    // Followers change with their leaders in ways the joint axes alone don't show; measure instead.
    useFiniteDifferences: chain.some((item) => item.driven),
    size,
    tolerance: Math.max(1e-4, size * 2e-4),
    position: () => joint.group.localToWorld(localPoint.clone()),
    direction: () => localDirection.clone().transformDirection(joint.group.matrixWorld),
  };
}

// ---- Solver ------------------------------------------------------------------------------

// World distance moved by 1 mm of a sliding joint (handles any model scale).
function slidePerMillimetre(rig, joint) {
  const group = joint.group;
  const before = group.getWorldPosition(new THREE.Vector3());
  const localAxis = joint.axis.clone().applyQuaternion(joint.restQuaternion);
  const after = group.parent.localToWorld(group.position.clone().addScaledVector(localAxis, 1 / 1000 / rig.metresPerUnit));
  return after.distanceTo(before) || 1e-9;
}

// Rotation (axis × angle) that turns `from` onto `to`.
function rotationBetween(from, to) {
  const axis = new THREE.Vector3().crossVectors(from, to);
  const angle = Math.atan2(axis.length(), from.dot(to));
  if (axis.lengthSq() < 1e-12) {
    if (angle < 1e-6) return new THREE.Vector3();
    // Opposite directions: any perpendicular axis works.
    const helper = Math.abs(from.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    return helper.cross(from).setLength(angle);
  }
  return axis.setLength(angle);
}

// Solves Ax = b for a small dense system (Gaussian elimination with partial pivoting).
function solveLinear(matrix, vector) {
  const size = vector.length;
  const rows = matrix.map((row, index) => [...row, vector[index]]);
  for (let column = 0; column < size; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < size; row += 1) if (Math.abs(rows[row][column]) > Math.abs(rows[pivot][column])) pivot = row;
    [rows[column], rows[pivot]] = [rows[pivot], rows[column]];
    for (let row = 0; row < size; row += 1) {
      if (row === column) continue;
      const factor = rows[row][column] / rows[column][column];
      for (let k = column; k <= size; k += 1) rows[row][k] -= factor * rows[column][k];
    }
  }
  return rows.map((row, index) => row[size] / row[index]);
}

// One damped-least-squares run from a seed. Leaves the rig at the result.
function solveFrom(rig, resolved, target, seed, { orient, maxIterations }) {
  const joints = resolved.active;
  const values = joints.map((joint) => seed[joint.id] ?? joint.value);
  const damping = resolved.size * 0.005;
  const weight = resolved.size * 0.15; // 1 rad of tool tilt counts like 15 % of the model's size
  const apply = () => rig.setValues(Object.fromEntries(joints.map((joint, index) => [joint.id, values[index]])));
  let error = Infinity;
  let tilt = 0;

  for (let iteration = 0; iteration <= maxIterations; iteration += 1) {
    apply();
    const position = resolved.position();
    const offset = target.clone().sub(position);
    error = offset.length();
    const residual = [offset.x, offset.y, offset.z];
    let currentDirection = null;
    if (orient) {
      currentDirection = resolved.direction();
      const rotation = rotationBetween(currentDirection, orient);
      tilt = rotation.length() / D2R;
      residual.push(rotation.x * weight, rotation.y * weight, rotation.z * weight);
    }
    if (error < resolved.tolerance && (!orient || tilt < ORIENTATION_TOLERANCE_DEG)) break;
    if (iteration === maxIterations) break;

    // Jacobian columns per natural unit (radian / metre); `units` converts a step back to ° / mm.
    const units = [];
    const columns = joints.map((joint, index) => {
      if (resolved.useFiniteDifferences) {
        const nudge = joint.type === 'revolute' ? 0.05 : 0.5;
        const unit = joint.type === 'revolute' ? 1 / D2R : 1 / slidePerMillimetre(rig, joint);
        const saved = values[index];
        values[index] = saved + nudge;
        apply();
        const scale = unit / nudge;
        const linear = resolved.position().sub(position).multiplyScalar(scale);
        const column = [linear.x, linear.y, linear.z];
        if (orient) {
          const turn = new THREE.Vector3().crossVectors(currentDirection, resolved.direction()).multiplyScalar(scale * weight);
          column.push(turn.x, turn.y, turn.z);
        }
        values[index] = saved;
        units[index] = unit;
        return column;
      }
      const axis = joint.axis.clone().transformDirection(joint.group.matrixWorld);
      if (joint.type === 'revolute') {
        const pivot = joint.group.getWorldPosition(new THREE.Vector3());
        const linear = new THREE.Vector3().crossVectors(axis, position.clone().sub(pivot));
        units[index] = 1 / D2R;
        return orient
          ? [linear.x, linear.y, linear.z, axis.x * weight, axis.y * weight, axis.z * weight]
          : [linear.x, linear.y, linear.z];
      }
      units[index] = 1 / slidePerMillimetre(rig, joint);
      return orient ? [axis.x, axis.y, axis.z, 0, 0, 0] : [axis.x, axis.y, axis.z];
    });
    if (resolved.useFiniteDifferences) apply();

    // Δq = Jᵀ (J Jᵀ + λ² I)⁻¹ e
    const rows = residual.length;
    const product = Array.from({ length: rows }, (_, row) => Array.from({ length: rows }, (_, column) => (
      columns.reduce((sum, item) => sum + item[row] * item[column], 0) + (row === column ? damping * damping : 0)
    )));
    const y = solveLinear(product, residual);
    const steps = columns.map((column, index) => column.reduce((sum, value, row) => sum + value * y[row], 0) * units[index]);

    // Take smaller steps rather than overshooting: at most 10° or 10 % of a slide's range.
    let scale = 1;
    joints.forEach((joint, index) => {
      const cap = joint.type === 'revolute' ? MAX_ROTATION_STEP_DEG : (joint.max - joint.min) * MAX_SLIDE_STEP_FRACTION;
      if (Math.abs(steps[index]) > cap) scale = Math.min(scale, cap / Math.abs(steps[index]));
    });
    joints.forEach((joint, index) => {
      if (!Number.isFinite(steps[index])) return;
      values[index] = THREE.MathUtils.clamp(values[index] + steps[index] * scale, joint.min, joint.max);
    });
  }
  return { values: Object.fromEntries(joints.map((joint, index) => [joint.id, values[index]])), error, tilt };
}

// Joints that can turn more than a full circle: use the equivalent angle nearest where they are.
function nearestEquivalents(joints, values, current) {
  const result = { ...values };
  joints.forEach((joint) => {
    if (joint.type !== 'revolute' || joint.max - joint.min < 360) return;
    let best = result[joint.id];
    for (let turns = -2; turns <= 2; turns += 1) {
      const candidate = values[joint.id] + turns * 360;
      if (candidate < joint.min || candidate > joint.max) continue;
      if (Math.abs(candidate - current[joint.id]) < Math.abs(best - current[joint.id])) best = candidate;
    }
    result[joint.id] = best;
  });
  return result;
}

function motionBetween(joints, from, to) {
  return joints.reduce((sum, joint) => {
    const change = Math.abs(to[joint.id] - from[joint.id]);
    return sum + (joint.type === 'revolute' ? change : change / 10); // 10 mm of slide ≈ 1°
  }, 0);
}

// Turns the first rotating joint so the tool faces the target (about that joint's own axis).
function aimedSeed(rig, resolved, target, current) {
  const first = resolved.active.find((joint) => joint.type === 'revolute');
  if (!first) return null;
  rig.setValues(current);
  const axis = first.axis.clone().transformDirection(first.group.matrixWorld);
  const pivot = first.group.getWorldPosition(new THREE.Vector3());
  const toTool = resolved.position().sub(pivot).projectOnPlane(axis);
  const toTarget = target.clone().sub(pivot).projectOnPlane(axis);
  if (toTool.lengthSq() < 1e-10 || toTarget.lengthSq() < 1e-10) return null;
  const angle = Math.atan2(new THREE.Vector3().crossVectors(toTool, toTarget).dot(axis), toTool.dot(toTarget)) / D2R;
  return { ...current, [first.id]: THREE.MathUtils.clamp(current[first.id] + angle, first.min, first.max) };
}

// Finds joint values that put the tool on `target` (world space, metres).
//   orient: wanted tool direction (world unit vector) or null for "any angle"
//   quick:  fewer retries, for live previews
// Returns { values, reached, error (m), tilt (°), motion }. The rig is left exactly as it was.
export function solveReach(rig, resolved, target, { orient = null, quick = false, maxIterations = 150 } = {}) {
  const saved = rig.getPose();
  const joints = resolved.active;
  const current = Object.fromEntries(joints.map((joint) => [joint.id, joint.value]));
  try {
    const seeds = [current];
    const aimed = aimedSeed(rig, resolved, target, current);
    if (aimed) seeds.push(aimed);
    seeds.push(Object.fromEntries(joints.map((joint) => [joint.id, THREE.MathUtils.clamp(joint.zero, joint.min, joint.max)])));
    if (!quick) {
      const random = seededRandom(17);
      for (let index = 0; index < 5; index += 1) {
        seeds.push(Object.fromEntries(joints.map((joint) => [joint.id, joint.min + (joint.max - joint.min) * random()])));
      }
    }

    const isReached = (result) => result.error < resolved.tolerance && (!orient || result.tilt < ORIENTATION_TOLERANCE_DEG);
    let best = null;
    const reached = [];
    for (const seed of seeds) {
      const result = solveFrom(rig, resolved, target, seed, { orient, maxIterations });
      result.values = nearestEquivalents(joints, result.values, current);
      result.motion = motionBetween(joints, current, result.values);
      if (isReached(result)) {
        reached.push(result);
        // From the current pose the answer is already the smallest move; otherwise compare one more.
        if (seed === current || reached.length >= 2) break;
      } else if (!best || result.error + result.tilt * resolved.tolerance < best.error + best.tilt * resolved.tolerance) {
        best = result;
      }
    }
    if (reached.length) {
      const choice = reached.reduce((a, b) => (b.motion < a.motion ? b : a));
      return { ...choice, reached: true };
    }
    return { ...best, reached: false };
  } finally {
    rig.setValues(saved);
  }
}

// ---- Diagnosis ---------------------------------------------------------------------------

// Lowest point of everything the tool's chain moves, with the rig at `values`.
function lowestChainPoint(rig, resolved, values) {
  const saved = rig.getPose();
  try {
    rig.setValues(values);
    rig.root.updateMatrixWorld(true);
    const box = new THREE.Box3();
    resolved.chain.forEach((joint) => joint.parts.forEach((part) => box.expandByObject(part)));
    return box.isEmpty() ? Infinity : box.min.y;
  } finally {
    rig.setValues(saved);
  }
}

// Solves and, if the target can't be reached, works out why, by re-solving with one rule relaxed
// at a time. status is one of:
//   'reachable'    – values are ready to use (warnings may still apply)
//   'below-floor'  – the target is under the floor
//   'joint-limit'  – reachable only if joints went past their ranges; see overLimits
//   'orientation'  – the point is reachable, but not with the tool pointing that way
//   'out-of-reach' – too far or too close for the machine's geometry; shortBy in metres
export function diagnoseReach(rig, resolved, target, { orient = null, floorY = 0 } = {}) {
  const floorTolerance = Math.max(resolved.tolerance, resolved.size * 0.002);
  if (target.y < floorY - floorTolerance) return { status: 'below-floor', reached: false };

  const result = solveReach(rig, resolved, target, { orient });
  if (result.reached) {
    const warnings = [];
    if (lowestChainPoint(rig, resolved, result.values) < floorY - floorTolerance) warnings.push('through-floor');
    const current = Object.fromEntries(resolved.active.map((joint) => [joint.id, joint.value]));
    const biggest = Math.max(0, ...resolved.active
      .filter((joint) => joint.type === 'revolute')
      .map((joint) => Math.abs(result.values[joint.id] - current[joint.id])));
    if (biggest > BIG_MOVE_DEG) warnings.push('big-move');
    return { status: 'reachable', ...result, warnings };
  }

  // 1) Without joint limits: if it works now, a joint's range is what blocks it.
  const limits = resolved.active.map((joint) => [joint.min, joint.max]);
  let free;
  try {
    resolved.active.forEach((joint) => {
      const span = joint.max - joint.min;
      if (joint.type === 'revolute') { joint.min = -720; joint.max = 720; } else { joint.min -= span * 10; joint.max += span * 10; }
    });
    free = solveReach(rig, resolved, target, { orient });
  } finally {
    resolved.active.forEach((joint, index) => { [joint.min, joint.max] = limits[index]; });
  }
  if (free.reached) {
    const overLimits = resolved.active
      .map((joint, index) => ({ joint, needs: free.values[joint.id], min: limits[index][0], max: limits[index][1] }))
      .filter(({ needs, min, max }) => needs < min - 0.5 || needs > max + 0.5);
    if (overLimits.length) return { status: 'joint-limit', ...result, overLimits };
  }

  // 2) Without the pointing direction: if the point alone is fine, only the direction is impossible.
  if (orient) {
    const positionOnly = solveReach(rig, resolved, target, {});
    if (positionOnly.reached) return { status: 'orientation', ...result, positionOnly };
  }

  return { status: 'out-of-reach', ...result, shortBy: free.error };
}
