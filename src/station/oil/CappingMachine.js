import * as THREE from 'three';
import { addMesh, box, cylinder, cylinderBetween, group, roundedBox } from './OilGeometry.js';
import { buildPortalFrame } from './FillingMachine.js';

const FRAME_HALF_X = 0.85;
const FRAME_HALF_Z = 0.5;
const CABINET_BOTTOM = 2.05;
const CABINET_HEIGHT = 0.36;
const PLATE_Y = 0.42;
/** Height inside the chuck sleeve where a freshly fed cap waits before sliding down. */
const CAP_FEED_OFFSET = 0.06;

/**
 * Four-spindle servo capper. The CappingHead group carries four chucks
 * (Chuck_01..04); each chuck holds a cap at its origin. Head origin = cap centre.
 */
export function createCappingMachine({ materials, centerX, chuckXs, capSeatY, stroke, createCap }) {
  const root = group(null, 'CappingMachine', [centerX, 0, 0]);
  buildPortalFrame(root, materials, { halfX: FRAME_HALF_X, halfZ: FRAME_HALF_Z, top: CABINET_BOTTOM, guardBottom: 0.98 });

  const cabinet = group(root, 'ControlCabinet');
  roundedBox(cabinet, [FRAME_HALF_X * 2 + 0.16, CABINET_HEIGHT, FRAME_HALF_Z * 2 + 0.12], [0, CABINET_BOTTOM + CABINET_HEIGHT / 2, 0], materials.brushed, 'Cabinet housing', 0.03);
  box(cabinet, [1.5, 0.26, 0.006], [0, CABINET_BOTTOM + CABINET_HEIGHT / 2, FRAME_HALF_Z + 0.062], materials.stainless, 'Access door');
  roundedBox(cabinet, [0.28, 0.07, 0.008], [-0.45, CABINET_BOTTOM + CABINET_HEIGHT / 2, FRAME_HALF_Z + 0.067], materials.frameDark, 'Name plate', 0.004);

  // Two pneumatic lift cylinders hanging from the cabinet.
  const lift = group(root, 'LiftCylinders');
  [-0.62, 0.62].forEach((x) => {
    cylinder(lift, 0.045, 0.3, [x, CABINET_BOTTOM - 0.15, 0], materials.aluminium, 'Cylinder barrel', { segments: 24 });
    cylinder(lift, 0.05, 0.03, [x, CABINET_BOTTOM - 0.3, 0], materials.frameDark, 'Cylinder end cap', { segments: 24 });
  });

  const head = group(root, 'CappingHead', [0, capSeatY + stroke, 0]);
  const localXs = chuckXs.map((x) => x - centerX);
  const halfSpan = Math.max(...localXs.map((x) => Math.abs(x))) + 0.1;
  roundedBox(head, [Math.max(halfSpan * 2, 1.4), 0.06, 0.22], [0, PLATE_Y, 0], materials.stainless, 'Head plate', 0.015);
  [-0.62, 0.62].forEach((x) => {
    cylinder(head, 0.018, 0.45, [x, PLATE_Y + 0.03 + 0.225, 0], materials.chrome, 'Piston rod', { segments: 16 });
  });

  const chucks = localXs.map((x, index) => {
    const spindle = group(head, `Spindle_0${index + 1}`, [x, 0, 0]);
    cylinder(spindle, 0.036, 0.14, [0, PLATE_Y + 0.1, 0], materials.frameDark, 'Servo motor', { segments: 24 });
    cylinder(spindle, 0.038, 0.02, [0, PLATE_Y + 0.17, 0], materials.brushed, 'Encoder cover', { segments: 24 });
    cylinder(spindle, 0.012, PLATE_Y - 0.09, [0, (PLATE_Y + 0.09) / 2, 0], materials.chrome, 'Spindle shaft', { segments: 16 });

    const chuck = group(spindle, `Chuck_0${index + 1}`);
    cylinder(chuck, 0.036, 0.09, [0, 0.037, 0], materials.stainless, 'Chuck sleeve', { segments: 28 });
    addMesh(chuck, new THREE.TorusGeometry(0.033, 0.005, 8, 28).rotateX(Math.PI / 2), materials.rubber, 'Grip insert', [0, -0.006, 0]);
    // Flats on the sleeve make the tightening rotation visible.
    box(chuck, [0.01, 0.06, 0.074], [0, 0.045, 0], materials.brushed, 'Chuck flat');
    return { chuck, cap: null };
  });

  function loadCap(entry) {
    entry.cap = createCap();
    entry.cap.position.y = CAP_FEED_OFFSET;
    entry.chuck.add(entry.cap);
  }
  chucks.forEach((entry) => {
    loadCap(entry);
    entry.cap.position.y = 0;
  });

  // Cap supply: elevated vibratory bowl with a gravity chute into the cabinet.
  const feeder = group(root, 'CapFeeder', [0.55, 0, -1.25]);
  cylinder(feeder, 0.05, 2.2, [0, 1.1, 0], materials.stainless, 'Feeder column', { segments: 20 });
  roundedBox(feeder, [0.4, 0.02, 0.4], [0, 0.01, 0], materials.brushed, 'Feeder base', 0.005);
  cylinder(feeder, 0.16, 0.14, [0, 2.27, 0], materials.motor, 'Vibratory drive', { segments: 28 });
  const bowlProfile = [
    new THREE.Vector2(0.0, 0),
    new THREE.Vector2(0.24, 0),
    new THREE.Vector2(0.27, 0.04),
    new THREE.Vector2(0.28, 0.16),
    new THREE.Vector2(0.27, 0.16),
    new THREE.Vector2(0.26, 0.05),
    new THREE.Vector2(0.23, 0.012),
    new THREE.Vector2(0.0, 0.012),
  ];
  const bowlMaterial = materials.stainless.clone();
  bowlMaterial.side = THREE.DoubleSide;
  addMesh(feeder, new THREE.LatheGeometry(bowlProfile, 40), bowlMaterial, 'Feeder bowl', [0, 2.34, 0]);
  for (let index = 0; index < 18; index += 1) {
    const angle = index * 2.4;
    const radius = 0.06 + (index % 6) * 0.03;
    const cap = createCap();
    cap.position.set(Math.cos(angle) * radius, 2.37 + (index % 3) * 0.012, Math.sin(angle) * radius);
    cap.rotation.set(index % 2 ? 0.3 : 0, angle, index % 3 ? 0.2 : 0);
    feeder.add(cap);
  }
  const chuteStart = [0.2, 2.42, 0.18];
  const chuteEnd = [-0.55, CABINET_BOTTOM + CABINET_HEIGHT - 0.02, 1.25 - FRAME_HALF_Z - 0.06];
  [-0.035, 0.035].forEach((offset) => {
    cylinderBetween(feeder, [chuteStart[0], chuteStart[1], chuteStart[2] + offset], [chuteEnd[0], chuteEnd[1], chuteEnd[2] + offset], 0.006, materials.stainless, 'Chute rail');
  });

  return {
    root,
    head,
    chucks,
    /** Cap centre height of the head (station space). */
    setHeadY(y) {
      head.position.y = y;
    },
    getHeadY() {
      return head.position.y;
    },
    setChuckRotation(angle) {
      chucks.forEach(({ chuck }) => { chuck.rotation.y = angle; });
    },
    /** Detaches the gripped caps (caller re-parents them onto the cans). */
    releaseCaps() {
      return chucks.map((entry) => {
        const { cap } = entry;
        entry.cap = null;
        return cap;
      });
    },
    /** Starts a fresh cap in every empty chuck, hidden inside the sleeve. */
    feedCaps() {
      chucks.forEach((entry) => { if (!entry.cap) loadCap(entry); });
    },
    /** 0 → cap inside the sleeve, 1 → cap seated in the chuck jaws. */
    setFeedProgress(progress) {
      chucks.forEach(({ cap }) => { if (cap) cap.position.y = CAP_FEED_OFFSET * (1 - progress); });
    },
    reset() {
      chucks.forEach((entry) => {
        if (entry.cap) entry.cap.removeFromParent();
        entry.cap = null;
        loadCap(entry);
        entry.cap.position.y = 0;
        entry.chuck.rotation.y = 0;
      });
      head.position.y = capSeatY + stroke;
    },
  };
}
