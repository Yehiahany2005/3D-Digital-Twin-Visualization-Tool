import * as THREE from 'three';

export class CameraManager {
  constructor(container) {
    this.container = container;
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1000);
    this.camera.position.set(3, 2.5, 4);
    this.updateAspectRatio();
  }

  updateAspectRatio() {
    const { clientWidth, clientHeight } = this.container;
    this.camera.aspect = clientWidth / Math.max(clientHeight, 1);
    this.camera.updateProjectionMatrix();
  }

  frameObject(object, controls) {
    const bounds = new THREE.Box3().setFromObject(object);
    const size = bounds.getSize(new THREE.Vector3());
    const center = bounds.getCenter(new THREE.Vector3());
    const maxDimension = Math.max(size.x, size.y, size.z);
    const halfFov = THREE.MathUtils.degToRad(this.camera.fov * 0.5);
    const distance = (maxDimension * 0.5) / Math.tan(halfFov);
    const direction = new THREE.Vector3(1, 0.7, 1).normalize();

    this.camera.position.copy(center).addScaledVector(direction, distance * 1.35);
    this.camera.near = Math.max(maxDimension / 1000, 0.001);
    this.camera.far = Math.max(maxDimension * 20, 100);
    this.camera.updateProjectionMatrix();
    controls.target.copy(center);
    controls.maxDistance = distance * 8;
    controls.minDistance = Math.max(distance * 0.08, this.camera.near * 2);
    controls.update();
    return { bounds, size, center };
  }
}