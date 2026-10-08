import * as THREE from 'three';

// Small helpers shared by the catalog components.

export function mesh(geometry, material, name, parent) {
  const object = new THREE.Mesh(geometry, material);
  object.name = name;
  object.castShadow = true;
  object.receiveShadow = true;
  parent?.add(object);
  return object;
}

export function box(parent, size, position, material, name) {
  const object = mesh(new THREE.BoxGeometry(...size), material, name, parent);
  object.position.set(...position);
  return object;
}

export function standard(color, { metalness = 0.3, roughness = 0.6, ...rest } = {}) {
  return new THREE.MeshStandardMaterial({ color, metalness, roughness, ...rest });
}

// Frees the geometry and materials a component created itself.
export function disposeObject(root) {
  root.traverse((child) => {
    if (!child.isMesh && !child.isLine) return;
    child.geometry?.dispose();
    [child.material].flat().forEach((material) => material?.dispose());
  });
}

// A named point other items can snap to (phase 2c). Coordinates are in the item's own frame.
//   type: 'flow-in' | 'flow-out' (conveyor ends), 'surface' (things sit on it),
//         'tool-mount' (a tool's mounting face), 'tool-tip' (a tool's working point)
export function anchor(type, position, direction = [0, 1, 0], extra = {}) {
  return { type, position, direction, ...extra };
}

// A box that blocks falling objects (phase 2e), in the item's own frame.
export function collider(size, position, extra = {}) {
  return { shape: 'box', size, position, ...extra };
}

export const number = (label, value, { min, max, step, unit } = {}) => ({ label, type: 'number', default: value, min, max, step, unit });
export const choice = (label, value, options) => ({ label, type: 'select', default: value, options });
export const toggle = (label, value) => ({ label, type: 'boolean', default: value });
