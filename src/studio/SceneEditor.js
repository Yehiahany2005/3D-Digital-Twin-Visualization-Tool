import * as THREE from 'three';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { cloneScene, dependentsOf, emptyScene, newId, ROTATION_ORDER, uniqueName } from './SceneDocument.js';
import { disposeInstance } from './ModelTemplates.js';
import { getComponent, resolveParams } from './catalog/index.js';
import { alignment, anchorNamed, anchorsOf, findSnap, worldOf } from './Anchors.js';

const D2R = Math.PI / 180;
const HISTORY_LIMIT = 100;

function round(value, digits = 4) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

// What has to be rebuilt from scratch when it changes (a different model, other parameters).
function buildSignature(item) {
  return JSON.stringify([item.source.kind, item.source.id, item.params || null]);
}

// A grey wire box that stands in for a model that couldn't be loaded (e.g. a file that is not on
// this computer), so the rest of the scene still opens and the item can be relinked or removed.
// Green ring and dot on the anchor a dragged item will snap to.
function createSnapMarker() {
  const group = new THREE.Group();
  group.name = 'SnapMarker';
  const material = new THREE.MeshBasicMaterial({ color: 0x4cd38a, depthTest: false, transparent: true });
  const dot = new THREE.Mesh(new THREE.SphereGeometry(0.05, 16, 12), material);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.16, 0.012, 8, 40), material);
  group.add(dot, ring);
  group.traverse((object) => { object.renderOrder = 1003; });
  group.visible = false;
  return group;
}

const toVector = (values) => new THREE.Vector3(...values);
const toQuaternion = (degrees) => new THREE.Quaternion().setFromEuler(new THREE.Euler(degrees[0] * D2R, degrees[1] * D2R, degrees[2] * D2R, ROTATION_ORDER));

function createPlaceholder() {
  const box = new THREE.Mesh(
    new THREE.BoxGeometry(0.6, 0.6, 0.6).translate(0, 0.3, 0),
    new THREE.MeshBasicMaterial({ color: 0x8a939a, wireframe: true }),
  );
  box.name = 'Missing model';
  return box;
}

// The scene being edited: keeps the 3D objects in step with the scene document, and holds the
// selection, the move/turn gizmo and undo/redo. Every change goes through commit(), so undo,
// saving and the panels always see the same document.
//
// Each item gets a root group (its placement); the model or component sits inside it:
//   item root (position, rotation) → asset.model (unit scale, base motion) → … → file content
export class SceneEditor {
  constructor({ scene, camera, domElement, controls, templates, resolveConfig, outline }) {
    this.scene = scene;
    this.camera = camera;
    this.controls = controls;
    this.templates = templates;
    this.resolveConfig = resolveConfig;
    this.outline = outline;
    this.root = new THREE.Group();
    this.root.name = 'SceneItems';
    this.root.visible = false;
    scene.add(this.root);

    this.document = emptyScene();
    this.runtimes = new Map();
    this.selectedId = null;
    this.undoStack = [];
    this.redoStack = [];
    this.listeners = new Set();
    this.tool = 'select';
    this.snap = 0.1;
    this.rotationSnapDeg = 15;
    this.freeRotation = false;
    this.playing = false;

    this.gizmo = new TransformControls(camera, domElement);
    this.gizmo.setSpace('world');
    this.gizmoHelper = this.gizmo.getHelper();
    this.gizmoHelper.visible = false;
    scene.add(this.gizmoHelper);
    this.gizmo.addEventListener('dragging-changed', (event) => {
      controls.enabled = !event.value;
      if (event.value) this.dragStart = this.selectedRuntime?.root.matrix.clone();
      else this.finishDrag();
    });
    this.gizmo.addEventListener('objectChange', () => {
      this.updateSnap();
      this.emit('dragging');
    });
    this.applyGizmoSettings();
    this.snapMarker = createSnapMarker();
    scene.add(this.snapMarker);
    this.snapCandidate = null;
    // Holding Alt while dragging moves freely, without snapping.
    this.altHeld = false;
    window.addEventListener('keydown', (event) => { if (event.key === 'Alt') this.altHeld = true; });
    window.addEventListener('keyup', (event) => { if (event.key === 'Alt') this.altHeld = false; });
    window.addEventListener('blur', () => { this.altHeld = false; });
  }

  // ---- Events -------------------------------------------------------------------------------

  // listener(type): 'document' (items changed), 'selection', 'item-ready', 'dragging', 'history'
  onChange(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(type, detail) {
    this.listeners.forEach((listener) => listener(type, detail));
  }

  // ---- Document & history ----------------------------------------------------------------------

  get items() {
    return this.document.items;
  }

  item(id) {
    return this.document.items.find((item) => item.id === id) || null;
  }

  // Opens a document (a loaded scene): history starts over.
  async setDocument(document) {
    this.select(null);
    this.document = cloneScene(document);
    this.undoStack = [];
    this.redoStack = [];
    await this.reconcile({ applyPoses: true });
    this.emit('document');
    this.emit('history');
  }

  // The one way to change the scene: mutate(document) edits a copy, which becomes current.
  commit(label, mutate) {
    // While the scene plays nothing may change: stopping puts everything back anyway.
    if (this.playing) {
      this.emit('status', 'Stop the simulation to change the scene.');
      return { result: null, ready: Promise.resolve() };
    }
    this.capturePoses();
    const before = cloneScene(this.document);
    const next = cloneScene(this.document);
    const result = mutate(next);
    this.undoStack.push({ label, document: before });
    if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
    this.redoStack = [];
    this.document = next;
    const reconciling = this.reconcile({ applyPoses: false });
    if (this.selectedId && !this.item(this.selectedId)) this.select(null);
    // Locking, mounting or attaching the selected item changes whether it can be moved.
    else this.updateGizmo();
    this.emit('document');
    this.emit('history');
    return { result, ready: reconciling };
  }

  get canUndo() {
    return this.undoStack.length > 0;
  }

  get canRedo() {
    return this.redoStack.length > 0;
  }

  undo() {
    if (this.playing) return;
    this.travel(this.undoStack, this.redoStack);
  }

  redo() {
    if (this.playing) return;
    this.travel(this.redoStack, this.undoStack);
  }

  travel(from, to) {
    const step = from.pop();
    if (!step) return;
    this.capturePoses();
    to.push({ label: step.label, document: cloneScene(this.document) });
    this.document = step.document;
    this.reconcile({ applyPoses: true });
    if (this.selectedId && !this.item(this.selectedId)) this.select(null);
    else this.updateGizmo();
    this.emit('document');
    this.emit('history');
  }

  get undoLabel() {
    return this.undoStack[this.undoStack.length - 1]?.label || null;
  }

  get redoLabel() {
    return this.redoStack[this.redoStack.length - 1]?.label || null;
  }

  // Writes where every machine's joints are now into a document (poses change without commits:
  // jogging, Reach, sequences).
  capturePoses(document = this.document) {
    document.items.forEach((item) => {
      const asset = this.runtimes.get(item.id)?.asset;
      if (!asset?.rig?.joints.length) return;
      const pose = {};
      Object.entries(asset.rig.getPose()).forEach(([id, value]) => {
        const joint = asset.rig.jointsById.get(id);
        if (joint && Math.abs(value - joint.zero) > 1e-6) pose[id] = round(value, 3);
      });
      if (Object.keys(pose).length) item.pose = pose;
      else delete item.pose;
    });
  }

  // ---- Keeping the 3D objects in step with the document ------------------------------------

  // Creates, rebuilds, updates and removes items so the 3D view matches the document. Models load
  // asynchronously; the returned promise resolves once everything asked for is in place.
  reconcile({ applyPoses }) {
    const wanted = new Map(this.document.items.map((item) => [item.id, item]));
    [...this.runtimes.keys()].forEach((id) => {
      if (!wanted.has(id)) this.destroyRuntime(id);
    });
    const loads = [];
    this.document.items.forEach((item) => {
      let runtime = this.runtimes.get(item.id);
      const signature = buildSignature(item);
      if (runtime && runtime.signature !== signature) {
        this.destroyRuntime(item.id);
        runtime = null;
      }
      if (!runtime) {
        runtime = this.createRuntime(item, signature);
        loads.push(runtime.loading.then(() => {
          this.applyItem(runtime, this.item(item.id), { applyPoses: true });
          this.applyLinks();
          // A rebuilt selected item (new parameters) keeps its gizmo and outline.
          if (runtime.id === this.selectedId) this.updateGizmo();
        }));
        if (runtime.id === this.selectedId) this.updateGizmo();
      }
      this.applyItem(runtime, item, { applyPoses });
    });
    this.applyLinks();
    return Promise.all(loads);
  }

  createRuntime(item, signature) {
    const root = new THREE.Group();
    root.name = item.name;
    root.userData.sceneItemId = item.id;
    this.root.add(root);
    const runtime = { id: item.id, root, signature, kind: 'loading', asset: null, component: null, content: null, error: null };
    runtime.loading = this.buildContent(runtime, item).catch((error) => {
      // A model file that isn't on this computer is expected (shared scenes); anything else is a bug.
      if (error.missingModel) console.warn(`Scene item "${item.name}": ${error.message}`);
      else console.error(`Scene item "${item.name}" could not be built.`, error);
      runtime.error = error;
      if (!runtime.destroyed) this.showMissing(runtime);
    });
    this.runtimes.set(item.id, runtime);
    return runtime;
  }

  async buildContent(runtime, item) {
    if (item.source.kind === 'catalog') {
      const definition = getComponent(item.source.id);
      if (!definition) throw new Error(`Unknown component "${item.source.id}".`);
      const built = await definition.build(resolveParams(definition, item.params));
      if (runtime.destroyed) {
        built.dispose?.();
        return;
      }
      runtime.kind = 'component';
      runtime.definition = definition;
      runtime.component = built;
      runtime.content = built.root;
    } else {
      const config = await this.resolveConfig(item.source);
      if (!config) throw Object.assign(new Error(`The model "${item.source.name || item.source.id}" is not on this computer.`), { missingModel: true });
      const asset = await this.templates.createInstance(config);
      if (runtime.destroyed) {
        disposeInstance(asset);
        return;
      }
      runtime.kind = 'model';
      runtime.asset = asset;
      runtime.content = asset.model;
    }
    runtime.root.add(runtime.content);
    this.emit('item-ready', runtime);
  }

  showMissing(runtime) {
    runtime.kind = 'missing';
    runtime.content = createPlaceholder();
    runtime.root.add(runtime.content);
    this.emit('item-ready', runtime);
  }

  destroyRuntime(id) {
    const runtime = this.runtimes.get(id);
    if (!runtime) return;
    runtime.destroyed = true;
    if (this.gizmo.object === runtime.root) this.gizmo.detach();
    if (runtime.asset) disposeInstance(runtime.asset);
    runtime.component?.dispose?.();
    runtime.root.removeFromParent();
    this.runtimes.delete(id);
  }

  applyItem(runtime, item, { applyPoses }) {
    if (!runtime || !item || runtime.destroyed) return;
    runtime.root.name = item.name;
    runtime.root.visible = !item.hidden;
    if (!item.mount && !item.attach) {
      runtime.root.position.fromArray(item.position);
      runtime.root.rotation.set(item.rotation[0] * D2R, item.rotation[1] * D2R, item.rotation[2] * D2R, ROTATION_ORDER);
    }
    const asset = runtime.asset;
    if (asset && applyPoses) {
      const rest = Object.fromEntries(asset.rig.joints.filter((joint) => !joint.driven).map((joint) => [joint.id, joint.zero]));
      asset.player.stop();
      asset.rig.setValues({ ...rest, ...(item.pose || {}) });
    }
    if (asset?.animationController) {
      const controller = asset.animationController;
      if (item.animation && controller.actions.has(item.animation)) {
        if (controller.activeClipName !== item.animation) controller.play(item.animation);
      } else if (controller.activeClipName) {
        controller.stop();
        controller.activeClipName = null;
      }
    }
    runtime.component?.setVisualState?.(item);
  }

  // Mounted and attached items hang under what they follow: a tool under the robot joint that
  // carries its flange, an attached item under its target (or one of its joints). Everything
  // else sits directly in the scene at its own placement.
  applyLinks() {
    this.document.items.forEach((item) => {
      const runtime = this.runtimes.get(item.id);
      if (!runtime || runtime.destroyed) return;
      const link = item.mount || item.attach;
      const target = link ? this.runtimes.get(link.to) : null;
      let parent = this.root;
      let local = null;
      if (link && target && !target.destroyed && target.kind !== 'loading') {
        if (item.mount) {
          const targetAnchor = anchorNamed(target, item.mount.anchor);
          const own = runtime.kind === 'component' ? runtime.component.anchors?.[item.mount.own] : null;
          if (targetAnchor && own) {
            parent = targetAnchor.object;
            local = alignment({ position: toVector(own.position), direction: toVector(own.direction) }, targetAnchor);
          }
        } else {
          const joint = item.attach.joint ? target.asset?.rig?.jointsById.get(item.attach.joint) : null;
          parent = joint?.group || target.root;
          local = { position: toVector(item.attach.position), quaternion: toQuaternion(item.attach.rotation) };
        }
      }
      // A link whose target isn't ready yet: wait out of sight rather than flash at the origin.
      runtime.root.visible = !item.hidden && (!link || Boolean(local));
      if (runtime.root.parent !== parent) parent.add(runtime.root);
      if (local) {
        runtime.root.position.copy(local.position);
        runtime.root.quaternion.copy(local.quaternion);
      } else if (!link) {
        runtime.root.position.fromArray(item.position);
        runtime.root.rotation.set(item.rotation[0] * D2R, item.rotation[1] * D2R, item.rotation[2] * D2R, ROTATION_ORDER);
      }
    });
    this.applyMountedTools();
  }

  // A machine with a tool mounted on it reaches with that tool's tip. The override belongs to
  // this copy only and is never saved into the model's rig.
  applyMountedTools() {
    this.runtimes.forEach((runtime) => {
      const asset = runtime.asset;
      if (!asset?.rig) return;
      const mounted = this.items.find((item) => item.mount?.to === runtime.id && item.mount.anchor === 'tool');
      const toolRuntime = mounted && this.runtimes.get(mounted.id);
      const tip = toolRuntime && anchorsOf(toolRuntime).find((anchor) => anchor.type === 'tool-tip');
      const flange = tip && anchorNamed(runtime, 'tool');
      if (tip && flange && toolRuntime.root.parent === flange.object) {
        asset.originalTools ??= structuredClone(asset.rig.tools);
        asset.flangeTool ??= asset.originalTools[0];
        const group = flange.object;
        toolRuntime.root.updateMatrix();
        const local = tip.position.clone().applyMatrix4(toolRuntime.root.matrix);
        const localDirection = tip.direction.clone().applyQuaternion(toolRuntime.root.quaternion);
        const { point, direction } = asset.rig.withRestPose(() => {
          group.updateMatrixWorld(true);
          const contentInverse = asset.content.matrixWorld.clone().invert();
          return {
            point: local.clone().applyMatrix4(group.matrixWorld).applyMatrix4(contentInverse),
            direction: localDirection.clone().transformDirection(group.matrixWorld).transformDirection(contentInverse),
          };
        });
        const tool = {
          id: 'mounted_tool',
          name: `${mounted.name} tip`,
          joint: flange.jointId,
          frame: 'model',
          point: point.toArray().map((value) => Math.round(value * 1e6) / 1e6),
          direction: direction.toArray().map((value) => Math.round(value * 1e6) / 1e6),
        };
        asset.toolLockedBy = mounted.name;
        if (JSON.stringify(asset.rig.tools) !== JSON.stringify([tool])) asset.rig.setTools([tool]);
      } else if (asset.originalTools) {
        const original = asset.originalTools;
        delete asset.originalTools;
        delete asset.toolLockedBy;
        asset.rig.setTools(original);
      }
    });
  }

  // ---- Snapping while dragging ------------------------------------------------------------------------

  updateSnap() {
    const runtime = this.selectedRuntime;
    const candidate = runtime && !this.altHeld && this.tool === 'move'
      ? findSnap(runtime, this.runtimes, { tolerance: Math.max(0.35, this.snap * 2), exclude: dependentsOf(this.document, runtime.id) })
      : null;
    this.snapCandidate = candidate;
    this.snapMarker.visible = Boolean(candidate);
    if (candidate) {
      this.snapMarker.position.copy(candidate.targetWorld.position);
      this.snapMarker.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), candidate.targetWorld.direction);
      const target = this.item(candidate.targetId);
      this.emit('status', candidate.target.type === 'tool-flange'
        ? `Release to mount on ${target?.name} (hold Alt to place freely).`
        : `Release to line up with ${target?.name} (hold Alt to place freely).`);
    }
  }

  // ---- Mounting and attaching ---------------------------------------------------------------------------

  // Mounts an item's anchor onto another item's anchor (a gripper onto a robot's flange).
  mountItem(id, targetId, targetAnchor = 'tool', ownAnchor = null) {
    const runtime = this.runtimes.get(id);
    const own = ownAnchor || anchorsOf(runtime).find((anchor) => anchor.type === 'tool-mount')?.name;
    const item = this.item(id);
    const target = this.item(targetId);
    if (!item || !target || !own) return false;
    this.commit(`Mount ${item.name} on ${target.name}`, (document) => {
      const editable = document.items.find((candidate) => candidate.id === id);
      delete editable.attach;
      editable.mount = { to: targetId, anchor: targetAnchor, own };
    });
    return true;
  }

  // Makes an item follow another item (or one of its joints), staying exactly where it is now.
  attachItem(id, targetId, jointId = null) {
    const runtime = this.runtimes.get(id);
    const target = this.runtimes.get(targetId);
    const item = this.item(id);
    if (!runtime || !target || !item || dependentsOf(this.document, id).has(targetId) || id === targetId) return false;
    const parent = jointId ? target.asset?.rig?.jointsById.get(jointId)?.group : target.root;
    if (!parent) return false;
    parent.updateMatrixWorld(true);
    runtime.root.updateMatrixWorld(true);
    const relative = parent.matrixWorld.clone().invert().multiply(runtime.root.matrixWorld);
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    relative.decompose(position, quaternion, new THREE.Vector3());
    const euler = new THREE.Euler().setFromQuaternion(quaternion, ROTATION_ORDER);
    const label = jointId ? `${this.item(targetId).name} › ${target.asset.rig.jointsById.get(jointId).name}` : this.item(targetId).name;
    this.commit(`Attach ${item.name} to ${label}`, (document) => {
      const editable = document.items.find((candidate) => candidate.id === id);
      delete editable.mount;
      editable.attach = {
        to: targetId,
        joint: jointId,
        position: position.toArray().map((value) => round(value)),
        rotation: [euler.x, euler.y, euler.z].map((value) => round(value / D2R, 3)),
      };
    });
    return true;
  }

  // Unmounts or detaches an item, leaving it where it is in the world.
  unlinkItem(id) {
    const runtime = this.runtimes.get(id);
    const item = this.item(id);
    if (!runtime || !item || (!item.mount && !item.attach)) return;
    runtime.root.updateMatrixWorld(true);
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    runtime.root.matrixWorld.decompose(position, quaternion, new THREE.Vector3());
    const euler = new THREE.Euler().setFromQuaternion(quaternion, ROTATION_ORDER);
    this.commit(`${item.mount ? 'Unmount' : 'Detach'} ${item.name}`, (document) => {
      const editable = document.items.find((candidate) => candidate.id === id);
      delete editable.mount;
      delete editable.attach;
      editable.position = position.toArray().map((value) => round(value));
      editable.rotation = [euler.x, euler.y, euler.z].map((value) => round(value / D2R, 3));
    });
  }

  // ---- Commands ----------------------------------------------------------------------------------

  // Adds an item; position defaults to the origin. Returns its id once committed.
  addItem({ source, name, position = [0, 0, 0], rotation = [0, 0, 0], params, select = true, label }) {
    const id = newId(source.kind === 'catalog' ? source.id : 'model');
    const { ready } = this.commit(label || `Add ${name}`, (document) => {
      const item = { id, name: uniqueName(document, name), source: { ...source }, position: position.map((value) => round(value)), rotation };
      if (params) item.params = { ...params };
      document.items.push(item);
    });
    if (select) this.select(id);
    return { id, ready };
  }

  updateItem(id, patch, label = 'Change') {
    if (!this.item(id)) return;
    this.commit(label, (document) => {
      const item = document.items.find((candidate) => candidate.id === id);
      Object.entries(patch).forEach(([key, value]) => {
        if (value === undefined) delete item[key];
        else item[key] = value;
      });
    });
  }

  // Removes items and everything mounted on or attached to them.
  removeItems(ids) {
    const doomed = new Set(ids);
    ids.forEach((id) => dependentsOf(this.document, id).forEach((dependent) => doomed.add(dependent)));
    if (!doomed.size) return;
    const names = this.items.filter((item) => doomed.has(item.id)).map((item) => item.name);
    this.commit(doomed.size === 1 ? `Delete ${names[0]}` : `Delete ${doomed.size} items`, (document) => {
      document.items = document.items.filter((item) => !doomed.has(item.id));
    });
  }

  duplicate(id) {
    const original = this.item(id);
    if (!original) return null;
    this.capturePoses();
    const copy = structuredClone(this.item(id));
    delete copy.mount;
    delete copy.attach;
    const root = this.runtimes.get(id)?.root;
    // A mounted item's copy starts free, next to where the original is now.
    if (root && (original.mount || original.attach)) {
      root.updateMatrixWorld(true);
      copy.position = root.getWorldPosition(new THREE.Vector3()).toArray();
    }
    copy.position = [copy.position[0] + Math.max(this.snap, 0.5), copy.position[1], copy.position[2] + Math.max(this.snap, 0.5)].map((value) => round(value));
    return this.addItem({ ...copy, name: original.name, label: `Duplicate ${original.name}` }).id;
  }

  // ---- Selection & gizmo ----------------------------------------------------------------------------

  get selectedRuntime() {
    return this.selectedId ? this.runtimes.get(this.selectedId) || null : null;
  }

  get selectedItem() {
    return this.selectedId ? this.item(this.selectedId) : null;
  }

  select(id) {
    if (id && !this.item(id)) id = null;
    if (this.selectedId === id) return;
    this.selectedId = id;
    this.updateGizmo();
    this.emit('selection');
  }

  // The item a clicked object belongs to (the nearest item root above it).
  itemIdFor(object) {
    for (let current = object; current && current !== this.root; current = current.parent) {
      if (current.userData.sceneItemId) return current.userData.sceneItemId;
    }
    return null;
  }

  setTool(tool) {
    this.tool = tool;
    this.updateGizmo();
    this.emit('selection');
  }

  setSnap(metres) {
    this.snap = metres;
    this.applyGizmoSettings();
  }

  setFreeRotation(free) {
    this.freeRotation = free;
    this.applyGizmoSettings();
    this.emit('selection');
  }

  applyGizmoSettings() {
    this.gizmo.setTranslationSnap(this.snap > 0 ? this.snap : null);
    this.gizmo.setRotationSnap(this.snap > 0 ? this.rotationSnapDeg * D2R : null);
    const rotating = this.tool === 'rotate';
    this.gizmo.setMode(rotating ? 'rotate' : 'translate');
    // Turning on the floor uses only the vertical axis; free rotation shows all three rings.
    this.gizmo.showX = !rotating || this.freeRotation;
    this.gizmo.showZ = !rotating || this.freeRotation;
    this.gizmo.showY = true;
    this.gizmo.setSpace(rotating && this.freeRotation ? 'local' : 'world');
  }

  // Why the selected item can't be moved with the gizmo right now, or null.
  moveBlocker(item = this.selectedItem) {
    if (!item) return 'Nothing selected.';
    if (item.locked) return `"${item.name}" is locked.`;
    if (item.mount) return `"${item.name}" is mounted; unmount it to move it on its own.`;
    if (item.attach) return `"${item.name}" follows another item; detach it to move it on its own.`;
    if (this.playing) return 'Stop the simulation to move things.';
    return null;
  }

  updateGizmo() {
    this.applyGizmoSettings();
    const runtime = this.selectedRuntime;
    const usable = runtime && this.tool !== 'select' && !this.moveBlocker() && this.root.visible;
    if (usable) this.gizmo.attach(runtime.root);
    else this.gizmo.detach();
    this.gizmoHelper.visible = Boolean(usable);
    this.outline.set(runtime && this.root.visible ? [runtime.root] : []);
  }

  // The gizmo is in use or under the pointer: clicks belong to it, not to selection.
  get gizmoBusy() {
    return this.gizmo.dragging || (this.gizmo.object && this.gizmo.axis !== null);
  }

  finishDrag() {
    const runtime = this.selectedRuntime;
    const snap = this.snapCandidate;
    this.snapCandidate = null;
    this.snapMarker.visible = false;
    if (!runtime || !this.dragStart) return;
    const moved = !runtime.root.matrix.equals(this.dragStart);
    this.dragStart = null;
    if (!moved) return;
    if (snap && snap.target.type === 'tool-flange') {
      this.mountItem(runtime.id, snap.targetId, snap.target.name, snap.own.name);
      return;
    }
    if (snap) {
      // Line the anchors up: the item turns about the vertical so its end faces the other one.
      const { position, quaternion } = alignment(
        { position: snap.own.position, direction: snap.own.direction },
        snap.targetWorld,
        { upright: true },
      );
      runtime.root.position.copy(position);
      runtime.root.quaternion.copy(quaternion);
      const placement = this.placementOf(runtime.root);
      this.updateItem(runtime.id, placement, `Snap ${this.selectedItem.name} to ${this.item(snap.targetId).name}`);
      return;
    }
    const { position, rotation } = this.placementOf(runtime.root);
    this.updateItem(runtime.id, { position, rotation }, this.tool === 'rotate' ? `Turn ${this.selectedItem.name}` : `Move ${this.selectedItem.name}`);
  }

  // Position and rotation (degrees) of an item root, as stored in the document.
  placementOf(root) {
    const euler = new THREE.Euler().setFromQuaternion(root.quaternion, ROTATION_ORDER);
    return {
      position: root.position.toArray().map((value) => round(value)),
      rotation: [euler.x, euler.y, euler.z].map((value) => round(value / D2R, 3)),
    };
  }

  // Nudges the selection by the snap size (arrow keys) or turns it (R).
  nudge(dx, dz) {
    const item = this.selectedItem;
    if (!item || this.moveBlocker(item)) return;
    const step = this.snap > 0 ? this.snap : 0.05;
    const position = [item.position[0] + dx * step, item.position[1], item.position[2] + dz * step].map((value) => round(value));
    this.updateItem(item.id, { position }, `Move ${item.name}`);
  }

  turn(degrees) {
    const item = this.selectedItem;
    if (!item || this.moveBlocker(item)) return;
    const yaw = ((item.rotation[1] + degrees + 540) % 360) - 180;
    this.updateItem(item.id, { rotation: [item.rotation[0], round(yaw, 3), item.rotation[2]] }, `Turn ${item.name}`);
  }

  // ---- Showing / hiding the scene (switching modes) -----------------------------------------------------

  setShown(shown) {
    this.root.visible = shown;
    if (!shown) {
      this.gizmo.detach();
      this.gizmoHelper.visible = false;
      this.outline.clear();
    } else {
      this.updateGizmo();
    }
  }

  update(deltaTime) {
    this.runtimes.forEach((runtime) => {
      if (!runtime.asset) return;
      runtime.asset.player.update(deltaTime);
      runtime.asset.animationController?.update(deltaTime);
    });
    this.runtimes.forEach((runtime) => runtime.component?.update?.(deltaTime, this));
    if (this.root.visible) this.outline.update();
  }

  // Every item's top-level 3D object (for Reach targets, framing the camera…).
  itemRoots() {
    return [...this.runtimes.values()].map((runtime) => runtime.root);
  }

  // Rebuilds the copies of models whose rig was changed in Machine mode since they were made.
  refreshRigs(currentSignature) {
    let rebuilt = 0;
    this.runtimes.forEach((runtime) => {
      if (runtime.kind !== 'model') return;
      const signature = currentSignature(runtime.asset.config);
      if (signature === runtime.asset.rigSignature) return;
      this.capturePoses();
      runtime.signature = 'stale';
      rebuilt += 1;
    });
    if (rebuilt) this.reconcile({ applyPoses: false });
    return rebuilt;
  }
}
