import * as THREE from 'three';
import { diagnoseReach, resolveTool, solveReach } from '../motion/InverseKinematics.js';
import { saveRig } from '../motion/RigStore.js';

// Reach: click a spot in the 3D view and the machine moves its tool tip there (inverse
// kinematics). Lives in a toolbar over the top of the viewport. Works for any rigged model;
// nothing here is specific to a vendor or robot type.
//
// The tool tip is the very end of the tool (fingertips, suction cup face, nozzle): the spot
// that should end up where the user clicks. It is set right here, from the toolbar, by
// clicking on the model. A rig stores it as its first (and in the UI only) tool point.

const MODES = {
  down: {
    label: 'Straight down',
    hint: 'Straight down: the tool always points at the floor, like a gripper picking from above. Best for floors, tables and boxes.',
  },
  any: {
    label: 'Any angle',
    hint: 'Any angle: the tool may come in from any side, so it reaches the most places. Use it when Straight down can\'t reach.',
  },
  surface: {
    label: 'Square to surface',
    hint: 'Square to surface: the tool meets the clicked surface head-on, e.g. a wall or a sloped face. On the floor it is the same as Straight down.',
  },
};
// Hover shows a quick answer; once the pointer rests this long, the full explanation follows.
const EXPLAIN_DELAY_MS = 180;

function centimetres(metres) {
  return metres >= 1 ? `${metres.toFixed(2)} m` : `${Math.max(1, Math.round(metres * 100))} cm`;
}

function degrees(value) {
  return `${Math.round(value)}°`;
}

function rangeText(joint, min, max) {
  return joint.type === 'revolute' ? `${degrees(min)} to ${degrees(max)}` : `${Math.round(min)} to ${Math.round(max)} mm`;
}

function round(value) {
  return Math.round(value * 1e6) / 1e6;
}

export class ReachPanel {
  constructor({ bar, picker, marker, toolMarkers, floor, onNeedJoints }) {
    this.bar = bar;
    this.picker = picker;
    this.marker = marker;
    this.toolMarkers = toolMarkers;
    this.floor = floor;
    this.onNeedJoints = onNeedJoints;
    this.asset = null;
    this.active = false;
    this.pickingTip = false;
    this.mode = 'down';
    this.resolved = null;
    this.hidden = false;
    this.explainTimer = null;
    this.lastTarget = null;
    this.query = (selector) => bar.querySelector(selector);

    this.toggle = this.query('[data-reach-toggle]');
    this.status = this.query('[data-reach-status]');
    this.action = this.query('[data-reach-action]');
    this.tipButton = this.query('[data-reach-tip-button]');
    this.tipLabel = this.query('[data-reach-tip-label]');
    this.tipMenu = this.query('[data-reach-tip-menu]');
    this.tipWhere = this.query('[data-reach-tip-where]');
    this.tipReset = this.query('[data-reach-tip-reset]');

    this.toggle.addEventListener('click', () => this.setActive(!this.active));
    this.bar.querySelectorAll('[data-reach-mode]').forEach((button) => {
      button.addEventListener('click', () => {
        this.setMode(button.dataset.reachMode);
        if (!this.lastTarget) this.showStatus(MODES[this.mode].hint, 'info');
      });
    });
    this.action.addEventListener('click', () => this.actionHandler?.());
    this.tipButton.addEventListener('click', () => (this.tipMenu.hidden ? this.openTipMenu() : this.closeTipMenu()));
    this.query('[data-reach-tip-pick]').addEventListener('click', () => this.startTipPick());
    this.query('[data-reach-tip-flip]').addEventListener('click', () => this.flipTip());
    this.tipReset.addEventListener('click', () => this.resetTip());
    document.addEventListener('pointerdown', (event) => {
      if (!this.tipMenu.hidden && !event.target.closest('.reach-tip')) this.closeTipMenu();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || event.target.closest?.('input, select, textarea')) return;
      if (!this.tipMenu.hidden) this.closeTipMenu();
      else if (this.pickingTip) this.endTipPick('Picking the tool tip was cancelled.');
      else if (this.active) this.setActive(false);
    });
    this.setMode(this.mode);
  }

  get rig() {
    return this.asset?.rig;
  }

  get tool() {
    return this.rig?.tools[0] || null;
  }

  setAsset(asset) {
    this.unsubscribe?.();
    this.unsubscribePlayer?.();
    if (this.pickingTip) this.endTipPick();
    this.closeTipMenu();
    this.asset = asset;
    this.modelSize = (() => {
      const size = new THREE.Box3().setFromObject(asset.model).getSize(new THREE.Vector3());
      return Math.max(size.x, size.y, size.z, 0.01);
    })();
    this.resolved = null;
    this.unsubscribe = asset.rig.onChange(() => {
      this.resolved = null;
      this.renderTip();
    });
    this.unsubscribePlayer = asset.player.onChange((status) => {
      if (status === 'Idle' && this.reaching) {
        this.reaching = false;
        this.showStatus(this.reachedText || 'Reached.', this.reachedTone || 'ok');
      }
    });
    this.renderTip();
    if (this.active) this.setActive(true);
    else this.showReady();
  }

  // Hidden while the Station runs: the station cycle drives the robot itself.
  setHidden(hidden) {
    this.hidden = hidden;
    this.bar.hidden = hidden;
    if (hidden) {
      this.closeTipMenu();
      if (this.pickingTip) this.endTipPick();
      this.setActive(false);
    }
  }

  currentTool() {
    if (this.resolved) return this.resolved;
    this.resolved = this.tool ? resolveTool(this.rig, this.tool) : null;
    return this.resolved;
  }

  // ---- Tool tip ----------------------------------------------------------------------

  renderTip() {
    const tool = this.tool;
    const joint = tool && this.rig.jointsById.get(tool.joint);
    // In a scene, a tool mounted on the machine decides the tip; it can't be edited here.
    const lockedBy = this.asset?.toolLockedBy;
    this.tipLabel.textContent = lockedBy ? `Tip: ${lockedBy}` : tool ? 'Tool tip' : 'Set tool tip';
    this.tipButton.classList.toggle('is-missing', !tool);
    this.tipWhere.textContent = lockedBy
      ? `The tip of the mounted "${lockedBy}" is used. Unmount it in Properties to set the tool tip yourself.`
      : tool
        ? (joint ? `Now on "${joint.name}": the pink dot and arrow on the model.` : 'Its part no longer has a joint. Pick it again.')
        : 'Not set yet.';
    ['[data-reach-tip-pick]', '[data-reach-tip-flip]'].forEach((selector) => { this.query(selector).disabled = Boolean(lockedBy); });
    const preset = this.asset?.config.rig?.tools?.length;
    this.tipReset.textContent = preset ? 'Reset' : 'Remove';
    this.tipReset.title = preset ? 'Go back to the built-in tool tip' : 'Remove the tool tip';
    this.tipReset.hidden = (!tool && !preset) || Boolean(lockedBy);
    if (!lockedBy) this.query('[data-reach-tip-flip]').disabled = !tool;
    if (!this.active && !this.pickingTip) this.showReady();
  }

  openTipMenu() {
    if (this.pickingTip) this.endTipPick();
    this.renderTip();
    this.tipMenu.hidden = false;
    this.tipButton.setAttribute('aria-expanded', 'true');
  }

  closeTipMenu() {
    if (this.tipMenu.hidden) return;
    this.tipMenu.hidden = true;
    this.tipButton.setAttribute('aria-expanded', 'false');
    if (!this.active && !this.pickingTip) this.toolMarkers.hide();
  }

  // Click on the model to set the tool tip; the pink marker follows the pointer meanwhile.
  startTipPick() {
    this.closeTipMenu();
    if (!this.rig?.joints.length) {
      this.showStatus('This model has no joints yet: the tool tip sits on a part that moves.', 'info', 'Set up joints', this.onNeedJoints);
      return;
    }
    if (this.active) this.setActive(false);
    this.pickingTip = true;
    this.tipButton.classList.add('is-picking');
    this.picker.setHandler((hit) => this.setTipFromHit(hit), this.asset.model, {
      owner: 'reach-tip',
      hover: (hit) => this.previewTip(hit),
      onRelease: () => this.endTipPick(),
    });
    this.showStatus('Click the very end of the tool: fingertips, suction cup face or nozzle. Esc to cancel.', 'info');
  }

  endTipPick(message) {
    if (!this.pickingTip) return;
    this.pickingTip = false;
    this.tipButton.classList.remove('is-picking');
    if (this.picker.owner === 'reach-tip') this.picker.setHandler(null);
    this.toolMarkers.hide();
    if (message) this.showStatus(message, 'muted');
    else this.showReady();
  }

  // The joint that carries a mesh (its own joint, or the one it rides on).
  ownerJoint(mesh) {
    for (let current = mesh; current && current !== this.rig.content; current = current.parent) {
      if (current.userData.rigJointId !== undefined) return this.rig.jointsById.get(current.userData.rigJointId);
    }
    return null;
  }

  // Surface normal facing the camera (CAD faces can be stored either way round).
  facingNormal(hit) {
    const normal = hit.face ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld) : new THREE.Vector3(0, -1, 0);
    if (normal.dot(this.picker.raycaster.ray.direction) > 0) normal.negate();
    return normal;
  }

  previewTip(hit) {
    if (!this.pickingTip) return;
    const joint = hit && this.ownerJoint(hit.object);
    if (!joint) {
      this.toolMarkers.hide();
      this.showStatus(hit ? "This part doesn't move. Point at the end of the tool." : 'Click the very end of the tool. Esc to cancel.', hit ? 'warn' : 'info');
      return;
    }
    this.toolMarkers.show([{ position: hit.point, direction: this.facingNormal(hit), highlighted: true }], this.modelSize);
    this.showStatus(`Click to put the tool tip here (it moves with "${joint.name}"). The arrow is the way it points.`, 'ok');
  }

  setTipFromHit(hit) {
    const joint = hit && this.ownerJoint(hit.object);
    if (!joint) return;
    const mesh = hit.object;
    const local = mesh.worldToLocal(hit.point.clone());
    const worldNormal = this.facingNormal(hit);
    const localNormal = worldNormal.transformDirection(mesh.matrixWorld.clone().invert());
    // Stored in the model frame at the rest pose, like joint pivots.
    const { point, direction } = this.rig.withRestPose(() => {
      const toModel = this.rig.content.matrixWorld.clone().invert();
      return {
        point: mesh.localToWorld(local.clone()).applyMatrix4(toModel),
        direction: localNormal.clone().transformDirection(mesh.matrixWorld).transformDirection(toModel),
      };
    });
    const id = this.tool?.id || 'tool';
    this.saveTools([{ id, name: 'Tool tip', joint: joint.id, frame: 'model', point: point.toArray().map(round), direction: direction.toArray().map(round) }]);
    this.endTipPick();
    this.setActive(true);
    if (this.active) this.showStatus(`Tool tip set on "${joint.name}". Now click where it should go.`, 'ok');
  }

  flipTip() {
    if (!this.tool) return;
    this.saveTools([{ ...this.tool, direction: (this.tool.direction || [0, -1, 0]).map((value) => -value) }]);
  }

  resetTip() {
    const preset = this.asset.config.rig?.tools;
    this.saveTools(preset?.length ? structuredClone(preset).slice(0, 1) : []);
    if (!preset?.length && this.active) this.setActive(false);
  }

  saveTools(tools) {
    this.rig.setTools(tools);
    saveRig(this.asset.config, this.rig.definition);
    if (!this.tipMenu.hidden) this.showTipMarker();
  }

  showTipMarker() {
    const resolved = this.currentTool();
    if (resolved) this.toolMarkers.show([{ position: resolved.position(), direction: resolved.direction(), highlighted: true }], this.modelSize);
    else this.toolMarkers.hide();
  }

  // ---- Mode & state --------------------------------------------------------------------

  setMode(mode) {
    this.mode = MODES[mode] ? mode : 'down';
    this.bar.querySelectorAll('[data-reach-mode]').forEach((button) => {
      const selected = button.dataset.reachMode === this.mode;
      button.classList.toggle('is-active', selected);
      button.setAttribute('aria-pressed', String(selected));
      button.title = MODES[button.dataset.reachMode].hint;
    });
    // Re-check the spot under the pointer with the new mode.
    if (this.active && this.lastTarget) this.preview(this.lastTarget, true);
  }

  // Why Reach can't start yet, or null.
  blocker() {
    if (!this.rig) return { text: 'Loading…' };
    if (!this.rig.joints.length) return { text: 'This model has no joints yet.', action: 'Set up joints', run: this.onNeedJoints };
    if (!this.tool) return { text: 'Set the tool tip first: the spot that should go where you click.', action: 'Set tool tip', run: () => this.startTipPick() };
    const resolved = this.currentTool();
    if (!resolved || !resolved.active.length) {
      return { text: 'The tool tip is on a part that no longer moves. Pick it again.', action: 'Set tool tip', run: () => this.startTipPick() };
    }
    return null;
  }

  setActive(active) {
    if (active && this.hidden) return;
    const blocker = active ? this.blocker() : null;
    if (blocker) {
      this.active = false;
      this.showStatus(blocker.text, 'info', blocker.action, blocker.run);
      this.updateToggle();
      return;
    }
    this.active = active;
    this.updateToggle();
    clearTimeout(this.explainTimer);
    if (active) {
      this.closeTipMenu();
      this.picker.setHandler((hit, event) => this.handleClick(hit, event), this.targets(), {
        owner: 'reach',
        hover: (hit, event) => this.handleHover(hit, event),
        filter: (hit) => !this.isOwnMovingPart(hit.object),
        onRelease: () => {
          this.active = false;
          this.updateToggle();
          this.cleanUp();
          if (!this.pickingTip) this.showReady();
        },
      });
      this.showStatus('Click where the tool tip should go. Esc to stop.', 'info');
    } else {
      if (this.picker.owner === 'reach') this.picker.setHandler(null);
      this.cleanUp();
      this.showReady();
    }
  }

  cleanUp() {
    clearTimeout(this.explainTimer);
    this.marker.hide();
    if (this.tipMenu.hidden) this.toolMarkers.hide();
    this.lastTarget = null;
  }

  updateToggle() {
    this.toggle.setAttribute('aria-pressed', String(this.active));
    this.toggle.classList.toggle('is-active', this.active);
    this.bar.classList.toggle('is-active', this.active);
  }

  showReady() {
    const blocker = this.blocker();
    if (blocker && this.rig) this.showStatus(blocker.text, 'muted', blocker.action, blocker.run);
    else this.showStatus('Turn on Reach, then click a spot: the tool tip moves there.', 'muted');
  }

  showStatus(text, tone = 'info', actionLabel = null, run = null) {
    this.status.textContent = text;
    this.status.dataset.tone = tone;
    this.action.hidden = !actionLabel;
    this.action.textContent = actionLabel || '';
    this.actionHandler = run ? () => { this.setActive(false); run(); } : null;
  }

  // ---- Picking -----------------------------------------------------------------------

  // What can be reached for: this machine and the floor, plus (in a scene) everything else placed
  // there. Asked at each click, so items added meanwhile count.
  targets() {
    return () => [this.asset?.model, this.floor, ...(this.extraTargets?.() || [])].filter(Boolean);
  }

  // In a scene, the other items are places to reach for too.
  setExtraTargets(provider) {
    this.extraTargets = provider;
  }

  // The moving machine itself is not a place to reach for. Joint groups are compared, not joint
  // names: two copies of the same robot have the same joint names.
  isOwnMovingPart(object) {
    const resolved = this.currentTool();
    if (!resolved) return false;
    const groups = new Set(resolved.chain.map((joint) => joint.group));
    for (let current = object; current; current = current.parent) {
      if (current.userData.rigJointId !== undefined) return groups.has(current);
    }
    return false;
  }

  // Where the pointer aims: the surface hit, or (in empty space) a level plane at the tool's height.
  targetFor(hit) {
    if (hit) return { point: hit.point.clone(), normal: this.facingNormal(hit), onFloor: hit.object === this.floor };
    const resolved = this.currentTool();
    const height = resolved ? resolved.position().y : 0;
    const point = this.picker.raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -height), new THREE.Vector3());
    return point ? { point, normal: new THREE.Vector3(0, 1, 0), onFloor: false } : null;
  }

  wantedDirection(target) {
    if (this.mode === 'any') return null;
    if (this.mode === 'surface') return target.normal.clone().negate();
    return new THREE.Vector3(0, -1, 0);
  }

  // Floor level for safety checks: the floor's surface, or the world ground.
  floorY() {
    return this.floor ? this.floor.getWorldPosition(new THREE.Vector3()).y : 0;
  }

  handleHover(hit, event) {
    if (!this.active) return;
    if (!event) {
      this.marker.hide();
      return;
    }
    const target = this.targetFor(hit);
    if (!target) {
      this.marker.hide();
      return;
    }
    this.lastTarget = target;
    this.preview(target, false);
  }

  // Quick answer now; the full "why" after the pointer rests.
  preview(target, explainNow) {
    const resolved = this.currentTool();
    if (!resolved) return;
    const orient = this.wantedDirection(target);
    clearTimeout(this.explainTimer);
    // Same allowance as diagnoseReach: a spot on the floor's surface is fine.
    if (target.point.y < this.floorY() - Math.max(resolved.tolerance, resolved.size * 0.002)) {
      this.showMarker(target, 'fail', orient);
      this.showStatus('That spot is below the floor.', 'fail');
      return;
    }
    const quick = solveReach(this.rig, resolved, target.point, { orient, quick: true, maxIterations: 60 });
    this.showMarker(target, quick.reached ? 'ok' : 'fail', orient);
    if (quick.reached) this.showStatus('Reachable: click to move there.', 'ok');
    const explain = () => {
      if (this.lastTarget !== target || !this.active) return;
      const result = diagnoseReach(this.rig, resolved, target.point, { orient, floorY: this.floorY() });
      this.describe(result, target, orient, false);
    };
    if (explainNow) explain();
    else this.explainTimer = setTimeout(explain, EXPLAIN_DELAY_MS);
  }

  showMarker(target, state, orient) {
    this.marker.show({ point: target.point, normal: target.normal, direction: orient, state, size: this.modelSize });
  }

  async handleClick(hit) {
    if (!this.active) return;
    const target = this.targetFor(hit);
    if (!target) return;
    const resolved = this.currentTool();
    if (!resolved) return;
    clearTimeout(this.explainTimer);
    this.lastTarget = target;
    const orient = this.wantedDirection(target);
    const result = diagnoseReach(this.rig, resolved, target.point, { orient, floorY: this.floorY() });
    this.describe(result, target, orient, true);
    if (result.status !== 'reachable') return;
    this.reaching = true;
    const throughFloor = result.warnings.includes('through-floor');
    this.reachedText = throughFloor ? 'Reached, but part of the machine dips below the floor.' : 'Reached.';
    this.reachedTone = throughFloor ? 'floor' : 'ok';
    await this.asset.player.moveTo(result.values, { label: 'Reaching' });
  }

  // Turns a diagnosis into a marker colour and a sentence.
  describe(result, target, orient, clicked) {
    const resolved = this.currentTool();
    let state = 'fail';
    let text;
    let action = null;
    let run = null;
    let tone = null;
    switch (result.status) {
      case 'reachable': {
        const warnings = result.warnings || [];
        state = warnings.length ? 'warn' : 'ok';
        if (warnings.includes('through-floor')) {
          text = 'Reachable, but part of the machine would dip below the floor.';
          tone = 'floor';
        }
        else if (warnings.includes('big-move')) text = 'Reachable with a big swing (over 120° on one joint).';
        else text = clicked ? 'Moving there…' : 'Reachable: click to move there.';
        if (clicked && warnings.length) text += ' Moving…';
        break;
      }
      case 'below-floor':
        text = 'That spot is below the floor.';
        break;
      case 'joint-limit': {
        const parts = result.overLimits.slice(0, 2).map(({ joint, needs, min, max }) => (
          `${joint.name} would need ${joint.type === 'revolute' ? degrees(needs) : `${Math.round(needs)} mm`} (range ${rangeText(joint, min, max)})`
        ));
        text = `Can't twist that far: ${parts.join('; ')}.`;
        break;
      }
      case 'orientation': {
        text = `Can reach this spot, but not ${this.mode === 'down' ? 'pointing straight down' : 'square to this surface'} (closest: ${degrees(result.tilt)} off).`;
        action = 'Use any angle';
        run = () => {
          this.setMode('any');
          this.setActive(true);
        };
        break;
      }
      default: {
        text = `Out of reach: about ${centimetres(result.shortBy ?? result.error)} beyond what it can reach.`;
        // With so few joints the tool can only travel along a line or a surface.
        const count = resolved?.active.length ?? 0;
        if (count === 1) text += ' This tool is moved by a single joint, so it can only follow one path.';
        else if (count === 2) text += ' This tool is moved by only two joints, so it reaches a limited area.';
      }
    }
    if (resolved) this.showMarker(target, state, orient);
    this.showStatus(text, tone || (state === 'ok' ? 'ok' : state === 'warn' ? 'warn' : 'fail'), action, run);
  }

  // ---- Per frame -----------------------------------------------------------------------

  update() {
    if (this.pickingTip) return; // the marker follows the pointer instead
    if (this.active || !this.tipMenu.hidden) this.showTipMarker();
  }
}
