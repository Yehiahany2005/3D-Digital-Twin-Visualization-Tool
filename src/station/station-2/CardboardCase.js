import * as THREE from 'three';
import { createProceduralBox } from '../station-3/ProceduralBox.js';
import { addMesh, group } from '../station-1/OilGeometry.js';

/** Erected-case flap angle (rad from closed). */
export const OPEN_ANGLE = THREE.MathUtils.degToRad(110);

/**
 * Cardboard case materials taken from the robot station's own box, so both
 * stations share the exact same cardboard and tape appearance.
 */
export function getCardboardMaterials(boxDefinition) {
  const reference = createProceduralBox(boxDefinition);
  return {
    cardboard: reference.root.getObjectByName('Box body').material,
    tape: reference.root.getObjectByName('Box tape seam').material,
  };
}

/**
 * Regular slotted carton with the same outer size as the Station 3 box
 * (length along X, width along Z, height along Y). Origin = centre of the base.
 * Minor flaps hinge on the end walls, major flaps on the side walls; both
 * start opened outward (erected case) and fold closed after packing.
 * Tape is laid along the major-flap seam by the case taper.
 */
export function createCardboardCaseFactory(definition, materials) {
  const { length, width, height, wall, flap } = definition;
  const wallHeight = height - flap * 2;
  const minorHingeY = wallHeight;
  const majorHingeY = wallHeight + flap;
  const minorDepth = width / 2;
  const majorDepth = width / 2;
  const tapeWidth = 0.05;
  const clipLength = 0.06;

  const geometries = {
    bottom: new THREE.BoxGeometry(length, wall, width),
    side: new THREE.BoxGeometry(length, majorHingeY, wall),
    end: new THREE.BoxGeometry(wall, wallHeight, width - wall * 2),
    minorFlap: new THREE.BoxGeometry(minorDepth, flap, width - wall * 2).translate(-minorDepth / 2, flap / 2, 0),
    majorFlap: new THREE.BoxGeometry(length, flap, majorDepth).translate(0, flap / 2, -majorDepth / 2),
    tapeTop: new THREE.BoxGeometry(1, 0.0012, tapeWidth).translate(0.5, 0, 0),
    tapeClip: new THREE.BoxGeometry(0.0012, clipLength, tapeWidth),
  };

  return () => {
    const root = group(null, 'CardboardCase');
    const body = group(root, 'CaseBody');
    addMesh(body, geometries.bottom, materials.cardboard, 'Case bottom', [0, wall / 2, 0]);
    [-1, 1].forEach((side) => {
      addMesh(body, geometries.side, materials.cardboard, side > 0 ? 'Side wall front' : 'Side wall rear', [0, majorHingeY / 2, side * (width / 2 - wall / 2)]);
      addMesh(body, geometries.end, materials.cardboard, side > 0 ? 'End wall leading' : 'End wall trailing', [side * (length / 2 - wall / 2), wallHeight / 2, 0]);
    });

    // Flap pivots on the hinge lines; geometry extends inward from each hinge.
    const flaps = group(root, 'Flaps');
    const minor = [-1, 1].map((side) => {
      const pivot = group(flaps, side > 0 ? 'Minor flap leading' : 'Minor flap trailing', [side * length / 2, minorHingeY, 0]);
      const mesh = addMesh(pivot, geometries.minorFlap, materials.cardboard, 'Flap');
      if (side < 0) mesh.scale.x = -1;
      return { pivot, side };
    });
    const major = [-1, 1].map((side) => {
      const pivot = group(flaps, side > 0 ? 'Major flap front' : 'Major flap rear', [0, majorHingeY, side * width / 2]);
      const mesh = addMesh(pivot, geometries.majorFlap, materials.cardboard, 'Flap');
      if (side < 0) mesh.scale.z = -1;
      return { pivot, side };
    });

    // Tape strip + L-clips over the end walls, revealed as the taper passes.
    const tape = group(root, 'Tape');
    const tapeTop = addMesh(tape, geometries.tapeTop, materials.tape, 'Tape seam', [0, height + 0.0006, 0], { castShadow: false });
    const leadingClip = addMesh(tape, geometries.tapeClip, materials.tape, 'Tape clip leading', [length / 2 + 0.0006, height - clipLength / 2, 0], { castShadow: false });
    const trailingClip = addMesh(tape, geometries.tapeClip, materials.tape, 'Tape clip trailing', [-length / 2 - 0.0006, height - clipLength / 2, 0], { castShadow: false });

    const contents = group(root, 'Contents');

    const kase = {
      root,
      contents,
      /** 0 = erected open, 1 = folded flat. */
      setMinorFlaps(closed) {
        const angle = OPEN_ANGLE * (1 - closed);
        minor.forEach(({ pivot, side }) => { pivot.rotation.z = -side * angle; });
      },
      setMajorFlaps(closed) {
        const angle = OPEN_ANGLE * (1 - closed);
        major.forEach(({ pivot, side }) => { pivot.rotation.x = side * angle; });
      },
      /**
       * Tape applied from the leading edge back to local X `fromX`
       * (−length/2 = fully taped). Pass null for no tape.
       */
      setTape(fromX) {
        const active = fromX !== null && fromX < length / 2;
        tape.visible = active;
        if (!active) return;
        const start = Math.max(fromX, -length / 2);
        tapeTop.position.x = start;
        tapeTop.scale.x = length / 2 - start;
        leadingClip.visible = true;
        trailingClip.visible = fromX <= -length / 2;
      },
    };
    kase.setMinorFlaps(0);
    kase.setMajorFlaps(0);
    kase.setTape(null);
    return kase;
  };
}
