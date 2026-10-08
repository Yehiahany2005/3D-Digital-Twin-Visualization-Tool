import * as THREE from 'three';
import { addMesh, box, cylinder, group, roundedBox } from './OilGeometry.js';
import { createLampMaterial, setLamp } from './OilMaterials.js';

const FRAME_HALF_X = 0.95;
const FRAME_HALF_Z = 0.5;
const CABINET_BOTTOM = 2.05;
const CABINET_HEIGHT = 0.32;
const MANIFOLD_Y = 0.3;
const STREAM_RADIUS = 0.0055;

/** Shared stainless portal: four posts with base plates, side rails and transparent guards. */
export function buildPortalFrame(parent, materials, { halfX, halfZ, top, guardBottom }) {
  const frame = group(parent, 'Frame');
  [[-1, -1], [-1, 1], [1, -1], [1, 1]].forEach(([sx, sz], index) => {
    roundedBox(frame, [0.08, top - 0.02, 0.08], [sx * halfX, 0.02 + (top - 0.02) / 2, sz * halfZ], materials.stainless, `Post ${index + 1}`, 0.012);
    roundedBox(frame, [0.18, 0.02, 0.18], [sx * halfX, 0.01, sz * halfZ], materials.brushed, `Base plate ${index + 1}`, 0.004);
    [[-0.06, -0.06], [0.06, 0.06], [-0.06, 0.06], [0.06, -0.06]].forEach(([bx, bz]) => {
      cylinder(frame, 0.008, 0.016, [sx * halfX + bx, 0.026, sz * halfZ + bz], materials.chrome, 'Anchor bolt', { segments: 6 });
    });
  });
  [-1, 1].forEach((sz) => {
    roundedBox(frame, [halfX * 2, 0.06, 0.06], [0, 0.32, sz * halfZ], materials.stainless, 'Lower side rail', 0.01);
    roundedBox(frame, [halfX * 2, 0.05, 0.05], [0, guardBottom - 0.03, sz * halfZ], materials.stainless, 'Guard rail', 0.01);
  });

  // Polycarbonate guards: front/rear full panels, ends only above the product path.
  const guards = group(parent, 'SafetyGuards');
  const guardHeight = top - guardBottom;
  [-1, 1].forEach((sz) => {
    addMesh(guards, new THREE.BoxGeometry(halfX * 2 - 0.08, guardHeight, 0.008), materials.guard, sz > 0 ? 'Front guard' : 'Rear guard', [0, guardBottom + guardHeight / 2, sz * (halfZ + 0.045)], { castShadow: false });
  });
  const endBottom = guardBottom + 0.38;
  [-1, 1].forEach((sx) => {
    addMesh(guards, new THREE.BoxGeometry(0.008, top - endBottom, halfZ * 2 - 0.08), materials.guard, 'End guard', [sx * (halfX + 0.045), endBottom + (top - endBottom) / 2, 0], { castShadow: false });
  });
  roundedBox(guards, [0.025, 0.22, 0.03], [halfX - 0.2, guardBottom + guardHeight * 0.5, halfZ + 0.065], materials.stainless, 'Door handle', 0.008);
  return frame;
}

function buildNozzle(head, index, x, materials, streamGeometry, splashGeometry) {
  const nozzle = group(head, `Nozzle_0${index + 1}`, [x, 0, 0]);
  cylinder(nozzle, 0.0085, 0.165, [0, 0.0825, 0], materials.stainless, 'Nozzle tube', { radiusBottom: 0.0075, segments: 16 });
  cylinder(nozzle, 0.013, 0.018, [0, 0.165, 0], materials.brushed, 'Nozzle collar', { segments: 6 });
  cylinder(nozzle, 0.026, 0.09, [0, 0.21, 0], materials.stainless, 'Valve body', { segments: 24 });
  cylinder(nozzle, 0.016, 0.055, [0, 0.215, 0.05], materials.brushed, 'Valve actuator', { axis: 'z', segments: 16 });
  cylinder(nozzle, 0.006, 0.02, [0, 0.215, 0.085], materials.airLine, 'Air fitting', { axis: 'z', segments: 10 });

  const stream = addMesh(nozzle, streamGeometry, materials.oilStream, 'Oil stream', [0, 0, 0], { castShadow: false });
  stream.visible = false;
  stream.renderOrder = 1;
  const splash = addMesh(nozzle, splashGeometry, materials.oilStream, 'Oil splash', [0, 0, 0], { castShadow: false });
  splash.visible = false;
  return { nozzle, stream, splash };
}

/**
 * Four-head volumetric filling machine. The FillingHead group (manifold,
 * valves and Nozzle_01..04) rides a vertical pneumatic actuator, so all
 * nozzles move together. Head origin = nozzle tip height.
 */
export function createFillingMachine({ materials, centerX, nozzleXs, tipLowered, stroke }) {
  const root = group(null, 'FillingMachine', [centerX, 0, 0]);
  buildPortalFrame(root, materials, { halfX: FRAME_HALF_X, halfZ: FRAME_HALF_Z, top: CABINET_BOTTOM, guardBottom: 0.98 });

  const cabinet = group(root, 'ControlCabinet');
  roundedBox(cabinet, [FRAME_HALF_X * 2 + 0.16, CABINET_HEIGHT, FRAME_HALF_Z * 2 + 0.12], [0, CABINET_BOTTOM + CABINET_HEIGHT / 2, 0], materials.brushed, 'Cabinet housing', 0.03);
  [-0.5, 0.5].forEach((x) => {
    box(cabinet, [0.9, 0.24, 0.006], [x, CABINET_BOTTOM + CABINET_HEIGHT / 2, FRAME_HALF_Z + 0.062], materials.stainless, 'Access door');
  });
  box(cabinet, [0.004, 0.24, 0.01], [0, CABINET_BOTTOM + CABINET_HEIGHT / 2, FRAME_HALF_Z + 0.064], materials.frameDark, 'Door split');
  roundedBox(cabinet, [0.3, 0.07, 0.008], [-0.5, CABINET_BOTTOM + CABINET_HEIGHT / 2, FRAME_HALF_Z + 0.067], materials.frameDark, 'Name plate', 0.004);

  // Vertical actuator: fixed cylinder barrel + two guide bushings.
  const actuator = group(root, 'VerticalActuator');
  roundedBox(actuator, [0.11, 0.42, 0.11], [0, CABINET_BOTTOM - 0.21, 0], materials.aluminium, 'Actuator barrel', 0.02);
  roundedBox(actuator, [0.13, 0.03, 0.13], [0, CABINET_BOTTOM - 0.43, 0], materials.frameDark, 'Rod-end cap', 0.008);
  [-0.6, 0.6].forEach((x) => {
    cylinder(actuator, 0.03, 0.09, [x, CABINET_BOTTOM - 0.045, 0], materials.frameDark, 'Linear bushing', { segments: 20 });
  });

  // Moving filling head.
  const head = group(root, 'FillingHead', [0, tipLowered + stroke, 0]);
  const localNozzleXs = nozzleXs.map((x) => x - centerX);
  const halfSpan = Math.max(...localNozzleXs.map((x) => Math.abs(x))) + 0.14;
  roundedBox(head, [halfSpan * 2, 0.09, 0.12], [0, MANIFOLD_Y, 0], materials.stainless, 'Product manifold', 0.02);
  roundedBox(head, [0.16, 0.04, 0.16], [0, MANIFOLD_Y + 0.065, 0], materials.brushed, 'Actuator clevis', 0.01);
  cylinder(head, 0.02, 0.55, [0, MANIFOLD_Y + 0.045 + 0.275, 0], materials.chrome, 'Piston rod', { segments: 20 });
  [-0.6, 0.6].forEach((x) => {
    cylinder(head, 0.016, 0.5, [x, MANIFOLD_Y + 0.045 + 0.25, 0], materials.chrome, 'Guide shaft', { segments: 16 });
    roundedBox(head, [0.07, 0.03, 0.07], [x, MANIFOLD_Y + 0.06, 0], materials.brushed, 'Guide clamp', 0.008);
  });
  // Manifold end fittings where the flexible hoses land.
  const productInlet = group(head, 'ProductInlet', [-halfSpan - 0.01, MANIFOLD_Y, 0]);
  cylinder(productInlet, 0.026, 0.04, [0, 0, 0], materials.brushed, 'Inlet fitting', { axis: 'x', segments: 20 });
  const airInlet = group(head, 'AirInlet', [halfSpan - 0.04, MANIFOLD_Y + 0.045, 0.03]);
  cylinder(airInlet, 0.01, 0.03, [0, 0.01, 0], materials.brushed, 'Air manifold fitting', { segments: 12 });

  const streamGeometry = new THREE.CylinderGeometry(STREAM_RADIUS, STREAM_RADIUS * 0.8, 1, 12, 1, true).translate(0, -0.5, 0);
  const splashGeometry = new THREE.TorusGeometry(0.018, 0.003, 6, 24).rotateX(Math.PI / 2);
  const nozzles = localNozzleXs.map((x, index) => buildNozzle(head, index, x, materials, streamGeometry, splashGeometry));

  // Fixed hose bulkheads on the cabinet underside.
  const productBulkhead = group(root, 'ProductBulkhead', [-halfSpan - 0.06, CABINET_BOTTOM - 0.02, -0.08]);
  cylinder(productBulkhead, 0.03, 0.04, [0, 0, 0], materials.brushed, 'Bulkhead fitting', { segments: 20 });
  const airBulkhead = group(root, 'AirBulkhead', [halfSpan + 0.02, CABINET_BOTTOM - 0.015, -0.05]);
  cylinder(airBulkhead, 0.012, 0.03, [0, 0, 0], materials.brushed, 'Air bulkhead', { segments: 12 });
  // Rigid product line enters the cabinet from the rear.
  const rearInlet = group(root, 'RearInlet', [-0.4, CABINET_BOTTOM + 0.16, -(FRAME_HALF_Z + 0.06)]);

  // Stack light on the cabinet roof.
  const stackLight = group(root, 'StackLight', [FRAME_HALF_X - 0.05, CABINET_BOTTOM + CABINET_HEIGHT, FRAME_HALF_Z - 0.05]);
  cylinder(stackLight, 0.04, 0.02, [0, 0.01, 0], materials.frameDark, 'Stack light base', { segments: 20 });
  cylinder(stackLight, 0.012, 0.12, [0, 0.08, 0], materials.stainless, 'Stack light pole', { segments: 12 });
  const lamps = {
    green: createLampMaterial(0x2ecc59),
    amber: createLampMaterial(0xf2a516),
    red: createLampMaterial(0xe23a2e),
  };
  ['green', 'amber', 'red'].forEach((color, index) => {
    cylinder(stackLight, 0.035, 0.07, [0, 0.175 + index * 0.075, 0], lamps[color], `Lamp ${color}`, { segments: 24 });
  });
  cylinder(stackLight, 0.037, 0.02, [0, 0.4, 0], materials.frameDark, 'Stack light cap', { segments: 24 });

  return {
    root,
    head,
    nozzles,
    anchors: { productBulkhead, airBulkhead, productInlet, airInlet, rearInlet },
    /** 0 = fully raised, 1 = nozzles inserted in the can necks. */
    setHeadTravel(travel) {
      head.position.y = tipLowered + stroke * (1 - travel);
    },
    getTipY() {
      return head.position.y;
    },
    /**
     * Shows oil running from a nozzle tip down to the oil surface.
     * `top`/`bottom` are drops below the tip (m); `widthScale` tapers the jet.
     */
    setStream(index, { visible, top = 0, bottom = 0, widthScale = 1, phase = 0 }) {
      const { stream, splash } = nozzles[index];
      const length = bottom - top;
      stream.visible = visible && length > 0.002;
      splash.visible = visible && bottom > 0.02 && top < bottom - 0.02;
      if (stream.visible) {
        stream.position.y = -top;
        stream.scale.set(widthScale, length, widthScale);
      }
      if (splash.visible) {
        const pulse = 1 + 0.18 * Math.sin(phase * 22 + index);
        splash.position.y = -bottom + 0.002;
        splash.scale.set(pulse * widthScale, 1, pulse * widthScale);
      }
    },
    setStackLight({ green = false, amber = false, red = false }) {
      setLamp(lamps.green, green);
      setLamp(lamps.amber, amber);
      setLamp(lamps.red, red);
    },
  };
}
