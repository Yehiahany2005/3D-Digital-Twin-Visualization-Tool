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

export function createProceduralConveyor(definition) {
  const { length, width, beltHeight, beltThickness, frameHeight, supportInset, rollerCount } = definition;
  const root = new THREE.Group();
  root.name = 'ProceduralConveyor';
  const frame = new THREE.Group();
  frame.name = 'ConveyorVisuals';
  root.add(frame);

  const steel = new THREE.MeshStandardMaterial({ color: 0x39434a, metalness: 0.82, roughness: 0.28 });
  const edge = new THREE.MeshStandardMaterial({ color: 0x66737a, metalness: 0.88, roughness: 0.2 });
  const beltMaterial = new THREE.MeshStandardMaterial({ color: 0x20262a, metalness: 0.05, roughness: 0.78 });
  const rollerMaterial = new THREE.MeshStandardMaterial({ color: 0xb7c0c4, metalness: 0.9, roughness: 0.22 });
  const accent = new THREE.MeshStandardMaterial({ color: 0xd58a27, metalness: 0.45, roughness: 0.35 });

  const beltY = beltHeight - beltThickness / 2;
  beam(frame, [length, 0.12, 0.12], [0, beltY + 0.06, width / 2 + 0.06], edge, 'Left belt rail');
  beam(frame, [length, 0.12, 0.12], [0, beltY + 0.06, -width / 2 - 0.06], edge, 'Right belt rail');
  mesh(new THREE.BoxGeometry(length, beltThickness, width), beltMaterial, 'Belt', frame).position.y = beltY;

  const rollerSpacing = length / (rollerCount + 1);
  const rollers = [];
  for (let index = 0; index < rollerCount; index += 1) {
    const x = -length / 2 + rollerSpacing * (index + 1);
    const roller = mesh(new THREE.CylinderGeometry(0.045, 0.045, width + 0.12, 20), rollerMaterial, `Roller ${index + 1}`, frame);
    roller.rotation.x = Math.PI / 2;
    roller.position.set(x, beltHeight - beltThickness - 0.012, 0);
    rollers.push(roller);
    const cap = mesh(new THREE.CylinderGeometry(0.065, 0.065, 0.018, 20), accent, `Roller cap ${index + 1}`, frame);
    cap.rotation.x = Math.PI / 2;
    cap.position.set(x, beltHeight - beltThickness - 0.012, width / 2 + 0.07);
  }

  const legY = frameHeight / 2;
  const legX = length / 2 - supportInset;
  const legZ = width / 2 - 0.08;
  [[-legX, -legZ], [-legX, legZ], [legX, -legZ], [legX, legZ]].forEach(([x, z], index) => {
    beam(frame, [0.12, frameHeight, 0.12], [x, legY, z], steel, `Support leg ${index + 1}`);
    beam(frame, [0.34, 0.07, 0.24], [x, 0.035, z], steel, `Foot ${index + 1}`);
  });
  beam(frame, [length - supportInset * 2, 0.1, 0.1], [0, 0.48, -legZ], steel, 'Lower near brace');
  beam(frame, [length - supportInset * 2, 0.1, 0.1], [0, 0.48, legZ], steel, 'Lower far brace');

  const references = {
    input: new THREE.Vector3(-length / 2, beltHeight, 0),
    pickup: new THREE.Vector3(length * 0.04, beltHeight, 0),
    output: new THREE.Vector3(length / 2, beltHeight, 0),
    drop: new THREE.Vector3(length * 0.36, beltHeight, 0),
    beltSurface: new THREE.Vector3(0, beltHeight, 0),
    center: new THREE.Vector3(0, 0, 0),
  };
  return { root, references, rollers };
}
