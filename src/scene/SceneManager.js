import * as THREE from 'three';

export class SceneManager {
  constructor() {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xaeb4b9);
    this.scene.fog = new THREE.Fog(0xaeb4b9, 30, 100);
    console.info('Scene created');
  }

  add(object) {
    this.scene.add(object);
  }
}