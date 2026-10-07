import * as THREE from 'three';

export function createProceduralBox(definition) {
  const root = new THREE.Group();
  root.name = 'ProceduralWorkpiece';
  const cardboard = new THREE.MeshStandardMaterial({ color: 0xb8793c, roughness: 0.72, metalness: 0.02 });
  const tape = new THREE.MeshStandardMaterial({ color: 0xe1c083, roughness: 0.48, metalness: 0.05 });
  const { length, width, height } = definition;
  const body = new THREE.Mesh(new THREE.BoxGeometry(length, height, width), cardboard);
  body.name = 'Box body';
  body.castShadow = true;
  body.receiveShadow = true;
  root.add(body);
  const seam = new THREE.Mesh(new THREE.BoxGeometry(0.07, height + 0.006, width + 0.008), tape);
  seam.name = 'Box tape seam';
  seam.castShadow = true;
  root.add(seam);
  const references = {
    center: new THREE.Vector3(0, 0, 0),
    bottom: new THREE.Vector3(0, -height / 2, 0),
    grasp: new THREE.Vector3(0, height / 2, 0),
    topSurface: new THREE.Vector3(0, height / 2, 0),
  };
  return { root, references };
}
