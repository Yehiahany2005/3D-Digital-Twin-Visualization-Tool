import * as THREE from 'three';

function mesh(geometry, material, name, parent) {
  const object = new THREE.Mesh(geometry, material);
  object.name = name;
  object.castShadow = true;
  object.receiveShadow = true;
  parent.add(object);
  return object;
}

function beam(parent, size, position, material, name) {
  const object = mesh(new THREE.BoxGeometry(...size), material, name, parent);
  object.position.set(...position);
  return object;
}

/**
 * Industrial infeed enclosure. Local +X faces the conveyor.
 * Opening/chute is centered on local origin so the group can be placed at the conveyor input.
 */
export function createProceduralBoxSourceMachine({
  depth = 1.55,
  width = 1.45,
  height = 1.85,
  openingWidth = 0.78,
  openingHeight = 0.58,
  beltHeight = 0.82,
  boxHeight = 0.42,
}) {
  const root = new THREE.Group();
  root.name = 'ProceduralBoxSourceMachine';
  const frame = new THREE.Group();
  frame.name = 'SourceMachineVisuals';
  root.add(frame);

  const steel = new THREE.MeshStandardMaterial({ color: 0x3a4349, metalness: 0.78, roughness: 0.32 });
  const panel = new THREE.MeshStandardMaterial({ color: 0x4d5961, metalness: 0.55, roughness: 0.42 });
  const panelDark = new THREE.MeshStandardMaterial({ color: 0x2c3338, metalness: 0.4, roughness: 0.55 });
  const accent = new THREE.MeshStandardMaterial({ color: 0xc47a1d, metalness: 0.48, roughness: 0.38 });
  const warning = new THREE.MeshStandardMaterial({ color: 0xd4a017, metalness: 0.35, roughness: 0.45 });
  const interior = new THREE.MeshStandardMaterial({ color: 0x15181b, metalness: 0.15, roughness: 0.9, side: THREE.DoubleSide });
  const glass = new THREE.MeshStandardMaterial({
    color: 0x6a8898,
    metalness: 0.2,
    roughness: 0.18,
    transparent: true,
    opacity: 0.35,
  });
  const lightOn = new THREE.MeshStandardMaterial({ color: 0x3dcf6a, emissive: 0x1a7a38, emissiveIntensity: 0.65, roughness: 0.4 });

  const wall = 0.06;
  const chuteDepth = 0.28;
  const bodyDepth = depth - chuteDepth;
  const bodyCenterX = -(chuteDepth + bodyDepth / 2);
  const openingCenterY = beltHeight + boxHeight / 2;

  // Main enclosure body (behind the conveyor input)
  beam(frame, [bodyDepth, height, width], [bodyCenterX, height / 2, 0], panel, 'Cabinet body');
  beam(frame, [bodyDepth - 0.04, height - 0.12, width - 0.12], [bodyCenterX, height / 2, 0], panelDark, 'Cabinet inset');

  // Front face plates flanking the exit opening
  const sidePlateWidth = (width - openingWidth) / 2;
  const frontX = -chuteDepth / 2;
  beam(frame, [chuteDepth, height, sidePlateWidth], [frontX, height / 2, -(openingWidth / 2 + sidePlateWidth / 2)], steel, 'Front left plate');
  beam(frame, [chuteDepth, height, sidePlateWidth], [frontX, height / 2, openingWidth / 2 + sidePlateWidth / 2], steel, 'Front right plate');

  const belowHeight = Math.max(0.08, openingCenterY - openingHeight / 2);
  const aboveStart = openingCenterY + openingHeight / 2;
  const aboveHeight = Math.max(0.08, height - aboveStart);
  beam(frame, [chuteDepth, belowHeight, openingWidth], [frontX, belowHeight / 2, 0], steel, 'Front lower plate');
  beam(frame, [chuteDepth, aboveHeight, openingWidth], [frontX, aboveStart + aboveHeight / 2, 0], steel, 'Front upper plate');

  // Exit chute / tunnel aligned with conveyor input
  const chute = new THREE.Group();
  chute.name = 'Exit chute';
  frame.add(chute);
  const tunnelLength = chuteDepth + 0.12;
  const tunnelX = -tunnelLength / 2 + 0.02;
  beam(chute, [tunnelLength, wall, openingWidth + wall * 2], [tunnelX, openingCenterY - openingHeight / 2 - wall / 2, 0], steel, 'Chute floor');
  beam(chute, [tunnelLength, wall, openingWidth + wall * 2], [tunnelX, openingCenterY + openingHeight / 2 + wall / 2, 0], steel, 'Chute roof');
  beam(chute, [tunnelLength, openingHeight, wall], [tunnelX, openingCenterY, -openingWidth / 2 - wall / 2], steel, 'Chute left wall');
  beam(chute, [tunnelLength, openingHeight, wall], [tunnelX, openingCenterY, openingWidth / 2 + wall / 2], steel, 'Chute right wall');
  mesh(new THREE.BoxGeometry(tunnelLength - 0.04, openingHeight - 0.02, openingWidth - 0.02), interior, 'Chute interior', chute)
    .position.set(tunnelX - 0.01, openingCenterY, 0);

  // Opening trim / lip at the conveyor interface (local x ≈ 0)
  beam(frame, [0.04, openingHeight + 0.1, openingWidth + 0.14], [0.02, openingCenterY, 0], accent, 'Exit trim');
  beam(frame, [0.05, 0.03, openingWidth + 0.18], [0.04, openingCenterY - openingHeight / 2 - 0.02, 0], warning, 'Exit lip');

  // Structural frame rails
  [[-width / 2 + 0.05, 0], [width / 2 - 0.05, 0]].forEach(([z], index) => {
    beam(frame, [depth - 0.08, 0.08, 0.08], [-(depth / 2) + 0.04, 0.06, z], steel, `Base rail ${index + 1}`);
    beam(frame, [depth - 0.08, 0.08, 0.08], [-(depth / 2) + 0.04, height - 0.06, z], steel, `Top rail ${index + 1}`);
  });
  beam(frame, [0.08, height, 0.08], [-depth + 0.08, height / 2, -width / 2 + 0.05], steel, 'Rear post L');
  beam(frame, [0.08, height, 0.08], [-depth + 0.08, height / 2, width / 2 - 0.05], steel, 'Rear post R');

  // Side access / observation window
  const window = mesh(new THREE.BoxGeometry(0.7, 0.45, 0.03), glass, 'Side window', frame);
  window.position.set(bodyCenterX, height * 0.62, width / 2 - 0.04);
  beam(frame, [0.78, 0.04, 0.04], [bodyCenterX, height * 0.62 + 0.24, width / 2 - 0.03], steel, 'Window frame top');
  beam(frame, [0.78, 0.04, 0.04], [bodyCenterX, height * 0.62 - 0.24, width / 2 - 0.03], steel, 'Window frame bottom');

  // Control cabinet + status light
  beam(frame, [0.22, 0.55, 0.32], [bodyCenterX + bodyDepth * 0.15, 1.05, -width / 2 - 0.12], panelDark, 'Control cabinet');
  beam(frame, [0.18, 0.28, 0.02], [bodyCenterX + bodyDepth * 0.15, 1.12, -width / 2 - 0.28], steel, 'Control panel');
  const status = mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.04, 16), lightOn, 'Status light', frame);
  status.rotation.x = Math.PI / 2;
  status.position.set(bodyCenterX + bodyDepth * 0.15, 1.32, -width / 2 - 0.29);

  // Roof vent / motor housing
  beam(frame, [0.55, 0.18, 0.45], [bodyCenterX, height + 0.06, 0], steel, 'Motor housing');
  const vent = mesh(new THREE.CylinderGeometry(0.12, 0.14, 0.16, 20), panelDark, 'Vent', frame);
  vent.position.set(bodyCenterX - 0.25, height + 0.16, 0.18);

  // Hazard stripes on front upper plate
  for (let index = 0; index < 4; index += 1) {
    const stripe = mesh(new THREE.BoxGeometry(0.03, 0.12, 0.08), warning, `Hazard stripe ${index + 1}`, frame);
    stripe.position.set(
      0.01,
      aboveStart + 0.1,
      -openingWidth / 2 + 0.1 + index * ((openingWidth - 0.12) / 3),
    );
  }

  const references = {
    opening: new THREE.Vector3(0, openingCenterY, 0),
    exit: new THREE.Vector3(0.04, beltHeight, 0),
    center: new THREE.Vector3(bodyCenterX, height / 2, 0),
  };

  return { root, references };
}
