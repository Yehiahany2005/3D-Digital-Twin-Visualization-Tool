import * as THREE from 'three';
import { JointControls } from '../../ui/JointControls.js';
import { parentOf } from '../SceneDocument.js';
import { icon } from './icons.js';
import { makeScrubbable } from './scrub.js';

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// Which groups are folded, remembered while the page is open: fold Joints once and it stays
// folded for every robot selected after.
const openGroups = new Map();

// The selected object (like Roblox Studio's Properties window), kept short: a header with its
// name and quick actions, then folding groups (Position, Settings, Attach, Robot, Joints…)
// in plain words. Rebuilt when another object is selected; when only values change, the fields
// are updated in place so typing isn't interrupted.
export class PropertiesPanel {
  constructor({ container, editor, describeSource, iconFor, onEditInMachine, onRelink, extraSections = [] }) {
    this.container = container;
    this.editor = editor;
    this.describeSource = describeSource;
    this.iconFor = iconFor;
    this.onEditInMachine = onEditInMachine;
    this.onRelink = onRelink;
    this.extraSections = extraSections;
    this.fields = [];
    this.structure = null;
    this.jointControls = null;
    editor.onChange((type) => {
      if (type === 'selection' || type === 'document' || type === 'item-ready') this.refresh();
      else if (type === 'dragging') this.syncValues();
    });
  }

  // Rebuild only when what is shown changes shape; otherwise just update the values.
  refresh() {
    const item = this.editor.selectedItem;
    const runtime = this.editor.selectedRuntime;
    const structure = item
      ? JSON.stringify([item.id, runtime?.kind, item.mount || item.attach || null, Boolean(item.locked), Object.keys(item.params || {}), this.editor.playing, this.editor.freeRotation, Boolean(item.hidden), this.editor.items.map((other) => other.id)])
      : `none:${this.editor.items.length}`;
    if (structure !== this.structure) {
      this.structure = structure;
      this.render();
    } else {
      this.syncValues();
    }
  }

  render() {
    this.fields = [];
    this.jointControls?.destroy();
    this.jointControls = null;
    const item = this.editor.selectedItem;
    if (!item) {
      this.renderNothingSelected();
      return;
    }
    const runtime = this.editor.selectedRuntime;
    const parts = [this.header(item, runtime)];
    const rigged = runtime?.asset?.rig?.joints.length;
    if (this.editor.playing) {
      // While playing only what moves things is offered; the layout can't change.
      parts.push(element('p', 'prop-note', 'Playing: stop to move or change things. Robots can still be jogged.'));
      // Extra groups that matter while playing (a robot's program, showing the running step).
      this.extraSections.forEach((build) => {
        const extra = build(item, runtime, this);
        if (extra) parts.push(extra);
      });
      if (runtime?.asset?.animations?.length) parts.push(this.animationGroup(item, runtime));
      if (rigged) parts.push(this.robotGroup(item, runtime), this.jointsGroup(runtime));
      this.container.replaceChildren(...parts);
      return;
    }
    if (runtime?.kind === 'missing') parts.push(this.missingNote(item));
    parts.push(this.positionGroup(item, runtime));
    this.extraSections.forEach((build) => {
      const extra = build(item, runtime, this);
      if (extra) parts.push(extra);
    });
    if (runtime?.asset?.animations?.length) parts.push(this.animationGroup(item, runtime));
    if (runtime?.kind === 'model') parts.push(this.robotGroup(item, runtime));
    if (rigged) parts.push(this.jointsGroup(runtime));
    this.container.replaceChildren(...parts);
  }

  renderNothingSelected() {
    const count = this.editor.items.length;
    this.container.replaceChildren(element('p', 'prop-empty', count
      ? 'Click an object in the view or in Objects to move it, change its settings or attach it to something.'
      : 'Nothing to show yet: add an object first.'));
  }

  // A folding group. open: how it starts the first time; after that the user's choice is kept.
  group(key, title, { open = true, note } = {}) {
    const node = element('details', 'prop-group');
    node.open = openGroups.has(key) ? openGroups.get(key) : open;
    node.addEventListener('toggle', () => openGroups.set(key, node.open));
    const summary = element('summary', 'prop-group-head');
    summary.append(icon('ChevronRight', 13), element('span', null, title));
    if (note) summary.append(element('small', null, note));
    const body = element('div', 'prop-group-body');
    node.append(summary, body);
    return { node, body };
  }

  // A text/number field bound to a value of the selected item. read() → value; write(value) commits.
  // Number fields can also be changed by dragging their label; preview(value) shows it meanwhile.
  field({ label, unit, type = 'number', step, read, write, disabled, title, preview }) {
    const wrapper = element('label', 'editor-field');
    const caption = element('span', null, label);
    if (unit) caption.append(' ', element('small', null, unit));
    const input = document.createElement('input');
    input.type = type;
    if (step) input.step = String(step);
    input.disabled = Boolean(disabled);
    if (title) wrapper.title = title;
    this.bindInput(input, { type, read, write });
    if (type === 'number' && !disabled) {
      makeScrubbable(caption, input, {
        step: step || 1,
        preview,
        commit: (value) => {
          write(value);
          // A drag that didn't change the document (e.g. back where it started) shows the value again.
          this.syncValues();
        },
      });
    }
    wrapper.append(caption, input);
    return wrapper;
  }

  bindInput(input, { type = 'number', read, write }) {
    const show = () => {
      if (document.activeElement !== input) input.value = String(read());
    };
    input.addEventListener('change', () => {
      const value = type === 'number' ? Number(input.value) : input.value.trim();
      if ((type === 'number' && !Number.isFinite(value)) || value === '') {
        show();
        return;
      }
      write(value);
    });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') input.blur();
      if (event.key === 'Escape') {
        input.value = String(read());
        input.blur();
      }
    });
    show();
    this.fields.push(show);
  }

  // Name, what it is, and the things done most often, as one row of buttons.
  header(item, runtime) {
    const node = element('div', 'prop-header');
    const title = element('div', 'prop-title');
    if (this.iconFor) title.append(icon(runtime?.kind === 'missing' ? 'AlertTriangle' : this.iconFor(item, runtime), 16));
    const name = element('input', 'prop-name');
    name.type = 'text';
    name.setAttribute('aria-label', 'Name');
    name.title = 'Click to rename';
    this.bindInput(name, {
      type: 'text',
      read: () => this.editor.item(item.id)?.name ?? '',
      write: (value) => this.editor.updateItem(item.id, { name: value }, `Rename to ${value}`),
    });
    title.append(name);
    node.append(title, element('p', 'prop-subtitle', this.describeSource(item, runtime)));

    if (item.mount || item.attach) {
      const parent = this.editor.item(parentOf(item));
      node.append(element('p', 'prop-subtitle', `${item.mount ? 'Mounted on' : 'Moves with'} ${parent?.name || 'another object'}.`));
    }
    // Size only matters when it may slow the view down.
    const stats = runtime?.asset?.stats;
    if (stats) {
      const { meshes, triangles, drawn = meshes } = stats;
      if (drawn > 300 || triangles > 1.5e6) {
        const warning = element('p', 'prop-warning', `Heavy model (${(triangles / 1e6).toFixed(1)} M triangles): several copies may slow the view.`);
        warning.title = `${meshes.toLocaleString()} parts, drawn as ${drawn}`;
        node.append(warning);
      }
    }

    const actions = element('div', 'prop-actions');
    const action = (iconName, label, run, { pressed, danger } = {}) => {
      const button = element('button', `icon-button${danger ? ' is-danger' : ''}`);
      button.type = 'button';
      button.title = label;
      button.setAttribute('aria-label', label);
      if (pressed !== undefined) {
        button.setAttribute('aria-pressed', String(pressed));
        button.classList.toggle('is-on', pressed);
      }
      button.append(icon(iconName, 15));
      button.addEventListener('click', run);
      actions.append(button);
    };
    const playing = this.editor.playing;
    action('Focus', 'Frame: point the camera at it (F)', () => this.editor.emit('frame', item.id));
    if (!playing) {
      // A floor plan is used once; everything else can be duplicated.
      if (item.source.kind !== 'plan') action('Copy', 'Duplicate (Ctrl+D)', () => this.editor.duplicate(item.id));
      action(item.hidden ? 'EyeOff' : 'Eye', item.hidden ? 'Hidden: click to show' : 'Hide', () => {
        this.editor.updateItem(item.id, { hidden: item.hidden ? undefined : true }, item.hidden ? `Show ${item.name}` : `Hide ${item.name}`);
      }, { pressed: Boolean(item.hidden) });
      action(item.locked ? 'Lock' : 'LockOpen', item.locked ? 'Locked: click to unlock' : 'Lock so it can\'t be moved by accident', () => {
        this.editor.updateItem(item.id, { locked: item.locked ? undefined : true }, item.locked ? `Unlock ${item.name}` : `Lock ${item.name}`);
      }, { pressed: Boolean(item.locked) });
      action('Trash2', 'Delete, with anything mounted on it (Delete)', () => this.editor.removeItems([item.id]), { danger: true });
    }
    node.append(actions);
    return node;
  }

  missingNote(item) {
    const node = element('div', 'prop-missing');
    node.append(element('p', 'editor-message is-error', this.editor.selectedRuntime?.error?.message || 'This model could not be loaded.'));
    if (item.source.kind === 'import' || item.source.kind === 'plan') {
      const relink = element('button', 'primary-button', 'Locate file…');
      relink.type = 'button';
      relink.title = `Choose ${item.source.name || 'the model file'} on this computer`;
      relink.addEventListener('click', () => this.onRelink?.(item));
      node.append(relink);
    }
    return node;
  }

  positionGroup(item, runtime) {
    const { node, body } = this.group('position', 'Position');
    const blocker = this.editor.moveBlocker(item);
    const linked = Boolean(item.mount || item.attach);
    const flat = item.source.kind === 'plan';
    const current = () => this.editor.item(item.id);
    // Mounted items show where they are in the world, but are moved by what they hang off.
    const world = () => {
      const root = runtime?.root;
      if (!root) return { position: current().position, rotation: current().rotation };
      root.updateMatrixWorld(true);
      const position = root.getWorldPosition(new THREE.Vector3()).toArray();
      const euler = new THREE.Euler().setFromQuaternion(root.getWorldQuaternion(new THREE.Quaternion()), 'YXZ');
      return { position, rotation: [euler.x, euler.y, euler.z].map(THREE.MathUtils.radToDeg) };
    };
    const live = () => (linked || this.editor.gizmo.dragging ? world() : this.editor.placementOf(runtime?.root || new THREE.Object3D()));
    const read = (key, index, digits) => () => {
      const value = runtime?.root ? live()[key][index] : current()[key][index];
      return round(value, digits);
    };
    const write = (key, index, label) => (value) => {
      const next = [...current()[key]];
      next[index] = value;
      this.editor.updateItem(item.id, { [key]: next }, `${label} ${current().name}`);
    };
    // While a label is dragged the object moves right away; the change is saved when let go.
    const previewPosition = (index) => (value) => {
      if (!runtime?.root || linked) return;
      runtime.root.position.setComponent(index, value);
    };
    const previewRotation = (index) => (value) => {
      if (!runtime?.root || linked) return;
      const degrees = [...current().rotation];
      degrees[index] = value;
      runtime.root.rotation.set(...degrees.map(THREE.MathUtils.degToRad), 'YXZ');
    };
    const grid = element('div', 'placement-fields');
    grid.append(
      this.field({ label: 'X', unit: 'm', step: 0.05, read: read('position', 0, 3), write: write('position', 0, 'Move'), disabled: blocker, title: 'Left / right on the floor. Drag the label to slide it.', preview: previewPosition(0) }),
      this.field({ label: 'Z', unit: 'm', step: 0.05, read: read('position', 2, 3), write: write('position', 2, 'Move'), disabled: blocker, title: 'Forward / back on the floor. Drag the label to slide it.', preview: previewPosition(2) }),
      // A floor plan lies on the floor; everything else can be raised.
      ...(flat ? [] : [this.field({ label: 'Above floor', unit: 'm', step: 0.05, read: read('position', 1, 3), write: write('position', 1, 'Move'), disabled: blocker, title: 'How high it sits above the floor. Drag the label to raise or lower it.', preview: previewPosition(1) })]),
      this.field({ label: 'Turn', unit: '°', step: 15, read: read('rotation', 1, 1), write: write('rotation', 1, 'Turn'), disabled: blocker, title: 'Turned on the floor. Drag the label to turn it (Shift: 1.5° steps).', preview: previewRotation(1) }),
    );
    if (!flat && (this.editor.freeRotation || Math.abs(item.rotation[0]) > 0.01 || Math.abs(item.rotation[2]) > 0.01)) {
      grid.append(
        this.field({ label: 'Tilt X', unit: '°', step: 15, read: read('rotation', 0, 1), write: write('rotation', 0, 'Tilt'), disabled: blocker, preview: previewRotation(0) }),
        this.field({ label: 'Tilt Z', unit: '°', step: 15, read: read('rotation', 2, 1), write: write('rotation', 2, 'Tilt'), disabled: blocker, preview: previewRotation(2) }),
      );
    }
    body.append(grid);
    if (blocker) body.append(element('p', 'editor-hint', blocker));
    return node;
  }

  animationGroup(item, runtime) {
    const { node, body } = this.group('animation', 'Animation');
    const select = document.createElement('select');
    select.setAttribute('aria-label', 'Animation');
    select.append(new Option('None (still)', ''));
    runtime.asset.animations.forEach((clip, index) => {
      const name = clip.name || `Animation ${index + 1}`;
      select.append(new Option(name, name));
    });
    const show = () => {
      if (document.activeElement !== select) select.value = this.editor.item(item.id)?.animation || '';
    };
    select.addEventListener('change', () => {
      this.editor.updateItem(item.id, { animation: select.value || undefined }, select.value ? `Play ${select.value}` : 'Stop animation');
    });
    show();
    this.fields.push(show);
    const wrapper = element('label', 'editor-field');
    wrapper.append(element('span', null, 'Plays on a loop'), select);
    body.append(wrapper);
    return node;
  }

  // Sequences to play, and the way to Joint Setup in the Machine tab.
  robotGroup(item, runtime) {
    const { rig, player } = runtime.asset;
    const rigged = rig?.joints.length;
    const { node, body } = this.group('robot', rigged ? 'Robot' : 'Joints');
    if (rig?.sequences?.length) {
      const row = element('div', 'button-row sequence-row');
      const select = document.createElement('select');
      select.setAttribute('aria-label', 'Sequence');
      rig.sequences.forEach((sequence) => select.append(new Option(sequence.name, sequence.id)));
      const play = element('button', null);
      play.type = 'button';
      play.append(icon('Play', 12), ' Play');
      play.addEventListener('click', () => {
        const sequence = rig.sequences.find((candidate) => candidate.id === select.value);
        if (sequence) player.playSequence(sequence);
      });
      const stop = element('button', null);
      stop.type = 'button';
      stop.append(icon('Square', 12), ' Stop');
      stop.addEventListener('click', () => player.stop());
      row.append(select, play, stop);
      body.append(element('span', 'editor-subtitle', 'Play a sequence'), row);
    } else if (!rigged) {
      body.append(element('p', 'editor-hint', 'This model has no joints yet, so it can\'t move or use Reach.'));
    }
    if (!this.editor.playing) {
      const setup = element('button', 'prop-link');
      setup.type = 'button';
      setup.append(icon('Wrench', 13), rigged ? ' Edit joints, tool tip and sequences' : ' Set up its joints');
      setup.title = 'Opens this model in the Machine tab. Every copy in every scene uses what you set up there.';
      setup.addEventListener('click', () => this.onEditInMachine?.(item));
      body.append(setup);
    }
    return node;
  }

  jointsGroup(runtime) {
    const { rig, player } = runtime.asset;
    const count = rig.joints.filter((joint) => joint.kind === 'joint' && !joint.driven).length;
    const { node, body } = this.group('joints', 'Move joints by hand', { open: false, note: `${count}` });
    const list = element('div', 'joints-list properties-joints');
    this.jointControls = new JointControls({ container: list, filter: (joint) => joint.kind === 'joint', emptyMessage: 'No joints.' });
    this.jointControls.setRig(rig, player);
    body.append(list);
    return node;
  }

  syncValues() {
    this.fields.forEach((show) => show());
  }

  update() {
    this.jointControls?.update();
  }
}
