import * as THREE from 'three';

const CLICK_TOLERANCE_PX = 5;
const ACCENT = 0x69c7d3;
const TARGET_COLOR = 0xf2b84b;
// Parts of the joint a follower (cylinder, rod) follows.
export const LINK_COLOR = 0xb38cff;
const DIM_COLOR = 0x111518;
// How long a preview lingers after the pointer leaves, so moving across the small gap between
// two buttons goes straight from one preview to the next instead of flashing back to normal.
const PREVIEW_LINGER_MS = 500;

// Turns clicks on the viewport into raycast hits, ignoring drags (which orbit the camera).
export class ViewportPicker {
  constructor({ domElement, camera }) {
    this.domElement = domElement;
    this.camera = camera;
    this.raycaster = new THREE.Raycaster();
    this.handler = null;
    this.target = null;
    this.down = null;

    domElement.addEventListener('pointerdown', (event) => {
      if (event.button === 0) this.down = { x: event.clientX, y: event.clientY };
    });
    domElement.addEventListener('pointerup', (event) => {
      const down = this.down;
      this.down = null;
      if (!down || !this.handler || !this.target) return;
      if (Math.hypot(event.clientX - down.x, event.clientY - down.y) > CLICK_TOLERANCE_PX) return;
      this.handler(this.pick(event), event);
    });
  }

  // handler(hit | null, event) is called for each click; pass null to stop picking.
  setHandler(handler, target) {
    this.handler = handler;
    this.target = target;
    this.domElement.style.cursor = handler ? 'crosshair' : '';
  }

  pick(event) {
    const rect = this.domElement.getBoundingClientRect();
    const pointer = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(pointer, this.camera);
    const hits = this.raycaster.intersectObject(this.target, true);
    return hits.find((hit) => hit.object.isMesh && hit.object.visible && hit.faceIndex !== undefined) || null;
  }
}

// Outline boxes around the currently selected parts.
export class SelectionOutline {
  constructor(scene) {
    this.scene = scene;
    this.helpers = [];
  }

  set(objects) {
    this.clear();
    objects.forEach((object) => {
      const helper = new THREE.BoxHelper(object, ACCENT);
      helper.material.depthTest = false;
      helper.material.transparent = true;
      helper.renderOrder = 999;
      this.scene.add(helper);
      this.helpers.push({ helper, object });
    });
  }

  clear() {
    this.helpers.forEach(({ helper }) => {
      helper.removeFromParent();
      helper.geometry.dispose();
      helper.material.dispose();
    });
    this.helpers = [];
  }

  update() {
    this.helpers.forEach(({ helper }) => helper.update());
  }
}

// Tints meshes so it is clear exactly what a selection or group contains: the selection in the
// accent colour, the parts a follower follows in violet, and a previewed group in amber. While a
// group is previewed everything outside it is dimmed, so a piece left out stands out even when it
// sits among the group's parts; a faint see-through amber still shows the group where it is hidden.
export class PartHighlight {
  constructor(scene) {
    this.scene = scene;
    this.modelMeshes = [];
    this.layers = {
      selection: { material: tintMaterial(ACCENT, 0.3, true), order: 997, overlays: [] },
      linked: { material: tintMaterial(LINK_COLOR, 0.55, true), order: 998, overlays: [] },
      dim: { material: tintMaterial(DIM_COLOR, 0.75, true), order: 999, overlays: [] },
      preview: { material: tintMaterial(TARGET_COLOR, 0.65, true), order: 1000, overlays: [] },
      previewXray: { material: tintMaterial(TARGET_COLOR, 0.14, false), order: 1001, overlays: [] },
    };
  }

  // Every mesh of the current model, so a preview can dim what it leaves out.
  setModelMeshes(meshes) {
    this.modelMeshes = meshes;
  }

  setSelection(meshes) {
    this.fill(this.layers.selection, meshes);
  }

  setLinked(meshes) {
    this.fill(this.layers.linked, meshes);
  }

  setPreview(meshes) {
    clearTimeout(this.previewTimer);
    const included = new Set(meshes);
    this.fill(this.layers.preview, meshes);
    this.fill(this.layers.previewXray, meshes);
    this.fill(this.layers.dim, meshes.length ? this.modelMeshes.filter((mesh) => !included.has(mesh)) : []);
  }

  // Ends the preview after a short delay; a new preview in the meantime replaces it directly.
  endPreviewSoon() {
    clearTimeout(this.previewTimer);
    this.previewTimer = setTimeout(() => this.setPreview([]), PREVIEW_LINGER_MS);
  }

  clear() {
    this.setSelection([]);
    this.setLinked([]);
    this.setPreview([]);
  }

  fill(layer, meshes) {
    layer.overlays.forEach(({ overlay }) => overlay.removeFromParent());
    // Skinned and instanced meshes would draw in the wrong place with a plain overlay.
    layer.overlays = meshes.filter((mesh) => !mesh.isSkinnedMesh && !mesh.isInstancedMesh).map((mesh) => {
      const overlay = new THREE.Mesh(mesh.geometry, layer.material);
      overlay.matrixAutoUpdate = false;
      overlay.renderOrder = layer.order;
      overlay.raycast = () => {};
      this.scene.add(overlay);
      return { overlay, mesh };
    });
    this.update();
  }

  update() {
    Object.values(this.layers).forEach(({ overlays }) => overlays.forEach(({ overlay, mesh }) => {
      overlay.matrix.copy(mesh.matrixWorld);
      overlay.visible = mesh.visible;
    }));
  }
}

function tintMaterial(color, opacity, depthTest) {
  return new THREE.MeshBasicMaterial({
    color,
    opacity,
    depthTest,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });
}

function overlayMaterial(color) {
  return new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.95 });
}

// Arrow along the joint axis, a dot at the pivot, a ring for rotation, and an
// optional marker for a linked joint's target point. Drawn on top of the model.
export class JointGizmo {
  constructor(scene) {
    this.group = new THREE.Group();
    this.group.name = 'JointGizmo';
    this.group.visible = false;

    this.arrow = new THREE.ArrowHelper(new THREE.Vector3(0, 1, 0), new THREE.Vector3(), 1, ACCENT, 0.2, 0.08);
    [this.arrow.line.material, this.arrow.cone.material].forEach((material) => {
      material.depthTest = false;
      material.transparent = true;
    });
    this.pivot = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), overlayMaterial(ACCENT));
    this.ring = new THREE.Mesh(new THREE.TorusGeometry(1, 0.03, 8, 48), overlayMaterial(ACCENT));
    this.target = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), overlayMaterial(TARGET_COLOR));
    // Dashed line from the pivot to the follow point, so the link reads at a glance.
    this.link = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
      new THREE.LineDashedMaterial({ color: TARGET_COLOR, depthTest: false, transparent: true }),
    );
    this.link.frustumCulled = false;
    this.group.add(this.arrow, this.pivot, this.ring, this.target, this.link);
    this.group.traverse((object) => { object.renderOrder = 1000; });
    scene.add(this.group);
  }

  // point/direction/target are in world space; size is the model's largest dimension.
  show({ point, direction, type, target, size }) {
    const length = size * 0.3;
    const direction3 = direction.clone().normalize();
    this.arrow.position.copy(point).addScaledVector(direction3, type === 'prismatic' ? -length / 2 : 0);
    this.arrow.setDirection(direction3);
    this.arrow.setLength(length, length * 0.18, length * 0.07);
    this.pivot.position.copy(point);
    this.pivot.scale.setScalar(size * 0.012);
    this.ring.visible = type === 'revolute';
    this.ring.position.copy(point);
    this.ring.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), direction3);
    this.ring.scale.setScalar(size * 0.08);
    this.target.visible = Boolean(target);
    this.link.visible = Boolean(target);
    if (target) {
      this.target.position.copy(target);
      this.target.scale.setScalar(size * 0.02);
      const positions = this.link.geometry.attributes.position;
      positions.setXYZ(0, point.x, point.y, point.z);
      positions.setXYZ(1, target.x, target.y, target.z);
      positions.needsUpdate = true;
      this.link.material.dashSize = size * 0.02;
      this.link.material.gapSize = size * 0.012;
      this.link.computeLineDistances();
    }
    this.group.visible = true;
  }

  hide() {
    this.group.visible = false;
  }
}
