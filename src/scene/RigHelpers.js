import * as THREE from 'three';

const CLICK_TOLERANCE_PX = 5;
const ACCENT = 0x69c7d3;
const TARGET_COLOR = 0xf2b84b;
const TRAVEL_COLOR = 0xb48cff;
const LINE_SNAP_COLOR = 0x4cd38a;
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
      if (!down || !this.handler) return;
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
  // target: an object, a list of objects, or a function returning them (asked at each pick).
  // options:
  //   owner     – who is picking; another owner taking over calls the previous onRelease
  //   onRelease – called when someone else takes the picker
  //   hover     – hover(hit | null, event) on pointer moves
  //   filter    – filter(hit) → false to look past a hit (e.g. the arm that is moving)
  //   cursor    – CSS cursor while picking (default: crosshair)
  setHandler(handler, target, options = {}) {
    // Stopping hands the picker back to the default handler, if there is one. The owner stopped
    // by itself, so it is not told it was released.
    const stopping = !handler;
    if (stopping && this.fallback && this.options.owner !== this.fallback.options.owner) {
      ({ handler, target, options } = this.fallback);
    }
    const previous = this.options;
    const changingOwner = !stopping && previous.owner && previous.owner !== options.owner;
    this.handler = handler;
    this.targets = handler ? target : [];
    this.options = handler ? options : {};
    this.domElement.style.cursor = handler ? (options.cursor || 'crosshair') : '';
    if (changingOwner && handler) previous.onRelease?.();
  }

  // The handler that picks whenever nobody else does (e.g. selecting items in a scene). Pass null
  // to remove it.
  setDefault(handler, target, options = {}) {
    const wasDefault = this.fallback && this.options.owner === this.fallback.options.owner;
    this.fallback = handler ? { handler, target, options } : null;
    if (handler && (!this.handler || wasDefault)) this.setHandler(handler, target, options);
    else if (!handler && wasDefault) this.setHandler(null);
  }

  resolveTargets() {
    const targets = typeof this.targets === 'function' ? this.targets() : this.targets;
    return [targets].flat().filter(Boolean);
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
    const targets = this.resolveTargets();
    if (!targets.length) return null;
    const hits = this.raycaster.intersectObjects(targets, true);
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

// Arrow along the joint axis, a dot at the pivot, a ring for rotation, the travel of a slide
// (a bar from min to max with an end stop at each end), and an optional marker for a linked
// joint's target point. Drawn on top of the model.
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
    // Slide travel: where the part can go, measured from where it sits in the file.
    this.travel = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
      new THREE.LineBasicMaterial({ color: TRAVEL_COLOR, depthTest: false, transparent: true }),
    );
    this.travel.frustumCulled = false;
    this.stops = [0, 1].map(() => new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 0.15, 24), overlayMaterial(TRAVEL_COLOR)));
    this.group.add(this.arrow, this.pivot, this.ring, this.target, this.link, this.travel, ...this.stops);
    this.group.traverse((object) => { object.renderOrder = 1000; });
    scene.add(this.group);
  }

  // point/direction/target are in world space; size is the model's largest dimension.
  // travel (slides only): { from, to } in metres along direction, measured from point.
  show({ point, direction, type, target, size, travel = null }) {
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
    const showTravel = type === 'prismatic' && Boolean(travel);
    this.travel.visible = showTravel;
    this.stops.forEach((stop) => { stop.visible = showTravel; });
    if (showTravel) {
      const ends = [travel.from, travel.to].map((distance) => point.clone().addScaledVector(direction3, distance));
      const positions = this.travel.geometry.attributes.position;
      ends.forEach((end, index) => positions.setXYZ(index, end.x, end.y, end.z));
      positions.needsUpdate = true;
      this.stops.forEach((stop, index) => {
        stop.position.copy(ends[index]);
        stop.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction3);
        stop.scale.setScalar(size * 0.025);
      });
    }
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

// Live preview for "Two points": a dot under the pointer, then a line with an arrowhead from
// the first point to the pointer. Green when the line is lined up with one of the model's axes.
export class LinePickPreview {
  constructor(scene) {
    this.group = new THREE.Group();
    this.group.name = 'LinePickPreview';
    this.group.visible = false;
    this.material = overlayMaterial(ACCENT);
    this.start = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), this.material);
    this.end = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), this.material);
    this.head = new THREE.Mesh(new THREE.ConeGeometry(1, 2.6, 16), this.material);
    this.line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
      new THREE.LineBasicMaterial({ color: ACCENT, depthTest: false, transparent: true }),
    );
    this.line.frustumCulled = false;
    this.group.add(this.start, this.end, this.head, this.line);
    this.group.traverse((object) => { object.renderOrder = 1002; });
    scene.add(this.group);
  }

  // World space. start null: only the dot under the pointer. size: the model's largest dimension.
  show({ start, end, snapped = false, size }) {
    const color = snapped ? LINE_SNAP_COLOR : ACCENT;
    this.material.color.setHex(color);
    this.line.material.color.setHex(color);
    const radius = size * 0.013;
    this.end.position.copy(end);
    this.end.scale.setScalar(radius);
    const drawLine = Boolean(start) && start.distanceTo(end) > radius;
    this.start.visible = Boolean(start);
    this.line.visible = drawLine;
    this.head.visible = drawLine;
    this.end.visible = !drawLine;
    if (start) {
      this.start.position.copy(start);
      this.start.scale.setScalar(radius);
    }
    if (drawLine) {
      const direction = end.clone().sub(start).normalize();
      const positions = this.line.geometry.attributes.position;
      positions.setXYZ(0, start.x, start.y, start.z);
      positions.setXYZ(1, end.x, end.y, end.z);
      positions.needsUpdate = true;
      this.head.position.copy(end).addScaledVector(direction, -radius * 2);
      this.head.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);
      this.head.scale.setScalar(radius * 1.5);
    }
    this.group.visible = true;
  }

  hide() {
    this.group.visible = false;
  }
}

// Live preview for "find the axis on the model": tints the surface under the pointer and
// draws the axis the joint would turn around (or slide along) through its pivot, with a
// ring the size of a round shaft or hole.
export class SurfacePreview {
  constructor(scene) {
    this.scene = scene;
    this.patch = new THREE.Mesh(new THREE.BufferGeometry(), tintMaterial(TARGET_COLOR, 0.55, false));
    this.patch.matrixAutoUpdate = false;
    this.patch.renderOrder = 1000;
    this.patch.raycast = () => {};
    this.axisLine = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
      new THREE.LineDashedMaterial({ color: ACCENT, depthTest: false, transparent: true }),
    );
    this.axisLine.frustumCulled = false;
    this.pivot = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), overlayMaterial(ACCENT));
    this.ring = new THREE.Mesh(new THREE.TorusGeometry(1, 0.04, 8, 64), overlayMaterial(ACCENT));
    this.group = new THREE.Group();
    this.group.name = 'SurfacePreview';
    this.group.add(this.patch, this.axisLine, this.pivot, this.ring);
    this.group.traverse((object) => { object.renderOrder = Math.max(object.renderOrder, 1000); });
    this.group.visible = false;
    this.key = null;
    scene.add(this.group);
  }

  // mesh: the hovered mesh; result: analyzeSurface(); world*: pivot/axis in world space.
  show({ mesh, result, worldPivot, worldAxis, worldRadius, size }) {
    const key = `${mesh.uuid}:${result.triangles[0]}:${result.triangles.length}`;
    if (key !== this.key) {
      this.key = key;
      this.patch.geometry.dispose();
      this.patch.geometry = patchGeometry(mesh.geometry, result.triangles);
    }
    this.patch.matrix.copy(mesh.matrixWorld);
    this.patch.matrixWorldNeedsUpdate = true;

    const half = size * 0.45;
    const positions = this.axisLine.geometry.attributes.position;
    positions.setXYZ(0, ...worldPivot.clone().addScaledVector(worldAxis, -half).toArray());
    positions.setXYZ(1, ...worldPivot.clone().addScaledVector(worldAxis, half).toArray());
    positions.needsUpdate = true;
    this.axisLine.material.dashSize = size * 0.025;
    this.axisLine.material.gapSize = size * 0.015;
    this.axisLine.computeLineDistances();

    this.pivot.position.copy(worldPivot);
    this.pivot.scale.setScalar(size * 0.012);
    this.ring.visible = Boolean(worldRadius);
    if (worldRadius) {
      this.ring.position.copy(worldPivot);
      this.ring.scale.setScalar(worldRadius * 1.08);
      this.ring.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), worldAxis);
    }
    this.group.visible = true;
  }

  hide() {
    this.group.visible = false;
  }
}

function patchGeometry(source, triangles) {
  const position = source.attributes.position;
  const index = source.index;
  const values = new Float32Array(triangles.length * 9);
  triangles.forEach((triangle, t) => {
    for (let corner = 0; corner < 3; corner += 1) {
      const vertex = index ? index.getX(triangle * 3 + corner) : triangle * 3 + corner;
      values.set([position.getX(vertex), position.getY(vertex), position.getZ(vertex)], (t * 3 + corner) * 3);
    }
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(values, 3));
  return geometry;
}
