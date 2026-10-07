import { saveRig } from '../motion/RigStore.js';
import { downloadBlob, exportAnimatedGlb, sequenceTimeline } from '../motion/AnimationExport.js';
import { formatJointValue } from './JointControls.js';

// Lets users save poses, chain them into timed sequences, play them, and export them as
// animation clips inside a .glb. Poses and sequences live in the rig definition, next to
// the joints, so they are saved and shared with the rig file.

const MIN_STEP_SECONDS = 0.1;
const MESSAGE_SECONDS = 4;

function slug(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'item';
}

function uniqueId(base, items) {
  const ids = new Set(items.map((item) => item.id));
  if (!ids.has(base)) return base;
  let counter = 2;
  while (ids.has(`${base}_${counter}`)) counter += 1;
  return `${base}_${counter}`;
}

function seconds(value) {
  return `${Math.round(value * 10) / 10} s`;
}

function button(text, label, onClick) {
  const element = document.createElement('button');
  element.type = 'button';
  element.textContent = text;
  if (label) {
    element.setAttribute('aria-label', label);
    element.title = label;
  }
  element.addEventListener('click', onClick);
  return element;
}

export class AnimationEditorPanel {
  // beforeExport() may return a function that undoes whatever it changed.
  constructor({ card, beforeExport }) {
    this.card = card;
    this.beforeExport = beforeExport;
    this.asset = null;
    this.selectedId = null;
    this.exporting = false;
    this.tab = 'poses';
    this.query = (selector) => card.querySelector(selector);
    this.bindEvents();
    this.setTab(this.tab);
  }

  get rig() {
    return this.asset?.rig;
  }

  get player() {
    return this.asset?.player;
  }

  get sequence() {
    return this.rig?.sequences.find((sequence) => sequence.id === this.selectedId) || null;
  }

  bindEvents() {
    this.card.querySelectorAll('[data-anim-tab]').forEach((tab) => {
      tab.addEventListener('click', () => this.setTab(tab.dataset.animTab));
    });
    const poseName = this.query('[data-pose-name]');
    this.query('[data-save-pose]').addEventListener('click', () => this.savePose(poseName.value));
    poseName.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') this.savePose(poseName.value);
    });

    this.query('[data-sequence-select]').addEventListener('change', (event) => {
      this.selectedId = event.target.value;
      this.render();
    });
    this.query('[data-new-sequence]').addEventListener('click', () => this.newSequence());
    this.query('[data-sequence-name]').addEventListener('change', (event) => {
      const name = event.target.value.trim();
      if (name) this.editSequence((sequence) => { sequence.name = name; });
      else event.target.value = this.sequence?.name || '';
    });
    this.query('[data-sequence-loop]').addEventListener('change', (event) => {
      this.editSequence((sequence) => { sequence.loop = event.target.checked; });
    });
    this.query('[data-add-move]').addEventListener('click', () => this.addMove());
    this.query('[data-add-wait]').addEventListener('click', () => {
      this.editSequence((sequence) => { sequence.steps.push({ type: 'wait', duration: 1 }); });
    });
    this.query('[data-play-sequence]').addEventListener('click', () => {
      if (this.sequence) this.player.playSequence(this.sequence);
    });
    this.query('[data-stop-sequence]').addEventListener('click', () => this.player?.stop());
    this.query('[data-delete-sequence]').addEventListener('click', () => this.deleteSequence());
    this.query('[data-export-glb]').addEventListener('click', () => this.exportGlb());
  }

  setAsset(asset) {
    this.unsubscribeRig?.();
    this.unsubscribePlayer?.();
    this.asset = asset;
    this.selectedId = null;
    this.unsubscribeRig = asset.rig.onChange(() => this.scheduleRender());
    this.unsubscribePlayer = asset.player.onChange(() => this.updatePlayState());
    this.query('[data-pose-name]').value = '';
    this.showMessage(null);
    this.render();
  }

  // ---- Saving ----------------------------------------------------------------

  commit(motions) {
    this.rig.setMotions(motions);
    const saved = saveRig(this.asset.config, this.rig.definition);
    if (!saved) this.showMessage("Couldn't save in this browser. Use Joint Setup → Export to keep your poses and sequences.", true);
  }

  setTab(tab) {
    this.tab = tab;
    this.card.querySelectorAll('[data-anim-tab]').forEach((button) => {
      const active = button.dataset.animTab === tab;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-selected', String(active));
    });
    this.card.querySelectorAll('[data-anim-panel]').forEach((panel) => {
      panel.hidden = panel.dataset.animPanel !== tab;
    });
  }

  editSequence(change) {
    const sequences = structuredClone(this.rig.sequences);
    const sequence = sequences.find((item) => item.id === this.selectedId);
    if (!sequence) return;
    sequence.steps ||= [];
    change(sequence);
    this.commit({ sequences });
  }

  // ---- Poses -----------------------------------------------------------------

  currentValues() {
    const values = {};
    this.rig.controllableJoints.forEach((joint) => {
      values[joint.id] = Math.round(joint.value * 1000) / 1000;
    });
    return values;
  }

  savePose(nameText) {
    if (!this.rig) return;
    if (!this.rig.controllableJoints.length) {
      this.showMessage('This model has no joints to pose yet. Set them up in Joint Setup first.', true);
      return;
    }
    const poses = this.rig.poses;
    const name = nameText.trim() || `Pose ${poses.length + 1}`;
    if (poses.some((pose) => pose.name.toLowerCase() === name.toLowerCase())) {
      this.showMessage(`There is already a pose called "${name}". Use its ↻ button to replace it, or pick another name.`, true);
      return;
    }
    const pose = { id: uniqueId(slug(name), poses), name, values: this.currentValues() };
    this.commit({ poses: [...poses, pose] });
    this.query('[data-pose-name]').value = '';
    this.showMessage(`Pose "${name}" saved.`);
  }

  // Swaps the pose's button for a text field; Enter or leaving the field saves, Escape cancels.
  startRename(pose, label) {
    const input = document.createElement('input');
    input.type = 'text';
    input.value = pose.name;
    input.className = 'pose-rename';
    input.setAttribute('aria-label', `New name for ${pose.name}`);
    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      const name = input.value.trim();
      const taken = this.rig.poses.some((other) => other.id !== pose.id && other.name.toLowerCase() === name.toLowerCase());
      if (save && taken) this.showMessage(`There is already a pose called "${name}".`, true);
      if (save && name && !taken && name !== pose.name) {
        this.commit({ poses: this.rig.poses.map((item) => (item.id === pose.id ? { ...item, name } : item)) });
      } else {
        input.replaceWith(label);
      }
    };
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') finish(true);
      if (event.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
    label.replaceWith(input);
    input.focus();
    input.select();
  }

  updatePose(id) {
    const target = this.rig.poses.find((pose) => pose.id === id);
    if (!window.confirm(`Replace "${target.name}" with where the joints are now? Sequences using it will follow.`)) return;
    this.commit({ poses: this.rig.poses.map((pose) => (pose.id === id ? { ...pose, values: this.currentValues() } : pose)) });
    this.showMessage(`Pose "${target.name}" updated.`);
  }

  goToPose(pose) {
    this.player.moveTo(pose.values, { label: `Moving to ${pose.name}` });
  }

  deletePose(id) {
    const target = this.rig.poses.find((pose) => pose.id === id);
    const users = this.rig.sequences.filter((sequence) => (sequence.steps || []).some((step) => step.pose === id));
    const question = users.length
      ? `Delete pose "${target.name}"? It is used in ${users.map((sequence) => `"${sequence.name}"`).join(', ')}; those steps will be removed.`
      : `Delete pose "${target.name}"?`;
    if (!window.confirm(question)) return;
    this.commit({
      poses: this.rig.poses.filter((pose) => pose.id !== id),
      sequences: this.rig.sequences.map((sequence) => (users.includes(sequence)
        ? { ...sequence, steps: sequence.steps.filter((step) => step.pose !== id) }
        : sequence)),
    });
    this.showMessage(`Pose "${target.name}" deleted.`);
  }

  poseSummary(pose) {
    return Object.entries(pose.values)
      .map(([id, value]) => {
        const joint = this.rig.jointsById.get(id);
        return joint ? `${joint.name} ${formatJointValue(joint, value)}` : null;
      })
      .filter(Boolean)
      .join('\n');
  }

  // ---- Sequences -------------------------------------------------------------

  newSequence() {
    if (!this.rig) return;
    const sequences = this.rig.sequences;
    let number = sequences.length + 1;
    while (sequences.some((sequence) => sequence.name === `Sequence ${number}`)) number += 1;
    const name = `Sequence ${number}`;
    const sequence = { id: uniqueId(slug(name), sequences), name, loop: false, steps: [] };
    this.selectedId = sequence.id;
    this.commit({ sequences: [...sequences, sequence] });
    this.showMessage(this.rig.poses.length
      ? `"${name}" created. Add steps with "+ Pose" and "+ Wait".`
      : `"${name}" created. Save some poses first, then add them as steps.`);
  }

  deleteSequence() {
    const sequence = this.sequence;
    if (!sequence || !window.confirm(`Delete sequence "${sequence.name}"?`)) return;
    this.player.stop();
    this.selectedId = null;
    this.commit({ sequences: this.rig.sequences.filter((item) => item.id !== sequence.id) });
    this.showMessage(`Sequence "${sequence.name}" deleted.`);
  }

  addMove() {
    const poses = this.rig?.poses || [];
    if (!poses.length) {
      this.showMessage('Save a pose first: move the joints, then press "Save pose".', true);
      return;
    }
    // Default to the pose saved last, which is usually the one just made.
    this.editSequence((sequence) => { sequence.steps.push({ type: 'move', pose: poses[poses.length - 1].id }); });
  }

  moveStep(index, offset) {
    this.editSequence((sequence) => {
      const [step] = sequence.steps.splice(index, 1);
      sequence.steps.splice(index + offset, 0, step);
    });
  }

  setStepPose(index, poseId) {
    this.editSequence((sequence) => {
      const { duration } = sequence.steps[index];
      sequence.steps[index] = { type: 'move', pose: poseId, ...(duration ? { duration } : {}) };
    });
  }

  setStepDuration(index, input) {
    const text = input.value.trim();
    const value = Number(text);
    this.editSequence((sequence) => {
      const step = sequence.steps[index];
      if (step.type === 'wait') step.duration = Number.isFinite(value) && value > 0 ? value : 0;
      else if (text === '' || !Number.isFinite(value) || value <= 0) delete step.duration;
      else step.duration = Math.max(MIN_STEP_SECONDS, value);
    });
  }

  // ---- Rendering ---------------------------------------------------------------

  // Edits commit on 'change', which fires before Tab moves focus on. Rendering a frame later lets
  // focus land first, so render() can put it back on the same field.
  scheduleRender() {
    if (this.renderQueued) return;
    this.renderQueued = true;
    requestAnimationFrame(() => {
      this.renderQueued = false;
      this.render();
    });
  }

  render() {
    // Re-rendering replaces the inputs, so keep keyboard focus on the same one.
    const focusKey = this.card.contains(document.activeElement) ? document.activeElement.dataset.focusKey : null;
    this.renderPoses();
    this.renderSequences();
    this.updatePlayState();
    if (focusKey) this.card.querySelector(`[data-focus-key="${focusKey}"]`)?.focus();
  }

  renderPoses() {
    const poses = this.rig?.poses || [];
    const canPose = Boolean(this.rig?.controllableJoints.length);
    this.query('[data-pose-count]').textContent = poses.length ? `${poses.length}` : '';
    this.query('[data-save-pose]').disabled = !canPose;
    this.query('[data-pose-name]').disabled = !canPose;

    const list = this.query('[data-pose-list]');
    list.replaceChildren();
    if (!canPose && !poses.length) {
      list.appendChild(this.emptyItem('No joints yet. Set them up in Joint Setup, then come back to pose them.'));
      return;
    }
    if (!poses.length) {
      list.appendChild(this.emptyItem('Move the joints in the Joints panel, then save where they are as a pose.'));
      return;
    }
    poses.forEach((pose) => {
      const item = document.createElement('li');
      item.className = 'pose-chip';
      const go = button(pose.name, null, (event) => {
        // The second click of a double-click (rename) should not start another move.
        if (event.detail < 2) this.goToPose(pose);
      });
      go.className = 'pose-go';
      go.title = `Click to move here, double-click to rename.\n${this.poseSummary(pose)}`;
      go.dataset.focusKey = `pose-${pose.id}`;
      go.addEventListener('dblclick', () => this.startRename(pose, go));
      item.append(
        go,
        button('↻', `Update ${pose.name} to the current joint positions`, () => this.updatePose(pose.id)),
        button('✕', `Delete ${pose.name}`, () => this.deletePose(pose.id)),
      );
      list.appendChild(item);
    });
  }

  renderSequences() {
    const sequences = this.rig?.sequences || [];
    if (!this.sequence) this.selectedId = sequences[0]?.id || null;
    const sequence = this.sequence;

    const select = this.query('[data-sequence-select]');
    select.replaceChildren(...sequences.map((item) => new Option(item.name, item.id)));
    if (!sequences.length) select.appendChild(new Option('No sequences yet', ''));
    select.value = this.selectedId || '';
    select.disabled = !sequences.length;
    this.query('[data-new-sequence]').disabled = !this.rig;
    this.query('[data-export-glb]').disabled = !sequences.length || this.exporting;
    this.query('[data-delete-sequence]').disabled = !sequence;
    this.query('[data-sequence-count]').textContent = sequences.length ? `${sequences.length}` : '';

    const editor = this.query('[data-sequence-editor]');
    editor.hidden = !sequence;
    if (!sequence) return;

    this.query('[data-sequence-name]').value = sequence.name;
    this.query('[data-sequence-loop]').checked = Boolean(sequence.loop);
    const timeline = sequenceTimeline(this.rig, sequence);
    const list = this.query('[data-step-list]');
    list.replaceChildren();
    const steps = sequence.steps || [];
    if (!steps.length) list.appendChild(this.emptyItem('No steps yet. Add poses to move between, with optional waits.'));
    steps.forEach((step, index) => list.appendChild(this.createStepRow(step, index, steps.length, timeline.segments[index])));

    this.query('[data-sequence-total]').textContent = steps.length
      ? `${steps.length} step${steps.length === 1 ? '' : 's'} · ${seconds(timeline.duration)}`
      : '';
  }

  createStepRow(step, index, count, segment) {
    const item = document.createElement('li');
    item.className = 'step-row';
    const number = document.createElement('span');
    number.className = 'step-number';
    number.textContent = `${index + 1}`;

    let what;
    if (step.type === 'wait') {
      what = document.createElement('span');
      what.className = 'step-wait';
      what.textContent = 'Wait';
    } else {
      what = document.createElement('select');
      what.setAttribute('aria-label', `Pose for step ${index + 1}`);
      what.dataset.focusKey = `step-pose-${index}`;
      // Steps written with their own joint values (e.g. built-in calibration) have no pose.
      if (step.pose === undefined) what.appendChild(new Option(step.label || 'Fixed values', ''));
      else if (!this.rig.poses.some((pose) => pose.id === step.pose)) what.appendChild(new Option('Missing pose', ''));
      this.rig.poses.forEach((pose) => what.appendChild(new Option(pose.name, pose.id)));
      what.value = this.rig.poses.some((pose) => pose.id === step.pose) ? step.pose : '';
      what.addEventListener('change', () => {
        if (what.value) this.setStepPose(index, what.value);
      });
    }

    const time = document.createElement('input');
    time.type = 'number';
    time.min = step.type === 'wait' ? '0' : String(MIN_STEP_SECONDS);
    time.step = '0.1';
    time.dataset.focusKey = `step-time-${index}`;
    time.value = step.duration ? String(step.duration) : '';
    if (step.type === 'wait') {
      time.setAttribute('aria-label', `Wait time in seconds for step ${index + 1}`);
      time.title = 'Seconds to hold still';
    } else {
      const automatic = segment ? Math.round(segment.plan.duration * 10) / 10 : '';
      time.placeholder = step.duration ? '' : `${automatic}`;
      time.setAttribute('aria-label', `Move time in seconds for step ${index + 1}`);
      time.title = step.duration
        ? 'Seconds this move takes. Clear it to move as fast as the joint speeds allow.'
        : `Automatic: ${automatic} s at the joints' speed limits. Type a time to change it.`;
    }
    time.addEventListener('change', () => this.setStepDuration(index, time));
    const unit = document.createElement('span');
    unit.className = 'step-unit';
    unit.textContent = 's';

    const up = button('↑', `Move step ${index + 1} earlier`, () => this.moveStep(index, -1));
    const down = button('↓', `Move step ${index + 1} later`, () => this.moveStep(index, 1));
    const remove = button('✕', `Remove step ${index + 1}`, () => this.editSequence((sequence) => { sequence.steps.splice(index, 1); }));
    [up, down, remove].forEach((element, position) => { element.dataset.focusKey = `step-${index}-button-${position}`; });
    up.disabled = index === 0;
    down.disabled = index === count - 1;

    item.append(number, what, time, unit, up, down, remove);
    return item;
  }

  emptyItem(text) {
    const item = document.createElement('li');
    item.className = 'empty-state';
    item.textContent = text;
    return item;
  }

  updatePlayState() {
    const playing = Boolean(this.player?.isPlaying);
    this.query('[data-play-sequence]').disabled = !this.sequence?.steps?.length;
    this.query('[data-stop-sequence]').disabled = !playing;
  }

  showMessage(text, isError = false) {
    const message = this.query('[data-animation-message]');
    message.hidden = !text;
    message.textContent = text || '';
    message.classList.toggle('is-error', isError);
    // Confirmations fade on their own so they don't take up room; errors stay until the next action.
    clearTimeout(this.messageTimer);
    if (text && !isError) this.messageTimer = setTimeout(() => { message.hidden = true; }, MESSAGE_SECONDS * 1000);
  }

  // ---- Export --------------------------------------------------------------------

  async exportGlb() {
    if (!this.rig?.sequences.length || this.exporting) return;
    const asset = this.asset;
    asset.player.stop();
    this.exporting = true;
    this.query('[data-export-glb]').disabled = true;
    this.showMessage('Building animation clips…');
    const restore = this.beforeExport?.();
    try {
      const { blob, clips, skipped } = await exportAnimatedGlb(asset, asset.rig.sequences);
      downloadBlob(blob, `${asset.config.name.replace(/[^\w.-]+/g, '_')}.glb`);
      const names = clips.map((clip) => `"${clip.name}" (${seconds(clip.duration)})`).join(', ');
      this.showMessage(`Exported ${clips.length} animation${clips.length === 1 ? '' : 's'}: ${names}.`
        + (skipped.length ? ` Skipped ${skipped.map((name) => `"${name}"`).join(', ')}: no joint moves.` : ''));
    } catch (error) {
      console.error('GLB export failed:', error);
      this.showMessage(`Export failed: ${error.message || 'unknown error'}`, true);
    } finally {
      restore?.();
      this.exporting = false;
      if (this.asset === asset) this.query('[data-export-glb]').disabled = !asset.rig.sequences.length;
    }
  }
}
