import * as THREE from 'three';
import { addMesh, group, roundedBox } from './OilGeometry.js';

/**
 * Epoxy floor slab with safety-yellow walkway lines and a mesh guard fence
 * along the rear of the cell. `bounds` = { minX, maxX, minZ, maxZ } in station space.
 */
export function createStationBase({ materials, bounds, walkwayZ = 0.9 }) {
  const root = group(null, 'StationBase');
  const width = bounds.maxX - bounds.minX;
  const depth = bounds.maxZ - bounds.minZ;
  const centerX = (bounds.minX + bounds.maxX) / 2;
  const centerZ = (bounds.minZ + bounds.maxZ) / 2;

  const slab = addMesh(root, new THREE.BoxGeometry(width, 0.02, depth), materials.floor, 'Floor slab', [centerX, -0.01, centerZ], { castShadow: false });
  slab.receiveShadow = true;

  // Walkway / keep-out markings (slightly above the slab to avoid z-fighting).
  const lineY = 0.001;
  const line = (length, thickness, x, z, rotated = false) => {
    const mesh = addMesh(root, new THREE.PlaneGeometry(rotated ? thickness : length, rotated ? length : thickness), materials.floorLine, 'Floor marking', [x, lineY, z], { castShadow: false });
    mesh.rotation.x = -Math.PI / 2;
    mesh.receiveShadow = true;
  };
  const inset = 0.15;
  line(width - inset * 2, 0.07, centerX, bounds.minZ + inset);
  line(width - inset * 2, 0.07, centerX, bounds.maxZ - inset);
  line(depth - inset * 2, 0.07, bounds.minX + inset, centerZ, true);
  line(depth - inset * 2, 0.07, bounds.maxX - inset, centerZ, true);
  // Operator walkway edge in front of the line.
  line(width - inset * 4, 0.05, centerX, walkwayZ);

  // Rear guard fence: yellow posts with wire-mesh panels.
  const fence = group(root, 'GuardFence');
  const fenceZ = bounds.minZ + 0.25;
  const fenceHeight = 2.0;
  const panelCount = Math.max(2, Math.round(width / 1.6));
  const panelWidth = (width - 0.6) / panelCount;
  for (let index = 0; index <= panelCount; index += 1) {
    const x = bounds.minX + 0.3 + index * panelWidth;
    roundedBox(fence, [0.06, fenceHeight, 0.06], [x, fenceHeight / 2 + 0.02, fenceZ], materials.safetyYellow, `Fence post ${index + 1}`, 0.008);
    roundedBox(fence, [0.14, 0.012, 0.14], [x, 0.026, fenceZ], materials.safetyYellow, `Fence foot ${index + 1}`, 0.004);
    if (index === panelCount) continue;
    const panelMaterial = materials.fence.clone();
    panelMaterial.map = materials.fence.map.clone();
    panelMaterial.map.repeat.set(panelWidth / 0.05, (fenceHeight - 0.25) / 0.05);
    panelMaterial.map.needsUpdate = true;
    addMesh(fence, new THREE.PlaneGeometry(panelWidth - 0.08, fenceHeight - 0.25), panelMaterial, `Mesh panel ${index + 1}`, [x + panelWidth / 2, 0.15 + (fenceHeight - 0.25) / 2, fenceZ], { castShadow: false });
    roundedBox(fence, [panelWidth - 0.06, 0.03, 0.03], [x + panelWidth / 2, fenceHeight - 0.08, fenceZ], materials.safetyYellow, 'Fence top rail', 0.006);
    roundedBox(fence, [panelWidth - 0.06, 0.03, 0.03], [x + panelWidth / 2, 0.14, fenceZ], materials.safetyYellow, 'Fence bottom rail', 0.006);
  }
  return { root };
}
