import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

const INTENSITY = 0.55;
// One reflection map per renderer, shared by every station.
const textures = new WeakMap();

function roomTexture(renderer) {
  if (!textures.has(renderer)) {
    const generator = new THREE.PMREMGenerator(renderer);
    textures.set(renderer, generator.fromScene(new RoomEnvironment(), 0.04).texture);
    generator.dispose();
  }
  return textures.get(renderer);
}

// Soft studio reflections for the procedural stations (painted metal and plastic look flat
// without them). apply() while a station is shown; restore() puts the scene's own back.
// Without a renderer (a station built inside the factory) both do nothing.
export class StationEnvironment {
  constructor({ scene, renderer }) {
    this.scene = scene;
    this.renderer = renderer;
    this.previous = null;
  }

  apply() {
    if (!this.renderer || this.previous) return;
    this.previous = { map: this.scene.environment, intensity: this.scene.environmentIntensity };
    this.scene.environment = roomTexture(this.renderer);
    this.scene.environmentIntensity = INTENSITY;
  }

  restore() {
    if (!this.previous) return;
    this.scene.environment = this.previous.map;
    this.scene.environmentIntensity = this.previous.intensity;
    this.previous = null;
  }
}
