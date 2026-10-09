import * as THREE from 'three';
import { createProceduralWorker } from './ProceduralWorker.js';

const GRIP_TOLERANCE = 0.035;
const CONVEYOR_SPEED = 0.7;
// Suction tool, in the gripper's own frame: it points along local −Y.
const TOOL_AXIS = new THREE.Vector3(0, -1, 0);
// Vacuum cup lip sits this far above the top surface at contact (no penetration).
const CONTACT_GAP = 0.001;
const APPROACH_HEIGHT = 0.3;
const LIFT_HEIGHT = 0.52;
// Carried box bottom clears already stacked boxes by this much when swinging in.
const CARRY_CLEARANCE = 0.12;
// Orientation error weight in the IK (metres per radian of tool rotation).
const ORIENTATION_WEIGHT = 0.6;
// Fork height above the wrap deck once the pallet is released: forks drop
// clear of the deck boards but stay above the pallet's bottom boards.
const FORK_RELEASE_HEIGHT = 0.015;
const FORK_WITHDRAW_CLEARANCE = 0.6;

function lerpPose(from, to, progress) {
  return Object.fromEntries(Object.keys(to).map((id) => [
    id,
    THREE.MathUtils.lerp(from[id] ?? 0, to[id], progress),
  ]));
}

// Catmull-Rom through a list of joint poses, progress 0…1 across the whole list.
function samplePosePath(poses, progress) {
  const segments = poses.length - 1;
  const scaled = THREE.MathUtils.clamp(progress, 0, 1) * segments;
  const index = Math.min(Math.floor(scaled), segments - 1);
  const t = scaled - index;
  const p0 = poses[Math.max(index - 1, 0)];
  const p1 = poses[index];
  const p2 = poses[index + 1];
  const p3 = poses[Math.min(index + 2, segments)];
  return Object.fromEntries(Object.keys(p2).map((id) => {
    const a = p0[id] ?? p1[id];
    const b = p1[id];
    const c = p2[id];
    const d = p3[id] ?? c;
    const value = 0.5 * ((2 * b) + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t * t + (-a + 3 * b - 3 * c + d) * t * t * t);
    return [id, value];
  }));
}

// Rotation vector (axis × angle, radians) of a quaternion.
function rotationVector(quaternion) {
  const q = quaternion.w < 0 ? new THREE.Quaternion(-quaternion.x, -quaternion.y, -quaternion.z, -quaternion.w) : quaternion;
  const sinHalf = Math.hypot(q.x, q.y, q.z);
  const scale = sinHalf < 1e-9 ? 2 : (2 * Math.atan2(sinHalf, q.w)) / sinHalf;
  return new THREE.Vector3(q.x, q.y, q.z).multiplyScalar(scale);
}

// Solves the small dense system A·x = b (Gaussian elimination with partial pivoting).
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

function lerpWorkerPose(from, to, progress) {
  return {
    x: THREE.MathUtils.lerp(from.x, to.x, progress),
    y: THREE.MathUtils.lerp(from.y, to.y, progress),
    z: THREE.MathUtils.lerp(from.z, to.z, progress),
    yaw: THREE.MathUtils.lerp(from.yaw, to.yaw, progress),
  };
}

export function createVacuumGripper() {
  const root = new THREE.Group();
  root.name = 'ProceduralVacuumGripper';
  const metal = new THREE.MeshStandardMaterial({ color: 0x87949b, metalness: 0.88, roughness: 0.24 });
  const rubber = new THREE.MeshStandardMaterial({ color: 0x161a1c, metalness: 0.05, roughness: 0.88 });
  const indicatorMaterial = new THREE.MeshStandardMaterial({ color: 0x65727b, emissive: 0x101820, roughness: 0.32 });
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.08, 0.14, 24), metal);
  body.name = 'Vacuum mounting body';
  body.castShadow = true;
  root.add(body);
  const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.027, 0.027, 0.17, 16), metal);
  stem.name = 'Vacuum mounting stem';
  stem.position.y = -0.14;
  stem.castShadow = true;
  root.add(stem);
  const bellows = new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.105, 0.085, 24), rubber);
  bellows.name = 'Vacuum bellows';
  bellows.position.y = -0.245;
  bellows.castShadow = true;
  root.add(bellows);
  const cupHeight = 0.055;
  const cupLipRadius = 0.095;
  const cup = new THREE.Mesh(new THREE.CylinderGeometry(0.12, cupLipRadius, cupHeight, 24), rubber);
  cup.name = 'Vacuum suction cup';
  cup.position.y = -0.305;
  cup.castShadow = true;
  root.add(cup);
  const indicator = new THREE.Mesh(new THREE.SphereGeometry(0.018, 12, 8), indicatorMaterial);
  indicator.name = 'Vacuum state indicator';
  indicator.position.set(0, 0.045, 0);
  root.add(indicator);
  // Suction point = centre of the cup lip; mount face = top of the mounting body.
  root.userData.suctionPoint = new THREE.Vector3(0, cup.position.y - cupHeight / 2, 0);
  root.userData.toolAxis = TOOL_AXIS.clone();
  root.userData.cupLipRadius = cupLipRadius;
  root.userData.mountOffset = body.geometry.parameters.height / 2;
  root.userData.setState = (state) => {
    const color = {
      OPEN: 0x65727b,
      APPROACHING: 0xffc857,
      GRIPPING: 0x65d68b,
      HOLDING: 0x35c6e8,
      RELEASING: 0x65d68b,
    }[state] || 0x65727b;
    indicator.material.color.setHex(color);
    indicator.material.emissive.copy(indicator.material.color).multiplyScalar(0.22);
  };
  root.userData.setState('OPEN');
  return root;
}

export class StationCycle {
  constructor({ stationRoot, robot, rig, boxFactory, boxDefinition, conveyor, gripper, layout, rootWorldMatrix, onUpdate, pallet, wrapMachine }) {
    this.stationRoot = stationRoot;
    this.robot = robot;
    this.rig = rig;
    this.boxFactory = boxFactory;
    this.boxDefinition = boxDefinition;
    this.conveyor = conveyor;
    this.gripper = gripper;
    this.layout = layout;
    this.onUpdate = onUpdate;
    this.pallet = pallet;
    this.wrapMachine = wrapMachine;
    this.state = 'IDLE';
    this.conveyorState = 'STOPPED';
    this.robotState = 'HOME';
    this.boxState = 'ON BELT';
    this.gripperState = 'OPEN';
    this.speedMultiplier = 1;
    this.distance = Infinity;
    this.box = null;
    this.floorBoxes = [];
    this.boxNumber = 0;
    this.stackTarget = null;
    this.positionError = Infinity;
    this.bottomHeight = 0;
    this.rotation = new THREE.Euler();
    this.attached = false;
    this.toolOrientation = new THREE.Quaternion();
    this.boxTopOffset = 0;
    /** Where the cup grips the current box, in the box's own frame (set when planning). */
    this.plannedGrasp = null;
    this.poseFrom = null;
    this.poseTo = null;
    this.elapsed = 0;
    this.duration = 0;
    this.home = this.getJointPose();
    this.rootWorldMatrix = rootWorldMatrix?.clone();
    this.targets = null;
    this.boxGraspLocal = new THREE.Vector3(0, 0, 0);
    this.worker = null;
    this.cargo = null;
    this.outboundActive = false;
    this.outboundTween = null;
    this.logReferences();
  }

  getJointPose() {
    return Object.fromEntries(this.rig.joints
      .filter((joint) => !joint.driven)
      .map((joint) => [joint.id, joint.value]));
  }

  assertRootTransform(expectedPosition, phase) {
    this.robot.updateMatrixWorld(true);
    const actualPosition = this.robot.getWorldPosition(new THREE.Vector3());
    const positionChanged = actualPosition.distanceTo(expectedPosition) > 1e-7;
    if (positionChanged) {
      console.error(`Station robot root changed during ${phase}; restoring the station transform.`, {
        expectedPosition: expectedPosition.toArray(),
        actualPosition: actualPosition.toArray(),
      });
      this.robot.position.copy(this.robot.parent.worldToLocal(expectedPosition.clone()));
      this.robot.updateMatrixWorld(true);
    }
  }

  logReferences() {
    const refs = this.layout;
    console.info('Station cycle references', {
      conveyorInput: refs.conveyor.input,
      conveyorPickup: refs.conveyor.pickup,
      conveyorDirection: this.getConveyorDirection().toArray(),
      beltSurfaceHeight: refs.conveyor.beltSurface.y,
      robotBase: refs.robot.base,
      floorDrop: refs.floorDrop,
      stackDropOrigin: refs.stackDropOrigin,
    });
  }

  getConveyorDirection() {
    return new THREE.Vector3(
      this.layout.conveyor.pickup.x - this.layout.conveyor.input.x,
      this.layout.conveyor.pickup.y - this.layout.conveyor.input.y,
      this.layout.conveyor.pickup.z - this.layout.conveyor.input.z,
    ).normalize();
  }

  get tcpGroup() {
    return this.rig.jointsById.get('axis6')?.group;
  }

  getSuctionWorld() {
    this.robot.updateMatrixWorld(true);
    return this.gripper.localToWorld(this.gripper.userData.suctionPoint.clone());
  }

  getBoxGraspWorld() {
    return this.box.root.localToWorld((this.plannedGrasp ?? this.box.references.grasp).clone());
  }

  getBoxCenter() {
    return this.box.root.getWorldPosition(new THREE.Vector3());
  }

  getBeltBoxCenterY() {
    return this.layout.conveyor.beltSurface.y + this.boxDefinition.height / 2 + this.boxDefinition.beltClearance;
  }

  createBoxAtInput() {
    if (this.box) return;
    this.box = this.boxFactory();
    this.boxGraspLocal.copy(this.box.references.grasp);
    const input = this.layout.conveyor.input;
    this.box.root.position.set(input.x, this.getBeltBoxCenterY(), input.z);
    this.box.root.rotation.set(0, 0, 0);
    this.stationRoot.add(this.box.root);
    this.boxState = 'ON BELT';
    this.distance = this.getSuctionWorld().distanceTo(this.getBoxGraspWorld());
    console.info('Station cycle physical references', {
      robotTcp: this.tcpGroup?.getWorldPosition(new THREE.Vector3()).toArray(),
      boxGrasp: this.getBoxGraspWorld().toArray(),
      floorDrop: [this.layout.floorDrop.x, this.layout.floorDrop.y, this.layout.floorDrop.z],
    });
    this.onUpdate?.(this);
  }

  getFloorDropGrasp() {
    return new THREE.Vector3(
      this.layout.floorDrop.x,
      this.layout.floorDrop.y + this.boxGraspLocal.y,
      this.layout.floorDrop.z,
    );
  }

  getStackTarget(index) {
    const { columns, rows, spacing } = this.layout.stack;
    const perLayer = columns * rows;
    const layer = Math.floor(index / perLayer);
    const layerIndex = index % perLayer;
    const column = layerIndex % columns;
    const row = Math.floor(layerIndex / columns);
    return new THREE.Vector3(
      this.layout.stackDropOrigin.x + column * (this.boxDefinition.length + spacing),
      this.layout.stackDropOrigin.y + layer * this.boxDefinition.height + this.boxDefinition.height / 2,
      this.layout.stackDropOrigin.z + row * (this.boxDefinition.width + spacing),
    );
  }

  setSpeed(multiplier) {
    if (![1, 2, 10].includes(multiplier)) throw new Error(`Unsupported station speed: ${multiplier}`);
    this.speedMultiplier = multiplier;
  }

  animateClaw(from, to, duration, state) {
    this.gripper.userData.motion = { from, to, duration, elapsed: 0 };
    this.beginHold(state, duration, { conveyor: 'STOPPED', robot: this.robotState, box: this.boxState, gripper: state });
  }

  getFlangeTarget(targetPoint) {
    const quaternion = this.gripper.getWorldQuaternion(new THREE.Quaternion());
    return targetPoint.clone().sub(this.gripper.userData.suctionPoint.clone().applyQuaternion(quaternion));
  }

  // Tool frame the robot holds while handling boxes: cup axis straight down, wrist roll
  // taken from the home pose so the tool turns as little as possible.
  getToolOrientation() {
    this.rig.setValues(this.home);
    this.robot.updateMatrixWorld(true);
    const homeQuaternion = this.gripper.getWorldQuaternion(new THREE.Quaternion());
    const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(homeQuaternion).setY(0);
    if (forward.lengthSq() < 1e-6) forward.set(1, 0, 0).applyQuaternion(homeQuaternion).setY(0);
    const yaw = Math.atan2(forward.x, forward.z);
    // Gripper local −Y (the tool axis) maps to world −Y for any pure yaw.
    return new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
  }

  // Damped least squares on the suction point AND the gripper's full orientation, so the
  // cup arrives flat on the box and a held box keeps its pose relative to the cup.
  solveTarget(targetPoint, seed = this.rig.getPose(), orientation = this.toolOrientation) {
    const ids = this.rig.joints.filter((joint) => !joint.driven).map((joint) => joint.id);
    const pose = Object.fromEntries(ids.map((id) => [id, seed[id] ?? this.rig.getValue(id)]));
    const residual = () => {
      const position = targetPoint.clone().sub(this.getSuctionWorld());
      const current = this.gripper.getWorldQuaternion(new THREE.Quaternion());
      const rotation = rotationVector(orientation.clone().multiply(current.invert()));
      return { position, rotation, vector: [position.x, position.y, position.z, ...rotation.clone().multiplyScalar(ORIENTATION_WEIGHT).toArray()] };
    };
    const nudge = 0.05;
    let bestError = Infinity;
    let stalled = 0;
    for (let iteration = 0; iteration < 200; iteration += 1) {
      this.rig.setValues(pose);
      const error = residual();
      if (error.position.length() < 0.0004 && error.rotation.length() < THREE.MathUtils.degToRad(0.05)) break;
      // Give up on a seed that has stopped improving (pinned on a joint limit or out of reach).
      const size = Math.hypot(...error.vector);
      if (size < bestError * 0.999) {
        bestError = size;
        stalled = 0;
      } else if ((stalled += 1) > 12) break;
      const columns = ids.map((id) => {
        // Nudge towards the inside of the range so a joint resting on a limit still shows its effect.
        const step = pose[id] + nudge > this.rig.jointsById.get(id).max ? -nudge : nudge;
        this.rig.setValues({ ...pose, [id]: pose[id] + step });
        const moved = residual().vector;
        return error.vector.map((value, row) => (value - moved[row]) / THREE.MathUtils.degToRad(step));
      });
      this.rig.setValues(pose);
      const damping = 0.012;
      const product = error.vector.map((_, row) => error.vector.map((__, column) => (
        columns.reduce((sum, item) => sum + item[row] * item[column], 0) + (row === column ? damping * damping : 0)
      )));
      const y = solveLinear(product, error.vector);
      ids.forEach((id, index) => {
        const delta = THREE.MathUtils.clamp(columns[index].reduce((sum, value, row) => sum + value * y[row], 0), -0.12, 0.12);
        pose[id] = this.rig.clamp(this.rig.jointsById.get(id), pose[id] + THREE.MathUtils.radToDeg(delta));
      });
    }
    this.rig.setValues(pose);
    return pose;
  }

  isSolved(targetPoint, orientation = this.toolOrientation) {
    const current = this.gripper.getWorldQuaternion(new THREE.Quaternion());
    return this.getSuctionWorld().distanceTo(targetPoint) < 0.002
      && THREE.MathUtils.radToDeg(current.angleTo(orientation)) < 0.25;
  }

  // Seeds for poses over the pallet: the arm turned to several base angles, reaching
  // forward or leaning back over itself.
  getStackSeeds(first) {
    const seeds = first === this.home ? [this.home] : [first, this.home];
    [-150, -100, -50, 0, 50, 100, 150].forEach((axis1) => {
      seeds.push({ ...this.home, axis1, axis2: 30, axis3: 0, axis4: 0, axis5: 60, axis6: axis1 });
      seeds.push({ ...this.home, axis1, axis2: -45, axis3: 45, axis4: 0, axis5: 100, axis6: axis1 });
    });
    return seeds;
  }

  // Straight tool-point line sampled into IK poses (tool orientation held).
  planPath(from, to, seed, steps = 8) {
    const poses = [];
    poses.solved = true;
    let previous = seed;
    for (let step = 1; step <= steps; step += 1) {
      const point = from.clone().lerp(to, step / steps);
      previous = this.solveTarget(point, previous);
      poses.solved &&= this.isSolved(point);
      poses.push(previous);
    }
    return poses;
  }

  // Swing between two solved poses along their joint-space route, re-solving each sample
  // so the tool stays vertical and the carried box never drops below the swing height.
  planSwing(from, to, fromPose, toPose, steps = 12) {
    const poses = [];
    for (let step = 1; step < steps; step += 1) {
      const t = step / steps;
      const seed = lerpPose(fromPose, toPose, t);
      this.rig.setValues(seed);
      const point = this.getSuctionWorld().setY(THREE.MathUtils.lerp(from.y, to.y, t));
      poses.push(this.solveTarget(point, seed));
    }
    poses.push(toPose);
    return poses;
  }

  // Height of the box's real top surface (tape included) above its centre.
  measureBoxTop() {
    this.box.root.updateMatrixWorld(true);
    const bounds = new THREE.Box3();
    const visit = (object) => {
      // Debug reference markers and hidden parts are not cardboard the cup can touch.
      if (!object.visible || object.name === 'ReferencePointsAndAxes') return;
      if (object.isMesh) bounds.expandByObject(object);
      object.children.forEach(visit);
    };
    visit(this.box.root);
    return bounds.isEmpty() ? this.boxGraspLocal.y : bounds.max.y - this.getBoxCenter().y;
  }

  // Grip points on the box top (box frame XZ): the centre first, then edge and corner
  // points as far out as the cup lip allows, for cells the arm can't reach centrally.
  getGraspOffsets() {
    const margin = this.gripper.userData.cupLipRadius + 0.01;
    const x = Math.max(this.boxDefinition.length / 2 - margin, 0);
    const z = Math.max(this.boxDefinition.width / 2 - margin, 0);
    const offsets = [new THREE.Vector3()];
    [-1, 0, 1].forEach((sx) => [-1, 0, 1].forEach((sz) => {
      if (sx || sz) offsets.push(new THREE.Vector3(sx * x, 0, sz * z));
    }));
    return offsets;
  }

  // Solves the placing contact, then the vertical column upward from it, so lowering and
  // retracting stay in one arm configuration. Returns the first fully solved column, else
  // the closest attempt.
  planStackColumn(contactPoint, carryPoint, seeds) {
    let best = null;
    for (const seed of seeds) {
      const pose = this.solveTarget(contactPoint, seed);
      const error = this.getSuctionWorld().distanceTo(contactPoint);
      if (!this.isSolved(contactPoint)) {
        if (!best || (!best.solved && error < best.error)) best = { pose, error, solved: false, path: null };
        continue;
      }
      const path = this.planPath(contactPoint, carryPoint, pose, 8);
      if (!best?.solved || path.solved) best = { pose, error, solved: path.solved, path };
      if (path.solved) break;
    }
    best.path ??= this.planPath(contactPoint, carryPoint, best.pose, 8);
    return best;
  }

  prepareTargets() {
    if (!this.attached) this.boxTopOffset = this.measureBoxTop();
    this.toolOrientation = this.getToolOrientation();
    this.stackTarget = this.getStackTarget(this.boxNumber);
    this.validateStackTarget(this.stackTarget);
    const contactLift = this.boxTopOffset + CONTACT_GAP;
    const stackContact = this.stackTarget.clone().setY(this.stackTarget.y + contactLift);
    const stackCarry = stackContact.clone().setY(stackContact.y + this.boxDefinition.height + CARRY_CLEARANCE);

    // The placing contact is the hardest reach, so it picks the grip point on the box top.
    let column = null;
    let graspOffset = null;
    // A box already in the cup (a re-plan) keeps the grip point it was picked with.
    const offsets = this.attached && this.plannedGrasp
      ? [new THREE.Vector3(this.plannedGrasp.x, 0, this.plannedGrasp.z)]
      : this.getGraspOffsets();
    for (const offset of offsets) {
      const seeds = column ? [column.pose, this.home] : this.getStackSeeds(this.home);
      const attempt = this.planStackColumn(stackContact.clone().add(offset), stackCarry.clone().add(offset), seeds);
      if (!column || (attempt.solved && !column.solved) || (!column.solved && attempt.error < column.error)) {
        column = attempt;
        graspOffset = offset;
      }
      if (column.solved) break;
    }
    if (!column.solved) console.warn(`Box ${this.boxNumber + 1}: no flat-cup path above the stack cell.`);
    this.plannedGrasp = new THREE.Vector3(graspOffset.x, contactLift, graspOffset.z);

    const contact = this.getBoxGraspWorld();
    const hover = contact.clone().setY(contact.y + APPROACH_HEIGHT);
    // Rise straight up to at least the swing height so the carried box never sweeps
    // over the stack below the cell it is going to.
    const lift = contact.clone().setY(Math.max(contact.y + LIFT_HEIGHT, stackCarry.y));
    const approachPose = this.solveTarget(hover, this.home);
    const pickupPath = this.planPath(hover, contact, approachPose, 6);
    const liftPath = this.planPath(contact, lift, pickupPath.at(-1), 6);
    const liftPose = liftPath.at(-1);
    const contactPose = column.pose;
    const retractPath = column.path;
    const carryPose = retractPath.at(-1);
    const lowerPath = [...retractPath.slice(0, -1).reverse(), contactPose];
    const carryPath = this.planSwing(lift, stackCarry.clone().add(graspOffset), liftPose, carryPose, 12);
    this.targets = {
      approach: approachPose,
      pickup: pickupPath,
      lift: liftPath,
      stackCarry: carryPath,
      stackLower: lowerPath,
      retract: retractPath,
    };
    this.rig.setValues(this.home);
  }

  validateStackTarget(target) {
    const boxBounds = new THREE.Box3(
      target.clone().sub(new THREE.Vector3(this.boxDefinition.length / 2, this.boxDefinition.height / 2, this.boxDefinition.width / 2)),
      target.clone().add(new THREE.Vector3(this.boxDefinition.length / 2, this.boxDefinition.height / 2, this.boxDefinition.width / 2)),
    );
    const conveyorBounds = new THREE.Box3().setFromObject(this.conveyor.root);
    const intersectsConveyor = boxBounds.intersectsBox(conveyorBounds);
    const targetBottom = this.layout.stackDropOrigin.y + Math.floor(this.boxNumber / (this.layout.stack.columns * this.layout.stack.rows)) * this.boxDefinition.height;
    const onFloor = Math.abs(target.y - targetBottom - this.boxDefinition.height / 2) < 1e-6;
    if (intersectsConveyor || !onFloor) {
      throw new Error(`Invalid stack target ${this.boxNumber + 1}: intersectsConveyor=${intersectsConveyor}, onFloor=${onFloor}`);
    }
  }

  setState(state, { conveyor = this.conveyorState, robot = this.robotState, box = this.boxState, gripper = this.gripperState } = {}) {
    this.state = state;
    this.conveyorState = conveyor;
    this.robotState = robot;
    this.boxState = box;
    this.gripperState = gripper;
    this.gripper.userData.setState(gripper);
    this.onUpdate?.(this);
  }

  beginMove(state, target, duration, options = {}) {
    this.poseFrom = this.getJointPose();
    this.poseTo = target;
    this.elapsed = 0;
    this.duration = duration;
    this.setState(state, options);
  }

  start() {
    if (this.state !== 'IDLE' && this.state !== 'COMPLETE') return;
    this.robot.updateMatrixWorld(true);
    const rootBeforeStart = this.robot.getWorldPosition(new THREE.Vector3());
    this.reset();
    this.createBoxAtInput();
    this.setState('SPAWN_BOX', { conveyor: 'STOPPED', robot: 'HOME', box: 'ON BELT', gripper: 'OPEN' });
    this.beginHold('SPAWN_BOX', 0.2, { conveyor: 'STOPPED', robot: 'HOME', box: 'ON BELT', gripper: 'OPEN' });
    this.assertRootTransform(rootBeforeStart, 'START initialization');
  }

  beginHold(state, duration, options) {
    this.poseFrom = this.getJointPose();
    this.poseTo = this.poseFrom;
    this.elapsed = 0;
    this.duration = duration;
    this.setState(state, options);
  }

  reset() {
    this.resetOutbound();
    this.poseTo = null;
    this.attached = false;
    this.rig.setValues(this.home);
    if (this.box) {
      this.box.root.removeFromParent();
      this.box = null;
    }
    this.floorBoxes.forEach((box) => box.root.removeFromParent());
    this.floorBoxes = [];
    this.boxNumber = 0;
    this.stackTarget = null;
    this.plannedGrasp = null;
    this.setState('IDLE', { conveyor: 'STOPPED', robot: 'HOME', box: 'ON BELT', gripper: 'OPEN' });
  }

  resetOutbound() {
    this.outboundTween = null;
    this.outboundActive = false;
    if (this.cargo) {
      if (this.pallet?.root) {
        this.stationRoot.attach(this.pallet.root);
        this.pallet.root.position.set(
          this.layout.pallet.center.x,
          this.layout.pallet.center.y,
          this.layout.pallet.center.z,
        );
        this.pallet.root.rotation.set(0, 0, 0);
      }
      this.floorBoxes.forEach((box) => {
        if (box.root.parent === this.cargo) this.stationRoot.attach(box.root);
      });
      this.cargo.removeFromParent();
      this.cargo = null;
    }
    if (this.worker) {
      this.worker.root.removeFromParent();
      this.worker = null;
    }
    this.wrapMachine?.resetWrap();
  }

  getWorkerPose() {
    return {
      x: this.worker.root.position.x,
      y: this.worker.root.position.y,
      z: this.worker.root.position.z,
      yaw: this.worker.root.rotation.y,
    };
  }

  applyWorkerPose(pose) {
    this.worker.root.position.set(pose.x, pose.y, pose.z);
    this.worker.root.rotation.set(0, pose.yaw, 0);
  }

  buildCargo() {
    if (this.cargo) return;
    this.cargo = new THREE.Group();
    this.cargo.name = 'PalletCargo';
    this.stationRoot.add(this.cargo);
    this.cargo.attach(this.pallet.root);
    this.floorBoxes.forEach((box) => this.cargo.attach(box.root));
  }

  beginOutboundTween(state, tween, duration, status = {}) {
    this.outboundTween = tween;
    this.elapsed = 0;
    this.duration = duration;
    this.poseTo = null;
    this.setState(state, {
      conveyor: 'STOPPED',
      robot: 'HOME',
      box: status.box ?? 'ON PALLET',
      gripper: 'OPEN',
      ...status,
    });
  }

  startOutbound() {
    this.outboundActive = true;
    this.poseTo = null;
    this.worker = createProceduralWorker();
    const spawn = this.layout.outbound.workerSpawn;
    this.worker.root.position.set(spawn.x, spawn.y, spawn.z);
    this.worker.root.rotation.set(0, spawn.yaw, 0);
    this.worker.setForkHeight(0.045);
    this.stationRoot.add(this.worker.root);
    this.buildCargo();
    this.beginOutboundTween('WORKER_SPAWN', { kind: 'hold' }, 0.35, { box: 'ON PALLET' });
  }

  attachCargoToJack() {
    this.worker.cargoAnchor.attach(this.cargo);
  }

  detachCargoToStation() {
    this.stationRoot.attach(this.cargo);
  }

  seatCargoOnWrapDeck(deckHeight) {
    const target = this.wrapMachine.root.localToWorld(new THREE.Vector3(0, deckHeight, 0));
    const palletWorld = this.pallet.root.getWorldPosition(new THREE.Vector3());
    const cargoWorld = this.cargo.getWorldPosition(new THREE.Vector3()).add(target.sub(palletWorld));
    this.cargo.position.copy(this.cargo.parent.worldToLocal(cargoWorld));
    this.cargo.updateMatrixWorld(true);
  }

  getForkBounds() {
    this.worker.root.updateMatrixWorld(true);
    return new THREE.Box3().setFromObject(this.worker.forks);
  }

  /** Back the jack out along its fork axis until the fork tips clear the pallet. */
  getClearWithdrawPose() {
    const pose = this.getWorkerPose();
    const palletBounds = new THREE.Box3().setFromObject(this.pallet.root);
    const forkBounds = this.getForkBounds();
    const travel = forkBounds.max.x - (palletBounds.min.x - FORK_WITHDRAW_CLEARANCE);
    const target = { ...this.layout.outbound.workerWithdraw };
    target.x = Math.min(target.x, pose.x - Math.max(travel, 0));
    return target;
  }

  assertToolClearOfPallet() {
    const palletBounds = new THREE.Box3().setFromObject(this.pallet.root);
    if (this.getForkBounds().intersectsBox(palletBounds)) {
      console.error('Pallet jack forks still intersect the pallet after withdrawal.');
    }
  }

  applyOutboundTween(progress) {
    const tween = this.outboundTween;
    if (!tween || tween.kind === 'hold') return;
    if (tween.kind === 'worker') {
      this.applyWorkerPose(lerpWorkerPose(tween.from, tween.to, progress));
    } else if (tween.kind === 'fork') {
      this.worker.setForkHeight(THREE.MathUtils.lerp(tween.from, tween.to, progress));
    } else if (tween.kind === 'wrap') {
      this.wrapMachine.setWrapProgress(progress);
    }
  }

  finishOutboundStep() {
    const finished = this.state;
    const durations = this.layout.outbound.durations;
    const lift = this.layout.outbound.liftHeight;
    const finishedTween = this.outboundTween;
    this.outboundTween = null;

    if (finished === 'WORKER_SPAWN') {
      this.beginOutboundTween('WORKER_APPROACH', {
        kind: 'worker',
        from: this.getWorkerPose(),
        to: { ...this.layout.outbound.workerEngage },
      }, durations.approach);
    } else if (finished === 'WORKER_APPROACH') {
      this.applyWorkerPose(this.layout.outbound.workerEngage);
      // Brief settle with forks under the pallet before lifting.
      this.beginOutboundTween('JACK_INSERT', { kind: 'hold' }, Math.max(0.4, durations.insert * 0.45));
    } else if (finished === 'JACK_INSERT') {
      this.attachCargoToJack();
      this.beginOutboundTween('JACK_LIFT', {
        kind: 'fork',
        from: this.worker.getForkHeight(),
        to: lift,
      }, durations.lift);
    } else if (finished === 'JACK_LIFT') {
      this.worker.setForkHeight(lift);
      this.beginOutboundTween('TRANSPORT_PALLET', {
        kind: 'worker',
        from: this.getWorkerPose(),
        to: { ...this.layout.outbound.workerAtWrap },
      }, durations.transport, { box: 'IN TRANSIT' });
    } else if (finished === 'TRANSPORT_PALLET') {
      this.applyWorkerPose(this.layout.outbound.workerAtWrap);
      this.beginOutboundTween('PLACE_IN_WRAP', {
        kind: 'worker',
        from: this.getWorkerPose(),
        to: { ...this.layout.outbound.workerPlace },
      }, durations.place, { box: 'IN TRANSIT' });
    } else if (finished === 'PLACE_IN_WRAP') {
      this.applyWorkerPose(this.layout.outbound.workerPlace);
      // Lower onto the turntable deck (pallet root was attached at forks ≈ 0.045).
      const deckHeight = this.wrapMachine?.deckHeight ?? this.layout.wrapMachine?.deckHeight ?? 0;
      const placeForkHeight = deckHeight + 0.045;
      this.beginOutboundTween('JACK_LOWER', {
        kind: 'fork',
        from: this.worker.getForkHeight(),
        to: placeForkHeight,
      }, durations.lower, { box: 'AT WRAPPER' });
    } else if (finished === 'JACK_LOWER') {
      const deckHeight = this.wrapMachine?.deckHeight ?? this.layout.wrapMachine?.deckHeight ?? 0;
      this.worker.setForkHeight(deckHeight + 0.045);
      // Pallet is resting on the turntable: release it and seat it exactly on center.
      this.detachCargoToStation();
      this.seatCargoOnWrapDeck(deckHeight);
      this.beginOutboundTween('JACK_RELEASE', {
        kind: 'fork',
        from: this.worker.getForkHeight(),
        to: deckHeight + FORK_RELEASE_HEIGHT,
      }, durations.release, { box: 'AT WRAPPER' });
    } else if (finished === 'JACK_RELEASE') {
      const deckHeight = this.wrapMachine?.deckHeight ?? this.layout.wrapMachine?.deckHeight ?? 0;
      this.worker.setForkHeight(deckHeight + FORK_RELEASE_HEIGHT);
      this.beginOutboundTween('WORKER_WITHDRAW', {
        kind: 'worker',
        from: this.getWorkerPose(),
        to: this.getClearWithdrawPose(),
      }, durations.withdraw, { box: 'AT WRAPPER' });
    } else if (finished === 'WORKER_WITHDRAW') {
      this.applyWorkerPose(finishedTween.to);
      this.beginOutboundTween('JACK_STOW', {
        kind: 'fork',
        from: this.worker.getForkHeight(),
        to: 0.045,
      }, durations.stow, { box: 'AT WRAPPER' });
    } else if (finished === 'JACK_STOW') {
      this.worker.setForkHeight(0.045);
      this.assertToolClearOfPallet();
      this.wrapMachine.resetWrap();
      this.beginOutboundTween('WRAPPING', { kind: 'wrap' }, durations.wrap, { box: 'WRAPPING' });
    } else if (finished === 'WRAPPING') {
      this.wrapMachine.setWrapProgress(1);
      this.outboundActive = false;
      this.setState('COMPLETE', { conveyor: 'STOPPED', robot: 'HOME', box: 'WRAPPED', gripper: 'OPEN' });
    }
    this.onUpdate?.(this);
  }

  updateOutbound(delta) {
    if (!this.outboundTween) return;
    this.elapsed = Math.min(this.elapsed + delta * this.speedMultiplier, this.duration);
    const progress = THREE.MathUtils.smoothstep(this.elapsed / Math.max(this.duration, 0.001), 0, 1);
    this.applyOutboundTween(progress);
    if (this.elapsed < this.duration) {
      this.onUpdate?.(this);
      return;
    }
    this.finishOutboundStep();
  }

  attachBox() {
    this.distance = this.getSuctionWorld().distanceTo(this.getBoxGraspWorld());
    if (this.distance > GRIP_TOLERANCE) {
      console.warn(`Grip prevented: TCP-to-grasp distance ${this.distance.toFixed(3)} m exceeds ${GRIP_TOLERANCE} m.`);
      return false;
    }
    // Rigid hold: the box keeps its pose relative to the cup until released.
    this.gripper.attach(this.box.root);
    this.attached = true;
    this.setState('GRIP', { conveyor: 'STOPPED', robot: 'PICKING', box: 'GRIPPED', gripper: 'GRIPPING' });
    return true;
  }

  releaseBox() {
    if (!this.attached) return false;
    const worldQuaternion = this.box.root.getWorldQuaternion(new THREE.Quaternion());
    this.stationRoot.attach(this.box.root);
    const expected = this.stackTarget.clone();
    const actual = this.box.root.getWorldPosition(new THREE.Vector3());
    const placementError = actual.distanceTo(expected);
    const expectedQuaternion = new THREE.Quaternion();
    const rotationError = 1 - Math.abs(worldQuaternion.dot(expectedQuaternion));
    this.positionError = placementError;
    const bottomError = Math.abs(
      this.box.root.localToWorld(new THREE.Vector3(0, -this.boxDefinition.height / 2, 0)).y
      - (this.stackTarget.y - this.boxDefinition.height / 2),
    );
    const overlap = this.floorBoxes.some((placed, placedIndex) => {
      const center = this.getStackTarget(placed.root.userData.stackIndex ?? placedIndex);
      const clearance = 1e-3;
      return Math.abs(center.x - expected.x) < this.boxDefinition.length - clearance
        && Math.abs(center.z - expected.z) < this.boxDefinition.width - clearance
        && Math.abs(center.y - expected.y) < this.boxDefinition.height - clearance;
    });
    this.bottomHeight = this.box.root.localToWorld(new THREE.Vector3(0, -this.boxDefinition.height / 2, 0)).y;
    console.info('Stack placement validation', {
      target: expected.toArray(),
      actual: actual.toArray(),
      positionError: placementError,
      bottomHeight: this.box.root.localToWorld(new THREE.Vector3(0, -this.boxDefinition.height / 2, 0)).y,
      targetBottomHeight: this.stackTarget.y - this.boxDefinition.height / 2,
      rotation: this.box.root.rotation.toArray(),
      overlap,
    });
    if (placementError > 0.04 || bottomError > 0.04 || rotationError > 1e-4 || overlap) {
      console.error('Stack placement validation failed.', { placementError, bottomError, rotationError, overlap });
      return false;
    }
    // The motion solver may leave a few millimetres of numerical error. Once
    // verification passes, place the box at the exact grid target before
    // releasing it so every following layer starts from a stable reference.
    this.box.root.position.copy(this.stationRoot.worldToLocal(expected.clone()));
    this.box.root.quaternion.identity();
    this.box.root.userData.stackIndex = this.boxNumber;
    this.plannedGrasp = null;
    this.floorBoxes.push(this.box);
    this.boxNumber += 1;
    this.box = null;
    this.attached = false;
    return true;
  }

  updateConveyor(delta) {
    if (!this.box) return;
    const direction = this.getConveyorDirection();
    const pickup = new THREE.Vector3(
      this.layout.conveyor.pickup.x,
      this.getBeltBoxCenterY(),
      this.layout.conveyor.pickup.z,
    );
    const scaledDelta = delta * this.speedMultiplier;
    const remaining = pickup.clone().sub(this.box.root.position).dot(direction);
    const travel = Math.min(CONVEYOR_SPEED * scaledDelta, Math.max(remaining, 0));
    this.box.root.position.addScaledVector(direction, travel);
    this.conveyor.rollers?.forEach((roller) => {
      roller.rotation.z -= travel / 0.045;
    });
    if (remaining <= CONVEYOR_SPEED * scaledDelta + 1e-6) {
      this.box.root.position.copy(pickup);
      this.setState('BOX_AT_PICKUP', { conveyor: 'STOPPED', robot: 'HOME', box: 'ON BELT', gripper: 'OPEN' });
      this.beginHold('BOX_AT_PICKUP', 0.25, { conveyor: 'STOPPED', robot: 'HOME', box: 'ON BELT', gripper: 'OPEN' });
    }
  }

  update(delta) {
    this.gripper.userData.update?.(delta, this.speedMultiplier);
    if (this.outboundActive) {
      this.updateOutbound(delta);
      return;
    }
    if (this.state === 'CONVEYOR_RUNNING') {
      this.updateConveyor(delta);
      return;
    }
    if (!this.poseTo) return;
    this.elapsed = Math.min(this.elapsed + delta * this.speedMultiplier, this.duration);
    const progress = THREE.MathUtils.smoothstep(this.elapsed / Math.max(this.duration, 0.001), 0, 1);
    this.rig.setValues(Array.isArray(this.poseTo)
      ? samplePosePath([this.poseFrom, ...this.poseTo], progress)
      : lerpPose(this.poseFrom, this.poseTo, progress));
    if (this.box) this.distance = this.getSuctionWorld().distanceTo(this.getBoxGraspWorld());
    if (this.elapsed < this.duration) {
      this.onUpdate?.(this);
      return;
    }
    const finished = this.state;
    this.poseTo = null;
    if (finished === 'SPAWN_BOX') {
      this.beginMove('CONVEYOR_RUNNING', null, 0, { conveyor: 'RUNNING', robot: 'HOME', box: 'ON BELT', gripper: 'OPEN' });
    } else if (finished === 'BOX_AT_PICKUP') {
      this.prepareTargets();
      this.beginMove('APPROACH_BOX', this.targets.approach, 1.8, { conveyor: 'STOPPED', robot: 'APPROACH', box: 'ON BELT', gripper: 'APPROACHING' });
    } else if (finished === 'APPROACH_BOX') {
      this.beginMove('LOWER_TO_BOX', this.targets.pickup, 1.0, { robot: 'APPROACH', box: 'ON BELT', gripper: 'APPROACHING' });
    } else if (finished === 'LOWER_TO_BOX') {
      this.animateClaw(0.82, 0.68, 0.45, 'GRIPPING');
    } else if (finished === 'GRIPPING') {
      if (!this.attachBox()) {
        this.setState('IDLE', { conveyor: 'STOPPED', robot: 'HOME', box: 'ON BELT', gripper: 'OPEN' });
        return;
      }
      this.beginMove('LIFT', this.targets.lift, 1.1, { robot: 'CARRYING', box: 'GRIPPED', gripper: 'HOLDING' });
    } else if (finished === 'LIFT') {
      this.beginMove('MOVE_TO_STACK', this.targets.stackCarry, 2.0, { robot: 'CARRYING', box: 'GRIPPED', gripper: 'HOLDING' });
    } else if (finished === 'MOVE_TO_STACK') {
      this.beginMove('LOWER_TO_STACK', this.targets.stackLower, 0.9, { robot: 'PLACING', box: 'GRIPPED', gripper: 'HOLDING' });
    } else if (finished === 'LOWER_TO_STACK') {
      this.animateClaw(0.68, 0.82, 0.45, 'RELEASING');
    } else if (finished === 'RELEASING') {
      if (!this.releaseBox()) {
        console.error(`Placement verification failed for box ${this.boxNumber + 1}; retrying target calculation.`);
        this.prepareTargets();
        this.beginMove('LOWER_TO_STACK', this.targets.stackLower, 0.9, { robot: 'PLACING', box: 'GRIPPED', gripper: 'HOLDING' });
        return;
      }
      this.beginHold('VERIFY_PLACEMENT', 0.16, { robot: 'PLACING', box: 'ON FLOOR', gripper: 'OPEN' });
    } else if (finished === 'VERIFY_PLACEMENT') {
      // Lift the open cup straight off the placed box before swinging home.
      this.beginMove('RETRACT', this.targets.retract, 0.8, { robot: 'RETURNING HOME', box: 'ON FLOOR', gripper: 'OPEN' });
    } else if (finished === 'RETRACT') {
      this.beginMove('RETURN_HOME', this.home, 2.2, { robot: 'RETURNING HOME', box: 'ON FLOOR', gripper: 'OPEN' });
    } else if (finished === 'RETURN_HOME') {
      if (this.boxNumber >= this.layout.stack.columns * this.layout.stack.rows * this.layout.stack.layers) {
        // Stacking complete — stop box/conveyor process and begin outbound handling.
        this.startOutbound();
      } else {
        this.createBoxAtInput();
        this.beginHold('SPAWN_BOX', 0.2, { conveyor: 'STOPPED', robot: 'HOME', box: 'ON BELT', gripper: 'OPEN' });
      }
    }
    this.onUpdate?.(this);
  }
}
