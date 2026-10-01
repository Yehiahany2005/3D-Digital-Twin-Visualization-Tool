import * as THREE from 'three';

export class LightingManager {
  createLights() {
    const lights = new THREE.Group();
    const ambientLight = new THREE.AmbientLight(0xe8edf0, 1.8);
    const keyLight = new THREE.DirectionalLight(0xffffff, 3.5);
    const fillLight = new THREE.DirectionalLight(0xb8d4ff, 1.2);

    keyLight.position.set(5, 10, 6);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.set(2048, 2048);
    keyLight.shadow.camera.near = 0.1;
    keyLight.shadow.camera.far = 50;
    keyLight.shadow.camera.left = -15;
    keyLight.shadow.camera.right = 15;
    keyLight.shadow.camera.top = 15;
    keyLight.shadow.camera.bottom = -15;
    keyLight.shadow.bias = -0.0002;
    keyLight.shadow.normalBias = 0.02;
    fillLight.position.set(-6, 5, -4);
    lights.add(ambientLight, keyLight, fillLight);
    return lights;
  }
}