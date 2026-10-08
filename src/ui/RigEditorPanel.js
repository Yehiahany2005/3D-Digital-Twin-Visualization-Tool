import * as THREE from 'three';
import { analyzeSurface } from '../motion/surfaceAnalysis.js';
import { emptyRigDefinition, originalParent, partReference } from '../motion/Rig.js';
import { downloadRig, forgetSavedRig, readRigFile, saveRig } from '../motion/RigStore.js';
import { niceNumber } from './JointControls.js';

const REVOLUTE_DEFAULTS = { min: -180, max: 180, speed: 60 };
// A new slide travels a quarter of the model's size, one way from where the part sits in the
// file (Reverse flips the way), and takes about two seconds end to end.
const SLIDE_TRAVEL_FRACTION = 0.25;
// A "Two points" direction within 3° of one of the model's axes snaps onto it exactly.
const SNAP_ANGLE_COS = Math.cos(THREE.MathUtils.degToRad(3));
// A flat face whose long side is less than this times its short side has no clear direction.
const CLEAR_ELONGATION = 1.3;
const TYPE_LABELS = { revolute: 'rotates', prismatic: 'slides', aim: 'follows (rotate)', stretch: 'follows (slide)' };
const TYPE_ICONS = { revolute: '⟳', prismatic: '↕', aim: '⤷', stretch: '⤷' };
const WORLD_AXES = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) };
// Direction buttons in plain words. 'up' is vertical; 'view' and 'right' are the horizontal
// directions into the screen and across it, so they match what the user is looking at.
const DIRECTION_BUTTONS = {
  revolute: {
    buttons: [
      { label: 'Turn', title: 'Spin left and right, like a swivel chair', direction: 'up' },
      { label: 'Swing', title: 'Swing up and down as you see it now, like a clock hand', direction: 'view' },
      { label: 'Tip', title: 'Lean toward and away from you', direction: 'right' },
    ],
  },
  prismatic: {
    buttons: [
      { label: 'Up/down', title: 'Slide up and down', direction: 'up' },
      { label: 'Sideways', title: 'Slide left and right as you see it now', direction: 'right' },
      { label: 'In/out', title: 'Slide toward and away from you', direction: 'view' },
    ],
  },
};

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
  constructor({ card, picker, outline, highlight, gizmo, surfacePreview }) {
    this.card = card;
    this.picker = picker;
    this.outline = outline;
    this.highlight = highlight;
    this.gizmo = gizmo;
    this.surfacePreview = surfacePreview;
    this.asset = null;
    this.meshes = [];
    this.selection = [];
    // The groups containing the last clicked part, smallest first (see groupLevels).
    this.levels = [];
    this.pickMode = null;
    this.draft = null;
    // Joints whose thread of mounted joints is folded away in the joint list.
    this.collapsed = new Set();
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
        // Keep a pick already asked for (e.g. "Set tool point" from Reach); otherwise pick parts.
        this.setPickMode(this.pickMode || 'parts');
      } else {
        this.setPickMode(null);
        this.gizmo.hide();
      }
      this.refreshSelection();
    });

    this.query('[data-select-parts]').addEventListener('click', () => this.setPickMode(this.pickMode === 'parts' ? null : 'parts'));
    this.query('[data-clear-selection]').addEventListener('click', () => this.setSelection([]));
    this.query('[data-pick-surface]').addEventListener('click', () => this.setPickMode('surface'));
    this.query('[data-pick-line]').addEventListener('click', () => this.setPickMode(this.pickMode === 'line' ? 'parts' : 'line'));
    this.query('[data-pick-target]').addEventListener('click', () => this.setPickMode('target'));
    this.query('[data-part-centre]').addEventListener('click', () => {
      if (!this.selection.length) return this.showMessage('Select the moving parts first.', true);
      this.draft.pivot = this.selectionCentre();
      return this.showMessage('Pivot moved to the centre of the selected parts.');
    });
    [0, 1, 2].forEach((index) => {
      this.query(`[data-direction="${index}"]`).addEventListener('click', () => {
        const { direction, label } = DIRECTION_BUTTONS[this.motion].buttons[index];
        this.draft.axis = this.snapToModelAxis(this.worldDirection(direction), direction !== 'up');
        this.showMessage(`Direction set to "${label}". The arrow and ring on the model show it; use Reverse if it goes the wrong way.`);
      });
    });
    this.query('[data-flip-axis]').addEventListener('click', () => {
      this.draft.axis.negate();
    });

    this.field('type').addEventListener('change', () => this.changeType(this.field('type').value));
    this.field('parent').addEventListener('change', () => {
      this.draft.parent = this.field('parent').value;
      this.refreshStretchAxis();
      this.writeFollowStatus();
    });
    this.field('name').addEventListener('input', () => { this.draft.name = this.field('name').value; });
    ['min', 'max', 'speed'].forEach((name) => {
      // On every keystroke, so the slide's travel on the model follows what is typed.
      this.field(name).addEventListener('input', () => {
        const value = Number(this.field(name).value);
        if (this.field(name).value !== '' && Number.isFinite(value)) this.draft[name] = value;
      });
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
    this.highlight.setModelMeshes(this.meshes);
    this.collapsed.clear();
    this.selection = [];
    this.levels = [];
    this.resetForm();
    this.refreshSelection();
    this.renderJointList();
    if (this.pickMode) this.setPickMode(this.pickMode);
  }

  open() {
    this.card.open = true;
    this.card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // ---- Picking -------------------------------------------------------------

  setPickMode(mode) {
    this.pickMode = this.asset ? mode : null;
    this.lineStart = null;
    this.updatePickButtons();
    if (this.pickMode) {
      this.picker.setHandler((hit, event) => this.handlePick(hit, event), this.asset.model, {
        owner: 'joint-setup',
        // Finding an axis previews what a click would pick, as the pointer moves.
        hover: this.pickMode === 'surface' ? (hit) => this.previewSurface(hit) : null,
        // Another tool (e.g. Reach) took over the viewport clicks.
        onRelease: () => {
          this.pickMode = null;
          this.updatePickButtons();
          this.surfacePreview.hide();
        },
      });
    } else if (this.picker.owner === 'joint-setup') {
      this.picker.setHandler(null);
    }
    if (this.pickMode !== 'surface') this.surfacePreview.hide();
    if (this.pickMode === 'surface') {
      this.showMessage(this.isSlide
        ? 'Move over the model: the highlighted surface and the dashed line show the way the part would slide. Rods, rails and long flat faces work best. Click to use it.'
        : 'Move over the model: the highlighted surface and the dashed line show the axis the joint would turn around. Round shafts and holes work best. Click to use it.');
    }
    if (this.pickMode === 'line') this.showMessage('Click the first point, then a second point further along the way the part slides. Click "Two points" again to cancel.');
    if (this.pickMode === 'target') this.showMessage('Click the point this joint should follow.');
  }

  updatePickButtons() {
    const selectButton = this.query('[data-select-parts]');
    selectButton.setAttribute('aria-pressed', String(this.pickMode === 'parts'));
    selectButton.classList.toggle('is-active', this.pickMode === 'parts');
    this.query('[data-pick-surface]').classList.toggle('is-active', this.pickMode === 'surface');
    this.query('[data-pick-line]').classList.toggle('is-active', this.pickMode === 'line');
    this.query('[data-pick-target]').classList.toggle('is-active', this.pickMode === 'target');
  }

  handlePick(hit, event) {
    if (!hit) {
      if (this.pickMode === 'parts' && !event.shiftKey) this.setSelection([]);
      return;
    }
    this.asset.player.stop();
    if (this.pickMode === 'parts') this.pickPart(hit.object, event.shiftKey);
    else if (this.pickMode === 'surface') this.pickSurface(hit);
    else if (this.pickMode === 'line') this.pickLinePoint(hit);
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
      // Adding a second movement to parts that already move: start from that joint's pivot.
      const parent = this.rig.jointsById.get(this.draft.parent);
      const stacking = parent && this.selection.length && this.selection.every((object) => parent.parts.includes(object));
      if (this.draft.pivotSource === 'auto' && stacking) this.draft.pivot = parent.pivotInModel.clone();
      this.refreshStretchAxis();
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
      this.refreshLinked();
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
      const endPreview = () => this.highlight.endPreviewSoon();
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

  // Hovering in "find axis" mode: show the surface that would be used and the axis through it.
  previewSurface(hit) {
    if (!hit || this.pickMode !== 'surface') {
      this.surfacePreview.hide();
      return;
    }
    const mesh = hit.object;
    const result = analyzeSurface(mesh, hit.faceIndex);
    const scale = mesh.getWorldScale(new THREE.Vector3()).x;
    if (this.isSlide) {
      this.previewSlideSurface(mesh, result, scale);
      return;
    }
    const worldPivot = result.pivot.clone().applyMatrix4(mesh.matrixWorld);
    const worldAxis = result.axis.clone().transformDirection(mesh.matrixWorld);
    this.surfacePreview.show({
      mesh,
      result,
      worldPivot,
      worldAxis,
      worldRadius: result.kind === 'round' ? result.radius * scale : null,
      size: this.modelSize,
    });
    const millimetres = scale * 1000;
    const found = {
      round: `Round surface, Ø ${round(result.radius * 2 * millimetres, 1)} mm: the joint will turn around the dashed line through its centre. Click to use it.`,
      flat: 'Flat face: the joint will turn around the dashed line standing straight out of it. Round shafts or holes usually give a better axis.',
      curved: 'Curved surface: the pivot goes to its centre of curvature. Check the direction afterwards.',
      point: "Can't read this surface; clicking uses the spot itself.",
    };
    this.showMessage(found[result.kind]);
  }

  // The way a part slides along a surface: along a rod or hole, or along a flat face's long
  // side (a carriage runs along its rail face, not into it). Null when the surface has none.
  slideDirection(result) {
    if (result.kind === 'round') return { direction: result.axis, clear: true };
    if (result.kind === 'flat' && result.along) return { direction: result.along, clear: result.elongation >= CLEAR_ELONGATION };
    return null;
  }

  slideMessage(result, slide, millimetres, clicked) {
    if (!slide) return 'This surface has no slide direction. Point at a rod, a rail or a long flat face, or use "Two points".';
    if (result.kind === 'round') {
      return clicked
        ? `Round surface found (Ø ${round(result.radius * 2 * millimetres, 1)} mm). The part slides along its centre line.`
        : `Round surface, Ø ${round(result.radius * 2 * millimetres, 1)} mm: the part will slide along the dashed line. Click to use it.`;
    }
    if (!slide.clear) {
      return clicked
        ? 'Flat face used, but it has no clear long side: check the arrow, or use "Two points".'
        : 'Flat face with no clear long side: the direction may be wrong. Try a rail edge or a rod, or use "Two points".';
    }
    return clicked
      ? 'Flat face found. The part slides along its long side.'
      : "Flat face: the part will slide along the dashed line (the face's long side). Click to use it.";
  }

  previewSlideSurface(mesh, result, scale) {
    const slide = this.slideDirection(result);
    if (slide) {
      this.surfacePreview.show({
        mesh,
        result,
        worldPivot: result.pivot.clone().applyMatrix4(mesh.matrixWorld),
        worldAxis: slide.direction.clone().transformDirection(mesh.matrixWorld),
        worldRadius: result.kind === 'round' ? result.radius * scale : null,
        size: this.modelSize,
      });
    } else {
      this.surfacePreview.hide();
    }
    this.showMessage(this.slideMessage(result, slide, scale * 1000, false));
  }

  // Model-frame (rest pose) version of a direction given in a mesh's own coordinates.
  meshDirectionToModel(mesh, direction) {
    return this.rig.withRestPose(() => {
      const toModel = this.rig.content.matrixWorld.clone().invert().multiply(mesh.matrixWorld);
      return direction.clone().transformDirection(toModel);
    });
  }

  pickSurface(hit) {
    const mesh = hit.object;
    const result = analyzeSurface(mesh, hit.faceIndex);
    if (this.isSlide) {
      // A slide only needs a direction; its pivot stays on the moving part.
      const slide = this.slideDirection(result);
      const millimetres = mesh.getWorldScale(new THREE.Vector3()).x * 1000;
      if (!slide) return this.showMessage(this.slideMessage(result, slide, millimetres, true), true);
      this.draft.axis = this.keepDirection(this.meshDirectionToModel(mesh, slide.direction));
      this.surfacePreview.hide();
      this.setPickMode('parts');
      return this.showMessage(this.slideMessage(result, slide, millimetres, true), !slide.clear);
    }
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
    this.surfacePreview.hide();
    this.setPickMode('parts');
    const messages = {
      round: `Round surface found (Ø ${round(result.radius * 2 * scale, 1)} mm). The axis runs through its centre.`,
      flat: 'Flat face found. The axis is perpendicular to it, with the pivot at its centre.',
      curved: 'Curved surface found. The pivot is at its centre of curvature; check the axis direction.',
      point: 'Could not read that surface; used the clicked point.',
    };
    return this.showMessage(messages[result.kind]);
  }

  // A surface gives a line, not a way along it: keep the sense the arrow already had, so
  // picking a rail doesn't silently flip a direction the user set with Reverse.
  keepDirection(direction) {
    const result = direction.clone().normalize();
    return result.dot(this.draft.axis) < 0 ? result.negate() : result;
  }

  // "Two points": the part slides from the first click toward the second.
  pickLinePoint(hit) {
    const mesh = hit.object;
    const local = mesh.worldToLocal(hit.point.clone());
    const point = this.rig.withRestPose(() => this.rig.content.worldToLocal(mesh.localToWorld(local)));
    if (!this.lineStart) {
      this.lineStart = point;
      return this.showMessage('First point set. Now click a second point further along the way the part slides.');
    }
    const direction = point.clone().sub(this.lineStart);
    if (direction.length() < this.modelSize * 1e-3 / this.rig.metresPerUnit) {
      return this.showMessage('The two points are too close together. Click a second point further away.', true);
    }
    direction.normalize();
    // Lines that are almost along one of the model's axes snap onto it exactly.
    const snapped = Object.values(WORLD_AXES).find((axis) => Math.abs(axis.dot(direction)) >= SNAP_ANGLE_COS);
    this.draft.axis = snapped ? snapped.clone().multiplyScalar(Math.sign(snapped.dot(direction))) : direction;
    this.setPickMode('parts');
    return this.showMessage(`Direction set from the two points${snapped ? ' (lined up with the model\'s axis)' : ''}. The arrow shows the way it slides; use Reverse to flip it.`);
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
    this.refreshStretchAxis();
    this.setPickMode('parts');
    this.writeForm();
    return this.showMessage(`Follow point set on "${this.rig.jointsById.get(owner).name}".`);
  }

  worldDirection(name) {
    if (name === 'up') return WORLD_AXES.y.clone();
    const { camera } = this.picker;
    const direction = name === 'view'
      ? camera.getWorldDirection(new THREE.Vector3())
      : WORLD_AXES.x.clone().applyQuaternion(camera.quaternion);
    return direction.setY(0);
  }

  // The model's own axis closest to a world direction, so the result lines up with the part
  // exactly rather than with the camera's angle. Horizontal directions skip the vertical axis.
  snapToModelAxis(worldDirection, horizontal) {
    const inverse = this.rig.content.getWorldQuaternion(new THREE.Quaternion()).invert();
    const direction = worldDirection.applyQuaternion(inverse);
    const up = WORLD_AXES.y.clone().applyQuaternion(inverse);
    let best = WORLD_AXES.y.clone();
    let bestScore = -1;
    Object.values(WORLD_AXES).forEach((axis) => {
      if (horizontal && Math.abs(axis.dot(up)) > 0.7) return;
      const score = Math.abs(axis.dot(direction));
      if (score > bestScore) {
        bestScore = score;
        best = axis.clone().multiplyScalar(Math.sign(axis.dot(direction)) || 1);
      }
    });
    return best;
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
      // Range and speed last used for each kind of movement, so switching type and back keeps them.
      remembered: {},
      ...REVOLUTE_DEFAULTS,
    };
  }

  // Range and speed for a new joint. Rotation is the same for any model; a slide's travel and
  // speed follow the model's size (a 10 cm gripper and a 20 m gantry both get something usable).
  typeDefaults(motion) {
    if (motion === 'revolute') return { ...REVOLUTE_DEFAULTS };
    const travel = niceNumber((this.modelSize || 1) * 1000 * SLIDE_TRAVEL_FRACTION);
    return { min: 0, max: travel, speed: niceNumber(travel / 2) };
  }

  changeType(type) {
    const { draft } = this;
    const before = this.motion;
    draft.type = type;
    const after = this.motion;
    if (after !== before) {
      // Degrees and millimetres don't convert: keep each kind's own values.
      draft.remembered[before] = { min: draft.min, max: draft.max, speed: draft.speed };
      Object.assign(draft, draft.remembered[after] || this.typeDefaults(after));
    }
    // A slide's pivot only places the arrow: put it back on the moving parts.
    if (this.isSlide && draft.pivotSource !== 'manual') {
      draft.pivotSource = 'auto';
      if (this.selection.length) draft.pivot = this.selectionCentre();
    }
    this.refreshStretchAxis();
    this.writeForm();
  }

  resetForm() {
    this.draft = this.newDraft();
    this.query('[data-form-title]').textContent = 'New joint';
    this.query('[data-save-joint]').textContent = 'Create joint';
    this.query('[data-cancel-edit]').hidden = true;
    this.field('name').oninput = () => { this.draft.nameEdited = true; };
    this.writeForm();
    this.showMessage(null);
    this.renderJointList();
  }

  suggestName() {
    const named = this.selection.find((object) => object.name);
    return named ? named.name : `Joint ${(this.rig?.joints.length || 0) + 1}`;
  }

  // Default parent: the joint that owns the selection or its closest original ancestor, so a
  // new joint on parts that already move adds its movement on top of the existing one.
  suggestParent() {
    let best = '';
    let bestDepth = -1;
    this.rig.joints.forEach((joint) => {
      if (joint.id === this.draft.editingId) return;
      joint.parts.forEach((part) => {
        const path = part.userData.partPath;
        const owns = this.selection.some((object) => object.userData.partPath === path
          || isOriginalDescendant(object.userData.partPath, path));
        if (owns && path.length > bestDepth) {
          best = joint.id;
          bestDepth = path.length;
        }
      });
    });
    return best;
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
    const directions = DIRECTION_BUTTONS[motion];
    directions.buttons.forEach(({ label, title }, index) => {
      const button = this.query(`[data-direction="${index}"]`);
      button.textContent = label;
      button.title = title;
    });
    // A slide has a direction but no pivot; a piston rod's direction comes from its follow point.
    const rod = draft.type === 'stretch';
    this.query('[data-axis-title]').textContent = motion === 'prismatic' ? 'Slide direction' : 'Axis & pivot';
    this.query('[data-axis-pick-row]').hidden = rod;
    this.query('[data-axis-buttons]').hidden = rod;
    this.query('[data-pick-line]').hidden = !this.isSlide;
    this.query('[data-part-centre]').hidden = motion === 'prismatic';
    this.query('[data-pick-surface]').title = this.isSlide
      ? 'Hover a rod, rail or long flat face to preview the way the part slides, then click'
      : 'Hover a round shaft, hole or flat face to preview the axis the joint turns around, then click';
    const note = this.query('[data-axis-note]');
    note.hidden = !rod;
    note.textContent = 'Set automatically: the rod slides along the line from its barrel to the follow point.';
    this.query('[data-range-hint]').textContent = motion === 'prismatic'
      ? '0 mm is where the part sits in the file. The purple bar on the model shows the travel.'
      : '0° is the pose the part has in the file.';
    if ((!this.isSlide && this.pickMode === 'line') || (rod && this.pickMode === 'surface')) this.setPickMode('parts');
    this.query('[data-link-fields]').hidden = !linked;
    this.query('[data-limit-fields]').hidden = linked;
    this.query('[data-speed-field]').hidden = linked;
    this.writeFollowStatus();
    this.card.querySelectorAll('[data-unit]').forEach((element) => { element.textContent = motion === 'prismatic' ? 'mm' : '°'; });
    this.query('[data-unit-speed]').textContent = motion === 'prismatic' ? 'mm/s' : '°/s';
    this.field('min').value = String(draft.min);
    this.field('max').value = String(draft.max);
    this.field('speed').value = String(draft.speed);
  }

  // The joint a follower follows, once its follow point is picked.
  get followedJoint() {
    const { draft } = this;
    const linked = draft && (draft.type === 'aim' || draft.type === 'stretch');
    return linked && draft.target ? this.rig?.jointsById.get(draft.linkJoint) || null : null;
  }

  writeFollowStatus() {
    const followed = this.followedJoint;
    const status = this.query('[data-target-status]');
    status.classList.toggle('is-set', Boolean(followed));
    this.query('[data-pick-target]').textContent = followed ? 'Change follow point' : 'Pick follow point';
    if (!followed) {
      status.textContent = 'Click "Pick follow point", then click the pin or point on the part it should follow.';
    } else {
      const swatch = document.createElement('span');
      swatch.className = 'follow-swatch';
      swatch.setAttribute('aria-hidden', 'true');
      const text = document.createElement('span');
      text.append('Follows ');
      const name = document.createElement('strong');
      name.textContent = followed.name;
      text.append(name);
      status.replaceChildren(swatch, text);
      const warning = this.stretchWarning();
      if (warning) {
        const line = document.createElement('small');
        line.className = 'follow-warning';
        line.textContent = warning;
        status.appendChild(line);
      }
    }
    this.refreshLinked();
  }

  // Tints the followed joint's parts so it is obvious what the follower is tied to.
  refreshLinked() {
    const followed = this.card.open ? this.followedJoint : null;
    this.highlight.setLinked(followed ? followed.parts.flatMap((part) => this.meshesUnder(part)) : []);
  }

  showMessage(text, isError = false) {
    const message = this.query('[data-editor-message]');
    message.hidden = !text;
    message.textContent = text || '';
    message.classList.toggle('is-error', isError);
  }

  get motion() {
    return this.draft.type === 'prismatic' || this.draft.type === 'stretch' ? 'prismatic' : 'revolute';
  }

  // A plain slide (not a piston rod that follows a point).
  get isSlide() {
    return this.draft?.type === 'prismatic';
  }

  stretchAnchor() {
    const parent = this.rig.jointsById.get(this.draft.parent);
    return parent?.definition?.aim ? parent.pivotInModel.clone() : this.draft.pivot.clone();
  }

  // A piston rod slides along the line from its anchor to its follow point. Both can change
  // after the follow point is picked (a new "Mounted on", other parts), so this is redone then.
  refreshStretchAxis() {
    const { draft } = this;
    if (draft?.type !== 'stretch' || !draft.target || !this.rig) return;
    const direction = draft.target.clone().sub(this.stretchAnchor());
    if (direction.lengthSq() > 0) draft.axis = direction.normalize();
  }

  // The rod only stays on its follow point if it is mounted on a barrel that turns to point at
  // that same point; otherwise it can only stretch in a fixed direction.
  stretchWarning() {
    const { draft } = this;
    if (draft?.type !== 'stretch' || !draft.target) return null;
    const parent = this.rig.jointsById.get(draft.parent);
    const aim = parent?.definition?.aim;
    const sameJoint = aim && aim.joint === draft.linkJoint;
    const samePoint = sameJoint && parent.pointInFrame(aim.target).distanceTo(draft.target) * this.rig.metresPerUnit <= this.modelSize * 0.01;
    if (samePoint) return null;
    return parent && sameJoint
      ? `Its barrel "${parent.name}" points at a different spot, so the rod will drift off the follow point. Pick the same point for both.`
      : 'Not mounted on a barrel that follows the same point: the rod keeps one direction, so it only stays on the follow point if that point moves straight along the rod. Mount it on a "Rotate to follow a point" barrel for a working cylinder.';
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
      remembered: {},
    };
    this.query('[data-form-title]').textContent = `Editing "${joint.name}"`;
    this.query('[data-save-joint]').textContent = 'Save joint';
    this.query('[data-cancel-edit]').hidden = false;
    this.selection = [...joint.parts];
    this.refreshSelection();
    this.writeForm();
    this.showMessage(null);
    this.renderJointList();
  }

  buildDefinition(id) {
    this.refreshStretchAxis();
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
    const carriesJoints = draft.editingId && this.rig.definition.joints.some((joint) => joint.parent === draft.editingId);
    if (!this.selection.length && !carriesJoints) return 'Select the parts that move first.';
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
    let movedFromParent = 0;
    definition.joints.forEach((other) => {
      if (other.id === id) return;
      const before = other.parts.length;
      other.parts = other.parts.filter((part) => !claimedPaths.has(part.path)
        && !this.rig.jointsById.get(other.id)?.parts.some((object) => claimedPaths.has(object.userData.partPath) && object.name === part.name));
      if (other.id === joint.parent) movedFromParent += before - other.parts.length;
      else moved += before - other.parts.length;
    });

    // If the new joint took every part of the joint it is mounted on, whatever rode on those
    // parts (mounted joints, follow points) now rides on the new joint instead.
    const parentDefinition = definition.joints.find((other) => other.id === joint.parent);
    if (!this.draft.editingId && movedFromParent && !parentDefinition.parts.length) {
      definition.joints.forEach((other) => {
        if (other.id === id) return;
        if (other.parent === parentDefinition.id) other.parent = id;
        ['aim', 'stretch'].forEach((key) => {
          if (other[key]?.joint === parentDefinition.id) other[key].joint = id;
        });
      });
    }

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
    const rodWarning = this.stretchWarning();
    this.resetForm();
    this.setSelection([]);
    // Parts taken from the joint this one is mounted on still follow it, so they gain a second movement.
    const parentName = this.rig.jointsById.get(joint.parent)?.name;
    const note = (movedFromParent ? ` It moves together with "${parentName}" and adds its own movement on top.` : '')
      + (moved ? ` ${moved} part${moved === 1 ? ' was' : 's were'} moved from another joint.` : '');
    return this.showMessage(`Joint "${joint.name}" ${verb}. Try it in the Joints panel.${note}${rodWarning ? ` Note: ${rodWarning}` : ''}`, Boolean(rodWarning));
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
    definition.tools = (definition.tools || []).filter((tool) => tool.joint !== id);
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

  // Joints keyed by the joint they are mounted on (null for the base), in rig order.
  jointChildren() {
    const ids = new Set(this.rig.joints.map((joint) => joint.id));
    const children = new Map();
    this.rig.joints.forEach((joint) => {
      const parent = ids.has(joint.definition.parent) ? joint.definition.parent : null;
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent).push(joint);
    });
    return children;
  }

  renderJointList() {
    const list = this.query('[data-joint-defs]');
    list.replaceChildren();
    this.highlight.setPreview([]);
    if (!this.rig) return;
    const joints = this.rig.joints;
    this.query('[data-joint-count]').textContent = joints.length ? String(joints.length) : '';

    if (this.rig.warnings.length) {
      const item = document.createElement('li');
      const details = document.createElement('details');
      details.className = 'joint-def-warnings';
      const summary = document.createElement('summary');
      summary.textContent = `⚠ ${this.rig.warnings.length} warning${this.rig.warnings.length === 1 ? '' : 's'}`;
      details.appendChild(summary);
      this.rig.warnings.forEach((warning) => {
        const line = document.createElement('p');
        line.textContent = warning;
        details.appendChild(line);
      });
      item.appendChild(details);
      list.appendChild(item);
    }
    if (!joints.length) {
      list.appendChild(this.emptyJointItem('No joints yet. Select parts above, set the axis, then create a joint.'));
      return;
    }

    // Joints are threads, like nested comments.
    const children = this.jointChildren();
    (children.get(null) || []).forEach((joint) => list.appendChild(this.createJointNode(joint, children)));
  }

  createJointNode(joint, children) {
    const item = document.createElement('li');
    item.className = 'joint-node';
    const mounted = children.get(joint.id) || [];
    const collapsed = this.collapsed.has(joint.id);
    item.appendChild(this.createJointRow(joint, collapsed ? this.countDescendants(joint.id, children) : 0));
    if (!mounted.length || collapsed) return item;

    // The thread line runs down from this joint to each joint mounted on it; clicking it folds the thread.
    const line = document.createElement('button');
    line.type = 'button';
    line.className = 'joint-thread-line';
    line.title = `Fold the joints mounted on ${joint.name}`;
    line.setAttribute('aria-label', `Fold the joints mounted on ${joint.name}`);
    line.addEventListener('click', () => {
      this.collapsed.add(joint.id);
      this.renderJointList();
    });
    const thread = document.createElement('ul');
    thread.className = 'joint-thread';
    mounted.forEach((child) => thread.appendChild(this.createJointNode(child, children)));
    item.append(line, thread);
    return item;
  }

  countDescendants(id, children) {
    return (children.get(id) || []).reduce((total, child) => total + 1 + this.countDescendants(child.id, children), 0);
  }

  emptyJointItem(text) {
    const item = document.createElement('li');
    item.className = 'empty-state';
    item.textContent = text;
    return item;
  }

  // folded: how many joints are hidden under this one (shown as a "+N" button to unfold).
  createJointRow(joint, folded) {
    const type = uiType(joint.definition);
    const parent = joint.definition.parent ? this.rig.jointsById.get(joint.definition.parent)?.name : 'base';
    const carried = this.rig.joints.filter((other) => other.definition.parent === joint.id).map((other) => other.name);
    const contents = !joint.parts.length && carried.length
      ? `carries ${carried.join(', ')}`
      : `${joint.parts.length} part${joint.parts.length === 1 ? '' : 's'}`;

    const row = document.createElement('div');
    row.className = 'joint-def';
    row.classList.toggle('is-active', joint.id === this.draft?.editingId);

    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'joint-def-name';
    edit.title = `${joint.name}: ${TYPE_LABELS[type]} · on ${parent} · ${contents}\nClick to edit.`;
    const icon = document.createElement('span');
    icon.className = 'joint-def-icon';
    icon.textContent = TYPE_ICONS[type];
    icon.setAttribute('aria-hidden', 'true');
    const name = document.createElement('span');
    name.textContent = joint.name;
    edit.append(icon, name);
    edit.setAttribute('aria-label', `Edit ${joint.name} (${TYPE_LABELS[type]})`);
    edit.addEventListener('click', () => this.editJoint(joint.id));

    // Hovering a row lights up that joint's parts on the model.
    const meshes = () => joint.parts.flatMap((part) => this.meshesUnder(part));
    row.addEventListener('pointerenter', () => this.highlight.setPreview(meshes()));
    row.addEventListener('pointerleave', () => this.highlight.endPreviewSoon());

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'joint-def-delete';
    remove.textContent = '✕';
    remove.title = `Delete ${joint.name}`;
    remove.setAttribute('aria-label', `Delete ${joint.name}`);
    remove.addEventListener('click', () => this.deleteJoint(joint.id));

    row.appendChild(edit);
    if (folded) {
      const unfold = document.createElement('button');
      unfold.type = 'button';
      unfold.className = 'joint-def-unfold';
      unfold.textContent = `+${folded}`;
      unfold.title = `Show the ${folded} joint${folded === 1 ? '' : 's'} mounted on ${joint.name}`;
      unfold.setAttribute('aria-label', unfold.title);
      unfold.addEventListener('click', () => {
        this.collapsed.delete(joint.id);
        this.renderJointList();
      });
      row.appendChild(unfold);
    }
    row.appendChild(remove);
    return row;
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
    // Travel of a slide, in metres from where the part sits in the file (0 mm).
    const zero = Number.isFinite(draft.zero) ? draft.zero : 0;
    const travel = this.isSlide && Number.isFinite(draft.min) && Number.isFinite(draft.max)
      ? { from: (Math.min(draft.min, draft.max) - zero) / 1000, to: (Math.max(draft.min, draft.max) - zero) / 1000 }
      : null;
    this.gizmo.show({ point, direction, type: motion, target, size: this.modelSize, travel });
  }
}
