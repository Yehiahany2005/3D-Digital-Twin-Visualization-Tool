import * as THREE from 'three';
import { addMesh, box, cylinder, cylinderGeometry, group, roundedBox } from './OilGeometry.js';

const BELT_TILE = 0.5;
const DRUM_RADIUS = 0.045;

/**
 * Flat-belt product conveyor section running along +X from `start` to `end`.
 * Includes side frames, head/tail drums, return rollers, legs with levelling
 * feet, adjustable side guides and an optional gear motor at the discharge end.
 */
export function createBeltConveyor({ name, start, end, beltHeight, beltWidth, guideHalfGap, materials, drive = true }) {
  const length = end - start;
  const root = group(null, name, [(start + end) / 2, 0, 0]);
  const half = length / 2;
  const frameZ = beltWidth / 2 + 0.03;

  // Own belt material so each section scrolls independently.
  const beltMaterial = materials.belt.clone();
  beltMaterial.map = materials.belt.map.clone();
  beltMaterial.map.repeat.set((length - 0.1) / BELT_TILE, 1);
  beltMaterial.map.needsUpdate = true;

  [-1, 1].forEach((side) => {
    roundedBox(root, [length, 0.14, 0.035], [0, beltHeight - 0.06, side * frameZ], materials.aluminium, `Side frame ${side > 0 ? 'front' : 'rear'}`, 0.006);
  });
  box(root, [length - 0.1, 0.012, beltWidth], [0, beltHeight - 0.006, 0], beltMaterial, 'Belt carry side');
  box(root, [length - 0.1, 0.01, beltWidth], [0, beltHeight - 0.095, 0], materials.beltReturn, 'Belt return side');

  const drums = [];
  [-1, 1].forEach((side) => {
    const drum = addMesh(root, cylinderGeometry(DRUM_RADIUS, beltWidth, { axis: 'z', segments: 28 }), materials.beltReturn, side > 0 ? 'Head drum' : 'Tail drum', [side * (half - 0.05), beltHeight - DRUM_RADIUS, 0]);
    drums.push(drum);
    // Visible stainless hub with a flat so drum rotation is readable.
    const hub = group(drum, 'Drum hub');
    [-1, 1].forEach((hubSide) => {
      addMesh(hub, cylinderGeometry(0.022, 0.012, { axis: 'z', segments: 20 }), materials.stainless, 'Hub', [0, 0, hubSide * (frameZ + 0.022)]);
      box(hub, [0.03, 0.006, 0.006], [0.008, 0, hubSide * (frameZ + 0.03)], materials.frameDark, 'Hub key');
    });
    roundedBox(root, [0.07, 0.07, 0.025], [side * (half - 0.05), beltHeight - DRUM_RADIUS, frameZ + 0.03], materials.frameDark, 'Bearing housing front', 0.008);
    roundedBox(root, [0.07, 0.07, 0.025], [side * (half - 0.05), beltHeight - DRUM_RADIUS, -frameZ - 0.03], materials.frameDark, 'Bearing housing rear', 0.008);
  });

  const returnRollers = [];
  const returnCount = Math.max(2, Math.floor(length / 0.9));
  for (let index = 0; index < returnCount; index += 1) {
    const x = -half + 0.35 + (index * (length - 0.7)) / Math.max(returnCount - 1, 1);
    returnRollers.push(addMesh(root, cylinderGeometry(0.025, beltWidth + 0.02, { axis: 'z', segments: 16 }), materials.stainless, `Return roller ${index + 1}`, [x, beltHeight - 0.125, 0]));
  }

  // Legs with levelling feet and bracing.
  const legHeight = beltHeight - 0.13;
  const legCount = Math.max(2, Math.ceil(length / 1.6) + 1);
  for (let index = 0; index < legCount; index += 1) {
    const x = -half + 0.2 + (index * (length - 0.4)) / (legCount - 1);
    [-1, 1].forEach((side) => {
      roundedBox(root, [0.05, legHeight - 0.06, 0.05], [x, 0.06 + (legHeight - 0.06) / 2, side * frameZ], materials.aluminium, `Leg ${index + 1}`, 0.006);
      cylinder(root, 0.012, 0.05, [x, 0.04, side * frameZ], materials.stainless, `Levelling screw ${index + 1}`, { segments: 12 });
      cylinder(root, 0.04, 0.014, [x, 0.007, side * frameZ], materials.rubber, `Levelling foot ${index + 1}`, { segments: 20 });
    });
    roundedBox(root, [0.04, 0.04, frameZ * 2], [x, 0.3, 0], materials.aluminium, `Cross brace ${index + 1}`, 0.005);
  }
  [-1, 1].forEach((side) => {
    roundedBox(root, [length - 0.4, 0.04, 0.04], [0, 0.3, side * frameZ], materials.aluminium, 'Longitudinal brace', 0.005);
  });

  // Adjustable side guides keep cans aligned with the belt centre line.
  const guides = group(root, 'SideGuides');
  [-1, 1].forEach((side) => {
    [0.06, 0.15].forEach((height, railIndex) => {
      roundedBox(guides, [length - 0.12, 0.03, 0.014], [0, beltHeight + height, side * guideHalfGap], materials.guide, `Guide rail ${railIndex + 1}`, 0.005);
    });
    const bracketCount = Math.max(2, Math.ceil(length / 0.8));
    for (let index = 0; index < bracketCount; index += 1) {
      const x = -half + 0.15 + (index * (length - 0.3)) / (bracketCount - 1);
      cylinder(guides, 0.007, 0.21, [x, beltHeight + 0.105, side * (frameZ + 0.006)], materials.stainless, 'Guide post', { segments: 10 });
      [0.06, 0.15].forEach((height) => {
        box(guides, [0.02, 0.012, frameZ - guideHalfGap], [x, beltHeight + height, side * (frameZ + guideHalfGap) / 2], materials.stainless, 'Guide arm');
      });
    }
  });

  if (drive) {
    const motor = group(root, 'GearMotor', [half - 0.05, beltHeight - DRUM_RADIUS, frameZ + 0.11]);
    roundedBox(motor, [0.15, 0.15, 0.11], [0, 0, 0], materials.motor, 'Gearbox', 0.02);
    cylinder(motor, 0.065, 0.26, [-0.2, 0, 0], materials.motor, 'Motor', { axis: 'x', segments: 28 });
    cylinder(motor, 0.067, 0.05, [-0.355, 0, 0], materials.frameDark, 'Fan cover', { axis: 'x', segments: 28 });
    roundedBox(motor, [0.08, 0.05, 0.08], [-0.18, 0.085, 0], materials.motor, 'Terminal box', 0.01);
  }

  let travelled = 0;
  return {
    root,
    start,
    end,
    /** Moves the belt surface by `distance` metres (rollers, drums and belt texture). */
    advance(distance) {
      travelled += distance;
      beltMaterial.map.offset.x = -travelled / BELT_TILE;
      drums.forEach((drum) => { drum.rotation.z = -travelled / DRUM_RADIUS; });
      returnRollers.forEach((roller) => { roller.rotation.z = travelled / 0.025; });
    },
    reset() {
      this.advance(-travelled);
    },
  };
}

/** Sheet-metal tunnel hood over the belt; cans enter/leave the station through it. */
export function createConveyorTunnel({ name, start, end, beltHeight, beltWidth, materials, openSide, clearHeight = 0.58 }) {
  const length = end - start;
  const root = group(null, name, [(start + end) / 2, 0, 0]);
  const innerZ = beltWidth / 2 + 0.07;
  const bottom = beltHeight - 0.16;
  const top = beltHeight + clearHeight;
  const wallHeight = top - bottom;
  [-1, 1].forEach((side) => {
    roundedBox(root, [length, wallHeight, 0.025], [0, bottom + wallHeight / 2, side * innerZ], materials.brushed, 'Side wall', 0.006);
  });
  roundedBox(root, [length + 0.02, 0.025, innerZ * 2 + 0.05], [0, top, 0], materials.brushed, 'Roof', 0.006);
  const closedEnd = openSide > 0 ? -1 : 1;
  roundedBox(root, [0.025, wallHeight, innerZ * 2], [closedEnd * length / 2, bottom + wallHeight / 2, 0], materials.brushed, 'End wall', 0.006);
  // Safety-yellow trim around the product opening.
  const openX = openSide * length / 2;
  roundedBox(root, [0.03, 0.04, innerZ * 2 + 0.06], [openX, top - 0.02, 0], materials.safetyYellow, 'Opening trim top', 0.006);
  [-1, 1].forEach((side) => {
    roundedBox(root, [0.03, wallHeight, 0.04], [openX, bottom + wallHeight / 2, side * (innerZ + 0.005)], materials.safetyYellow, 'Opening trim side', 0.006);
  });
  // Dark interior lining.
  const lining = new THREE.MeshStandardMaterial({ color: 0x15191c, roughness: 0.9, metalness: 0.1, side: THREE.BackSide });
  addMesh(root, new THREE.BoxGeometry(length - 0.01, wallHeight - 0.04, innerZ * 2 - 0.03), lining, 'Interior lining', [0, bottom + wallHeight / 2, 0], { castShadow: false });
  return { root };
}
