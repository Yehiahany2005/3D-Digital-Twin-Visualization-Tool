import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { Simulation } from '../Simulation.js';
import { getComponent, resolveParams } from '../catalog/index.js';
import { WorkerRunner } from './WorkerRunner.js';
import { movePalletSteps, newStep } from './Program.js';
import { palletChoices } from './targets.js';

// A worker with a pallet jack (the real catalog component) takes a loaded pallet (the real one)
// across the floor with physics running: the boxes have to ride along and stay on it.

const BOX = { length: 0.4, height: 0.3, width: 0.3 };

function catalogItem(id, componentId, { name, position = [0, 0, 0], yaw = 0, params = {} } = {}) {
  const definition = getComponent(componentId);
  const component = definition.build(resolveParams(definition, params));
  const root = new THREE.Group();
  root.position.set(...position);
  root.rotation.y = THREE.MathUtils.degToRad(yaw);
  root.add(component.root);
  return {
    item: { id, name: name || definition.name, source: { kind: 'catalog', id: componentId }, params },
    runtime: { kind: 'component', root, component },
  };
}

// A low stand (like a wrapper's turntable) with a top surface `height` up.
function stand(id, position, height) {
  const root = new THREE.Group();
  root.position.set(...position);
  return {
    item: { id, name: 'Turntable', source: { kind: 'catalog', id: 'stand' } },
    runtime: {
      kind: 'component',
      root,
      component: {
        body: 'static',
        colliders: [{ shape: 'box', size: [1.6, height, 1.6], position: [0, height / 2, 0] }],
        anchors: { surface: { type: 'surface', position: [0, height, 0], direction: [0, 1, 0], size: [1.6, 1.6] } },
      },
    },
  };
}

function scene(program, { pallets = [[3, 0, 0]], extra = [] } = {}) {
  const entries = [
    catalogItem('worker', 'worker', { position: [0, 0, 0] }),
    ...pallets.map((position, index) => catalogItem(`pallet${index + 1}`, 'pallet', { name: index ? `Pallet ${index + 1}` : 'Pallet', position, params: { length: 1.2, width: 1.0 } })),
    // Two boxes on the first pallet.
    ...[-0.25, 0.25].map((z, index) => catalogItem(`box${index + 1}`, 'box', {
      position: [pallets[0][0], 0.144, pallets[0][2] + z],
      params: { length: BOX.length, width: BOX.width, height: BOX.height },
    })),
    catalogItem('bay', 'floor_marking', { name: 'Bay', position: [3, 0, 5] }),
    ...extra,
  ];
  entries[0].item.program = program;
  const root = new THREE.Group();
  const items = entries.map(({ item }) => item);
  const runtimes = new Map(entries.map(({ item, runtime }) => [item.id, runtime]));
  runtimes.forEach((runtime, id) => {
    runtime.id = id;
    runtime.root.userData.sceneItemId = id;
    root.add(runtime.root);
  });
  root.updateMatrixWorld(true);
  const editor = { root, items, runtimes, document: { items }, item: (id) => items.find((item) => item.id === id) };
  return { editor };
}

async function play({ editor }, { seconds = 60, until = (runner) => runner.finished || runner.error } = {}) {
  const simulation = new Simulation(editor);
  await simulation.start();
  const dt = 1 / 60;
  for (let time = 0; time < 0.5; time += dt) simulation.step(dt);
  const runner = new WorkerRunner({ editor, simulation, itemId: 'worker' });
  runner.start();
  for (let time = 0; time < seconds && !until(runner); time += dt) {
    runner.update(dt);
    for (let tick = 0; tick < 12; tick += 1) await Promise.resolve();
    simulation.step(dt);
  }
  return { simulation, runner };
}

const at = (editor, id) => editor.runtimes.get(id).root.getWorldPosition(new THREE.Vector3());

describe('a worker with a pallet jack', () => {
  it('takes a loaded pallet to a bay, puts it down and walks back', async () => {
    const world = scene({ loop: false, steps: movePalletSteps({ pallet: 'pallet1', to: { kind: 'item', item: 'bay' } }) });
    const { runner, simulation } = await play(world);
    expect(runner.error).toBeNull();
    expect(runner.finished).toBe(true);
    const pallet = at(world.editor, 'pallet1');
    expect(pallet.x).toBeCloseTo(3, 1);
    expect(pallet.z).toBeCloseTo(5, 1);
    expect(pallet.y).toBeCloseTo(0, 2);
    // The boxes came along and still stand on it.
    ['box1', 'box2'].forEach((id) => {
      const box = at(world.editor, id);
      expect(Math.hypot(box.x - 3, box.z - 5)).toBeLessThan(0.6);
      expect(box.y).toBeGreaterThan(0.1);
      expect(box.y).toBeLessThan(0.2);
    });
    expect(simulation.boxesOn('pallet1')).toHaveLength(2);
    // Back where it started, facing the same way.
    const worker = world.editor.runtimes.get('worker').root;
    expect(worker.position.length()).toBeLessThan(0.01);
    expect(new THREE.Vector3(1, 0, 0).applyQuaternion(worker.quaternion).x).toBeCloseTo(1, 3);
    simulation.stop();
  }, 60000);

  it('puts a pallet down on a low surface it is taken to', async () => {
    const world = scene({
      loop: false,
      steps: [newStep('pick-pallet', { pallet: 'pallet1' }), newStep('go-to', { target: { kind: 'item', item: 'table' } }), newStep('put-down')],
    }, { extra: [stand('table', [-3, 0, 2], 0.15)] });
    const { runner, simulation } = await play(world);
    expect(runner.error).toBeNull();
    const pallet = at(world.editor, 'pallet1');
    expect(pallet.x).toBeCloseTo(-3, 1);
    expect(pallet.z).toBeCloseTo(2, 1);
    expect(pallet.y).toBeCloseTo(0.15, 2);
    simulation.stop();
  }, 60000);

  it('waits until a pallet has enough boxes on it', async () => {
    const world = scene({ loop: false, steps: [newStep('wait-load', { pallet: 'pallet1', count: 3 })] });
    const { runner, simulation } = await play(world, { seconds: 2 });
    expect(runner.finished).toBe(false);
    expect(runner.status).toMatch(/Waiting for 3 boxes on Pallet/);
    simulation.stop();
  });

  it('says what is wrong when putting down nothing', async () => {
    const world = scene({ loop: false, steps: [newStep('put-down')] });
    const { runner, simulation } = await play(world, { seconds: 1 });
    expect(runner.error.message).toMatch(/isn't carrying a pallet/);
    simulation.stop();
  });

  it('numbers the pallets when there are several', () => {
    const { editor } = scene(null, { pallets: [[3, 0, 0], [6, 0, 0]] });
    expect(palletChoices(editor).map((choice) => choice.label)).toEqual(['Pallet 1', 'Pallet 2']);
    const single = scene(null);
    expect(palletChoices(single.editor).map((choice) => choice.label)).toEqual(['Pallet']);
  });
});
