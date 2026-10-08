import * as THREE from 'three';
import { JointControls } from '../../ui/JointControls.js';
import { parentOf } from '../SceneDocument.js';
import { icon } from './icons.js';

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

function section(title) {
  const node = element('section', 'editor-section');
  if (title) node.append(element('span', 'editor-section-title', title));
  return node;
}

// Properties of the selected item (like Roblox Studio's Properties window): name, where it is,
// its settings, its joints and animations, and what can be done with it. Rebuilt when another
// item is selected; when only values change, the fields are updated in place so typing isn't
// interrupted.
export class PropertiesPanel {
  constructor({ container, editor, describeSource, onEditInMachine, onRelink, onAdd, extraSections = [] }) {
    this.container = container;
    this.editor = editor;
    this.describeSource = describeSource;
    this.onEditInMachine = onEditInMachine;
    this.onRelink = onRelink;
    this.onAdd = onAdd;
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
      : 'none';
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
    const parts = [this.headerSection(item, runtime)];
    if (runtime?.kind === 'missing') parts.push(this.missingSection(item));
    parts.push(this.placementSection(item, runtime));
    this.extraSections.forEach((build) => {
      const extra = build(item, runtime, this);
      if (extra) parts.push(extra);
    });
    if (runtime?.asset?.animations?.length) parts.push(this.animationSection(item, runtime));
    if (runtime?.asset?.rig?.joints.length) parts.push(this.jointsSection(item, runtime));
    parts.push(this.actionsSection(item, runtime));
    this.container.replaceChildren(...parts);
  }

  renderNothingSelected() {
    const count = this.editor.items.length;
    const node = section();
    node.append(element('p', 'editor-hint', count
      ? `${count} item${count === 1 ? '' : 's'} in this scene. Click one in the 3D view or in the Explorer to see and change its properties.`
      : 'Nothing here yet. Add a robot, a conveyor or one of your imported models to start building the scene.'));
    const row = element('div', 'button-row');
    const add = element('button', 'primary-button', 'Add models and parts');
    add.type = 'button';
    add.addEventListener('click', () => this.onAdd?.());
    row.append(add);
    node.append(row);
    this.container.replaceChildren(node);
  }

  // A text/number field bound to a value of the selected item. read() → value; write(value) commits.
  field({ label, unit, type = 'number', step, read, write, disabled, title }) {
    const wrapper = element('label', 'editor-field');
    const caption = element('span', null, label);
    if (unit) caption.append(' ', element('small', null, unit));
    const input = document.createElement('input');
    input.type = type;
    if (step) input.step = String(step);
    input.disabled = Boolean(disabled);
    if (title) wrapper.title = title;
    const show = () => {
      if (document.activeElement !== input) input.value = String(read());
    };
    input.addEventListener('change', () => {
      const value = type === 'number' ? Number(input.value) : input.value.trim();
      if (type === 'number' && !Number.isFinite(value)) {
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
    wrapper.append(caption, input);
    return wrapper;
  }

  headerSection(item, runtime) {
    const node = section();
    node.append(this.field({
      label: 'Name',
      type: 'text',
      read: () => this.editor.item(item.id)?.name ?? '',
      write: (name) => name && this.editor.updateItem(item.id, { name }, `Rename to ${name}`),
    }));
    const source = element('p', 'editor-hint properties-source');
    source.textContent = this.describeSource(item, runtime);
    node.append(source);
    if (runtime?.asset?.stats) {
      const { meshes, triangles } = runtime.asset.stats;
      const heavy = meshes > 300 || triangles > 1.5e6;
      const stats = element('p', `editor-hint properties-stats${heavy ? ' is-heavy' : ''}`);
      stats.textContent = `${meshes.toLocaleString()} parts · ${(triangles / 1e6).toFixed(2)} M triangles${heavy ? ' · heavy: several of these may slow the view' : ''}`;
      node.append(stats);
    }
    if (item.mount || item.attach) {
      const parent = this.editor.item(parentOf(item));
      node.append(element('p', 'editor-hint', `${item.mount ? 'Mounted on' : 'Follows'} "${parent?.name || '?'}": it moves with it.`));
    }
    return node;
  }

  missingSection(item) {
    const node = section();
    const message = element('p', 'editor-message is-error');
    message.textContent = this.editor.selectedRuntime?.error?.message || 'This model could not be loaded.';
    node.append(message);
    if (item.source.kind === 'import') {
      const row = element('div', 'button-row');
      const relink = element('button', null, 'Locate file…');
      relink.type = 'button';
      relink.title = `Choose ${item.source.name || 'the model file'} on this computer`;
      relink.addEventListener('click', () => this.onRelink?.(item));
      row.append(relink);
      node.append(row);
    }
    return node;
  }

  placementSection(item, runtime) {
    const node = section('Placement');
    const blocker = this.editor.moveBlocker(item);
    const linked = Boolean(item.mount || item.attach);
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
    const grid = element('div', 'placement-fields');
    grid.append(
      this.field({ label: 'X', unit: 'm', step: 0.05, read: read('position', 0, 3), write: write('position', 0, 'Move'), disabled: blocker }),
      this.field({ label: 'Height', unit: 'm', step: 0.05, read: read('position', 1, 3), write: write('position', 1, 'Move'), disabled: blocker }),
      this.field({ label: 'Z', unit: 'm', step: 0.05, read: read('position', 2, 3), write: write('position', 2, 'Move'), disabled: blocker }),
      this.field({ label: 'Turn', unit: '°', step: 15, read: read('rotation', 1, 1), write: write('rotation', 1, 'Turn'), disabled: blocker }),
    );
    if (this.editor.freeRotation || Math.abs(item.rotation[0]) > 0.01 || Math.abs(item.rotation[2]) > 0.01) {
      grid.append(
        this.field({ label: 'Tilt X', unit: '°', step: 15, read: read('rotation', 0, 1), write: write('rotation', 0, 'Tilt'), disabled: blocker }),
        this.field({ label: 'Tilt Z', unit: '°', step: 15, read: read('rotation', 2, 1), write: write('rotation', 2, 'Tilt'), disabled: blocker }),
      );
    }
    node.append(grid);
    if (blocker && !this.editor.playing) node.append(element('p', 'editor-hint', blocker));
    return node;
  }

  animationSection(item, runtime) {
    const node = section('Animation');
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
    node.append(wrapper);
    return node;
  }

  jointsSection(item, runtime) {
    const { rig, player } = runtime.asset;
    const node = section('Joints');
    const list = element('div', 'joints-list properties-joints');
    this.jointControls = new JointControls({ container: list, filter: (joint) => joint.kind === 'joint', emptyMessage: 'No joints.' });
    this.jointControls.setRig(rig, player);
    node.append(list);
    if (rig.sequences?.length) {
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
      node.append(element('span', 'editor-subtitle', 'Sequences'), row);
    }
    return node;
  }

  actionsSection(item, runtime) {
    const node = section();
    const row = element('div', 'button-row properties-actions');
    const button = (iconName, label, run, title) => {
      const control = element('button', null);
      control.type = 'button';
      control.append(icon(iconName, 13), ` ${label}`);
      control.title = title || label;
      control.addEventListener('click', run);
      row.append(control);
      return control;
    };
    button('Focus', 'Frame', () => this.editor.emit('frame', item.id), 'Point the camera at it (F)');
    button('Copy', 'Duplicate', () => this.editor.duplicate(item.id), 'Make a copy next to it (Ctrl+D)');
    button('Trash2', 'Delete', () => this.editor.removeItems([item.id]), 'Delete it and anything mounted on it (Delete)');
    if (runtime?.kind === 'model') {
      button('Wrench', 'Joints & animations', () => this.onEditInMachine?.(item), 'Open this model in Machine mode to set up its joints, tool tip and sequences. Every copy in every scene uses them.');
    }
    node.append(row);
    return node;
  }

  syncValues() {
    this.fields.forEach((show) => show());
  }

  update() {
    this.jointControls?.update();
  }
}
