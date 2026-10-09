import * as THREE from 'three';
import {
  DEFAULT_APPROACH, DEFAULT_BOX, STEP_ORDER, STEP_TYPES, WORKER_STEP_ORDER, duplicateStep, emptyProgram, enclosingGrid, findStep, gridSpots,
  insertSteps, moveStep, movePalletSteps, newStep, normalizeProgram, pickAndPlaceSteps, removeStep, stepCount, updateStep,
} from '../program/Program.js';
import {
  destinationChoices, destinationLabel, gridSurfaces, gridWorldSpots, isPallet, itemFrame, palletChoices, palletLabel, sceneSpots,
  targetFrame, targetLabel,
} from '../program/targets.js';
import { getComponent, resolveParams } from '../catalog/index.js';
import { icon } from './icons.js';
import { makeScrubbable } from './scrub.js';

const UP = new THREE.Vector3(0, 1, 0);

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label, run, { title, className, iconName } = {}) {
  const control = element('button', className);
  control.type = 'button';
  if (iconName) control.append(icon(iconName, 13));
  if (label) control.append(iconName ? ` ${label}` : label);
  if (title) {
    control.title = title;
    if (!label) control.setAttribute('aria-label', title);
  }
  control.addEventListener('click', run);
  return control;
}

const key = (target) => (target ? JSON.stringify(target) : '');
const same = (a, b) => key(a) === key(b);
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

// A robot's program, in the Selected panel: the steps it runs when the scene plays. A worker with
// a pallet jack gets the same panel with its own steps (pick up a pallet, go to, put it down).
//
// Steps are listed in order (blocks indent the steps they repeat). Click a step to open it: its
// settings, where it goes (shown in the 3D view, green if the robot can reach it), and buttons
// to move, copy or delete it. While the scene plays the list shows which step is running, and
// the reason if the robot had to stop.
export class ProgramPanel {
  constructor({ editor, markers, checker, pickTarget, previewReach, runnerFor }) {
    this.editor = editor;
    this.markers = markers;
    this.checker = checker;
    this.pickTarget = pickTarget;
    this.previewReach = previewReach;
    this.runnerFor = runnerFor;
    this.itemId = null;
    this.expanded = null;
    this.adding = null;
    this.builder = null;
    this.signature = null;
    this.body = null;
    editor.onChange((type) => {
      if (type === 'selection' && editor.selectedId !== this.itemId) this.detach();
    });
  }

  // ---- The group in the Selected panel -----------------------------------------------------

  // Called by the Selected panel for a selected robot or worker; returns the group to show, or null.
  section(item, runtime, panel) {
    const robot = runtime?.kind === 'model' && runtime.asset?.rig?.joints.length;
    const worker = runtime?.kind === 'component' && runtime.component?.palletJack;
    if (!robot && !worker) {
      this.detach();
      return null;
    }
    if (item.id !== this.itemId) {
      this.itemId = item.id;
      this.expanded = null;
      this.adding = null;
      this.builder = null;
    }
    const count = stepCount(this.program.steps);
    const { node, body } = panel.group('program', 'Program', { open: true, note: count ? plural(count, 'step') : 'empty' });
    this.body = body;
    this.signature = null;
    this.render();
    return node;
  }

  detach() {
    this.itemId = null;
    this.body = null;
    this.markers.clear();
    this.checker.cancel();
  }

  get item() {
    return this.itemId ? this.editor.item(this.itemId) : null;
  }

  get runtime() {
    return this.itemId ? this.editor.runtimes.get(this.itemId) : null;
  }

  get program() {
    return normalizeProgram(this.item?.program || emptyProgram());
  }

  get rig() {
    return this.runtime?.asset?.rig;
  }

  // A worker with a pallet jack rather than a robot.
  get worker() {
    return Boolean(this.runtime?.component?.palletJack);
  }

  get playing() {
    return this.editor.playing;
  }

  commit(change, label) {
    const next = change(this.program);
    this.editor.updateItem(this.itemId, { program: next }, label);
  }

  // ---- Rendering ---------------------------------------------------------------------------

  // What the panel looks like depends on these; anything else is updated in place.
  structure() {
    return JSON.stringify([this.itemId, this.item?.program || null, this.playing, this.expanded, this.adding, this.builder, this.runnerFor(this.itemId)?.error || null, this.editor.items.map((item) => [item.id, item.name])]);
  }

  render() {
    const { body } = this;
    if (!body) return;
    this.signature = this.structure();
    this.live = [];
    const program = this.program;
    const count = stepCount(program.steps);
    const note = body.parentElement?.querySelector(':scope > summary small');
    if (note) note.textContent = count ? plural(count, 'step') : 'empty';
    const parts = [];
    if (this.playing) parts.push(this.runStatus());
    if (!this.worker && !this.rig.tools.length) {
      parts.push(element('p', 'program-warning', 'No tool tip yet: put a gripper on this robot (select the gripper → Attach), or set its tool tip with Reach → Tool tip. Reach and Grip need it.'));
    }
    if (!program.steps.length && !this.playing) {
      parts.push(element('p', 'editor-hint', this.worker
        ? 'This worker stands still when the scene plays. Add steps one by one, or let Move a pallet write a whole trip for you.'
        : 'This robot stands still when the scene plays. Add steps one by one, or let Pick & place write a whole cycle for you.'));
    }
    if (program.steps.length) {
      const list = element('ol', 'program-steps');
      const counter = { value: 0 };
      program.steps.forEach((step) => list.append(this.stepRow(step, counter, program)));
      parts.push(list);
    }
    if (!this.playing) {
      if (this.builder) parts.push(this.builderForm());
      else {
        const actions = element('div', 'program-actions');
        actions.append(
          button('Add step', () => { this.adding = this.adding === 'root' ? null : 'root'; this.render(); }, { iconName: 'Plus', className: this.adding === 'root' ? 'is-active' : '' }),
          this.worker
            ? button('Move a pallet', () => this.addPalletTrip(), { iconName: 'WandSparkles', title: 'Write a whole trip: pick up a pallet, take it somewhere, put it down and come back' })
            : button('Pick & place', () => { this.builder = this.defaultBuilder(); this.adding = null; this.render(); }, { iconName: 'WandSparkles', title: 'Write a whole pick-and-place cycle: wait for a box, pick it up, put it on the next spot of a grid' }),
        );
        parts.push(actions);
        if (this.adding === 'root') parts.push(this.addMenu(null));
      }
      if (program.steps.length) {
        const loop = element('label', 'editor-check');
        const input = Object.assign(document.createElement('input'), { type: 'checkbox', checked: program.loop });
        input.addEventListener('change', () => this.commit((current) => ({ ...current, loop: input.checked }), input.checked ? 'Repeat program' : 'Run program once'));
        loop.append(input, ' Start over when it ends');
        parts.push(loop);
      }
    }
    body.replaceChildren(...parts);
    this.updateLive();
  }

  runStatus() {
    const node = element('p', 'program-status');
    this.live.push(() => {
      const runner = this.runnerFor(this.itemId);
      node.classList.toggle('is-error', Boolean(runner?.error));
      node.textContent = !runner ? 'There is no program to run.'
        : runner.error ? `Stopped: ${runner.error.message}`
          : runner.finished ? 'Program finished.'
            : `Now: ${runner.status}`;
    });
    return node;
  }

  stepRow(step, counter, program) {
    counter.value += 1;
    const type = STEP_TYPES[step.type] || { label: step.type, icon: 'Box' };
    const row = element('li', 'program-step');
    row.dataset.stepId = step.id;
    const open = this.expanded === step.id && !this.playing;
    row.classList.toggle('is-open', open);
    const runner = this.runnerFor(this.itemId);
    if (runner?.error?.stepId === step.id) row.classList.add('is-error');

    const head = element('button', 'program-step-head');
    head.type = 'button';
    head.setAttribute('aria-expanded', String(open));
    const number = element('span', 'program-step-number', String(counter.value));
    const text = element('span', 'program-step-text');
    text.append(element('strong', null, type.label), element('span', null, this.describe(step)));
    head.append(number, icon(type.icon, 14), text);
    // Whether the robot can reach it (while editing; playing shows what really happens instead).
    const reach = !this.playing && this.reachState(step, program);
    if (reach) {
      const badge = element('span', 'program-step-reach');
      this.live.push(() => {
        const state = this.reachState(step, this.program);
        badge.dataset.state = state;
        badge.title = { ok: 'The robot can reach this', fail: 'The robot can\'t reach this (open the step for details)', pending: 'Checking whether the robot can reach this…' }[state];
      });
      head.append(badge);
    }
    if (!this.playing) head.addEventListener('click', () => { this.expanded = open ? null : step.id; this.adding = null; this.render(); });
    else head.disabled = true;
    row.append(head);
    if (runner?.error?.stepId === step.id) row.append(element('p', 'program-step-error', runner.error.message));
    if (open) row.append(this.stepEditor(step, program));

    if (step.steps) {
      const nested = element('ol', 'program-steps is-nested');
      step.steps.forEach((child) => nested.append(this.stepRow(child, counter, program)));
      if (!this.playing) {
        const add = element('li', 'program-add-inside');
        add.append(button(`Add step inside`, () => { this.adding = this.adding === step.id ? null : step.id; this.render(); }, { iconName: 'Plus', className: `prop-link${this.adding === step.id ? ' is-active' : ''}` }));
        if (this.adding === step.id) add.append(this.addMenu(step.id));
        nested.append(add);
      }
      row.append(nested);
    }
    return row;
  }

  addMenu(parentId) {
    const menu = element('div', 'program-add-menu');
    const insideGrid = parentId && (findStep(this.program.steps, parentId)?.step.type === 'grid' || enclosingGrid(this.program.steps, parentId));
    (this.worker ? WORKER_STEP_ORDER : STEP_ORDER).forEach((type) => {
      const definition = STEP_TYPES[type];
      const choice = element('button', 'program-add-choice');
      choice.type = 'button';
      const text = element('span');
      text.append(element('strong', null, definition.label), element('small', null, definition.help));
      choice.append(icon(definition.icon, 15), text);
      choice.addEventListener('click', () => {
        const settings = type === 'reach' && insideGrid ? { target: { kind: 'grid' } } : this.defaultsFor(type);
        const step = newStep(type, settings);
        this.adding = null;
        this.expanded = step.id;
        this.commit((program) => insertSteps(program, [step], { parentId }), `Add ${definition.label.toLowerCase()} step`);
      });
      menu.append(choice);
    });
    return menu;
  }

  // Sensible first settings, so a new step usually works without changing anything.
  defaultsFor(type) {
    const rig = this.rig;
    if (type === 'pick-pallet') return { pallet: palletChoices(this.editor)[0]?.id ?? null };
    if (type === 'wait-load') {
      const pallet = palletChoices(this.editor)[0]?.id ?? null;
      return { pallet, count: this.expectedLoad(pallet) || 1 };
    }
    if (type === 'pose') return { pose: rig.poses[0]?.id ?? null };
    if (type === 'sequence') return { sequence: rig.sequences[0]?.id ?? null };
    if (type === 'grid') {
      const surface = gridSurfaces(this.editor, this.itemId).find((spot) => this.editor.runtimes.get(spot.target.item)?.component?.belt === undefined);
      const box = this.boxSize();
      return { on: surface?.target || null, spacing: [Math.round((box.length + 0.02) * 1000) / 1000, Math.round((box.width + 0.02) * 1000) / 1000], layerHeight: box.height };
    }
    if (type === 'conveyor') return { item: this.conveyors()[0]?.id ?? null };
    return {};
  }

  // The size of the boxes in this scene: a box source's, or the usual box.
  boxSize() {
    const source = this.editor.items.find((item) => item.source.kind === 'catalog' && item.source.id === 'box_source');
    if (!source) return DEFAULT_BOX;
    const params = resolveParams(getComponent('box_source'), source.params);
    return { length: params.boxLength, width: params.boxWidth, height: params.boxHeight };
  }

  conveyors() {
    return this.editor.items.filter((item) => this.editor.runtimes.get(item.id)?.component?.belt);
  }

  // How many boxes a robot in this scene stacks on a pallet (the spots of its grid there), or 0.
  expectedLoad(palletId) {
    if (!palletId) return 0;
    let count = 0;
    const visit = (steps) => steps.forEach((step) => {
      if (step.type === 'grid' && step.on?.item === palletId) count = Math.max(count, gridSpots(step).length);
      if (step.steps) visit(step.steps);
    });
    this.editor.items.forEach((item) => visit(normalizeProgram(item.program).steps));
    return count;
  }

  // "Move a pallet": the first pallet, taken to the first other object (a wrapper, if there is
  // one), after waiting for a robot to fill it if one stacks it.
  addPalletTrip() {
    const pallet = palletChoices(this.editor)[0]?.id ?? null;
    const destinations = destinationChoices(this.editor, this.itemId).filter((choice) => !isPallet(this.editor.item(choice.target.item)));
    const wrapper = destinations.find((choice) => this.editor.item(choice.target.item)?.source.id === 'stretch_wrapper');
    const to = (wrapper || destinations.find((choice) => !this.editor.runtimes.get(choice.target.item)?.asset?.rig) || destinations[0])?.target ?? null;
    const steps = movePalletSteps({ pallet, to, waitFor: this.expectedLoad(pallet) });
    this.adding = null;
    this.expanded = null;
    this.commit((program) => insertSteps(program, steps), 'Add pallet trip');
  }

  describe(step) {
    const rig = this.rig;
    switch (step.type) {
      case 'pose': return rig.poses.find((pose) => pose.id === step.pose)?.name || 'choose a pose';
      case 'sequence': return rig.sequences.find((sequence) => sequence.id === step.sequence)?.name || 'choose a sequence';
      case 'reach': return step.target ? targetLabel(this.editor, step.target) : 'choose where';
      case 'grip': return 'the box at the tool tip';
      case 'release': return 'the box it holds';
      case 'wait': return `${step.seconds ?? 0} s`;
      case 'wait-box': return step.at ? `at ${targetLabel(this.editor, step.at)}` : 'choose where';
      case 'grid': {
        const count = gridSpots(step).length;
        return `${step.on ? `on ${targetLabel(this.editor, step.on).replace(/ · top$/, '')}` : 'choose a surface'} · ${step.columns}×${step.rows}×${step.layers} = ${plural(count, 'spot')}`;
      }
      case 'repeat': return plural(step.times ?? 0, 'time');
      case 'conveyor': {
        const conveyor = this.editor.item(step.item);
        return conveyor ? `${conveyor.name} ${step.running ? 'on' : 'off'}` : 'choose a conveyor';
      }
      case 'pick-pallet': return palletLabel(this.editor, step.pallet) || 'choose a pallet';
      case 'go-to': return destinationLabel(this.editor, step.target) || 'choose where';
      case 'put-down': return 'where it is';
      case 'wait-load': {
        const count = step.count ?? 1;
        return step.pallet ? `${count} box${count === 1 ? '' : 'es'} on ${palletLabel(this.editor, step.pallet)}` : 'choose a pallet';
      }
      default: return '';
    }
  }

  // ---- Editing one step ------------------------------------------------------------------------

  stepEditor(step, program) {
    const node = element('div', 'program-step-body');
    const update = (patch, label) => this.commit((current) => updateStep(current, step.id, patch), label);
    const fields = element('div', 'program-fields');
    const help = STEP_TYPES[step.type]?.help;
    if (help) node.append(element('p', 'editor-hint', help));

    switch (step.type) {
      case 'pose': {
        if (!this.rig.poses.length) node.append(element('p', 'program-warning', 'This robot has no saved poses yet. Save some in the Machine tab → Animation Setup.'));
        else fields.append(this.select('Pose', this.rig.poses.map((pose) => [pose.id, pose.name]), step.pose, (value) => update({ pose: value }, 'Choose pose')));
        break;
      }
      case 'sequence': {
        if (!this.rig.sequences.length) node.append(element('p', 'program-warning', 'This robot has no saved sequences yet. Make some in the Machine tab → Animation Setup.'));
        else fields.append(this.select('Sequence', this.rig.sequences.map((sequence) => [sequence.id, sequence.name]), step.sequence, (value) => update({ sequence: value }, 'Choose sequence')));
        break;
      }
      case 'reach': {
        const inGrid = Boolean(enclosingGrid(program.steps, step.id));
        node.append(this.targetEditor(step, inGrid, update));
        fields.append(
          this.number('Come from above', 'm', step.approach ?? DEFAULT_APPROACH, 0.05, 0, (value) => update({ approach: value }, 'Change approach'), 'Goes up, across and down from this high above. 0: straight there.'),
          this.select('Tool points', [['down', 'Straight down'], ['any', 'Any angle']], step.orient || 'down', (value) => update({ orient: value }, 'Change tool direction')),
        );
        break;
      }
      case 'wait':
        fields.append(this.number('Seconds', 's', step.seconds ?? 1, 0.5, 0, (value) => update({ seconds: value }, 'Change wait')));
        break;
      case 'wait-box':
        node.append(this.spotPicker('Where', step.at, (target) => update({ at: target }, 'Choose where to wait'), 'wait for a box'));
        break;
      case 'grid': {
        const surfaces = gridSurfaces(this.editor, this.itemId);
        fields.append(
          this.select('On', surfaces.map((spot) => [key(spot.target), spot.label.replace(/ · top$/, '')]), key(step.on), (value) => update({ on: value ? JSON.parse(value) : null }, 'Choose grid surface'), 'choose…'),
          this.number('Columns', '', step.columns, 1, 1, (value) => update({ columns: Math.round(value) }, 'Change grid')),
          this.number('Rows', '', step.rows, 1, 1, (value) => update({ rows: Math.round(value) }, 'Change grid')),
          this.number('Layers', '', step.layers, 1, 1, (value) => update({ layers: Math.round(value) }, 'Change grid')),
          this.number('Spacing along', 'm', step.spacing[0], 0.01, 0.01, (value) => update({ spacing: [value, step.spacing[1]] }, 'Change grid spacing'), 'Distance between spots along the object\'s length (usually a box length plus a gap)'),
          this.number('Spacing across', 'm', step.spacing[1], 0.01, 0.01, (value) => update({ spacing: [step.spacing[0], value] }, 'Change grid spacing'), 'Distance between rows (usually a box width plus a gap)'),
          this.number('Layer height', 'm', step.layerHeight, 0.01, 0.01, (value) => update({ layerHeight: value }, 'Change layer height'), 'How much higher each layer is (usually the box height)'),
        );
        node.append(this.reachSummary(step, program));
        break;
      }
      case 'repeat':
        fields.append(this.number('Times', '', step.times ?? 1, 1, 0, (value) => update({ times: Math.round(value) }, 'Change repeat count')));
        break;
      case 'conveyor': {
        const conveyors = this.conveyors();
        if (!conveyors.length) node.append(element('p', 'program-warning', 'There is no conveyor in this scene.'));
        else {
          fields.append(
            this.select('Conveyor', conveyors.map((item) => [item.id, item.name]), step.item, (value) => update({ item: value }, 'Choose conveyor')),
            this.select('Switch it', [['on', 'On'], ['off', 'Off']], step.running ? 'on' : 'off', (value) => update({ running: value === 'on' }, 'Switch conveyor')),
          );
        }
        break;
      }
      case 'pick-pallet':
        node.append(this.palletPicker(step.pallet, (value) => update({ pallet: value }, 'Choose pallet')));
        break;
      case 'go-to':
        node.append(this.destinationPicker(step.target, (target) => update({ target }, 'Choose where to go')));
        break;
      case 'wait-load':
        node.append(this.palletPicker(step.pallet, (value) => update({ pallet: value }, 'Choose pallet')));
        fields.append(this.number('Boxes', '', step.count ?? 1, 1, 1, (value) => update({ count: Math.round(value) }, 'Change box count'), 'Carry on once the pallet has at least this many boxes on it'));
        break;
      default:
        break;
    }
    if (fields.children.length) node.append(fields);

    const tools = element('div', 'program-step-tools');
    const found = findStep(program.steps, step.id);
    const up = button('', () => this.commit((current) => moveStep(current, step.id, -1), 'Move step up'), { iconName: 'ChevronUp', title: 'Move up', className: 'icon-button' });
    const down = button('', () => this.commit((current) => moveStep(current, step.id, 1), 'Move step down'), { iconName: 'ChevronDown', title: 'Move down', className: 'icon-button' });
    up.disabled = found.index === 0;
    down.disabled = found.index === found.list.length - 1;
    tools.append(
      up,
      down,
      button('', () => this.commit((current) => duplicateStep(current, step.id), 'Copy step'), { iconName: 'Copy', title: 'Copy (right after it)', className: 'icon-button' }),
    );
    if (step.type === 'reach' && step.target && step.target.kind !== 'box') {
      tools.append(button('Show me', () => this.previewReach(this.itemId, this.previewPoint(step, program), step.orient), { iconName: 'Crosshair', title: 'Move the robot there now, to see it', className: 'program-try' }));
    }
    tools.append(button('', () => { this.expanded = null; this.commit((current) => removeStep(current, step.id), 'Delete step'); }, { iconName: 'Trash2', title: 'Delete step', className: 'icon-button is-danger' }));
    node.append(tools);
    return node;
  }

  // Reach targets: what (a spot, the box waiting at a spot, the next grid spot) and where.
  targetEditor(step, inGrid, update) {
    const node = element('div', 'program-target');
    const target = step.target;
    const kind = target?.kind === 'box' ? 'box' : target?.kind === 'grid' ? 'grid' : 'spot';
    const kinds = [['spot', 'A spot'], ['box', 'The box waiting at a spot']];
    if (inGrid || kind === 'grid') kinds.push(['grid', 'The next spot on the grid']);
    node.append(this.select('Reach', kinds, kind, (value) => {
      const where = target?.kind === 'box' ? target.at : target?.kind === 'grid' ? null : target;
      if (value === 'grid') update({ target: { kind: 'grid' } }, 'Reach the grid');
      else if (value === 'box') update({ target: where ? { kind: 'box', at: where } : null }, 'Reach a box');
      else update({ target: where }, 'Reach a spot');
    }));
    if (kind === 'grid') {
      if (!inGrid) node.append(element('p', 'program-warning', 'Put this step inside a "Repeat across a grid" step.'));
    } else {
      const where = kind === 'box' ? target?.at : target;
      node.append(this.spotPicker('Where', where, (picked) => update({ target: kind === 'box' ? { kind: 'box', at: picked } : picked }, 'Choose where to reach'), kind === 'box' ? 'find the box' : 'reach'));
    }
    if (target) node.append(this.reachSummary(step, null));
    return node;
  }

  // A spot: chosen from the scene's named spots, or clicked in the view.
  spotPicker(label, current, choose, purpose) {
    const row = element('div', 'program-spot');
    const spots = sceneSpots(this.editor, this.itemId);
    const options = spots.map((spot) => [key(spot.target), spot.label]);
    if (current && !spots.some((spot) => same(spot.target, current))) options.unshift([key(current), targetLabel(this.editor, current)]);
    row.append(
      this.select(label, options, key(current), (value) => choose(value ? JSON.parse(value) : null), 'choose…'),
      button('', () => this.pickTarget({ purpose, onPicked: choose }), { iconName: 'Crosshair', title: 'Click the spot in the 3D view (near a conveyor end or a pallet top it snaps to it)', className: 'icon-button' }),
    );
    return row;
  }

  // A pallet, from a list numbered when there are several.
  palletPicker(current, choose) {
    const node = element('div', 'program-fields');
    const pallets = palletChoices(this.editor);
    if (!pallets.length) {
      node.append(element('p', 'program-warning', 'There is no pallet in this scene: add one (Add → Pallets & boxes).'));
      return node;
    }
    node.append(this.select('Pallet', pallets.map((choice) => [choice.id, choice.label]), current, (value) => choose(value), 'choose…'));
    return node;
  }

  // Where a worker goes: an object, where it started, or a point clicked on the floor.
  destinationPicker(current, choose) {
    const row = element('div', 'program-spot');
    const options = [[key({ kind: 'start' }), 'Where it started'], ...destinationChoices(this.editor, this.itemId).map((choice) => [key(choice.target), choice.label])];
    if (current && !options.some(([value]) => value === key(current))) options.push([key(current), destinationLabel(this.editor, current)]);
    row.append(
      this.select('Go to', options, key(current), (value) => choose(value ? JSON.parse(value) : null), 'choose…'),
      button('', () => this.pickTarget({
        purpose: 'go to',
        onPicked: (target) => choose(target.item ? { kind: 'item', item: target.item } : target),
      }), { iconName: 'Crosshair', title: 'Click an object or a point on the floor in the 3D view', className: 'icon-button' }),
    );
    return row;
  }

  // Where a worker's step goes, to show in the 3D view: a pallet's top or the destination.
  workerPoint(step) {
    const palletId = step.type === 'pick-pallet' || step.type === 'wait-load' ? step.pallet : null;
    if (palletId) {
      const frame = itemFrame(this.editor, palletId);
      const height = this.editor.runtimes.get(palletId)?.component?.palletSize?.height ?? 0;
      return frame ? frame.position.addScaledVector(UP, height) : null;
    }
    if (step.type !== 'go-to' || !step.target) return null;
    if (step.target.kind === 'start') return itemFrame(this.editor, this.itemId)?.position || null;
    if (step.target.kind === 'item') return itemFrame(this.editor, step.target.item)?.position || null;
    return targetFrame(this.editor, step.target)?.position || null;
  }

  // ---- Reachability ----------------------------------------------------------------------------

  // The points a step needs the robot to reach (to check and to show), or null if it has none.
  // [{ position, above }] and, for grids, the boxes' places.
  stepPoints(step, program) {
    const approach = Math.max(0, step.approach ?? DEFAULT_APPROACH);
    const withAbove = (position, extra = 0) => ({ position, above: approach > 0 ? position.clone().addScaledVector(UP, approach + extra) : null });
    if (step.type === 'grid') return this.gridPoints(step, approach);
    if (step.type !== 'reach' || !step.target) return null;
    if (step.target.kind === 'grid') {
      const grid = program && enclosingGrid(program.steps, step.id);
      return grid ? this.gridPoints(grid, approach) : null;
    }
    if (step.target.kind === 'box') {
      const frame = targetFrame(this.editor, step.target.at);
      return frame ? { points: [withAbove(frame.position.clone().addScaledVector(UP, this.boxSize().height))] } : null;
    }
    const frame = targetFrame(this.editor, step.target);
    return frame ? { points: [withAbove(frame.position)] } : null;
  }

  // Each grid spot, as a box standing there and the tool tip on top of it (where a box is let go).
  gridPoints(grid, approach) {
    const spots = grid.on ? gridWorldSpots(this.editor, grid) : null;
    if (!spots) return null;
    const height = grid.layerHeight;
    const size = [Math.max(0.02, grid.spacing[0] - 0.02), height, Math.max(0.02, grid.spacing[1] - 0.02)];
    return {
      grid: true,
      points: spots.map((spot) => {
        const top = spot.position.clone().addScaledVector(UP, height + 0.01);
        return { position: top, above: approach > 0 ? top.clone().addScaledVector(UP, approach + height) : null, spot, size };
      }),
    };
  }

  pointState(point, orient) {
    return this.checker.checkAll(this.runtime, [point.position, point.above].filter(Boolean), orient);
  }

  reachState(step, program) {
    const found = this.stepPoints(step, program);
    if (!found?.points.length) return null;
    const states = found.points.map((point) => this.pointState(point, step.orient));
    if (states.includes('fail')) return 'fail';
    if (states.includes('pending')) return 'pending';
    return 'ok';
  }

  reachSummary(step, program) {
    const node = element('p', 'program-reach');
    this.live.push(() => {
      const found = this.stepPoints(step, program || this.program);
      if (!found?.points.length) {
        node.textContent = '';
        return;
      }
      const states = found.points.map((point) => this.pointState(point, step.orient));
      const failed = states.map((state, index) => (state === 'fail' ? index + 1 : null)).filter(Boolean);
      const pending = states.filter((state) => state === 'pending').length;
      node.dataset.state = failed.length ? 'fail' : pending ? 'pending' : 'ok';
      if (found.grid) {
        node.textContent = failed.length ? `Can't reach ${failed.length === states.length ? 'any spot' : `spot${failed.length === 1 ? '' : 's'} ${failed.join(', ')}`} of ${states.length}. Move the robot or the ${step.type === 'grid' ? 'surface' : 'grid'} closer.`
          : pending ? `Checking ${states.length - pending} of ${states.length} spots…` : `The robot can reach all ${states.length} spots.`;
      } else {
        node.textContent = failed.length ? 'The robot can\'t reach this (with the tool pointing that way). Move the robot or the spot, or lower "Come from above".'
          : pending ? 'Checking whether the robot can reach this…' : 'The robot can reach this.';
      }
    });
    return node;
  }

  // Where "Show me" moves the tool: the spot, or the first spot of the grid.
  previewPoint(step, program) {
    const found = this.stepPoints(step, program);
    return found?.points[0]?.position || null;
  }

  // ---- Pick & place --------------------------------------------------------------------------

  defaultBuilder() {
    const ends = sceneSpots(this.editor, this.itemId, { types: ['flow-out'] });
    const conveyorEnd = ends.find((spot) => this.editor.runtimes.get(spot.target.item)?.component?.belt) || ends[0];
    const surface = gridSurfaces(this.editor, this.itemId).find((spot) => !this.editor.runtimes.get(spot.target.item)?.component?.belt);
    return { from: conveyorEnd?.target || null, onto: surface?.target || null, columns: 3, rows: 3, layers: 1 };
  }

  builderForm() {
    const form = element('div', 'program-builder');
    const builder = this.builder;
    const set = (patch) => { this.builder = { ...this.builder, ...patch }; this.render(); };
    form.append(element('strong', null, 'Pick & place'));
    form.append(element('p', 'editor-hint', 'Writes the usual cycle: wait for a box, pick it up, put it on the next spot of a grid, and repeat until the grid is full.'));
    form.append(this.spotPicker('Pick boxes from', builder.from, (target) => set({ from: target }), 'pick boxes from'));
    const surfaces = gridSurfaces(this.editor, this.itemId);
    const fields = element('div', 'program-fields');
    fields.append(
      this.select('Put them on', surfaces.map((spot) => [key(spot.target), spot.label.replace(/ · top$/, '')]), key(builder.onto), (value) => set({ onto: value ? JSON.parse(value) : null }), 'choose…'),
      this.number('Columns', '', builder.columns, 1, 1, (value) => set({ columns: Math.round(value) })),
      this.number('Rows', '', builder.rows, 1, 1, (value) => set({ rows: Math.round(value) })),
      this.number('Layers', '', builder.layers, 1, 1, (value) => set({ layers: Math.round(value) })),
    );
    form.append(fields);
    const box = this.boxSize();
    form.append(element('p', 'editor-hint', `Boxes: ${Math.round(box.length * 100)} × ${Math.round(box.width * 100)} × ${Math.round(box.height * 100)} cm${this.editor.items.some((item) => item.source.id === 'box_source') ? ' (from the box source)' : ''}.`));
    const actions = element('div', 'program-actions');
    const add = button('Add these steps', () => {
      const homePose = (this.rig.poses.find((pose) => /home/i.test(pose.name)) || this.rig.poses[0])?.id ?? null;
      const steps = pickAndPlaceSteps({ from: builder.from, onto: builder.onto, grid: { columns: builder.columns, rows: builder.rows, layers: builder.layers }, box, homePose });
      this.builder = null;
      this.expanded = steps.find((step) => step.type === 'grid')?.id ?? null;
      this.commit((program) => insertSteps(program, steps), 'Add pick & place');
    }, { className: 'primary-button' });
    add.disabled = !builder.from || !builder.onto;
    actions.append(add, button('Cancel', () => { this.builder = null; this.render(); }));
    form.append(actions);
    return form;
  }

  // ---- Small form controls -----------------------------------------------------------------------

  select(label, options, value, onChange, placeholder = null) {
    const wrapper = element('label', 'editor-field');
    const select = document.createElement('select');
    if (placeholder !== null || !options.some(([optionValue]) => optionValue === value)) select.append(new Option(placeholder || 'choose…', ''));
    options.forEach(([optionValue, text]) => select.append(new Option(text, optionValue)));
    select.value = value ?? '';
    select.addEventListener('change', () => onChange(select.value || null));
    wrapper.append(element('span', null, label), select);
    return wrapper;
  }

  number(label, unit, value, step, min, onChange, title) {
    const wrapper = element('label', 'editor-field');
    const caption = element('span', null, label);
    if (unit) caption.append(' ', element('small', null, unit));
    const input = Object.assign(document.createElement('input'), { type: 'number', value: String(value ?? ''), step: String(step) });
    if (min !== undefined) input.min = String(min);
    if (title) wrapper.title = title;
    input.addEventListener('change', () => {
      const parsed = Number(input.value);
      if (!Number.isFinite(parsed) || (min !== undefined && parsed < min)) {
        input.value = String(value ?? '');
        return;
      }
      onChange(parsed);
    });
    input.addEventListener('keydown', (event) => { if (event.key === 'Enter') input.blur(); });
    makeScrubbable(caption, input, { step, min, commit: onChange });
    wrapper.append(caption, input);
    return wrapper;
  }

  // ---- Every frame -----------------------------------------------------------------------------

  updateLive() {
    this.live?.forEach((update) => update());
    this.updateMarkers();
    const runner = this.runnerFor(this.itemId);
    this.body?.querySelectorAll('.program-step').forEach((row) => {
      row.classList.toggle('is-current', Boolean(runner && !runner.error && !runner.finished && row.dataset.stepId === runner.currentId));
    });
  }

  // The open step's spots in the 3D view (nothing while playing).
  updateMarkers() {
    const step = this.expanded && !this.playing ? findStep(this.program.steps, this.expanded)?.step : null;
    if (step && this.worker) {
      const point = this.workerPoint(step);
      if (point) this.markers.show({ points: [{ position: point, state: 'ok' }] });
      else this.markers.clear();
      return;
    }
    const found = step && this.stepPoints(step, this.program);
    if (!found) {
      this.markers.clear();
      return;
    }
    const orient = step.orient;
    if (found.grid) {
      this.markers.show({
        boxes: found.points.map((point) => ({ position: point.spot.position, quaternion: point.spot.quaternion, size: point.size, state: this.pointState(point, orient) })),
      });
    } else {
      this.markers.show({ points: found.points.map((point) => ({ ...point, state: this.pointState(point, orient) })) });
    }
  }

  update() {
    if (!this.itemId || !this.body?.isConnected) return;
    if (this.structure() !== this.signature) {
      // Typing in a field: wait until it is done, so the field isn't replaced under the cursor.
      if (this.body.contains(document.activeElement) && document.activeElement.matches('input[type="number"], input[type="text"]')) return;
      this.render();
      return;
    }
    const answered = this.checker.work();
    if (answered || this.playing) this.updateLive();
  }
}
