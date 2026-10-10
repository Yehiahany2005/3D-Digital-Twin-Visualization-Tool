import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { Simulation } from '../Simulation.js';
import { parseDxf } from './dxf.js';
import { FloorPlan } from './FloorPlan.js';
import { line, writeDxf } from './sampleDxf.js';

// A plan in metres with one diagonal wall from (-5, -5) to (5, 5) and a note line beside it.
function diagonalPlan() {
  return new FloorPlan(parseDxf(writeDxf({ insunits: 6, entities: [line('WALLS', -5, -5, 5, 5), line('NOTES', 10, 0, 12, 0)] })));
}

const settings = (walls) => ({ plan: { unit: 'm', hiddenLayers: [], walls: { layers: walls, height: 3, opacity: 0.4 } } });

describe('FloorPlan', () => {
  it('draws to scale on the floor (drawing y is world −z) and raises chosen layers into walls', () => {
    const plan = diagonalPlan();
    plan.setVisualState({ plan: { unit: 'mm', hiddenLayers: [] } });
    plan.root.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(plan.layerObjects.get('WALLS')[0]);
    // 10 m drawn in "mm" is 1 cm.
    expect(box.max.x - box.min.x).toBeCloseTo(0.01, 6);
    plan.setVisualState(settings(['WALLS']));
    expect(plan.body).toBe('static');
    expect(plan.colliders).toHaveLength(1);
    const [wall] = plan.colliders;
    expect(wall.size[0]).toBeCloseTo(Math.hypot(10, 10), 6);
    expect(wall.size[1]).toBe(3);
    // Not raised: no body at all.
    plan.setVisualState(settings([]));
    expect(plan.body).toBe('none');
  });

  it('finds the line under a point, only on shown layers', () => {
    const plan = diagonalPlan();
    plan.setVisualState(settings([]));
    plan.root.updateMatrixWorld(true);
    // The wall passes through world (2, 0, −2); the mirror point (2, 0, 2) is far from it.
    expect(plan.isNear(new THREE.Vector3(2, 0, -2.05), 0.1)).toBe(true);
    expect(plan.isNear(new THREE.Vector3(2, 0, 2), 0.1)).toBe(false);
    expect(plan.isNear(new THREE.Vector3(11, 0, 0), 0.1)).toBe(true);
    plan.setVisualState({ plan: { unit: 'm', hiddenLayers: ['NOTES'] } });
    expect(plan.isNear(new THREE.Vector3(11, 0, 0), 0.1)).toBe(false);
  });

  it('stops a falling box on a raised wall (turned the right way), not on the flat drawing', async () => {
    const plan = diagonalPlan();
    plan.setVisualState(settings(['WALLS']));
    const root = new THREE.Group();
    const planRoot = new THREE.Group();
    planRoot.add(plan.root);
    planRoot.userData.sceneItemId = 'plan';
    root.add(planRoot);
    const items = [{ id: 'plan' }];
    const runtimes = new Map([['plan', { kind: 'plan', root: planRoot, component: plan }]]);
    const boxes = [[2, 6, -2], [2, 6, 2]].map((position, index) => {
      const box = new THREE.Group();
      box.position.set(...position);
      box.userData.sceneItemId = `box${index}`;
      root.add(box);
      items.push({ id: `box${index}` });
      runtimes.set(`box${index}`, { kind: 'component', root: box, component: { body: 'dynamic', mass: 8, colliders: [{ size: [0.3, 0.3, 0.3], position: [0, 0.15, 0] }] } });
      return box;
    });
    const simulation = new Simulation({ root, items, runtimes });
    await simulation.start();
    for (let time = 0; time < 2; time += 1 / 60) simulation.step(1 / 60);
    // On the wall's top (3 m) or nudged off it, but never down through it; the other box on the floor.
    expect(boxes[0].position.y).toBeGreaterThan(2.9);
    expect(boxes[1].position.y).toBeLessThan(0.05);
    simulation.stop();
  });
});
