import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { Rig } from '../../motion/Rig.js';
import { MotionPlayer } from '../../motion/MotionPlayer.js';
import { Simulation } from '../Simulation.js';
import { ProgramRunner } from './ProgramRunner.js';
import { newStep, pickAndPlaceSteps } from './Program.js';

// A gantry robot (built in millimetres, tool pointing down) picks boxes off a pad and puts them
// on a pallet, with real physics: the whole "smart steps" chain, without a browser.

function gantry() {
  const content = new THREE.Group();
  const material = new THREE.MeshBasicMaterial();
  [
    { name: 'bridge', size: [200, 100, 3000], at: [0, 2000, 0] },
    { name: 'carriage', size: [300, 150, 300], at: [0, 1900, 0] },
    { name: 'quill', size: [100, 1200, 100], at: [0, 1300, 0] },
    { name: 'wrist', size: [150, 100, 150], at: [0, 650, 0] },
    { name: 'head', size: [80, 200, 80], at: [0, 500, 0] },
  ].forEach(({ name, size, at }) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material);
    mesh.name = name;
    mesh.position.set(...at);
    content.add(mesh);
  });
  const model = new THREE.Group();
  model.scale.setScalar(0.001);
  model.add(content);
  model.updateMatrixWorld(true);
  const rig = new Rig({
    root: model,
    content,
    definition: {
      version: 1,
      joints: [
        { id: 'x', type: 'prismatic', parent: null, parts: [{ name: 'bridge' }], axis: [1, 0, 0], pivot: [0, 2000, 0], min: -1500, max: 1500, speed: 2000 },
        { id: 'z', type: 'prismatic', parent: 'x', parts: [{ name: 'carriage' }], axis: [0, 0, 1], pivot: [0, 1900, 0], min: -1200, max: 1200, speed: 2000 },
        { id: 'y', type: 'prismatic', parent: 'z', parts: [{ name: 'quill' }], axis: [0, 1, 0], pivot: [0, 1300, 0], min: -900, max: 0, speed: 1000 },
        { id: 'spin', type: 'revolute', parent: 'y', parts: [{ name: 'wrist' }], axis: [0, 1, 0], pivot: [0, 650, 0], min: -180, max: 180, speed: 180 },
        { id: 'tilt', type: 'revolute', parent: 'spin', parts: [{ name: 'head' }], axis: [1, 0, 0], pivot: [0, 600, 0], min: -90, max: 90, speed: 180 },
      ],
      tools: [{ id: 'tool', joint: 'tilt', point: [0, 350, 0], direction: [0, -1, 0] }],
      poses: [{ id: 'home', name: 'Home', values: { x: 0, z: 0, y: 0, spin: 0, tilt: 0 } }],
      sequences: [],
    },
  });
  return { model, rig };
}

const BOX = { length: 0.3, height: 0.08, width: 0.25 };

// A flat static slab with a top surface spot, like a pallet.
function slab(size, position) {
  const root = new THREE.Group();
  root.position.set(...position);
  return {
    kind: 'component',
    root,
    component: {
      body: 'static',
      colliders: [{ shape: 'box', size, position: [0, size[1] / 2, 0] }],
      anchors: { surface: { type: 'surface', position: [0, size[1], 0], direction: [0, 1, 0] } },
    },
  };
}

function box(position) {
  const root = new THREE.Group();
  root.position.set(...position);
  return {
    kind: 'component',
    root,
    component: { body: 'dynamic', mass: 8, colliders: [{ shape: 'box', size: [BOX.length, BOX.height, BOX.width], position: [0, BOX.height / 2, 0] }] },
  };
}

function scene(program) {
  const root = new THREE.Group();
  const robot = gantry();
  const robotRoot = new THREE.Group();
  robotRoot.add(robot.model);
  const runtimes = new Map([
    ['robot', { kind: 'model', root: robotRoot, asset: { rig: robot.rig, player: new MotionPlayer(robot.rig), animations: [] } }],
    ['pad', slab([1, 0.02, 1], [-0.8, 0, 0])],
    ['pallet', slab([1, 0.02, 0.6], [0.8, 0, 0])],
    ['box1', box([-0.8, 0.02, -0.2])],
    ['box2', box([-0.8, 0.02, 0.2])],
  ]);
  const items = [
    { id: 'robot', name: 'Gantry', program },
    { id: 'pad', name: 'Pad' },
    { id: 'pallet', name: 'Pallet' },
    { id: 'box1', name: 'Box 1' },
    { id: 'box2', name: 'Box 2' },
  ];
  runtimes.forEach((runtime, id) => {
    runtime.id = id;
    runtime.root.userData.sceneItemId = id;
    root.add(runtime.root);
  });
  root.updateMatrixWorld(true);
  const editor = { root, items, runtimes, document: { items }, item: (id) => items.find((item) => item.id === id) };
  return { editor, rig: robot.rig, player: runtimes.get('robot').asset.player };
}

// Runs the scene like the app does each frame: program, then motion, then physics.
async function play({ editor, player }, { seconds = 90, settle = 1 } = {}) {
  const simulation = new Simulation(editor);
  await simulation.start();
  const dt = 1 / 60;
  for (let time = 0; time < settle; time += dt) simulation.step(dt);
  const runner = new ProgramRunner({ editor, simulation, itemId: 'robot' });
  runner.start();
  for (let time = 0; time < seconds && !runner.finished && !runner.error; time += dt) {
    runner.update(dt);
    // Let the program's promises move on before the frame is drawn.
    await Promise.resolve();
    await Promise.resolve();
    player.update(dt);
    simulation.step(dt);
  }
  return { simulation, runner };
}

const at = (editor, id) => editor.runtimes.get(id).root.position;

describe('robot programs in a scene', () => {
  it('picks boxes up and places them across a grid', async () => {
    const steps = pickAndPlaceSteps({
      from: { kind: 'spot', item: 'pad', anchor: 'surface' },
      onto: { kind: 'spot', item: 'pallet', anchor: 'surface' },
      grid: { columns: 2, rows: 1, layers: 1 },
      box: BOX,
      homePose: 'home',
    });
    // Low approach: this gantry only reaches 35 cm above the floor.
    const tune = (list) => list.forEach((step) => {
      if (step.type === 'reach') step.approach = 0.08;
      if (step.steps) tune(step.steps);
    });
    tune(steps);
    const world = scene({ loop: false, steps });
    const { runner, simulation } = await play(world);
    expect(runner.error).toBeNull();
    expect(runner.finished).toBe(true);
    // Both boxes now stand on the pallet, side by side on the grid's two spots.
    const placed = ['box1', 'box2'].map((id) => at(world.editor, id).clone()).sort((a, b) => a.x - b.x);
    const spacing = BOX.length + 0.02;
    expect(placed[0].x).toBeCloseTo(0.8 - spacing / 2, 1);
    expect(placed[1].x).toBeCloseTo(0.8 + spacing / 2, 1);
    placed.forEach((position) => {
      expect(position.y).toBeGreaterThan(0.01);
      expect(position.y).toBeLessThan(0.04);
      expect(Math.abs(position.z)).toBeLessThan(0.05);
    });
    expect(simulation.bodies.some((entry) => entry.held)).toBe(false);
    simulation.stop();
  }, 60000);

  it('stops with a plain reason when a target is out of reach', async () => {
    const world = scene({
      loop: false,
      steps: [newStep('reach', { target: { kind: 'point', item: null, offset: [3, 0.2, 0] }, approach: 0 })],
    });
    const { runner, simulation } = await play(world, { seconds: 5 });
    expect(runner.finished).toBe(false);
    expect(runner.error.message).toMatch(/Can't reach a point on the floor/);
    simulation.stop();
  });

  it('says what is wrong when gripping with nothing under the tool', async () => {
    const world = scene({ loop: false, steps: [newStep('grip')] });
    const { runner, simulation } = await play(world, { seconds: 2 });
    expect(runner.error.message).toMatch(/no box at the tool tip/);
    simulation.stop();
  });
});
