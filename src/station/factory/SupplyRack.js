import * as THREE from 'three';
import { canvasTexture, group, roundedBox } from '../station-1/OilGeometry.js';

const UPRIGHT = new THREE.MeshStandardMaterial({ color: 0x1f4f8f, metalness: 0.35, roughness: 0.5 });
const BEAM = new THREE.MeshStandardMaterial({ color: 0xe0662a, metalness: 0.3, roughness: 0.5 });
const DECK = new THREE.MeshStandardMaterial({ color: 0x8e979c, metalness: 0.7, roughness: 0.4 });

function isRendered(object, root) {
  for (let node = object; node && node !== root; node = node.parent) if (!node.visible) return false;
  return true;
}

/**
 * Stock of identical items drawn with one InstancedMesh per template part, so
 * a rack of 100+ cans costs a dozen draw calls. Taking an item hides the last
 * instance (slots are ordered so the last one is the most accessible).
 */
export function createInstancedStock({ name, template, slots }) {
  const root = group(null, name);
  template.updateMatrixWorld(true);
  const inverse = template.matrixWorld.clone().invert();
  const parts = [];
  template.traverse((object) => {
    if (!object.isMesh || !isRendered(object, template)) return;
    const local = inverse.clone().multiply(object.matrixWorld);
    const mesh = new THREE.InstancedMesh(object.geometry, object.material, slots.length);
    mesh.name = `${name} · ${object.name}`;
    mesh.castShadow = object.castShadow;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    mesh.renderOrder = object.renderOrder;
    slots.forEach((slot, index) => mesh.setMatrixAt(index, slot.clone().multiply(local)));
    mesh.instanceMatrix.needsUpdate = true;
    root.add(mesh);
    parts.push(mesh);
  });
  let remaining = slots.length;
  const apply = () => parts.forEach((mesh) => { mesh.count = remaining; });
  return {
    root,
    capacity: slots.length,
    get remaining() {
      return remaining;
    },
    take() {
      if (remaining === 0) return false;
      remaining -= 1;
      apply();
      return true;
    },
    refill() {
      remaining = slots.length;
      apply();
    },
  };
}

/**
 * Selective pallet-rack frame: blue uprights, orange step beams and wire decks.
 * Origin = centre of the footprint on the floor; length along X, depth along Z.
 */
export function createRackFrame({ name, length, depth, deckHeights, height, bays = 1 }) {
  const root = group(null, name);
  const bayLength = length / bays;
  for (let bay = 0; bay <= bays; bay += 1) {
    const x = -length / 2 + bay * bayLength;
    [-1, 1].forEach((side) => {
      roundedBox(root, [0.07, height, 0.07], [x, height / 2, side * depth / 2], UPRIGHT, 'Upright', 0.008);
      roundedBox(root, [0.16, 0.012, 0.16], [x, 0.006, side * depth / 2], UPRIGHT, 'Base plate', 0.003);
    });
    for (let y = 0.35; y < height - 0.1; y += 0.5) {
      roundedBox(root, [0.03, 0.03, depth], [x, y, 0], UPRIGHT, 'Frame brace', 0.005);
    }
  }
  deckHeights.forEach((deckY) => {
    [-1, 1].forEach((side) => {
      roundedBox(root, [length, 0.1, 0.05], [0, deckY - 0.05, side * depth / 2], BEAM, 'Step beam', 0.008);
    });
    roundedBox(root, [length - 0.04, 0.02, depth - 0.02], [0, deckY - 0.01, 0], DECK, 'Wire deck', 0.004);
  });
  return root;
}

/** Double-sided sign board on a post. Origin on the floor at the post. */
export function createSign({ title, subtitle = '', accent = '#e0a521', height = 3.1, width = 2.2, materials }) {
  const root = group(null, `Sign: ${title}`);
  const texture = canvasTexture(1024, 300, (context, w, h) => {
    context.fillStyle = '#16232b';
    context.fillRect(0, 0, w, h);
    context.fillStyle = accent;
    context.fillRect(0, 0, 18, h);
    context.fillStyle = '#eef3f5';
    context.font = 'bold 92px Arial, sans-serif';
    context.fillText(title, 52, 140);
    context.fillStyle = '#9fb4c0';
    context.font = '54px Arial, sans-serif';
    context.fillText(subtitle, 52, 232);
  });
  const face = new THREE.MeshStandardMaterial({ map: texture, roughness: 0.6, metalness: 0.1, side: THREE.DoubleSide });
  roundedBox(root, [0.07, height, 0.07], [0, height / 2, 0], materials.frame, 'Sign post', 0.01);
  const board = new THREE.Mesh(new THREE.PlaneGeometry(width, width * 300 / 1024), face);
  board.name = 'Sign board';
  board.position.set(0, height + 0.05, 0.04);
  root.add(board);
  return root;
}
