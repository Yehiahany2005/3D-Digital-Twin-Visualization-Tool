import * as THREE from 'three';
import { addMesh, box, cylinder, group, roundedBox } from '../station-1/OilGeometry.js';
import { createBeltConveyor } from '../station-1/OilConveyor.js';

const BELT_WIDTH = 0.52;
const PUSHER_PLATE_LENGTH = 0.68;

/**
 * Station 1 → Station 2 can transfer (built in Station 1 local coordinates).
 * Single-file guides keep Station 1's cans in line until two pneumatic side
 * pushers shift consecutive pairs into Station 2's two lanes; a centre
 * divider then keeps the lanes apart into Station 2's infeed tunnel.
 */
export function createCanTransfer({ materials, layout, beltHeight }) {
  const root = group(null, 'CanTransfer_S1_to_S2');
  const belt = createBeltConveyor({
    name: 'TransferBelt',
    start: layout.start,
    end: layout.end,
    beltHeight,
    beltWidth: BELT_WIDTH,
    guideHalfGap: 0.237,
    materials,
  });
  root.add(belt.root);
  const frameZ = BELT_WIDTH / 2 + 0.065;

  // Single-file guides continue Station 1's lane up to the row former.
  const singleFile = group(root, 'SingleFileGuides');
  const guideLength = layout.singleFileGuideEnd - layout.start;
  const guideX = (layout.start + layout.singleFileGuideEnd) / 2;
  const guideZ = layout.canHalfWidth + 0.012;
  [-1, 1].forEach((side) => {
    [0.06, 0.15].forEach((height) => {
      roundedBox(singleFile, [guideLength, 0.03, 0.014], [guideX, beltHeight + height, side * guideZ], materials.guide, 'Single-file rail', 0.005);
    });
    [layout.start + 0.3, layout.singleFileGuideEnd - 0.1].forEach((x) => {
      box(singleFile, [0.02, 0.012, frameZ - guideZ], [x, beltHeight + 0.15, side * (frameZ + guideZ) / 2], materials.stainless, 'Rail arm');
    });
  });

  // Centre lane divider hung from an overhead bridge (cans pass underneath).
  const divider = group(root, 'LaneDivider');
  const dividerLength = layout.end - layout.laneDividerStart;
  roundedBox(divider, [dividerLength, 0.17, 0.012], [layout.laneDividerStart + dividerLength / 2, beltHeight + 0.11, 0], materials.stainless, 'Divider blade', 0.004);
  const bridgeX = layout.laneDividerStart + dividerLength / 2;
  const bridgeTop = beltHeight + 0.5;
  [-1, 1].forEach((side) => {
    roundedBox(divider, [0.04, bridgeTop - beltHeight + 0.02, 0.04], [bridgeX, (beltHeight + bridgeTop) / 2, side * frameZ], materials.stainless, 'Bridge post', 0.006);
  });
  roundedBox(divider, [0.04, 0.04, frameZ * 2 + 0.04], [bridgeX, bridgeTop, 0], materials.stainless, 'Bridge beam', 0.006);
  roundedBox(divider, [0.02, bridgeTop - beltHeight - 0.19, 0.012], [bridgeX, (bridgeTop + beltHeight + 0.19) / 2, 0], materials.stainless, 'Divider hanger', 0.003);

  // Row former: pusher A (operator side, pushes towards −Z) and pusher B (pushes towards +Z).
  const pushers = [1, -1].map((side) => {
    const name = side > 0 ? 'Pusher_A' : 'Pusher_B';
    const pusher = group(root, name, [layout.pusherCenter, 0, 0]);
    const cylinderZ = side * 0.62;
    roundedBox(pusher, [0.12, beltHeight + 0.2, 0.12], [0, (beltHeight + 0.2) / 2, side * 0.78], materials.frame, 'Pusher stand', 0.012);
    roundedBox(pusher, [0.22, 0.02, 0.22], [0, 0.01, side * 0.78], materials.brushed, 'Stand foot', 0.004);
    cylinder(pusher, 0.04, 0.34, [0, beltHeight + 0.25, cylinderZ], materials.aluminium, 'Cylinder barrel', { axis: 'z', segments: 20 });
    cylinder(pusher, 0.045, 0.03, [0, beltHeight + 0.25, side * 0.45], materials.frameDark, 'Rod-end cap', { axis: 'z', segments: 20 });
    // Moving plate + rod; face sits on the plate's inner side.
    const plate = group(pusher, 'PusherPlate');
    roundedBox(plate, [PUSHER_PLATE_LENGTH, 0.1, 0.012], [0, beltHeight + 0.25, side * 0.006], materials.safetyYellow, 'Plate', 0.004);
    box(plate, [PUSHER_PLATE_LENGTH - 0.04, 0.08, 0.004], [0, beltHeight + 0.25, -side * 0.001], materials.rubber, 'Plate pad');
    cylinder(plate, 0.012, 0.5, [0, beltHeight + 0.25, side * 0.26], materials.chrome, 'Piston rod', { axis: 'z', segments: 12 });
    [-0.2, 0.2].forEach((x) => cylinder(plate, 0.008, 0.36, [x, beltHeight + 0.25, side * 0.19], materials.chrome, 'Guide rod', { axis: 'z', segments: 10 }));
    return { side, plate };
  });

  const api = {
    root,
    belt,
    /** Places pusher A (side +1) or B (side −1) with its pushing face at `faceZ`. */
    setPusherFace(side, faceZ) {
      pushers.find((pusher) => pusher.side === side).plate.position.z = faceZ;
    },
    retractPushers() {
      pushers.forEach(({ side }) => api.setPusherFace(side, side * layout.pusherRetracted));
    },
  };
  api.retractPushers();
  return api;
}

/**
 * Station 2 → Station 3 case transfer belt (world space, along z = 0) plus an
 * infeed port on the back of Station 3's box source cabinet.
 */
export function createCaseTransfer({ materials, layout, beltHeight, caseWidth }) {
  const root = group(null, 'CaseTransfer_S2_to_S3');
  const belt = createBeltConveyor({
    name: 'TransferBelt',
    start: layout.start,
    end: layout.end,
    beltHeight,
    beltWidth: BELT_WIDTH,
    guideHalfGap: caseWidth / 2 + 0.012,
    materials,
  });
  root.add(belt.root);

  const port = group(root, 'S3_InfeedPort', [layout.cabinetBackX, 0, 0]);
  const openingY = beltHeight + 0.27;
  const dark = new THREE.MeshStandardMaterial({ color: 0x101316, roughness: 0.95, metalness: 0.1 });
  addMesh(port, new THREE.PlaneGeometry(0.76, 0.56), dark, 'Port opening', [-0.004, openingY, 0], { castShadow: false }).rotation.y = -Math.PI / 2;
  roundedBox(port, [0.04, 0.66, 0.06], [-0.02, openingY, 0.41], materials.safetyYellow, 'Port trim side', 0.006);
  roundedBox(port, [0.04, 0.66, 0.06], [-0.02, openingY, -0.41], materials.safetyYellow, 'Port trim side', 0.006);
  roundedBox(port, [0.04, 0.06, 0.88], [-0.02, openingY + 0.31, 0], materials.safetyYellow, 'Port trim top', 0.006);
  // Short strip curtain stubs above the opening (cases pass below them).
  for (let index = 0; index < 6; index += 1) {
    box(port, [0.004, 0.08, 0.11], [-0.03, openingY + 0.24, -0.3 + index * 0.12], new THREE.MeshStandardMaterial({ color: 0x9fb0b8, transparent: true, opacity: 0.55, roughness: 0.2 }), 'Curtain strip');
  }
  return { root, belt };
}

/** Floor bay marking (yellow outline) — e.g. pallet-jack parking. */
export function createFloorBay({ materials, center, size, name }) {
  const root = group(null, name, [center.x, 0.002, center.z]);
  const [width, depth] = size;
  const strip = (w, d, x, z) => {
    const mesh = addMesh(root, new THREE.PlaneGeometry(w, d), materials.floorLine, 'Bay line', [x, 0, z], { castShadow: false });
    mesh.rotation.x = -Math.PI / 2;
  };
  strip(width, 0.06, 0, -depth / 2);
  strip(width, 0.06, 0, depth / 2);
  strip(0.06, depth, -width / 2, 0);
  strip(0.06, depth, width / 2, 0);
  return root;
}
