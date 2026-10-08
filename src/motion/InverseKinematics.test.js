import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { Rig } from './Rig.js';
import { chainFor, diagnoseReach, resolveTool, solveReach } from './InverseKinematics.js';

// Test machines are built from plain boxes and rigged like Joint Setup would, so these tests
// exercise the generic behaviour (any vendor, any machine type), not one particular robot.

const V = (x, y, z) => new THREE.Vector3(x, y, z);

function machine(parts, joints, { unitScale = 1, tools = [] } = {}) {
  const content = new THREE.Group();
  const material = new THREE.MeshBasicMaterial();
  parts.forEach(({ name, size, at }) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material);
    mesh.name = name;
    mesh.position.set(...at);
    content.add(mesh);
  });
  const root = new THREE.Group();
  root.scale.setScalar(unitScale);
  root.add(content);
  root.updateMatrixWorld(true);
  return new Rig({ root, content, definition: { version: 1, joints, tools, poses: [], sequences: [] } });
}

const MACHINES = {
  'six-axis arm': () => machine([
    { name: 'turret', size: [0.5, 0.3, 0.5], at: [0, 0.65, 0] },
    { name: 'upperArm', size: [0.15, 1.0, 0.15], at: [0.2, 1.3, 0] },
    { name: 'forearm', size: [1.0, 0.12, 0.12], at: [0.7, 1.8, 0] },
    { name: 'wrist', size: [0.1, 0.1, 0.1], at: [1.25, 1.8, 0] },
    { name: 'hand', size: [0.1, 0.1, 0.1], at: [1.35, 1.8, 0] },
    { name: 'flange', size: [0.05, 0.1, 0.1], at: [1.45, 1.8, 0] },
  ], [
    { id: 'a1', type: 'revolute', parent: null, parts: [{ name: 'turret' }], axis: [0, 1, 0], pivot: [0, 0.5, 0], min: -170, max: 170, speed: 90 },
    { id: 'a2', type: 'revolute', parent: 'a1', parts: [{ name: 'upperArm' }], axis: [0, 0, 1], pivot: [0.2, 0.8, 0], min: -80, max: 80, speed: 90 },
    { id: 'a3', type: 'revolute', parent: 'a2', parts: [{ name: 'forearm' }], axis: [0, 0, 1], pivot: [0.2, 1.8, 0], min: -170, max: 70, speed: 90 },
    { id: 'a4', type: 'revolute', parent: 'a3', parts: [{ name: 'wrist' }], axis: [1, 0, 0], pivot: [1.2, 1.8, 0], min: -300, max: 300, speed: 180 },
    { id: 'a5', type: 'revolute', parent: 'a4', parts: [{ name: 'hand' }], axis: [0, 0, 1], pivot: [1.3, 1.8, 0], min: -120, max: 120, speed: 180 },
    { id: 'a6', type: 'revolute', parent: 'a5', parts: [{ name: 'flange' }], axis: [1, 0, 0], pivot: [1.4, 1.8, 0], min: -360, max: 360, speed: 360 },
  ], { tools: [{ id: 'tool', joint: 'a6', point: [1.5, 1.8, 0], direction: [1, 0, 0] }] }),

  // Built in millimetres (scale 0.001) with sliding joints, to test units and scale.
  'gantry (mm)': () => machine([
    { name: 'bridge', size: [200, 100, 3000], at: [0, 2000, 0] },
    { name: 'carriage', size: [300, 150, 300], at: [0, 1900, 0] },
    { name: 'quill', size: [100, 1200, 100], at: [0, 1300, 0] },
    { name: 'wrist', size: [150, 100, 150], at: [0, 650, 0] },
    { name: 'head', size: [80, 200, 80], at: [0, 500, 0] },
  ], [
    { id: 'x', type: 'prismatic', parent: null, parts: [{ name: 'bridge' }], axis: [1, 0, 0], pivot: [0, 2000, 0], min: -1500, max: 1500, speed: 500 },
    { id: 'z', type: 'prismatic', parent: 'x', parts: [{ name: 'carriage' }], axis: [0, 0, 1], pivot: [0, 1900, 0], min: -1200, max: 1200, speed: 500 },
    { id: 'y', type: 'prismatic', parent: 'z', parts: [{ name: 'quill' }], axis: [0, 1, 0], pivot: [0, 1300, 0], min: -900, max: 0, speed: 300 },
    { id: 'spin', type: 'revolute', parent: 'y', parts: [{ name: 'wrist' }], axis: [0, 1, 0], pivot: [0, 650, 0], min: -180, max: 180, speed: 90 },
    { id: 'tilt', type: 'revolute', parent: 'spin', parts: [{ name: 'head' }], axis: [1, 0, 0], pivot: [0, 600, 0], min: -90, max: 90, speed: 90 },
  ], { unitScale: 0.001, tools: [{ id: 'tool', joint: 'tilt', point: [0, 350, 0], direction: [0, -1, 0] }] }),

  scara: () => machine([
    { name: 'arm1', size: [0.4, 0.1, 0.1], at: [0.2, 0.5, 0] },
    { name: 'arm2', size: [0.35, 0.1, 0.1], at: [0.575, 0.5, 0] },
    { name: 'quill', size: [0.04, 0.4, 0.04], at: [0.75, 0.4, 0] },
    { name: 'flange', size: [0.08, 0.02, 0.08], at: [0.75, 0.2, 0] },
  ], [
    { id: 'j1', type: 'revolute', parent: null, parts: [{ name: 'arm1' }], axis: [0, 1, 0], pivot: [0, 0.5, 0], min: -130, max: 130, speed: 180 },
    { id: 'j2', type: 'revolute', parent: 'j1', parts: [{ name: 'arm2' }], axis: [0, 1, 0], pivot: [0.4, 0.5, 0], min: -145, max: 145, speed: 180 },
    { id: 'j3', type: 'prismatic', parent: 'j2', parts: [{ name: 'quill' }], axis: [0, 1, 0], pivot: [0.75, 0.4, 0], min: -250, max: 0, speed: 500 },
    { id: 'j4', type: 'revolute', parent: 'j3', parts: [{ name: 'flange' }], axis: [0, 1, 0], pivot: [0.75, 0.2, 0], min: -360, max: 360, speed: 360 },
  ], { tools: [{ id: 'tool', joint: 'j4', point: [0.75, 0.18, 0], direction: [0, -1, 0] }] }),

  'redundant 7-joint arm': () => {
    const parts = [];
    const joints = [];
    let parent = null;
    ['y', 'z', 'y', 'z', 'y', 'z', 'y'].forEach((axis, index) => {
      const y = 0.2 + index * 0.3;
      parts.push({ name: `link${index}`, size: [0.08, 0.3, 0.08], at: [0, y + 0.15, 0] });
      joints.push({ id: `q${index}`, type: 'revolute', parent, parts: [{ name: `link${index}` }], axis: axis === 'y' ? [0, 1, 0] : [0, 0, 1], pivot: [0, y, 0], min: -170, max: 170, speed: 90 });
      parent = `q${index}`;
    });
    return machine(parts, joints, { tools: [{ id: 'tool', joint: 'q6', point: [0, 2.3, 0], direction: [0, 1, 0] }] });
  },

  // The tool rides on a follower ("rocker" aims at a point on "crank"), so the crank must be
  // found as part of the chain even though nothing is mounted on it.
  linkage: () => machine([
    { name: 'crank', size: [0.5, 0.05, 0.05], at: [0.25, 0.5, 0] },
    { name: 'rocker', size: [0.05, 0.6, 0.05], at: [0.6, 0.8, 0] },
    { name: 'hand', size: [0.2, 0.05, 0.05], at: [0.7, 1.1, 0] },
  ], [
    { id: 'crank', type: 'revolute', parent: null, parts: [{ name: 'crank' }], axis: [0, 0, 1], pivot: [0, 0.5, 0], min: -60, max: 60, speed: 90 },
    { id: 'rocker', type: 'revolute', parent: null, parts: [{ name: 'rocker' }], axis: [0, 0, 1], pivot: [0.6, 0.5, 0], aim: { joint: 'crank', target: [0.5, 0.5, 0] } },
    { id: 'hand', type: 'revolute', parent: 'rocker', parts: [{ name: 'hand' }], axis: [0, 0, 1], pivot: [0.6, 1.1, 0], min: -90, max: 90, speed: 90 },
  ], { tools: [{ id: 'tool', joint: 'hand', point: [0.8, 1.1, 0], direction: [1, 0, 0] }] }),
};

function seededRandom(seed) {
  let state = seed;
  return () => {
    state = (state + 0x6D2B79F5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Reachable targets: put the machine in random valid poses and record where the tool is.
function reachableTargets(rig, resolved, count) {
  const random = seededRandom(11);
  const start = rig.getPose();
  const targets = [];
  for (let index = 0; index < count; index += 1) {
    rig.setValues(Object.fromEntries(resolved.active.map((joint) => [joint.id, joint.min + (joint.max - joint.min) * random()])));
    targets.push({ position: resolved.position(), direction: resolved.direction() });
  }
  rig.setValues(start);
  return targets;
}

function successRate(rig, resolved, targets, withDirection) {
  const reached = targets.filter(({ position, direction }) => (
    solveReach(rig, resolved, position, withDirection ? { orient: direction } : {}).reached
  )).length;
  return reached / targets.length;
}

describe('solveReach on different kinds of machines', () => {
  Object.entries(MACHINES).forEach(([name, build]) => {
    it(`${name}: reaches points and tool directions it can physically reach`, () => {
      const rig = build();
      const resolved = resolveTool(rig, rig.definition.tools[0]);
      const targets = reachableTargets(rig, resolved, 60);
      expect(successRate(rig, resolved, targets, false)).toBeGreaterThanOrEqual(0.97);
      expect(successRate(rig, resolved, targets, true)).toBeGreaterThanOrEqual(0.95);
    });
  });

  it('leaves the rig exactly as it was', () => {
    const rig = MACHINES['six-axis arm']();
    const resolved = resolveTool(rig, rig.definition.tools[0]);
    rig.setValues({ a2: 20, a3: -30 });
    const before = rig.getPose();
    solveReach(rig, resolved, V(1.2, 1.0, 0.4));
    expect(rig.getPose()).toEqual(before);
  });

  it('returns values that really put the tool on the target', () => {
    const rig = MACHINES['gantry (mm)']();
    const resolved = resolveTool(rig, rig.definition.tools[0]);
    const target = V(0.8, 0.2, -0.5); // the quill reaches from 0.35 m down to -0.55 m
    const result = solveReach(rig, resolved, target, { orient: V(0, -1, 0) });
    expect(result.reached).toBe(true);
    rig.setValues(result.values);
    expect(resolved.position().distanceTo(target)).toBeLessThan(resolved.tolerance);
  });

  it('picks the nearest equivalent angle for joints that turn more than a full circle', () => {
    const rig = MACHINES.scara();
    const resolved = resolveTool(rig, rig.definition.tools[0]);
    rig.setValues({ j4: 300 });
    const tool = resolved.position();
    const result = solveReach(rig, resolved, tool.clone().add(V(0, -0.05, 0)));
    expect(result.reached).toBe(true);
    expect(Math.abs(result.values.j4 - 300)).toBeLessThan(5);
  });
});

describe('chainFor', () => {
  it('includes the joint a follower follows', () => {
    const rig = MACHINES.linkage();
    expect(chainFor(rig, 'hand').map((joint) => joint.id)).toEqual(['crank', 'rocker', 'hand']);
    const resolved = resolveTool(rig, rig.definition.tools[0]);
    expect(resolved.active.map((joint) => joint.id)).toEqual(['crank', 'hand']);
    expect(resolved.useFiniteDifferences).toBe(true);
  });

  it('leaves out joints on other branches', () => {
    const rig = MACHINES['six-axis arm']();
    expect(chainFor(rig, 'a3').map((joint) => joint.id)).toEqual(['a1', 'a2', 'a3']);
  });
});

describe('diagnoseReach explains failures', () => {
  it('reports a point that is too far away, and by how much', () => {
    const rig = MACHINES['six-axis arm']();
    const resolved = resolveTool(rig, rig.definition.tools[0]);
    const result = diagnoseReach(rig, resolved, V(8, 1, 0));
    expect(result.status).toBe('out-of-reach');
    expect(result.shortBy).toBeGreaterThan(4);
  });

  it('rejects points under the floor', () => {
    const rig = MACHINES['six-axis arm']();
    const resolved = resolveTool(rig, rig.definition.tools[0]);
    expect(diagnoseReach(rig, resolved, V(1.2, -0.3, 0)).status).toBe('below-floor');
  });

  it('reports a point exactly behind a ±170° base as a joint-range problem', () => {
    const rig = MACHINES['six-axis arm']();
    const resolved = resolveTool(rig, rig.definition.tools[0]);
    const result = diagnoseReach(rig, resolved, V(-1.3, 1.6, 0));
    expect(result.status).toBe('joint-limit');
  });

  it('names the joint whose range is too small', () => {
    // Pan-tilt that can only pan ±60°: a point behind it needs the pan joint past its range.
    const rig = machine([
      { name: 'yoke', size: [0.1, 0.2, 0.1], at: [0, 0.4, 0] },
      { name: 'barrel', size: [0.3, 0.05, 0.05], at: [0.15, 0.5, 0] },
    ], [
      { id: 'pan', type: 'revolute', parent: null, parts: [{ name: 'yoke' }], axis: [0, 1, 0], pivot: [0, 0.3, 0], min: -60, max: 60, speed: 90 },
      { id: 'tilt', type: 'revolute', parent: 'pan', parts: [{ name: 'barrel' }], axis: [0, 0, 1], pivot: [0, 0.5, 0], min: -45, max: 45, speed: 90 },
    ], { tools: [{ id: 'tool', joint: 'tilt', point: [0.3, 0.5, 0], direction: [1, 0, 0] }] });
    const resolved = resolveTool(rig, rig.definition.tools[0]);
    const result = diagnoseReach(rig, resolved, V(-0.3, 0.5, 0));
    expect(result.status).toBe('joint-limit');
    expect(result.overLimits.map(({ joint }) => joint.id)).toContain('pan');
  });

  it('tells apart "can reach the point" from "can reach it pointing that way"', () => {
    // A SCARA's tool always points down, so it can't point sideways at a point it can reach.
    const rig = MACHINES.scara();
    const resolved = resolveTool(rig, rig.definition.tools[0]);
    const result = diagnoseReach(rig, resolved, V(0.5, 0.1, 0.3), { orient: V(1, 0, 0) });
    expect(result.status).toBe('orientation');
  });

  it('warns when reaching needs a very large swing', () => {
    const rig = MACHINES['six-axis arm']();
    const resolved = resolveTool(rig, rig.definition.tools[0]);
    // About 150° round from where the arm points now (the base turns ±170°).
    const result = diagnoseReach(rig, resolved, V(-1.1, 1.6, 0.64));
    expect(result.status).toBe('reachable');
    expect(result.warnings).toContain('big-move');
  });
});

describe('resolveTool', () => {
  it('reads tool points given in a part\'s own frame', () => {
    const rig = MACHINES['six-axis arm']();
    // flange part is centred at (1.45, 1.8, 0); +0.05 along its x is the model point (1.5, 1.8, 0)
    const modelFrame = resolveTool(rig, { joint: 'a6', point: [1.5, 1.8, 0], direction: [1, 0, 0] });
    const partFrame = resolveTool(rig, { joint: 'a6', frame: 'part', point: [0.05, 0, 0], direction: [1, 0, 0] });
    expect(partFrame.position().distanceTo(modelFrame.position())).toBeLessThan(1e-9);
  });

  it('returns null when the tool\'s joint is gone', () => {
    const rig = MACHINES.scara();
    expect(resolveTool(rig, { joint: 'missing', point: [0, 0, 0] })).toBeNull();
  });
});
