import * as THREE from 'three';
import { box, cylinder, group, roundedBox } from '../oil/OilGeometry.js';
import { createLampMaterial, setLamp } from '../oil/OilMaterials.js';

const BEAM_OFFSET_X = 0.26;
const MAST_LENGTH = 1.25;
const FINGER_OPEN = 0.045;
const FINGER_CLOSED = 0.0235;

/** Pneumatic parallel gripper that hooks under a jerry-can handle grip. Origin = grip centre. */
function createHandleGripper(parent, materials, index) {
  const unit = group(parent, `Gripper_0${index + 1}`);
  roundedBox(unit, [0.07, 0.05, 0.1], [0, 0.08, 0], materials.aluminium, 'Gripper body', 0.01);
  roundedBox(unit, [0.05, 0.05, 0.06], [0, 0.13, 0], materials.frameDark, 'Rail carriage', 0.008);
  cylinder(unit, 0.005, 0.03, [0.03, 0.09, 0.03], materials.airLine, 'Air fitting', { axis: 'x', segments: 10 });
  const fingers = [-1, 1].map((side) => {
    const finger = group(unit, side > 0 ? 'Finger front' : 'Finger rear', [0, 0, side * FINGER_OPEN]);
    roundedBox(finger, [0.05, 0.075, 0.008], [0, 0.0175, 0], materials.stainless, 'Finger plate', 0.003);
    // Lip that hooks under the handle grip when closed.
    box(finger, [0.05, 0.005, 0.006], [0, -0.017, -side * 0.007], materials.rubber, 'Finger lip');
    return { finger, side };
  });
  return {
    unit,
    /** 0 = open, 1 = closed on the handle. */
    setClosed(closed) {
      const z = THREE.MathUtils.lerp(FINGER_OPEN, FINGER_CLOSED, closed);
      fingers.forEach(({ finger, side }) => { finger.position.z = side * z; });
    },
  };
}

/**
 * Two-axis Cartesian case-packing robot. The carriage travels along Z on twin
 * beams; the vertical axis lowers the GripperHead. Four handle grippers sit on
 * a pitch-change rail so the 2×2 group can be collapsed from conveyor lane
 * spacing to carton spacing in flight.
 *
 * `gripXs` are the gripper X offsets of one row; `setPitch` sets the Z distance between rows.
 */
export function createPickAndPlaceRobot({ materials, x, columnZ, beamY, gripXs, homeZ, homeY }) {
  const root = group(null, 'PickAndPlaceRobot', [x, 0, 0]);

  const frame = group(root, 'GantryFrame');
  const postTop = beamY - 0.09;
  [-1, 1].forEach((sz) => {
    [-1, 1].forEach((sx) => {
      roundedBox(frame, [0.12, postTop, 0.12], [sx * BEAM_OFFSET_X, postTop / 2, sz * columnZ], materials.frame, 'Column', 0.015);
      roundedBox(frame, [0.26, 0.02, 0.26], [sx * BEAM_OFFSET_X, 0.01, sz * columnZ], materials.brushed, 'Column base plate', 0.004);
    });
    roundedBox(frame, [BEAM_OFFSET_X * 2 + 0.12, 0.1, 0.12], [0, postTop - 0.05, sz * columnZ], materials.frame, 'End tie', 0.012);
    roundedBox(frame, [BEAM_OFFSET_X * 2, 0.08, 0.08], [0, 0.45, sz * columnZ], materials.frame, 'Lower tie', 0.01);
  });
  [-1, 1].forEach((sx) => {
    roundedBox(frame, [0.12, 0.18, columnZ * 2 + 0.12], [sx * BEAM_OFFSET_X, beamY, 0], materials.aluminium, sx > 0 ? 'Z beam right' : 'Z beam left', 0.012);
    roundedBox(frame, [0.03, 0.02, columnZ * 2], [sx * (BEAM_OFFSET_X - 0.045), beamY + 0.1, 0], materials.chrome, 'Linear rail', 0.004);
  });
  // Cable carrier lying on the right beam.
  roundedBox(frame, [0.09, 0.05, columnZ * 1.1], [BEAM_OFFSET_X, beamY + 0.115, columnZ * 0.42], materials.plasticBlack, 'Cable carrier', 0.012);
  [-1, 1].forEach((sz) => {
    roundedBox(frame, [0.1, 0.12, 0.08], [0, beamY + 0.15, sz * (columnZ - 0.05)], materials.safetyYellow, 'End stop', 0.01);
  });

  // Status beacon on the gantry.
  const beacon = createLampMaterial(0x2ecc59);
  const beaconIdle = createLampMaterial(0xf2a516);
  cylinder(frame, 0.012, 0.12, [BEAM_OFFSET_X, beamY + 0.15, -columnZ], materials.stainless, 'Beacon pole', { segments: 10 });
  const beaconLamp = cylinder(frame, 0.04, 0.08, [BEAM_OFFSET_X, beamY + 0.25, -columnZ], beaconIdle, 'Beacon lamp', { segments: 24 });

  // Carriage on the beams.
  const carriage = group(root, 'Carriage', [0, beamY, homeZ]);
  roundedBox(carriage, [BEAM_OFFSET_X * 2 + 0.16, 0.04, 0.34], [0, 0.13, 0], materials.brushed, 'Carriage plate', 0.01);
  [-1, 1].forEach((sx) => {
    roundedBox(carriage, [0.08, 0.05, 0.14], [sx * (BEAM_OFFSET_X - 0.045), 0.135 - 0.02, 0], materials.frameDark, 'Rail block', 0.008);
  });
  cylinder(carriage, 0.07, 0.2, [0.12, 0.27, 0.08], materials.frameDark, 'Z servo motor', { segments: 24 });
  cylinder(carriage, 0.065, 0.2, [-0.12, 0.27, 0.08], materials.frameDark, 'Y servo motor', { segments: 24 });
  roundedBox(carriage, [0.2, 0.3, 0.2], [0, 0, 0], materials.brushed, 'Vertical guide housing', 0.02);

  // Vertical axis: mast slides through the carriage housing; head hangs below.
  const vertical = group(root, 'VerticalAxis', [0, homeY, homeZ]);
  roundedBox(vertical, [0.12, MAST_LENGTH, 0.12], [0, 0.2 + MAST_LENGTH / 2, 0], materials.aluminium, 'Mast profile', 0.012);
  roundedBox(vertical, [0.02, MAST_LENGTH, 0.04], [0.07, 0.2 + MAST_LENGTH / 2, 0], materials.chrome, 'Mast rail', 0.004);

  const head = group(vertical, 'GripperHead');
  roundedBox(head, [0.6, 0.04, 0.46], [gripXs.reduce((a, b) => a + b, 0) / gripXs.length, 0.2, 0], materials.stainless, 'Head plate', 0.012);
  roundedBox(head, [0.18, 0.04, 0.18], [0, 0.18 + 0.04, 0], materials.brushed, 'Mast flange', 0.01);
  const railCenterX = gripXs.reduce((a, b) => a + b, 0) / gripXs.length;
  [-1, 1].forEach((sx) => {
    roundedBox(head, [0.03, 0.02, 0.44], [railCenterX + sx * 0.2, 0.17, 0], materials.chrome, 'Pitch rail', 0.004);
  });
  cylinder(head, 0.035, 0.12, [railCenterX + 0.25, 0.24, 0.12], materials.frameDark, 'Pitch servo', { segments: 20 });

  // Grippers: order = row (rear, front) × X; positions set by setPitch().
  const grippers = [];
  [-1, 1].forEach((row) => {
    gripXs.forEach((gx) => {
      const gripper = createHandleGripper(head, materials, grippers.length);
      gripper.row = row;
      gripper.unit.position.x = gx;
      grippers.push(gripper);
    });
  });

  return {
    root,
    carriage,
    vertical,
    head,
    grippers,
    /** Gripper-origin height (handle grip centre) in station space. */
    setY(y) {
      vertical.position.y = y;
    },
    getY() {
      return vertical.position.y;
    },
    setZ(z) {
      carriage.position.z = z;
      vertical.position.z = z;
    },
    getZ() {
      return carriage.position.z;
    },
    /** Row spacing along Z (centre to centre). */
    setPitch(pitch) {
      grippers.forEach((gripper) => { gripper.unit.position.z = gripper.row * pitch / 2; });
    },
    setGrip(closed) {
      grippers.forEach((gripper) => gripper.setClosed(closed));
    },
    setBeacon(running) {
      beaconLamp.material = running ? beacon : beaconIdle;
      setLamp(beacon, running, 1.6);
      setLamp(beaconIdle, !running, 1.4);
    },
    /** World-space gripper origins (for hand-over checks). */
    getGripperWorld(index) {
      return grippers[index].unit.getWorldPosition(new THREE.Vector3());
    },
  };
}
