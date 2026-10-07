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
 * Stylized industrial worker with an integrated pallet jack.
 * Local +X is the forward / fork direction.
 * Root sits on the floor at the worker/jack footprint center.
 */
export function createProceduralWorker() {
  const root = new THREE.Group();
  root.name = 'ProceduralWorker';

  const suit = new THREE.MeshStandardMaterial({ color: 0x2f6f9f, metalness: 0.15, roughness: 0.62 });
  const suitDark = new THREE.MeshStandardMaterial({ color: 0x1d3f57, metalness: 0.2, roughness: 0.55 });
  const skin = new THREE.MeshStandardMaterial({ color: 0xc68642, roughness: 0.72, metalness: 0.05 });
  const boot = new THREE.MeshStandardMaterial({ color: 0x22262a, roughness: 0.7, metalness: 0.1 });
  const steel = new THREE.MeshStandardMaterial({ color: 0x6a757c, metalness: 0.85, roughness: 0.28 });
  const steelDark = new THREE.MeshStandardMaterial({ color: 0x3d464c, metalness: 0.8, roughness: 0.32 });
  const accent = new THREE.MeshStandardMaterial({ color: 0xd58a27, metalness: 0.45, roughness: 0.38 });
  const wheelMat = new THREE.MeshStandardMaterial({ color: 0x1a1d20, roughness: 0.85, metalness: 0.05 });

  const figure = new THREE.Group();
  figure.name = 'WorkerFigure';
  figure.position.set(-0.55, 0, 0.28);
  root.add(figure);

  beam(figure, [0.28, 0.52, 0.2], [0, 1.05, 0], suit, 'Torso');
  beam(figure, [0.3, 0.08, 0.22], [0, 1.34, 0], accent, 'Safety vest band');
  const head = mesh(new THREE.SphereGeometry(0.11, 16, 12), skin, 'Head', figure);
  head.position.set(0, 1.55, 0);
  const hardHat = mesh(new THREE.SphereGeometry(0.125, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.55), accent, 'Hard hat', figure);
  hardHat.position.set(0, 1.6, 0);
  beam(figure, [0.09, 0.42, 0.09], [-0.1, 0.55, 0], suitDark, 'Left leg');
  beam(figure, [0.09, 0.42, 0.09], [0.1, 0.55, 0], suitDark, 'Right leg');
  beam(figure, [0.12, 0.08, 0.2], [-0.1, 0.08, 0.04], boot, 'Left boot');
  beam(figure, [0.12, 0.08, 0.2], [0.1, 0.08, 0.04], boot, 'Right boot');
  beam(figure, [0.08, 0.38, 0.08], [-0.22, 1.1, 0.12], suit, 'Left arm');
  beam(figure, [0.08, 0.38, 0.08], [0.18, 1.05, 0.18], suit, 'Right arm');
  beam(figure, [0.07, 0.07, 0.07], [0.18, 0.84, 0.32], skin, 'Right hand');

  const jack = new THREE.Group();
  jack.name = 'PalletJack';
  root.add(jack);

  // Handle / tiller assembly behind the forks
  beam(jack, [0.16, 0.12, 0.42], [-0.55, 0.18, 0], steelDark, 'Jack body');
  beam(jack, [0.06, 0.85, 0.06], [-0.62, 0.55, 0], steel, 'Tiller mast');
  beam(jack, [0.06, 0.06, 0.36], [-0.62, 0.98, 0], steel, 'Tiller handle');
  beam(jack, [0.05, 0.05, 0.18], [-0.45, 0.22, 0], accent, 'Pump lever');

  const steerWheel = mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.05, 16), wheelMat, 'Steer wheel', jack);
  steerWheel.rotation.z = Math.PI / 2;
  steerWheel.position.set(-0.55, 0.07, 0);

  const forks = new THREE.Group();
  forks.name = 'JackForks';
  forks.position.set(0, 0.045, 0);
  jack.add(forks);

  const forkLength = 1.15;
  const forkY = 0.035;
  [[-0.18, 'Left'], [0.18, 'Right']].forEach(([z, side]) => {
    beam(forks, [forkLength, 0.05, 0.1], [forkLength / 2 - 0.15, forkY, z], steel, `${side} fork`);
    const tipWheel = mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.04, 12), wheelMat, `${side} fork wheel`, forks);
    tipWheel.rotation.z = Math.PI / 2;
    tipWheel.position.set(forkLength - 0.28, 0.035, z);
  });
  beam(forks, [0.12, 0.06, 0.5], [-0.12, forkY, 0], steelDark, 'Fork crossbar');

  const cargoAnchor = new THREE.Group();
  cargoAnchor.name = 'CargoAnchor';
  // Pallet center sits above the fork mid-span when engaged.
  cargoAnchor.position.set(0.55, 0, 0);
  forks.add(cargoAnchor);

  const references = {
    cargoAnchor: cargoAnchor.position.clone(),
    forkTip: new THREE.Vector3(forkLength - 0.2, 0.06, 0),
  };

  return {
    root,
    figure,
    jack,
    forks,
    cargoAnchor,
    references,
    setForkHeight(height) {
      forks.position.y = height;
    },
    getForkHeight() {
      return forks.position.y;
    },
  };
}
