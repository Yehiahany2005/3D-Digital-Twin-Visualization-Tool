import * as THREE from 'three';
import { createProceduralConveyor } from '../../station/station-3/ProceduralConveyor.js';
import { createProceduralBoxSourceMachine } from '../../station/station-3/ProceduralBoxSourceMachine.js';
import { anchor, box, collider, disposeObject, number, standard, toggle } from './shared.js';

const BELT_THICKNESS = 0.08;

// Belt conveyor. Its origin is the middle of the conveyor on the floor; boxes travel along +X.
export const beltConveyor = {
  id: 'belt_conveyor',
  name: 'Belt conveyor',
  category: 'Conveyors',
  description: 'Moves boxes along when the scene plays',
  icon: 'Layers',
  params: {
    length: number('Length', 4.8, { min: 0.5, max: 40, step: 0.1, unit: 'm' }),
    width: number('Belt width', 1.05, { min: 0.2, max: 3, step: 0.05, unit: 'm' }),
    beltHeight: number('Belt height', 0.82, { min: 0.2, max: 2.5, step: 0.05, unit: 'm' }),
    speed: number('Speed', 0.7, { min: 0, max: 5, step: 0.05, unit: 'm/s' }),
    endStop: toggle('Stop at the end (boxes wait there)', true),
    running: toggle('Running', true),
  },
  build({ length, width, beltHeight, speed, endStop, running }) {
    const conveyor = createProceduralConveyor({
      length,
      width,
      beltHeight,
      beltThickness: BELT_THICKNESS,
      frameHeight: Math.max(0.1, beltHeight - 0.1),
      supportInset: Math.min(0.42, length * 0.12),
      rollerCount: Math.max(2, Math.round(length / 0.37)),
    });
    const { root } = conveyor;
    const stopMaterial = standard(0xd58a27, { metalness: 0.45, roughness: 0.35 });
    if (endStop) box(root, [0.05, 0.12, width + 0.12], [length / 2 + 0.03, beltHeight + 0.06, 0], stopMaterial, 'End stop');
    const half = length / 2;
    return {
      root,
      anchors: {
        input: anchor('flow-in', [-half, beltHeight, 0], [-1, 0, 0]),
        output: anchor('flow-out', [half, beltHeight, 0], [1, 0, 0]),
        surface: anchor('surface', [0, beltHeight, 0], [0, 1, 0], { size: [length, width] }),
      },
      colliders: [
        collider([length, BELT_THICKNESS, width], [0, beltHeight - BELT_THICKNESS / 2, 0], { belt: true }),
        collider([length, 0.12, 0.12], [0, beltHeight + 0.06 - BELT_THICKNESS / 2, width / 2 + 0.06]),
        collider([length, 0.12, 0.12], [0, beltHeight + 0.06 - BELT_THICKNESS / 2, -width / 2 - 0.06]),
        ...(endStop ? [collider([0.05, 0.3, width + 0.12], [half + 0.03, beltHeight + 0.15, 0])] : []),
      ],
      body: 'static',
      // What the simulation needs (phase 2e): boxes on this belt move along +X at `speed`.
      belt: { length, width, top: beltHeight, speed: running ? speed : 0, endStop },
      update(deltaTime, editor) {
        if (!editor?.playing || !running) return;
        const turn = (speed * deltaTime) / 0.045;
        conveyor.rollers.forEach((roller) => { roller.rotation.y -= turn; });
      },
      dispose: () => disposeObject(root),
    };
  },
};

// Infeed machine that puts out boxes. Origin: its opening, on the floor; boxes come out along +X.
export const boxSource = {
  id: 'box_source',
  name: 'Box source',
  category: 'Conveyors',
  description: 'Sends out a box every few seconds',
  icon: 'Package',
  params: {
    interval: number('Every', 6, { min: 0.5, max: 600, step: 0.5, unit: 's' }),
    maxBoxes: number('Stop after', 50, { min: 1, max: 500, step: 1, unit: 'boxes' }),
    boxLength: number('Box length', 0.62, { min: 0.05, max: 2, step: 0.01, unit: 'm' }),
    boxWidth: number('Box width', 0.42, { min: 0.05, max: 2, step: 0.01, unit: 'm' }),
    boxHeight: number('Box height', 0.42, { min: 0.05, max: 2, step: 0.01, unit: 'm' }),
    beltHeight: number('Exit height', 0.82, { min: 0, max: 2.5, step: 0.05, unit: 'm' }),
  },
  build({ interval, maxBoxes, boxLength, boxWidth, boxHeight, beltHeight }) {
    const { root } = createProceduralBoxSourceMachine({
      beltHeight,
      boxHeight,
      openingWidth: boxWidth + 0.22,
      openingHeight: boxHeight + 0.16,
      height: Math.max(1.85, beltHeight + boxHeight + 0.6),
    });
    return {
      root,
      anchors: { output: anchor('flow-out', [0.04, beltHeight, 0], [1, 0, 0]) },
      colliders: [],
      body: 'none',
      // Phase 2e: a new box appears just outside the opening every `interval` seconds.
      source: { interval, maxBoxes, box: { length: boxLength, width: boxWidth, height: boxHeight }, spawn: [0.04 + boxLength / 2 + 0.05, beltHeight + boxHeight / 2 + 0.02, 0] },
      dispose: () => disposeObject(root),
    };
  },
};

// End of the line: boxes that fall or slide into it disappear. Origin: middle of the bin, on the floor.
export const boxRemover = {
  id: 'box_remover',
  name: 'End of line',
  category: 'Conveyors',
  description: 'Takes away boxes that reach it',
  icon: 'Trash2',
  params: {
    length: number('Length', 1.2, { min: 0.3, max: 5, step: 0.05, unit: 'm' }),
    width: number('Width', 1.2, { min: 0.3, max: 5, step: 0.05, unit: 'm' }),
    height: number('Height', 0.7, { min: 0.1, max: 2, step: 0.05, unit: 'm' }),
  },
  build({ length, width, height }) {
    const root = new THREE.Group();
    root.name = 'EndOfLine';
    const wall = standard(0x3b4248, { metalness: 0.6, roughness: 0.4 });
    const rim = standard(0xf2c230, { metalness: 0.3, roughness: 0.5 });
    const t = 0.04;
    box(root, [length, t, width], [0, t / 2, 0], wall, 'Bin floor');
    box(root, [length, height, t], [0, height / 2, width / 2 - t / 2], wall, 'Bin side');
    box(root, [length, height, t], [0, height / 2, -width / 2 + t / 2], wall, 'Bin side');
    box(root, [t, height, width], [length / 2 - t / 2, height / 2, 0], wall, 'Bin end');
    box(root, [t, height, width], [-length / 2 + t / 2, height / 2, 0], wall, 'Bin end');
    box(root, [length + 0.02, 0.03, 0.06], [0, height, width / 2 - t / 2], rim, 'Rim');
    box(root, [length + 0.02, 0.03, 0.06], [0, height, -width / 2 + t / 2], rim, 'Rim');
    return {
      root,
      anchors: { input: anchor('flow-in', [-length / 2, height, 0], [-1, 0, 0]) },
      colliders: [collider([length, t, width], [0, t / 2, 0])],
      body: 'static',
      // Phase 2e: boxes inside this volume are removed.
      sink: { size: [length, height + 0.5, width], center: [0, (height + 0.5) / 2, 0] },
      dispose: () => disposeObject(root),
    };
  },
};
