import * as THREE from 'three';

// Floor, fog, grid and shadow settings were tuned for the ~4 m ABB robot.
// Imported models range from millimetre parts to whole buildings, so all of
// those settings are scaled by the model's size relative to that reference.
const REFERENCE_SIZE = 4;

function fitLight(light, scale) {
  light.userData.basePosition ??= light.position.clone();
  light.position.copy(light.userData.basePosition).multiplyScalar(scale);
  if (!light.castShadow) return;

  const camera = light.shadow.camera;
  light.userData.baseShadow ??= {
    left: camera.left,
    right: camera.right,
    top: camera.top,
    bottom: camera.bottom,
    near: camera.near,
    far: camera.far,
    normalBias: light.shadow.normalBias,
  };
  const base = light.userData.baseShadow;
  camera.left = base.left * scale;
  camera.right = base.right * scale;
  camera.top = base.top * scale;
  camera.bottom = base.bottom * scale;
  camera.near = base.near * scale;
  camera.far = base.far * scale;
  camera.updateProjectionMatrix();
  light.shadow.normalBias = base.normalBias * scale;
}

// span: the size to fit, in metres, when it shouldn't be measured from `model` (a scene sizes
// to its whole layout, with a sensible minimum).
export function fitEnvironment({ model, span, scene, floor, grid, lightGroups }) {
  let extent = span;
  if (!Number.isFinite(extent)) {
    const size = new THREE.Box3().setFromObject(model).getSize(new THREE.Vector3());
    extent = Math.max(size.x, size.y, size.z);
  }
  const scale = Math.max(extent, 0.01) / REFERENCE_SIZE;

  floor.scale.setScalar(scale);
  floor.position.y = -0.001 * scale;
  if (grid) {
    grid.scale.setScalar(scale);
    grid.position.y = floor.position.y;
  }
  if (scene.fog) {
    scene.fog.near = 30 * scale;
    scene.fog.far = 100 * scale;
  }
  lightGroups.forEach((group) => group?.traverse((light) => {
    if (light.isDirectionalLight) fitLight(light, scale);
  }));
}
