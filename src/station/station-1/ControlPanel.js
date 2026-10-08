import * as THREE from 'three';
import { addMesh, cylinder, group, roundedBox } from './OilGeometry.js';

const STATE_COLORS = {
  IDLE: '#f2a516',
  FILLING: '#e3a52b',
  TRANSPORTING: '#4fb3e8',
  CAPPING: '#5d8de0',
  OUTPUT: '#39c46a',
};

/** Station 1 screen content; other stations pass their own `describe`. */
function describeOilStation(status) {
  return {
    rows: [
      ['Conveyor', status.mainConveyor],
      ['Outfeed', status.outfeedConveyor],
      ['Filling head', status.fillingHead],
      ['Capping head', status.cappingHead],
      ['Filled / capped', `${status.filledCount} / ${status.cappedCount}`],
      ['Output', `${status.outputCount} cans`],
    ],
    bar: { fraction: status.fillLevel ?? 0, label: `Fill ${Math.round((status.fillLevel ?? 0) * 100)} %   ·   Speed ${status.speed}×` },
  };
}

function drawScreen(context, width, height, status, title, describe, stateColors = {}) {
  context.fillStyle = '#0d171e';
  context.fillRect(0, 0, width, height);
  context.fillStyle = '#16303f';
  context.fillRect(0, 0, width, 54);
  context.fillStyle = '#d6e4ec';
  context.font = 'bold 26px Arial, sans-serif';
  context.textAlign = 'left';
  context.fillText(title, 18, 36);

  const color = stateColors[status.state] || STATE_COLORS[status.state] || '#d6e4ec';
  context.fillStyle = color;
  context.fillRect(18, 72, 12, 64);
  context.font = 'bold 46px Arial, sans-serif';
  context.fillText(status.state.replace(/_/g, ' '), 44, 118);
  context.fillStyle = '#9fb4c0';
  context.font = '24px Arial, sans-serif';
  context.fillText(status.step || '—', 44, 158);

  const { rows, bar } = describe(status);
  context.font = '22px Arial, sans-serif';
  rows.forEach(([label, value], index) => {
    const y = 204 + index * 34;
    context.fillStyle = '#7f95a2';
    context.fillText(label, 18, y);
    context.fillStyle = '#e6eef2';
    context.fillText(String(value ?? '—'), 250, y);
  });

  // Fill level bar.
  const barX = 18;
  const barY = height - 46;
  const barWidth = width - 36;
  context.fillStyle = '#1b2c36';
  context.fillRect(barX, barY, barWidth, 22);
  context.fillStyle = '#c98d16';
  context.fillRect(barX, barY, barWidth * THREE.MathUtils.clamp(bar.fraction, 0, 1), 22);
  context.fillStyle = '#d6e4ec';
  context.font = '18px Arial, sans-serif';
  context.fillText(bar.label, barX + 6, barY - 8);
}

/** Pedestal HMI with live process screen, E-stop and push buttons. Faces +Z. */
export function createControlPanel({ materials, title = 'STATION 1 · OIL FILLING & CAPPING', describe = describeOilStation, stateColors = {} }) {
  const root = group(null, 'ControlPanel');
  roundedBox(root, [0.36, 0.02, 0.3], [0, 0.01, 0], materials.brushed, 'Pedestal base', 0.006);
  roundedBox(root, [0.12, 1.0, 0.12], [0, 0.52, 0], materials.stainless, 'Pedestal column', 0.02);

  const enclosure = group(root, 'HMIEnclosure', [0, 1.2, 0]);
  enclosure.rotation.x = -0.32;
  roundedBox(enclosure, [0.62, 0.46, 0.16], [0, 0, 0], materials.stainless, 'Enclosure', 0.025);
  roundedBox(enclosure, [0.5, 0.31, 0.012], [0, 0.04, 0.081], materials.plasticBlack, 'Screen bezel', 0.01);

  const canvas = document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 420;
  const context = canvas.getContext('2d');
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  const screen = addMesh(enclosure, new THREE.PlaneGeometry(0.46, 0.28), new THREE.MeshBasicMaterial({ map: texture, toneMapped: false }), 'HMI screen', [0, 0.04, 0.088], { castShadow: false });
  screen.receiveShadow = false;

  // Operator buttons below the screen.
  const buttons = group(enclosure, 'Buttons', [0, -0.17, 0.08]);
  cylinder(buttons, 0.022, 0.016, [-0.18, 0, 0.008], materials.buttonGreen, 'Start button', { axis: 'z', segments: 20 });
  cylinder(buttons, 0.022, 0.016, [-0.1, 0, 0.008], materials.plasticBlack, 'Stop button', { axis: 'z', segments: 20 });
  cylinder(buttons, 0.018, 0.02, [-0.02, 0, 0.01], materials.brushed, 'Key switch', { axis: 'z', segments: 20 });
  roundedBox(buttons, [0.09, 0.09, 0.006], [0.16, 0, 0.003], materials.safetyYellow, 'E-stop collar', 0.01);
  cylinder(buttons, 0.012, 0.02, [0.16, 0, 0.014], materials.plasticBlack, 'E-stop stem', { axis: 'z', segments: 16 });
  const mushroom = addMesh(buttons, new THREE.SphereGeometry(0.03, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), materials.emergency, 'E-stop mushroom', [0.16, 0, 0.024]);
  mushroom.rotation.x = Math.PI / 2;
  mushroom.scale.y = 0.5;

  let lastKey = '';
  return {
    root,
    update(status) {
      const key = JSON.stringify(status);
      if (key === lastKey) return;
      lastKey = key;
      drawScreen(context, canvas.width, canvas.height, status, title, describe, stateColors);
      texture.needsUpdate = true;
    },
  };
}
