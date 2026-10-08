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
// One tool owns the picker at a time (Joint Setup, Reach…); taking it over tells the previous
// owner through its onRelease callback, so only one click mode is ever active.
export class ViewportPicker {
  constructor({ domElement, camera }) {
    this.domElement = domElement;
    this.camera = camera;
    this.raycaster = new THREE.Raycaster();
    this.handler = null;
    this.targets = [];
    this.options = {};
    this.down = null;
    this.hoverEvent = null;

    domElement.addEventListener('pointerdown', (event) => {
      if (event.button === 0) this.down = { x: event.clientX, y: event.clientY };
    });
    domElement.addEventListener('pointerup', (event) => {
      const down = this.down;
      this.down = null;
      if (!down || !this.handler || !this.targets.length) return;
      if (Math.hypot(event.clientX - down.x, event.clientY - down.y) > CLICK_TOLERANCE_PX) return;
      this.handler(this.pick(event), event);
    });
    // Hover is reported at most once per frame.
    domElement.addEventListener('pointermove', (event) => {
      if (!this.options.hover || event.buttons) return;
      const pending = this.hoverEvent;
      this.hoverEvent = event;
      if (!pending) requestAnimationFrame(() => {
        const latest = this.hoverEvent;
        this.hoverEvent = null;
        if (latest && this.options.hover) this.options.hover(this.pick(latest), latest);
      });
    });
    domElement.addEventListener('pointerleave', () => {
      this.hoverEvent = null;
      this.options.hover?.(null, null);
    });
  }

  // handler(hit | null, event) is called for each click; pass null to stop picking.
  // target: an object or a list of objects to hit. options:
  //   owner     – who is picking; another owner taking over calls the previous onRelease
  //   onRelease – called when someone else takes the picker
  //   hover     – hover(hit | null, event) on pointer moves
  //   filter    – filter(hit) → false to look past a hit (e.g. the arm that is moving)
  setHandler(handler, target, options = {}) {
    const previous = this.options;
    const changingOwner = previous.owner && previous.owner !== options.owner;
    this.handler = handler;
    this.targets = handler ? [target].flat().filter(Boolean) : [];
    this.options = handler ? options : {};
    this.domElement.style.cursor = handler ? 'crosshair' : '';
    if (changingOwner && handler) previous.onRelease?.();
  }

  get owner() {
    return this.options.owner || null;
  }

  pick(event) {
    const rect = this.domElement.getBoundingClientRect();
    const pointer = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(pointer, this.camera);
    const hits = this.raycaster.intersectObjects(this.targets, true);
    const { filter } = this.options;
    return hits.find((hit) => hit.object.isMesh && hit.object.visible && hit.faceIndex !== undefined
      && (!filter || filter(hit))) || null;
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

const TOOL_COLOR = 0xff78c8;
export const REACH_COLORS = { ok: 0x4cd38a, warn: 0xf2b84b, fail: 0xf06464 };

// Tool points (Reach): a dot at each tool point and an arrow for the way it points.
export class ToolMarkers {
  constructor(scene) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.group.name = 'ToolMarkers';
    this.group.visible = false;
    scene.add(this.group);
    this.items = [];
  }

  // tools: [{ position, direction, highlighted }] in world space; size = model's largest dimension.
  show(tools, size) {
    while (this.items.length < tools.length) {
      const dot = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), overlayMaterial(TOOL_COLOR));
      const arrow = new THREE.ArrowHelper(new THREE.Vector3(0, -1, 0), new THREE.Vector3(), 1, TOOL_COLOR);
      [arrow.line.material, arrow.cone.material].forEach((material) => {
        material.depthTest = false;
        material.transparent = true;
      });
      dot.renderOrder = 1001;
      arrow.traverse((object) => { object.renderOrder = 1001; });
      this.group.add(dot, arrow);
      this.items.push({ dot, arrow });
    }
    this.items.forEach(({ dot, arrow }, index) => {
      const tool = tools[index];
      dot.visible = Boolean(tool);
      arrow.visible = Boolean(tool);
      if (!tool) return;
      const length = size * 0.12;
      dot.position.copy(tool.position);
      dot.scale.setScalar(size * (tool.highlighted ? 0.014 : 0.01));
      arrow.position.copy(tool.position);
      arrow.setDirection(tool.direction.clone().normalize());
      arrow.setLength(length, length * 0.25, length * 0.12);
    });
    this.group.visible = tools.length > 0;
  }

  hide() {
    this.group.visible = false;
  }
}

// Where Reach is aiming: a dot coloured by whether the tool can get there, and an arrow showing
// the way the tool will point (none for "any angle").
export class ReachMarker {
  constructor(scene) {
    this.group = new THREE.Group();
    this.group.name = 'ReachMarker';
    this.group.visible = false;
    this.dot = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 14), overlayMaterial(REACH_COLORS.ok));
    this.ring = new THREE.Mesh(new THREE.TorusGeometry(1, 0.12, 8, 40), overlayMaterial(REACH_COLORS.ok));
    this.arrow = new THREE.ArrowHelper(new THREE.Vector3(0, -1, 0), new THREE.Vector3(), 1, REACH_COLORS.ok);
    [this.arrow.line.material, this.arrow.cone.material].forEach((material) => {
      material.depthTest = false;
      material.transparent = true;
    });
    this.group.add(this.dot, this.ring, this.arrow);
    this.group.traverse((object) => { object.renderOrder = 1002; });
    scene.add(this.group);
  }

  // state: 'ok' | 'warn' | 'fail'; direction: wanted tool direction (or null); normal: surface normal.
  show({ point, state, direction, normal, size }) {
    const color = REACH_COLORS[state] ?? REACH_COLORS.ok;
    [this.dot.material, this.ring.material, this.arrow.line.material, this.arrow.cone.material].forEach((material) => material.color.setHex(color));
    this.dot.position.copy(point);
    this.dot.scale.setScalar(size * 0.012);
    this.ring.position.copy(point);
    this.ring.scale.setScalar(size * 0.035);
    this.ring.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), (normal || new THREE.Vector3(0, 1, 0)).clone().normalize());
    this.arrow.visible = Boolean(direction);
    if (direction) {
      const length = size * 0.1;
      // The arrow ends at the point, showing the way the tool comes in.
      this.arrow.position.copy(point).addScaledVector(direction, -length);
      this.arrow.setDirection(direction.clone().normalize());
      this.arrow.setLength(length, length * 0.3, length * 0.15);
    }
    this.group.visible = true;
  }

  hide() {
    this.group.visible = false;
  }
}
