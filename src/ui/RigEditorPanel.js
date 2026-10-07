import * as THREE from 'three';
import { analyzeSurface } from '../motion/surfaceAnalysis.js';
import { emptyRigDefinition, originalParent, partReference } from '../motion/Rig.js';
import { downloadRig, forgetSavedRig, readRigFile, saveRig } from '../motion/RigStore.js';

const TYPE_DEFAULTS = {
  revolute: { min: -180, max: 180, speed: 60 },
  prismatic: { min: -500, max: 500, speed: 250 },
};
const TYPE_LABELS = { revolute: 'rotates', prismatic: 'slides', aim: 'follows (rotate)', stretch: 'follows (slide)' };
const WORLD_AXES = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) };

function slug(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'joint';
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function uiType(definition) {
  if (definition.aim) return 'aim';
  if (definition.stretch) return 'stretch';
  return definition.type === 'prismatic' ? 'prismatic' : 'revolute';
}

function isOriginalDescendant(path, ancestorPath) {
  if (path === undefined || ancestorPath === undefined) return false;
  return ancestorPath === '' ? path !== '' : path.startsWith(`${ancestorPath}/`);
}

export class RigEditorPanel {
  constructor({ card, picker, outline, highlight, gizmo }) {
    this.card = card;
    this.picker = picker;
    this.outline = outline;
    this.highlight = highlight;
    this.gizmo = gizmo;
    this.asset = null;
    this.meshes = [];
    this.selection = [];
    // The groups containing the last clicked part, smallest first (see groupLevels).
    this.levels = [];
    this.pickMode = null;
    this.draft = null;
    this.query = (selector) => card.querySelector(selector);
    this.field = (name) => card.querySelector(`[data-field="${name}"]`);

    this.bindEvents();
  }

  get rig() {
    return this.asset?.rig;
  }

  bindEvents() {
    this.card.addEventListener('toggle', () => {
      if (this.card.open) {
        this.setPickMode('parts');
      } else {
        this.setPickMode(null);
        this.gizmo.hide();
      }
      this.refreshSelection();
    });

    this.query('[data-select-parts]').addEventListener('click', () => this.setPickMode(this.pickMode === 'parts' ? null : 'parts'));
    this.query('[data-clear-selection]').addEventListener('click', () => this.setSelection([]));
    this.query('[data-pick-surface]').addEventListener('click', () => this.setPickMode('surface'));
    this.query('[data-pick-target]').addEventListener('click', () => this.setPickMode('target'));
    this.query('[data-part-centre]').addEventListener('click', () => {
      if (!this.selection.length) return this.showMessage('Select the moving parts first.', true);
      this.draft.pivot = this.selectionCentre();
      this.writeVectorFields();
      return this.showMessage('Pivot moved to the centre of the selected parts.');
    });
    Object.entries(WORLD_AXES).forEach(([name, direction]) => {
      this.query(`[data-axis="${name}"]`).addEventListener('click', () => {
        // Buttons use the viewport's X/Y/Z (Y is up), converted into the model's own frame.
        const inverse = this.rig.content.getWorldQuaternion(new THREE.Quaternion()).invert();
        this.draft.axis = direction.clone().applyQuaternion(inverse).normalize();
        this.writeVectorFields();
      });
    });
    this.query('[data-flip-axis]').addEventListener('click', () => {
      this.draft.axis.negate();
      this.writeVectorFields();
    });

    ['axisX', 'axisY', 'axisZ', 'pivotX', 'pivotY', 'pivotZ'].forEach((name) => {
      this.field(name).addEventListener('change', () => this.readVectorFields());
    });
    this.field('type').addEventListener('change', () => {
      const type = this.field('type').value;
      const motion = type === 'prismatic' || type === 'stretch' ? 'prismatic' : 'revolute';
      Object.assign(this.draft, { type }, TYPE_DEFAULTS[motion]);
      this.writeForm();
    });
    this.field('parent').addEventListener('change', () => { this.draft.parent = this.field('parent').value; });
    this.field('name').addEventListener('input', () => { this.draft.name = this.field('name').value; });
    ['min', 'max', 'speed'].forEach((name) => {
      this.field(name).addEventListener('change', () => { this.draft[name] = Number(this.field(name).value); });
    });

    this.query('[data-save-joint]').addEventListener('click', () => this.saveJoint());
    this.query('[data-cancel-edit]').addEventListener('click', () => this.resetForm());
    this.query('[data-export-rig]').addEventListener('click', () => {
      if (this.rig) downloadRig(this.rig.definition, this.asset.config.name);
    });
    const importInput = this.query('[data-import-rig-input]');
    this.query('[data-import-rig]').addEventListener('click', () => importInput.click());
    importInput.addEventListener('change', async () => {
      const [file] = importInput.files;
      importInput.value = '';
      if (file) await this.importRig(file);
    });
    this.query('[data-reset-rig]').addEventListener('click', () => this.resetRig());
  }

  setAsset(asset) {
    this.unsubscribe?.();
    this.asset = asset;
    this.unsubscribe = asset.rig.onChange(() => this.renderJointList());
    this.modelSize = (() => {
      const size = new THREE.Box3().setFromObject(asset.model).getSize(new THREE.Vector3());
      return Math.max(size.x, size.y, size.z, 0.01);
    })();
    this.meshes = [];
    asset.rig.content.traverse((object) => {
      if (object.isMesh && object.userData.partPath !== undefined) this.meshes.push(object);
    });
    this.selection = [];
    this.levels = [];
    this.resetForm();
    this.refreshSelection();
    this.renderJointList();
    this.picker.target = asset.model;
    if (this.pickMode) this.setPickMode(this.pickMode);
  }

  open() {
    this.card.open = true;
    this.card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // ---- Picking -------------------------------------------------------------

  setPickMode(mode) {
    this.pickMode = this.asset ? mode : null;
    const selectButton = this.query('[data-select-parts]');
    selectButton.setAttribute('aria-pressed', String(this.pickMode === 'parts'));
    selectButton.classList.toggle('is-active', this.pickMode === 'parts');
    this.query('[data-pick-surface]').classList.toggle('is-active', this.pickMode === 'surface');
    this.query('[data-pick-target]').classList.toggle('is-active', this.pickMode === 'target');
    this.picker.setHandler(this.pickMode ? (hit, event) => this.handlePick(hit, event) : null, this.asset?.model);
    if (this.pickMode === 'surface') this.showMessage('Click a round shaft, hole or flat face on the model.');
    if (this.pickMode === 'target') this.showMessage('Click the point this joint should follow.');
  }

  handlePick(hit, event) {
    if (!hit) {
      if (this.pickMode === 'parts' && !event.shiftKey) this.setSelection([]);
      return;
    }
    this.asset.player.stop();
    if (this.pickMode === 'parts') this.pickPart(hit.object, event.shiftKey);
    else if (this.pickMode === 'surface') this.pickSurface(hit);
    else if (this.pickMode === 'target') this.pickTarget(hit);
  }

  // Meshes are often unnamed children of a named part, so climb to the first named object,
  // but never as far as a group that holds the whole model.
  selectableFor(object) {
    let current = object;
    while (!current.name) {
      const parent = originalParent(current);
      if (!parent || parent === this.rig.content || this.meshesUnder(parent).length >= this.meshes.length) break;
      current = parent;
    }
    return current;
  }

  pickPart(object, additive) {
    const part = this.selectableFor(object);
    const removing = additive && this.selection.includes(part);
    if (!removing) this.levels = this.groupLevels(part);
    if (!additive) return this.setSelection([part]);
    return this.setSelection(removing ? this.selection.filter((item) => item !== part) : [...this.selection, part]);
  }

  // Meshes inside an object in the file's original hierarchy. Joints re-parent parts, so
  // walking the live scene graph would miss parts that already belong to a joint.
  meshesUnder(object) {
    const path = object.userData.partPath;
    if (path === undefined) return [];
    return this.meshes.filter((mesh) => mesh.userData.partPath === path || isOriginalDescendant(mesh.userData.partPath, path));
  }

  // The part plus the groups it sits in, smallest first. A group holding exactly the same
  // meshes as the level below adds nothing, so only the best-named of those is kept, and
  // the climb stops before the group that holds the whole model.
  groupLevels(part) {
    const levels = [{ object: part, meshes: this.meshesUnder(part) }];
    let current = originalParent(part);
    while (current && current !== this.rig.content && current.userData.partPath !== undefined) {
      const meshes = this.meshesUnder(current);
      if (meshes.length >= this.meshes.length) break;
      const last = levels[levels.length - 1];
      if (meshes.length > last.meshes.length) levels.push({ object: current, meshes });
      else if (levels.length > 1 && (current.name || !last.object.name)) levels[levels.length - 1] = { object: current, meshes };
      current = originalParent(current);
    }
    return levels;
  }

  // Swaps whichever level is selected for the chosen one, keeping any other selected parts.
  selectLevel(level) {
    const levelObjects = this.levels.map((item) => item.object);
    this.setSelection([...this.selection.filter((object) => !levelObjects.includes(object)), level.object]);
  }

  setSelection(objects) {
    // Drop duplicates and anything already covered by a selected ancestor.
    const unique = [...new Set(objects)];
    this.selection = unique.filter((object) => !unique.some((other) => other !== object
      && isOriginalDescendant(object.userData.partPath, other.userData.partPath)));
    if (this.draft && !this.draft.editingId) {
      if (this.draft.pivotSource === 'auto' && this.selection.length) this.draft.pivot = this.selectionCentre();
      if (!this.draft.nameEdited) this.draft.name = this.suggestName();
      this.draft.parent = this.suggestParent();
      this.writeForm();
    }
    this.refreshSelection();
  }

  refreshSelection() {
    const count = this.query('[data-selection-count]');
    count.textContent = this.selection.length ? `${this.selection.length} selected` : 'None selected';
    const list = this.query('[data-selection-list]');
    list.replaceChildren(...this.selection.map((object) => {
      const item = document.createElement('li');
      item.textContent = object.name || `(unnamed ${object.type.toLowerCase()})`;
      item.title = `Path ${object.userData.partPath}`;
      return item;
    }));
    if (this.card.open) {
      this.outline.set(this.selection);
      this.highlight.setSelection(this.selection.flatMap((object) => this.meshesUnder(object)));
    } else {
      this.outline.clear();
      this.highlight.clear();
    }
    this.renderLevels();
  }

  renderLevels() {
    if (!this.rig) this.levels = [];
    else if (!this.levels.some((level) => this.selection.includes(level.object))) {
      const last = this.selection[this.selection.length - 1];
      this.levels = last ? this.groupLevels(last) : [];
    }
    this.highlight.setPreview([]);
    const single = this.levels.length === 1;
    this.query('[data-part-levels]').hidden = !this.levels.length;
    this.query('[data-part-levels-hint]').textContent = single
      ? "The last part you clicked isn't inside any group other than the whole model."
      : 'Groups that contain the last part you clicked, largest first. Hover to highlight what each one holds; click to select it.';
    const list = this.query('[data-part-level-list]');
    list.hidden = single;
    list.replaceChildren(...[...this.levels].reverse().map((level, depth) => {
      const selected = this.selection.includes(level.object);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'part-level';
      button.classList.toggle('is-active', selected);
      button.setAttribute('aria-pressed', String(selected));
      button.style.setProperty('--depth', String(Math.min(depth, 6)));
      const name = document.createElement('span');
      name.textContent = level.object.name || (level.meshes.length > 1 ? 'Unnamed group' : 'Unnamed part');
      const count = document.createElement('small');
      count.textContent = `${level.meshes.length} piece${level.meshes.length === 1 ? '' : 's'}`;
      button.append(name, count);
      button.title = name.textContent;
      const preview = () => this.highlight.setPreview(level.meshes);
      const endPreview = () => this.highlight.setPreview([]);
      button.addEventListener('pointerenter', preview);
      button.addEventListener('focus', preview);
      button.addEventListener('pointerleave', endPreview);
      button.addEventListener('blur', endPreview);
      button.addEventListener('click', () => this.selectLevel(level));
      const item = document.createElement('li');
      item.appendChild(button);
      return item;
    }));
  }

  // Centre of the selected parts' bounding box, in model coordinates at the rest pose.
  selectionCentre() {
    return this.rig.withRestPose(() => {
      const box = new THREE.Box3();
      this.selection.forEach((object) => box.expandByObject(object));
      return this.rig.content.worldToLocal(box.getCenter(new THREE.Vector3()));
    });
  }

  pickSurface(hit) {
    const mesh = hit.object;
    const result = analyzeSurface(mesh, hit.faceIndex);
    const { pivot, axis, scale } = this.rig.withRestPose(() => {
      const toModel = this.rig.content.matrixWorld.clone().invert().multiply(mesh.matrixWorld);
      return {
        pivot: result.pivot.clone().applyMatrix4(toModel),
        axis: result.axis.clone().transformDirection(toModel),
        scale: mesh.getWorldScale(new THREE.Vector3()).x * 1000,
      };
    });
    this.draft.pivot = pivot;
    this.draft.axis = axis;
    this.draft.pivotSource = 'surface';
    this.writeVectorFields();
    this.setPickMode('parts');
    const messages = {
      round: `Round surface found (Ø ${round(result.radius * 2 * scale, 1)} mm). The axis runs through its centre.`,
      flat: 'Flat face found. The axis is perpendicular to it, with the pivot at its centre.',
      curved: 'Curved surface found. The pivot is at its centre of curvature; check the axis direction.',
      point: 'Could not read that surface; used the clicked point.',
    };
    this.showMessage(messages[result.kind]);
  }

  pickTarget(hit) {
    const mesh = hit.object;
    // The followed joint is whichever joint carries the clicked part.
    let current = mesh;
    while (current && current !== this.rig.content && current.userData.rigJointId === undefined) current = current.parent;
    const owner = current?.userData.rigJointId;
    const ownPart = owner === this.draft.editingId
      || this.selection.some((object) => object === mesh || isOriginalDescendant(mesh.userData.partPath, object.userData.partPath));
    if (!owner) return this.showMessage("That part doesn't move, so there is nothing to follow. Click a point on a part that has a joint.", true);
    if (ownPart) return this.showMessage("That point is on this joint's own parts. Click a point on the part it should follow.", true);
    const local = mesh.worldToLocal(hit.point.clone());
    this.draft.target = this.rig.withRestPose(() => this.rig.content.worldToLocal(mesh.localToWorld(local)));
    this.draft.linkJoint = owner;
    if (this.draft.type === 'stretch') {
      const anchor = this.stretchAnchor();
      const direction = this.draft.target.clone().sub(anchor);
      if (direction.lengthSq() > 0) this.draft.axis = direction.normalize();
    }
    this.setPickMode('parts');
    this.writeForm();
    return this.showMessage(`Follow point set on "${this.rig.jointsById.get(owner).name}".`);
  }

  // ---- Draft & form ---------------------------------------------------------

  newDraft() {
    return {
      editingId: null,
      name: '',
      nameEdited: false,
      type: 'revolute',
      parent: '',
      linkJoint: '',
      target: null,
      axis: this.rig ? WORLD_AXES.y.clone().applyQuaternion(this.rig.content.getWorldQuaternion(new THREE.Quaternion()).invert()) : WORLD_AXES.y.clone(),
      pivot: new THREE.Vector3(),
      pivotSource: 'auto',
      ...TYPE_DEFAULTS.revolute,
    };
  }

  resetForm() {
    this.draft = this.newDraft();
    this.query('[data-form-title]').textContent = 'New joint';
    this.query('[data-save-joint]').textContent = 'Create joint';
    this.query('[data-cancel-edit]').hidden = true;
    this.field('name').oninput = () => { this.draft.nameEdited = true; };
    this.writeForm();
    this.showMessage(null);
  }

  suggestName() {
    const named = this.selection.find((object) => object.name);
    return named ? named.name : `Joint ${(this.rig?.joints.length || 0) + 1}`;
  }

  // Default parent: the joint that owns the closest original ancestor of the selection.
  suggestParent() {
    let best = '';
    let bestDepth = -1;
    this.rig.joints.forEach((joint) => {
      if (joint.id === this.draft.editingId) return;
      joint.parts.forEach((part) => {
        const path = part.userData.partPath;
        const owns = this.selection.some((object) => isOriginalDescendant(object.userData.partPath, path));
        if (owns && path.length > bestDepth) {
          best = joint.id;
          bestDepth = path.length;
        }
      });
    });
    return best;
  }

  get millimetresPerUnit() {
    return this.rig.metresPerUnit * 1000;
  }

  writeVectorFields() {
    const { axis, pivot } = this.draft;
    ['X', 'Y', 'Z'].forEach((component, index) => {
      this.field(`axis${component}`).value = String(round(axis.getComponent(index), 4));
      this.field(`pivot${component}`).value = String(round(pivot.getComponent(index) * this.millimetresPerUnit, 1));
    });
  }

  readVectorFields() {
    const read = (name) => Number(this.field(name).value) || 0;
    const axis = new THREE.Vector3(read('axisX'), read('axisY'), read('axisZ'));
    if (axis.lengthSq() > 0) this.draft.axis = axis.normalize();
    this.draft.pivot = new THREE.Vector3(read('pivotX'), read('pivotY'), read('pivotZ')).divideScalar(this.millimetresPerUnit);
    this.draft.pivotSource = 'manual';
    this.writeVectorFields();
  }

  jointOptions(select, { includeBase, exclude }) {
    select.replaceChildren();
    if (includeBase) select.appendChild(new Option('Base (fixed)', ''));
    this.rig?.joints.forEach((joint) => {
      if (exclude.has(joint.id)) return;
      select.appendChild(new Option(joint.name, joint.id));
    });
  }

  // Ids of a joint and everything mounted on it (cannot become its parent).
  descendantsOf(id) {
    const result = new Set(id ? [id] : []);
    let grew = true;
    while (grew) {
      grew = false;
      this.rig.definition.joints.forEach((definition) => {
        if (definition.parent && result.has(definition.parent) && !result.has(definition.id)) {
          result.add(definition.id);
          grew = true;
        }
      });
    }
    return result;
  }

  writeForm() {
    if (!this.rig) return;
    const { draft } = this;
    const motion = draft.type === 'prismatic' || draft.type === 'stretch' ? 'prismatic' : 'revolute';
    this.field('name').value = draft.name;
    this.field('type').value = draft.type;
    this.jointOptions(this.field('parent'), { includeBase: true, exclude: this.descendantsOf(draft.editingId) });
    this.field('parent').value = draft.parent;

    const linked = draft.type === 'aim' || draft.type === 'stretch';
    this.query('[data-link-fields]').hidden = !linked;
    this.query('[data-limit-fields]').hidden = linked;
    this.query('[data-speed-field]').hidden = linked;
    const followed = this.rig.jointsById.get(draft.linkJoint);
    this.query('[data-target-status]').textContent = draft.target && followed
      ? `Follows a point on "${followed.name}". Pick again to change it.`
      : 'Click the point it should follow, e.g. the pin on the other part. The joint it belongs to is found for you.';
    this.card.querySelectorAll('[data-unit]').forEach((element) => { element.textContent = motion === 'prismatic' ? 'mm' : '°'; });
    this.query('[data-unit-speed]').textContent = motion === 'prismatic' ? 'mm/s' : '°/s';
    this.field('min').value = String(draft.min);
    this.field('max').value = String(draft.max);
    this.field('speed').value = String(draft.speed);
    this.writeVectorFields();
  }

  showMessage(text, isError = false) {
    const message = this.query('[data-editor-message]');
    message.hidden = !text;
    message.textContent = text || '';
    message.classList.toggle('is-error', isError);
  }

  stretchAnchor() {
    const parent = this.rig.jointsById.get(this.draft.parent);
    return parent?.definition?.aim ? parent.pivotInModel.clone() : this.draft.pivot.clone();
  }

  // ---- Joint definitions ------------------------------------------------------

  editJoint(id) {
    const joint = this.rig.jointsById.get(id);
    if (!joint) return;
    const definition = joint.definition;
    const type = uiType(definition);
    const link = definition.aim || definition.stretch;
    this.draft = {
      ...this.newDraft(),
      editingId: id,
      name: joint.name,
      nameEdited: true,
      type,
      parent: definition.parent || '',
      linkJoint: link?.joint || '',
      target: link ? joint.pointInFrame(link.target) : null,
      axis: joint.axis.clone(),
      pivot: joint.pivotInModel.clone(),
      pivotSource: 'manual',
      min: joint.min,
      max: joint.max,
      speed: joint.speed,
      zero: joint.zero,
    };
    this.query('[data-form-title]').textContent = `Editing "${joint.name}"`;
    this.query('[data-save-joint]').textContent = 'Save joint';
    this.query('[data-cancel-edit]').hidden = false;
    this.selection = [...joint.parts];
    this.refreshSelection();
    this.writeForm();
    this.showMessage(null);
  }

  buildDefinition(id) {
    const { draft } = this;
    const motion = draft.type === 'prismatic' || draft.type === 'stretch' ? 'prismatic' : 'revolute';
    const vector = (value) => value.toArray().map((component) => round(component, 6));
    const definition = {
      id,
      name: draft.name.trim() || id,
      type: motion,
      parent: draft.parent || null,
      parts: this.selection.map(partReference),
      frame: 'model',
      axis: vector(draft.axis),
      pivot: vector(draft.pivot),
    };
    if (Number.isFinite(draft.zero) && draft.zero !== 0) definition.zero = draft.zero;
    if (draft.type === 'aim') definition.aim = { joint: draft.linkJoint, target: vector(draft.target) };
    else if (draft.type === 'stretch') {
      definition.stretch = { joint: draft.linkJoint, target: vector(draft.target), anchor: vector(this.stretchAnchor()) };
    } else Object.assign(definition, { min: Math.min(draft.min, draft.max), max: Math.max(draft.min, draft.max), speed: draft.speed });
    return definition;
  }

  validateDraft() {
    const { draft } = this;
    if (!this.selection.length) return 'Select the parts that move first.';
    if (draft.axis.lengthSq() === 0) return 'The axis cannot be zero.';
    if (draft.type === 'aim' || draft.type === 'stretch') {
      if (!draft.target || !this.rig.jointsById.has(draft.linkJoint)) return 'Pick the follow point on the model.';
    } else if (!(draft.speed > 0)) return 'Speed must be greater than zero.';
    return null;
  }

  saveJoint() {
    if (!this.rig) return;
    const error = this.validateDraft();
    if (error) return this.showMessage(error, true);
    this.asset.player.stop();

    const previous = structuredClone(this.rig.definition);
    const definition = structuredClone(previous);
    const id = this.draft.editingId || this.uniqueId(slug(this.draft.name || 'joint'));
    const joint = this.buildDefinition(id);
    const claimedPaths = new Set(joint.parts.map((part) => part.path));

    // A part can belong to only one joint: take selected parts away from other joints.
    let moved = 0;
    definition.joints.forEach((other) => {
      if (other.id === id) return;
      const before = other.parts.length;
      other.parts = other.parts.filter((part) => !claimedPaths.has(part.path)
        && !this.rig.jointsById.get(other.id)?.parts.some((object) => claimedPaths.has(object.userData.partPath) && object.name === part.name));
      moved += before - other.parts.length;
    });

    // Joints on the base whose parts sit inside the new joint's parts get mounted on it.
    if (!this.draft.editingId) {
      definition.joints.forEach((other) => {
        if (other.parent) return;
        const runtime = this.rig.jointsById.get(other.id);
        const paths = runtime?.parts.map((part) => part.userData.partPath) || [];
        if (paths.length && paths.every((path) => [...claimedPaths].some((claimed) => isOriginalDescendant(path, claimed)))) {
          other.parent = id;
        }
      });
    }

    const index = definition.joints.findIndex((item) => item.id === id);
    if (index === -1) definition.joints.push(joint);
    else definition.joints[index] = joint;

    try {
      this.rig.setDefinition(definition);
    } catch (setupError) {
      this.rig.setDefinition(previous);
      return this.showMessage(setupError.message, true);
    }
    this.persist();
    const verb = this.draft.editingId ? 'saved' : 'created';
    this.resetForm();
    this.setSelection([]);
    const note = moved ? ` ${moved} part${moved === 1 ? ' was' : 's were'} moved from another joint.` : '';
    return this.showMessage(`Joint "${joint.name}" ${verb}. Try it in the Joints panel.${note}`);
  }

  uniqueId(base) {
    const ids = new Set(this.rig.definition.joints.map((joint) => joint.id));
    if (!ids.has(base)) return base;
    let counter = 2;
    while (ids.has(`${base}_${counter}`)) counter += 1;
    return `${base}_${counter}`;
  }

  deleteJoint(id) {
    const target = this.rig.jointsById.get(id);
    if (!target || !window.confirm(`Delete joint "${target.name}"? Parts mounted on it stay where they are.`)) return;
    this.asset.player.stop();
    const definition = structuredClone(this.rig.definition);
    const removed = definition.joints.find((joint) => joint.id === id);
    definition.joints = definition.joints.filter((joint) => joint.id !== id);
    definition.joints.forEach((joint) => {
      if (joint.parent === id) joint.parent = removed.parent || null;
      ['aim', 'stretch'].forEach((key) => {
        if (joint[key]?.joint === id) {
          delete joint[key];
          joint.type = joint.type || 'revolute';
        }
      });
    });
    this.rig.setDefinition(definition);
    this.persist();
    if (this.draft.editingId === id) this.resetForm();
    this.showMessage(`Joint "${target.name}" deleted.`);
  }

  renderJointList() {
    const list = this.query('[data-joint-defs]');
    list.replaceChildren();
    if (!this.rig) return;
    this.rig.warnings.forEach((warning) => {
      const item = document.createElement('li');
      item.className = 'joint-def-warning';
      item.textContent = warning;
      list.appendChild(item);
    });
    if (!this.rig.joints.length) {
      const empty = document.createElement('li');
      empty.className = 'empty-state';
      empty.textContent = 'No joints yet. Select parts above, set the axis, then create a joint.';
      list.appendChild(empty);
      return;
    }
    this.rig.joints.forEach((joint) => {
      const item = document.createElement('li');
      item.className = 'joint-def';
      const text = document.createElement('div');
      const name = document.createElement('strong');
      name.textContent = joint.name;
      const detail = document.createElement('small');
      const parent = joint.definition.parent ? this.rig.jointsById.get(joint.definition.parent)?.name : 'base';
      detail.textContent = `${TYPE_LABELS[uiType(joint.definition)]} · on ${parent} · ${joint.parts.length} part${joint.parts.length === 1 ? '' : 's'}`;
      text.append(name, detail);
      const edit = document.createElement('button');
      edit.type = 'button';
      edit.textContent = 'Edit';
      edit.addEventListener('click', () => this.editJoint(joint.id));
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = 'Delete';
      remove.setAttribute('aria-label', `Delete ${joint.name}`);
      remove.addEventListener('click', () => this.deleteJoint(joint.id));
      item.append(text, edit, remove);
      list.appendChild(item);
    });
  }

  // ---- Rig file -----------------------------------------------------------------

  persist() {
    const saved = saveRig(this.asset.config, this.rig.definition);
    this.query('[data-save-state]').textContent = saved
      ? 'Saved in this browser. Export a .rig.json file to keep or share the rig.'
      : "Couldn't save in this browser. Use Export to keep the rig.";
  }

  async importRig(file) {
    try {
      const definition = await readRigFile(file);
      this.asset.player.stop();
      this.rig.setDefinition(definition);
      this.persist();
      this.resetForm();
      const warnings = this.rig.warnings.length;
      this.showMessage(`Imported ${this.rig.joints.length} joint${this.rig.joints.length === 1 ? '' : 's'} from ${file.name}.`
        + (warnings ? ` ${warnings} warning${warnings === 1 ? '' : 's'}: see the joint list.` : ''), warnings > 0);
    } catch (error) {
      this.showMessage(`Could not import ${file.name}: ${error.message}`, true);
    }
  }

  resetRig() {
    const preset = this.asset.config.rig;
    const question = preset
      ? 'Reset this model to its built-in rig? Your changes will be lost.'
      : 'Remove all joints from this model? Your changes will be lost.';
    if (!window.confirm(question)) return;
    this.asset.player.stop();
    forgetSavedRig(this.asset.config);
    this.rig.setDefinition(preset ? structuredClone(preset) : emptyRigDefinition());
    this.resetForm();
    this.setSelection([]);
    this.query('[data-save-state]').textContent = 'Reset. Changes are saved in this browser once you edit the rig.';
  }

  // ---- Per-frame -------------------------------------------------------------------

  update() {
    if (!this.card.open || !this.rig) return;
    this.outline.update();
    this.highlight.update();
    const { draft } = this;
    if (!this.selection.length && !draft.editingId) {
      this.gizmo.hide();
      return;
    }
    const motion = draft.type === 'prismatic' || draft.type === 'stretch' ? 'prismatic' : 'revolute';
    const { point, direction } = this.rig.modelToWorld(draft.pivot, draft.axis, draft.parent);
    const target = draft.target && (draft.type === 'aim' || draft.type === 'stretch')
      ? this.rig.modelToWorld(draft.target, draft.axis, draft.linkJoint).point
      : null;
    this.gizmo.show({ point, direction, type: motion, target, size: this.modelSize });
  }
}
