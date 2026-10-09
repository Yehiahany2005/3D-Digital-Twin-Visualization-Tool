import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { Simulation } from './Simulation.js';

// A gantry-shaped model: two pillars and a beam across their tops. Its bounding box is a solid
// block 2.4 m wide and 1.7 m tall, but most of that is the empty space under the beam.
function gantry() {
  const root = new THREE.Group();
  const material = new THREE.MeshBasicMaterial();
  const part = (size, position) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material);
    mesh.position.set(...position);
    root.add(mesh);
    return mesh;
  };
  part([0.4, 1.5, 0.4], [-1, 0.75, 0]);
  part([0.4, 1.5, 0.4], [1, 0.75, 0]);
  const beam = part([2.4, 0.2, 0.4], [0, 1.6, 0]);
  return { root, beam };
}

// A scene with the gantry (solid) and cardboard boxes dropped at the given spots.
function scene({ moving = false, drops }) {
  const root = new THREE.Group();
  const model = gantry();
  root.add(model.root);
  model.root.userData.sceneItemId = 'gantry';
  const items = [{ id: 'gantry', solid: true }];
  const runtimes = new Map([['gantry', { kind: 'model', root: model.root, asset: { rig: { joints: moving ? [{ id: 'lift' }] : [] }, animations: [] } }]]);
  drops.forEach((position, index) => {
    const id = `box${index}`;
    const box = new THREE.Group();
    box.position.set(...position);
    box.userData.sceneItemId = id;
    root.add(box);
    items.push({ id });
    runtimes.set(id, {
      kind: 'component',
      root: box,
      component: { body: 'dynamic', mass: 8, colliders: [{ shape: 'box', size: [0.3, 0.3, 0.3], position: [0, 0.15, 0] }] },
    });
  });
  return { editor: { root, items, runtimes }, beam: model.beam };
}

function run(simulation, seconds) {
  for (let time = 0; time < seconds; time += 1 / 60) simulation.step(1 / 60);
}

describe('solid models in the simulation', () => {
  it('collide with their real shape, not their bounding box', async () => {
    const { editor } = scene({ drops: [[0, 0.9, 0], [0, 2.2, 0]] });
    const simulation = new Simulation(editor);
    await simulation.start();
    run(simulation, 3);
    const under = editor.runtimes.get('box0').root.position;
    const onTop = editor.runtimes.get('box1').root.position;
    // Under the beam is empty: the box falls to the floor.
    expect(under.y).toBeLessThan(0.02);
    expect(Math.abs(under.x)).toBeLessThan(0.05);
    // On the beam it rests on the beam's top (1.7 m).
    expect(onTop.y).toBeGreaterThan(1.65);
    expect(onTop.y).toBeLessThan(1.75);
    simulation.stop();
  });

  it('move their colliders with their moving parts', async () => {
    const { editor, beam } = scene({ moving: true, drops: [[0, 2.2, 0]] });
    const simulation = new Simulation(editor);
    await simulation.start();
    run(simulation, 2);
    const box = editor.runtimes.get('box0').root.position;
    expect(box.y).toBeGreaterThan(1.65);
    // The beam goes up 0.5 m: the box resting on it goes up with it.
    for (let step = 1; step <= 50; step += 1) {
      beam.position.y = 1.6 + 0.5 * (step / 50);
      simulation.step(1 / 60);
    }
    run(simulation, 1);
    expect(box.y).toBeGreaterThan(2.15);
    expect(box.y).toBeLessThan(2.25);
    simulation.stop();
  });
});
