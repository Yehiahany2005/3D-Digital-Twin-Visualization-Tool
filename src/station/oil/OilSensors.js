import * as THREE from 'three';
import { addMesh, box, cylinder, group, roundedBox } from './OilGeometry.js';
import { createLampMaterial, setLamp } from './OilMaterials.js';

/** Retro-reflective photo-eye across the belt with a status LED. */
function createPhotoEye(parent, materials, { name, x, beltHeight, frameZ }) {
  const sensor = group(parent, name, [x, 0, 0]);
  const beamY = beltHeight + 0.2;
  const postHeight = 0.24;
  [-1, 1].forEach((side) => {
    cylinder(sensor, 0.008, postHeight, [0, beltHeight + postHeight / 2, side * (frameZ + 0.035)], materials.stainless, 'Mounting rod', { segments: 10 });
  });
  // Emitter / receiver on the operator side.
  const head = group(sensor, 'PhotoEye', [0, beamY, frameZ + 0.035]);
  roundedBox(head, [0.035, 0.055, 0.03], [0, 0, 0], materials.plasticBlack, 'Sensor housing', 0.005);
  cylinder(head, 0.011, 0.006, [0, 0.008, -0.016], materials.lens, 'Sensor lens', { axis: 'z', segments: 16 });
  const ledMaterial = createLampMaterial(0x39d353);
  const ledOff = createLampMaterial(0xf2a516);
  const led = addMesh(head, new THREE.SphereGeometry(0.005, 10, 8), ledOff, 'Status LED', [0, 0.031, 0.006], { castShadow: false });
  setLamp(ledOff, true, 0.9);
  addMesh(head, new THREE.CylinderGeometry(0.003, 0.003, 0.12, 8), materials.rubber, 'Sensor cable', [0, -0.08, 0.008]);
  // Reflector on the far side.
  const reflector = group(sensor, 'Reflector', [0, beamY, -(frameZ + 0.035)]);
  roundedBox(reflector, [0.04, 0.04, 0.008], [0, 0, 0.002], materials.plasticBlack, 'Reflector frame', 0.003);
  box(reflector, [0.032, 0.032, 0.002], [0, 0, 0.007], new THREE.MeshStandardMaterial({ color: 0xc8302a, metalness: 0.3, roughness: 0.2 }), 'Reflector prism');

  return {
    x,
    setDetected(detected) {
      led.material = detected ? ledMaterial : ledOff;
      setLamp(ledMaterial, detected, 1.8);
      setLamp(ledOff, !detected, 0.9);
    },
  };
}

/** Ultrasonic level transmitter for the oil tank roof. */
function createLevelTransmitter(parent, materials, position) {
  const transmitter = group(parent, 'Sensor_TankLevel', position);
  cylinder(transmitter, 0.03, 0.04, [0, 0.02, 0], materials.brushed, 'Process connection', { segments: 6 });
  cylinder(transmitter, 0.045, 0.09, [0, 0.085, 0], materials.stainless, 'Transmitter body', { segments: 24 });
  roundedBox(transmitter, [0.07, 0.05, 0.05], [0, 0.155, 0], materials.motor, 'Display head', 0.01);
  return transmitter;
}

/**
 * Line sensors. `zones` is a list of { name, x } in station space; each
 * photo-eye lights green while a can breaks its beam.
 */
export function createSensors({ materials, zones, beltHeight, beltWidth, tankLevelMount, canLength }) {
  const root = group(null, 'Sensors');
  const frameZ = beltWidth / 2 + 0.03;
  const eyes = zones.map((zone) => ({ name: zone.name, ...createPhotoEye(root, materials, { ...zone, beltHeight, frameZ }) }));
  if (tankLevelMount) createLevelTransmitter(root, materials, tankLevelMount.toArray());
  const state = Object.fromEntries(eyes.map((eye) => [eye.name, false]));

  return {
    root,
    state,
    /** Updates every photo-eye from the current can X positions. */
    update(canXs) {
      eyes.forEach((eye) => {
        const detected = canXs.some((x) => Math.abs(x - eye.x) < canLength / 2);
        if (detected === state[eye.name]) return;
        state[eye.name] = detected;
        eye.setDetected(detected);
      });
    },
    reset() {
      eyes.forEach((eye) => {
        state[eye.name] = false;
        eye.setDetected(false);
      });
    },
  };
}
