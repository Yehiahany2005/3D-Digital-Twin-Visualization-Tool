import * as THREE from 'three';
import { addMesh, canvasTexture, cylinder, cylinderBetween, group, roundedBox } from './OilGeometry.js';

function tankPlateTexture() {
  return canvasTexture(512, 256, (context, width, height) => {
    context.fillStyle = '#f3f4f2';
    context.fillRect(0, 0, width, height);
    context.fillStyle = '#e0a521';
    context.fillRect(0, 0, width, 46);
    context.fillStyle = '#1b1f22';
    context.textAlign = 'center';
    context.font = 'bold 34px Arial, sans-serif';
    context.fillText('LUBE OIL SUPPLY', width / 2, 34);
    context.font = 'bold 70px Arial, sans-serif';
    context.fillText('T-101', width / 2, 135);
    context.font = '32px Arial, sans-serif';
    context.fillText('SAE 15W-40 · 800 L', width / 2, 200);
  });
}

/**
 * Vertical stainless oil reservoir on legs with dished head, manway, vent,
 * level sight glass and an outlet cone. Also carries the transfer pump skid.
 * Origin = tank axis on the floor.
 */
export function createOilTank({ materials, radius, height, legHeight }) {
  const root = group(null, 'OilTank');
  const shellBottom = legHeight;
  const shellTop = legHeight + height;

  const shell = group(root, 'Shell');
  cylinder(shell, radius, height, [0, shellBottom + height / 2, 0], materials.stainless, 'Tank shell', { segments: 48 });
  const dome = addMesh(shell, new THREE.SphereGeometry(radius, 48, 16, 0, Math.PI * 2, 0, Math.PI / 2), materials.stainless, 'Dished head', [0, shellTop, 0]);
  dome.scale.y = 0.24;
  cylinder(shell, radius, 0.16, [0, shellBottom - 0.08, 0], materials.stainless, 'Outlet cone', { radiusBottom: 0.06, segments: 48 });
  [0.12, height - 0.12].forEach((y, index) => {
    addMesh(shell, new THREE.TorusGeometry(radius + 0.004, 0.008, 8, 48).rotateX(Math.PI / 2), materials.brushed, `Stiffening ring ${index + 1}`, [0, shellBottom + y, 0]);
  });

  // Legs with gusset pads.
  for (let index = 0; index < 4; index += 1) {
    const angle = Math.PI / 4 + index * (Math.PI / 2);
    const x = Math.cos(angle) * (radius - 0.02);
    const z = Math.sin(angle) * (radius - 0.02);
    roundedBox(root, [0.07, legHeight + 0.12, 0.07], [x, (legHeight + 0.12) / 2, z], materials.stainless, `Leg ${index + 1}`, 0.01);
    roundedBox(root, [0.16, 0.015, 0.16], [x, 0.0075, z], materials.brushed, `Foot plate ${index + 1}`, 0.004);
  }

  // Top fittings: manway, vent and fill line.
  const top = shellTop + radius * 0.24;
  cylinder(root, 0.17, 0.08, [0, top - 0.02, 0], materials.brushed, 'Manway collar', { segments: 32 });
  cylinder(root, 0.19, 0.025, [0, top + 0.03, 0], materials.stainless, 'Manway lid', { segments: 32 });
  for (let index = 0; index < 10; index += 1) {
    const angle = (index / 10) * Math.PI * 2;
    cylinder(root, 0.009, 0.03, [Math.cos(angle) * 0.17, top + 0.05, Math.sin(angle) * 0.17], materials.chrome, 'Lid bolt', { segments: 6 });
  }
  cylinderBetween(root, [0.28, shellTop + 0.02, 0.1], [0.28, shellTop + 0.32, 0.1], 0.025, materials.stainless, 'Vent pipe');
  addMesh(root, new THREE.SphereGeometry(0.04, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), materials.stainless, 'Vent cap', [0.28, shellTop + 0.32, 0.1]);

  // Level sight glass on the front of the shell.
  const sight = group(root, 'LevelSightGlass', [0, 0, radius + 0.05]);
  const sightBottom = shellBottom + 0.1;
  const sightTop = shellTop - 0.1;
  const sightLength = sightTop - sightBottom;
  cylinder(sight, 0.016, sightLength, [0, sightBottom + sightLength / 2, 0], materials.sightGlass, 'Sight tube', { segments: 16 });
  const sightOil = cylinder(sight, 0.011, 1, [0, sightBottom, 0], materials.oil, 'Sight oil', { segments: 12 });
  sightOil.geometry.translate(0, 0.5, 0);
  [sightBottom - 0.03, sightTop + 0.03].forEach((y, index) => {
    cylinder(sight, 0.022, 0.05, [0, y, 0], materials.brushed, `Sight valve ${index + 1}`, { segments: 16 });
    cylinderBetween(sight, [0, y, 0], [0, y, -0.06], 0.012, materials.brushed, `Sight stub ${index + 1}`);
  });

  const plateMaterial = new THREE.MeshStandardMaterial({ map: tankPlateTexture(), metalness: 0.2, roughness: 0.5 });
  const plate = addMesh(root, new THREE.CylinderGeometry(radius + 0.003, radius + 0.003, 0.24, 32, 1, true, -0.5, 1), plateMaterial, 'Tank name plate', [0, shellBottom + height * 0.62, 0], { castShadow: false });
  plate.rotation.y = 0.7;

  const outlet = new THREE.Vector3(0, shellBottom - 0.16, 0);
  const levelTop = new THREE.Vector3(0.22, top, -0.12);

  let level = 1;
  return {
    root,
    radius,
    references: { outlet, levelSensorMount: levelTop },
    get level() {
      return level;
    },
    setLevel(value) {
      level = THREE.MathUtils.clamp(value, 0, 1);
      sightOil.scale.y = Math.max(0.001, level * sightLength);
    },
  };
}

/** Centrifugal transfer pump with motor on a steel skid. Origin = pump volute centre on the floor. */
export function createTransferPump({ materials }) {
  const root = group(null, 'TransferPump');
  roundedBox(root, [0.7, 0.06, 0.3], [0.18, 0.03, 0], materials.frame, 'Pump skid', 0.008);
  roundedBox(root, [0.16, 0.1, 0.18], [0, 0.11, 0], materials.frame, 'Pump pedestal', 0.01);
  cylinder(root, 0.1, 0.09, [0, 0.24, 0], materials.stainless, 'Pump volute', { axis: 'x', segments: 32 });
  cylinder(root, 0.05, 0.08, [-0.08, 0.24, 0], materials.stainless, 'Suction nozzle', { axis: 'x', segments: 20 });
  cylinder(root, 0.045, 0.1, [0, 0.36, 0], materials.stainless, 'Discharge nozzle', { segments: 20 });
  cylinder(root, 0.03, 0.12, [0.1, 0.24, 0], materials.brushed, 'Bearing frame', { axis: 'x', segments: 20 });
  cylinder(root, 0.09, 0.3, [0.32, 0.24, 0], materials.motor, 'Pump motor', { axis: 'x', segments: 32 });
  cylinder(root, 0.092, 0.05, [0.495, 0.24, 0], materials.frameDark, 'Motor fan cover', { axis: 'x', segments: 32 });
  roundedBox(root, [0.1, 0.06, 0.1], [0.3, 0.355, 0], materials.motor, 'Motor terminal box', 0.01);
  for (let index = 0; index < 8; index += 1) {
    const angle = (index / 8) * Math.PI * 2;
    roundedBox(root, [0.26, 0.012, 0.012], [0.32, 0.24 + Math.sin(angle) * 0.092, Math.cos(angle) * 0.092], materials.motor, 'Cooling fin', 0.004);
  }
  return {
    root,
    references: {
      suction: new THREE.Vector3(-0.12, 0.24, 0),
      discharge: new THREE.Vector3(0, 0.41, 0),
    },
  };
}
