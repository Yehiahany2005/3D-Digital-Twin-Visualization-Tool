import * as THREE from 'three';

const WIDTH = 192;
const HEIGHT = 144;

// Renders small pictures of catalog components for the Add drawer, with the app's own renderer
// (a second WebGL context would cost memory), one at a time, and keeps them for the session.
export class ThumbnailRenderer {
  constructor(renderer) {
    this.renderer = renderer;
    this.cache = new Map();
    this.target = new THREE.WebGLRenderTarget(WIDTH, HEIGHT, { samples: 4 });
    this.target.texture.colorSpace = THREE.SRGBColorSpace;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x353a40);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 2.2));
    const sun = new THREE.DirectionalLight(0xffffff, 2.4);
    sun.position.set(3, 5, 4);
    this.scene.add(sun);
    this.camera = new THREE.PerspectiveCamera(35, WIDTH / HEIGHT, 0.01, 200);
    this.queue = Promise.resolve();
  }

  get(id) {
    return this.cache.get(id);
  }

  // build() → Promise<{ root, dispose? }>; resolves to a data URL (or null if it couldn't be drawn).
  request(id, build) {
    if (this.cache.has(id)) return Promise.resolve(this.cache.get(id));
    this.queue = this.queue.then(async () => {
      if (this.cache.has(id)) return this.cache.get(id);
      let built;
      try {
        built = await build();
        // Animated components (people) are drawn in their first frame, not their bind pose.
        built.update?.(1 / 60);
        const url = this.render(built.root);
        this.cache.set(id, url);
        return url;
      } catch (error) {
        console.warn(`No picture for ${id}.`, error);
        this.cache.set(id, null);
        return null;
      } finally {
        built?.root.removeFromParent();
        built?.dispose?.();
      }
    });
    return this.queue;
  }

  render(object) {
    this.scene.add(object);
    object.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(object);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(size.length() / 2, 0.01);
    const distance = radius / Math.sin(THREE.MathUtils.degToRad(this.camera.fov / 2)) * 0.95;
    this.camera.position.copy(center).add(new THREE.Vector3(1, 0.75, 1.2).normalize().multiplyScalar(distance));
    this.camera.near = distance / 100;
    this.camera.far = distance * 10;
    this.camera.updateProjectionMatrix();
    this.camera.lookAt(center);

    const { renderer } = this;
    const previousTarget = renderer.getRenderTarget();
    const previousShadows = renderer.shadowMap.enabled;
    renderer.shadowMap.enabled = false;
    renderer.setRenderTarget(this.target);
    renderer.render(this.scene, this.camera);
    const pixels = new Uint8Array(WIDTH * HEIGHT * 4);
    renderer.readRenderTargetPixels(this.target, 0, 0, WIDTH, HEIGHT, pixels);
    renderer.setRenderTarget(previousTarget);
    renderer.shadowMap.enabled = previousShadows;
    this.scene.remove(object);

    // Pixels come bottom row first; a canvas wants the top row first.
    const canvas = document.createElement('canvas');
    canvas.width = WIDTH;
    canvas.height = HEIGHT;
    const context = canvas.getContext('2d');
    const image = context.createImageData(WIDTH, HEIGHT);
    for (let row = 0; row < HEIGHT; row += 1) {
      image.data.set(pixels.subarray(row * WIDTH * 4, (row + 1) * WIDTH * 4), (HEIGHT - 1 - row) * WIDTH * 4);
    }
    context.putImageData(image, 0, 0);
    return canvas.toDataURL('image/png');
  }
}
