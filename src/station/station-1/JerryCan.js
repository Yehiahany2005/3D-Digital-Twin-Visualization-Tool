import * as THREE from 'three';
import { addMesh, group, roundedBoxGeometry } from './OilGeometry.js';

/** Ribbed screw-cap geometry: alternating radius gives moulded grip ribs. */
function createRibbedCapGeometry(radius, height) {
  const segments = 48;
  const geometry = new THREE.CylinderGeometry(radius, radius, height, segments, 1);
  const position = geometry.getAttribute('position');
  for (let index = 0; index < position.count; index += 1) {
    const x = position.getX(index);
    const z = position.getZ(index);
    const length = Math.hypot(x, z);
    if (length < radius * 0.99) continue;
    const angle = Math.atan2(z, x);
    const rib = Math.round(((angle + Math.PI) / (Math.PI * 2)) * segments) % 2 === 0 ? 1.045 : 1;
    position.setXYZ(index, x * rib, position.getY(index), z * rib);
  }
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * Cap factory. Each cap is a Group whose origin is the cap centre, so a
 * capping chuck can carry it and then hand it over to a can.
 */
export function createCapFactory(definition, materials) {
  const { capRadius, capHeight } = definition;
  const geometries = {
    shell: createRibbedCapGeometry(capRadius, capHeight),
    top: new THREE.CylinderGeometry(capRadius * 0.86, capRadius * 0.92, 0.004, 32),
    tamperRing: new THREE.TorusGeometry(capRadius * 0.98, 0.0022, 8, 32).rotateX(Math.PI / 2),
  };
  return () => {
    const cap = group(null, 'Cap');
    addMesh(cap, geometries.shell, materials.cap, 'Cap shell');
    addMesh(cap, geometries.top, materials.cap, 'Cap top', [0, capHeight / 2 + 0.001, 0]);
    addMesh(cap, geometries.tamperRing, materials.cap, 'Tamper ring', [0, -capHeight / 2 + 0.002, 0]);
    return cap;
  };
}

/**
 * HDPE 20 L lubricant jerry can. Origin is the centre of the can base, so it
 * rests directly on the belt. Neck is offset towards +X; handle towards −X.
 * Body is translucent natural HDPE so the rising oil level is visible.
 */
export function createJerryCanFactory(definition, materials) {
  const { length, width, height, cornerRadius, neckOffsetX, neckRadius, neckHeight, capHeight } = definition;
  const oilInset = 0.012;
  const oilBase = 0.012;
  const innerHeight = height - oilBase - cornerRadius;
  const shoulderHeight = 0.012;
  const neckBaseY = height + 0.008;
  const neckTopY = neckBaseY + neckHeight;
  const capSeatY = neckTopY - capHeight / 2 + 0.006;

  const geometries = {
    body: roundedBoxGeometry([length, height, width], cornerRadius, 4).translate(0, height / 2, 0),
    oil: new THREE.BoxGeometry(length - oilInset * 2, 1, width - oilInset * 2).translate(0, 0.5, 0),
    shoulder: new THREE.CylinderGeometry(neckRadius + 0.011, neckRadius + 0.014, shoulderHeight, 28),
    neck: new THREE.CylinderGeometry(neckRadius, neckRadius, neckHeight, 28),
    thread: new THREE.TorusGeometry(neckRadius + 0.001, 0.0018, 6, 28).rotateX(Math.PI / 2),
    handlePost: roundedBoxGeometry([0.03, 0.05, 0.05], 0.009),
    handleGrip: roundedBoxGeometry([0.15, 0.026, 0.038], 0.011),
    label: new THREE.PlaneGeometry(0.17, 0.2),
    foot: roundedBoxGeometry([length - 0.03, 0.008, width - 0.03], 0.003),
  };

  return () => {
    const root = group(null, 'JerryCan');
    const oil = addMesh(root, geometries.oil, materials.oil, 'Oil volume', [0, oilBase, 0], { castShadow: false });
    oil.scale.y = 0.0001;
    oil.visible = false;
    oil.renderOrder = 1;

    const body = addMesh(root, geometries.body, materials.hdpe, 'Can body');
    body.renderOrder = 2;
    addMesh(root, geometries.foot, materials.hdpeSolid, 'Base foot', [0, 0.004, 0]);

    // Printed labels on both broad faces; the +X end stays clear as a level window.
    const labelX = -0.035;
    const labelY = 0.18;
    addMesh(root, geometries.label, materials.label, 'Label front', [labelX, labelY, width / 2 + 0.0015], { castShadow: false });
    const back = addMesh(root, geometries.label, materials.label, 'Label back', [labelX, labelY, -width / 2 - 0.0015], { castShadow: false });
    back.rotation.y = Math.PI;

    const neck = group(root, 'Neck', [neckOffsetX, 0, 0]);
    addMesh(neck, geometries.shoulder, materials.hdpeSolid, 'Neck shoulder', [0, height + shoulderHeight / 2 - 0.002, 0]);
    addMesh(neck, geometries.neck, materials.hdpeSolid, 'Neck', [0, neckBaseY + neckHeight / 2, 0]);
    addMesh(neck, geometries.thread, materials.hdpeSolid, 'Thread 1', [0, neckBaseY + neckHeight * 0.35, 0]);
    addMesh(neck, geometries.thread, materials.hdpeSolid, 'Thread 2', [0, neckBaseY + neckHeight * 0.7, 0]);

    const handle = group(root, 'Handle');
    addMesh(handle, geometries.handlePost, materials.hdpeSolid, 'Handle post rear', [-0.1, height + 0.02, 0]);
    addMesh(handle, geometries.handlePost, materials.hdpeSolid, 'Handle post front', [-0.008, height + 0.02, 0]);
    addMesh(handle, geometries.handleGrip, materials.hdpeSolid, 'Handle grip', [-0.054, height + 0.052, 0]);

    let level = 0;
    return {
      root,
      references: {
        neckTop: new THREE.Vector3(neckOffsetX, neckTopY, 0),
        capSeat: new THREE.Vector3(neckOffsetX, capSeatY, 0),
      },
      cap: null,
      get level() {
        return level;
      },
      /** Fill fraction 0..1 of the usable inner height. */
      setLevel(value) {
        level = THREE.MathUtils.clamp(value, 0, 1);
        oil.visible = level > 0.001;
        oil.scale.y = Math.max(0.0001, level * innerHeight);
      },
      /** Oil surface height above the can base. */
      surfaceY(value = level) {
        return oilBase + value * innerHeight;
      },
    };
  };
}
