import * as THREE from 'three';
import { anchor, box, choice, collider, disposeObject, number, standard } from './shared.js';

// Work table. Origin: middle of the table, on the floor.
export const table = {
  id: 'table',
  name: 'Table',
  category: 'Fixtures',
  description: 'Steel work table',
  icon: 'Square',
  params: {
    length: number('Length', 1.6, { min: 0.3, max: 5, step: 0.05, unit: 'm' }),
    width: number('Width', 0.8, { min: 0.3, max: 3, step: 0.05, unit: 'm' }),
    height: number('Height', 0.9, { min: 0.3, max: 1.5, step: 0.05, unit: 'm' }),
  },
  build({ length, width, height }) {
    const root = new THREE.Group();
    root.name = 'Table';
    const top = standard(0x8e979c, { metalness: 0.7, roughness: 0.35 });
    const steel = standard(0x3a4349, { metalness: 0.75, roughness: 0.35 });
    const thickness = 0.04;
    box(root, [length, thickness, width], [0, height - thickness / 2, 0], top, 'Table top');
    const leg = 0.05;
    [[1, 1], [1, -1], [-1, 1], [-1, -1]].forEach(([sx, sz], index) => {
      box(root, [leg, height - thickness, leg], [sx * (length / 2 - leg), (height - thickness) / 2, sz * (width / 2 - leg)], steel, `Leg ${index + 1}`);
    });
    box(root, [length - leg * 2, 0.04, width - leg * 2], [0, 0.18, 0], steel, 'Lower shelf');
    return {
      root,
      anchors: { surface: anchor('surface', [0, height, 0], [0, 1, 0], { size: [length, width] }) },
      colliders: [collider([length, thickness, width], [0, height - thickness / 2, 0])],
      body: 'static',
      dispose: () => disposeObject(root),
    };
  },
};

// Safety fence panel. Origin: the middle of its bottom edge; the panel runs along X.
export const fence = {
  id: 'fence',
  name: 'Safety fence',
  category: 'Fixtures',
  description: 'Mesh fence panel with posts',
  icon: 'Square',
  params: {
    length: number('Length', 2, { min: 0.3, max: 10, step: 0.1, unit: 'm' }),
    height: number('Height', 2, { min: 0.5, max: 3, step: 0.1, unit: 'm' }),
  },
  build({ length, height }) {
    const root = new THREE.Group();
    root.name = 'Fence';
    const post = standard(0xf2c230, { metalness: 0.3, roughness: 0.5 });
    const frame = standard(0x2c3135, { metalness: 0.6, roughness: 0.4 });
    const meshMaterial = new THREE.MeshStandardMaterial({ color: 0x1f2326, metalness: 0.4, roughness: 0.6, transparent: true, opacity: 0.38, side: THREE.DoubleSide, depthWrite: false });
    const p = 0.06;
    box(root, [p, height, p], [-length / 2, height / 2, 0], post, 'Post');
    box(root, [p, height, p], [length / 2, height / 2, 0], post, 'Post');
    box(root, [length, 0.03, 0.03], [0, height - 0.05, 0], frame, 'Top rail');
    box(root, [length, 0.03, 0.03], [0, 0.15, 0], frame, 'Bottom rail');
    const panel = new THREE.Mesh(new THREE.PlaneGeometry(length - p, height - 0.25), meshMaterial);
    panel.name = 'Mesh';
    panel.position.y = 0.15 + (height - 0.25) / 2;
    root.add(panel);
    // A visible weave: thin lines every 5 cm would be many meshes; a grid of lines is one.
    const lines = [];
    for (let x = -length / 2 + p; x < length / 2 - p / 2; x += 0.05) lines.push(x, 0.15, 0, x, height - 0.05, 0);
    for (let y = 0.15; y < height - 0.05; y += 0.05) lines.push(-length / 2, y, 0, length / 2, y, 0);
    const weave = new THREE.LineSegments(
      new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(lines, 3)),
      new THREE.LineBasicMaterial({ color: 0x15181a, transparent: true, opacity: 0.55 }),
    );
    weave.name = 'Weave';
    root.add(weave);
    return {
      root,
      anchors: {},
      colliders: [collider([length, height, 0.05], [0, height / 2, 0])],
      body: 'static',
      dispose: () => disposeObject(root),
    };
  },
};

// Tape on the floor marking a walkway or a zone. Origin: middle of the rectangle.
const TAPE_COLORS = { yellow: 0xf2c230, white: 0xeeeeee, red: 0xd84b3c, green: 0x3ea65a, blue: 0x2f7fd1 };
export const floorMarking = {
  id: 'floor_marking',
  name: 'Floor marking',
  category: 'Fixtures',
  description: 'Taped rectangle: walkway, zone or parking spot',
  icon: 'Square',
  params: {
    length: number('Length', 3, { min: 0.2, max: 50, step: 0.1, unit: 'm' }),
    width: number('Width', 1.5, { min: 0.2, max: 50, step: 0.1, unit: 'm' }),
    tape: number('Tape width', 0.05, { min: 0.02, max: 0.3, step: 0.01, unit: 'm' }),
    color: choice('Colour', 'yellow', Object.keys(TAPE_COLORS).map((value) => ({ value, label: value[0].toUpperCase() + value.slice(1) }))),
  },
  build({ length, width, tape, color }) {
    const root = new THREE.Group();
    root.name = 'FloorMarking';
    const material = new THREE.MeshStandardMaterial({ color: TAPE_COLORS[color] || TAPE_COLORS.yellow, roughness: 0.7, polygonOffset: true, polygonOffsetFactor: -2 });
    const y = 0.002;
    const strip = (size, position) => {
      const piece = box(root, [size[0], 0.002, size[1]], [position[0], y, position[1]], material, 'Tape');
      piece.castShadow = false;
    };
    strip([length, tape], [0, width / 2 - tape / 2]);
    strip([length, tape], [0, -width / 2 + tape / 2]);
    strip([tape, width - tape * 2], [length / 2 - tape / 2, 0]);
    strip([tape, width - tape * 2], [-length / 2 + tape / 2, 0]);
    return { root, anchors: {}, colliders: [], body: 'none', dispose: () => disposeObject(root) };
  },
};
