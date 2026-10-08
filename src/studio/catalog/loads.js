import * as THREE from 'three';
import { createProceduralPallet } from '../../station/ProceduralPallet.js';
import { createProceduralBox } from '../../station/ProceduralBox.js';
import { anchor, collider, disposeObject, number, toggle } from './shared.js';

// Wooden pallet. Origin: middle of the pallet, on the floor.
export const pallet = {
  id: 'pallet',
  name: 'Pallet',
  category: 'Pallets & boxes',
  description: 'Wooden pallet to stack boxes on',
  icon: 'Layers',
  params: {
    length: number('Length', 2.1, { min: 0.4, max: 3, step: 0.05, unit: 'm' }),
    width: number('Width', 1.5, { min: 0.4, max: 3, step: 0.05, unit: 'm' }),
    height: number('Height', 0.144, { min: 0.08, max: 0.4, step: 0.01, unit: 'm' }),
  },
  build({ length, width, height }) {
    const built = createProceduralPallet({ length, width, height });
    return {
      root: built.root,
      anchors: { surface: anchor('surface', [0, height, 0], [0, 1, 0], { size: [length, width] }) },
      colliders: [collider([length, height, width], [0, height / 2, 0])],
      body: 'static',
      dispose: () => disposeObject(built.root),
    };
  },
};

// Cardboard box. Origin: the middle of its bottom face (so it stands on what it is placed on).
// When the scene plays it falls, rides conveyors and stacks.
export const cardboardBox = {
  id: 'box',
  name: 'Box',
  category: 'Pallets & boxes',
  description: 'Cardboard box; falls and rides conveyors when playing',
  icon: 'Package',
  params: {
    length: number('Length', 0.62, { min: 0.05, max: 2, step: 0.01, unit: 'm' }),
    width: number('Width', 0.42, { min: 0.05, max: 2, step: 0.01, unit: 'm' }),
    height: number('Height', 0.42, { min: 0.05, max: 2, step: 0.01, unit: 'm' }),
    mass: number('Weight', 8, { min: 0.1, max: 500, step: 0.5, unit: 'kg' }),
    loose: toggle('Falls and moves when playing', true),
  },
  build({ length, width, height, mass, loose }) {
    const built = createProceduralBox({ length, width, height });
    const root = new THREE.Group();
    root.name = 'Box';
    built.root.position.y = height / 2;
    root.add(built.root);
    return {
      root,
      anchors: {
        surface: anchor('surface', [0, height, 0], [0, 1, 0], { size: [length, width] }),
        grasp: anchor('grasp', [0, height, 0], [0, 1, 0]),
      },
      colliders: [collider([length, height, width], [0, height / 2, 0])],
      body: loose ? 'dynamic' : 'static',
      mass,
      dispose: () => disposeObject(root),
    };
  },
};

export function createBoxMesh({ length, width, height }) {
  const built = createProceduralBox({ length, width, height });
  return built.root;
}
