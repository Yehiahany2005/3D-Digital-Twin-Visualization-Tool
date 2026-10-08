import * as THREE from 'three';
import { diagnoseReach, resolveTool, solveReach } from '../motion/InverseKinematics.js';

// Reach: click a spot in the 3D view and the machine moves its tool point there (inverse
// kinematics). Lives in a toolbar over the top of the viewport. Works for any rigged model
// with a tool point (set in Joint Setup); nothing here is specific to a vendor or robot type.

const MODES = {
  down: { label: 'Point down', hint: 'The tool points straight down at the spot.' },
  any: { label: 'Any angle', hint: 'The tool can come in at any angle; reaches the most places.' },
  surface: { label: 'Face surface', hint: 'The tool meets the clicked surface square-on.' },
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

export class ReachPanel {
  constructor({ bar, picker, marker, toolMarkers, floor, onNeedTool, onNeedJoints }) {
    this.bar = bar;
    this.picker = picker;
    this.marker = marker;
    this.toolMarkers = toolMarkers;
    this.floor = floor;
    this.onNeedTool = onNeedTool;
    this.onNeedJoints = onNeedJoints;
    this.asset = null;
    this.active = false;
    this.mode = 'down';
    this.toolId = null;
    this.resolved = null;
    this.hidden = false;
    this.explainTimer = null;
    this.lastTarget = null;
    this.query = (selector) => bar.querySelector(selector);

    this.toggle = this.query('[data-reach-toggle]');
    this.toolSelect = this.query('[data-reach-tool]');
    this.status = this.query('[data-reach-status]');
    this.action = this.query('[data-reach-action]');

    this.toggle.addEventListener('click', () => this.setActive(!this.active));
    this.toolSelect.addEventListener('change', () => {
      this.toolId = this.toolSelect.value;
      this.resolved = null;
      this.marker.hide();
    });
    this.bar.querySelectorAll('[data-reach-mode]').forEach((button) => {
      button.addEventListener('click', () => this.setMode(button.dataset.reachMode));
    });
    this.action.addEventListener('click', () => this.actionHandler?.());
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || !this.active) return;
      if (event.target.closest?.('input, select, textarea')) return;
      this.setActive(false);
    });
    this.setMode(this.mode);
  }

  get rig() {
    return this.asset?.rig;
  }

  setAsset(asset) {
    this.unsubscribe?.();
    this.unsubscribePlayer?.();
    this.asset = asset;
    this.modelSize = (() => {
      const size = new THREE.Box3().setFromObject(asset.model).getSize(new THREE.Vector3());
      return Math.max(size.x, size.y, size.z, 0.01);
    })();
    this.resolved = null;
    this.unsubscribe = asset.rig.onChange(() => {
      this.resolved = null;
      this.renderTools();
    });
    this.unsubscribePlayer = asset.player.onChange((status) => {
      if (status === 'Idle' && this.reaching) {
        this.reaching = false;
        this.showStatus(this.reachedText || 'Reached.', 'ok');
      }
    });
    this.renderTools();
    if (this.active) this.setActive(true);
    else this.showReady();
  }

  // Hidden while the Station runs: the station cycle drives the robot itself.
  setHidden(hidden) {
    this.hidden = hidden;
    this.bar.hidden = hidden;
    if (hidden) this.setActive(false);
  }

  // ---- Tools -------------------------------------------------------------------------

  renderTools() {
    const tools = this.rig?.tools || [];
    if (!tools.some((tool) => tool.id === this.toolId)) this.toolId = tools[0]?.id || null;
    this.toolSelect.replaceChildren(...tools.map((tool) => new Option(tool.name || tool.id, tool.id)));
    this.toolSelect.value = this.toolId || '';
    this.toolSelect.hidden = tools.length < 2;
    if (!this.active) this.showReady();
  }

  currentTool() {
    if (this.resolved) return this.resolved;
    const tool = this.rig?.tools.find((item) => item.id === this.toolId);
    this.resolved = tool ? resolveTool(this.rig, tool) : null;
    return this.resolved;
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
    if (!this.rig.tools.length) return { text: 'Set a tool point first: the point that should reach.', action: 'Set tool point', run: this.onNeedTool };
    const resolved = this.currentTool();
    if (!resolved) return { text: "The tool point's joint is missing.", action: 'Fix tool point', run: this.onNeedTool };
    if (!resolved.active.length) return { text: "The tool point isn't on anything that moves.", action: 'Fix tool point', run: this.onNeedTool };
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
      this.picker.setHandler((hit, event) => this.handleClick(hit, event), this.targets(), {
        owner: 'reach',
        hover: (hit, event) => this.handleHover(hit, event),
        filter: (hit) => !this.isOwnMovingPart(hit.object),
        onRelease: () => {
          this.active = false;
          this.updateToggle();
          this.cleanUp();
          this.showReady();
        },
      });
      this.showStatus('Click where the tool should go. Esc to stop.', 'info');
    } else {
      if (this.picker.owner === 'reach') this.picker.setHandler(null);
      this.cleanUp();
      this.showReady();
    }
  }

  cleanUp() {
    clearTimeout(this.explainTimer);
    this.marker.hide();
    this.toolMarkers.hide();
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
    else this.showStatus('Move the tool to any spot you click.', 'muted');
  }

  showStatus(text, tone = 'info', actionLabel = null, run = null) {
    this.status.textContent = text;
    this.status.dataset.tone = tone;
    this.action.hidden = !actionLabel;
    this.action.textContent = actionLabel || '';
    this.actionHandler = run ? () => { this.setActive(false); run(); } : null;
  }

  // ---- Picking -----------------------------------------------------------------------

  targets() {
    return [this.asset.model, this.floor].filter(Boolean);
  }

  // The moving machine itself is not a place to reach for.
  isOwnMovingPart(object) {
    const resolved = this.currentTool();
    if (!resolved) return false;
    const ids = new Set(resolved.chain.map((joint) => joint.id));
    for (let current = object; current; current = current.parent) {
      if (current.userData.rigJointId !== undefined) return ids.has(current.userData.rigJointId);
    }
    return false;
  }

  // Where the pointer aims: the surface hit, or (in empty space) a level plane at the tool's height.
  targetFor(hit) {
    if (hit) {
      const normal = hit.face ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld) : new THREE.Vector3(0, 1, 0);
      // Double-sided CAD faces can report a normal pointing away from the camera; face the viewer.
      if (normal.dot(this.picker.raycaster.ray.direction) > 0) normal.negate();
      return { point: hit.point.clone(), normal, onFloor: hit.object === this.floor };
    }
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
    this.reachedText = result.warnings.includes('through-floor')
      ? 'Reached, but part of the machine dips below the floor.'
      : 'Reached.';
    await this.asset.player.moveTo(result.values, { label: 'Reaching' });
  }

  // Turns a diagnosis into a marker colour and a sentence.
  describe(result, target, orient, clicked) {
    const resolved = this.currentTool();
    let state = 'fail';
    let text;
    let action = null;
    let run = null;
    switch (result.status) {
      case 'reachable': {
        const warnings = result.warnings || [];
        state = warnings.length ? 'warn' : 'ok';
        if (warnings.includes('through-floor')) text = 'Reachable, but part of the machine would dip below the floor.';
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
        const label = MODES[this.mode].label.toLowerCase();
        text = `Can reach this spot, but not ${this.mode === 'down' ? 'pointing down' : `with "${label}"`} (closest: ${degrees(result.tilt)} off).`;
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
    this.showStatus(text, state === 'ok' ? 'ok' : state === 'warn' ? 'warn' : 'fail', action, run);
  }

  // ---- Per frame -----------------------------------------------------------------------

  update() {
    if (!this.active) return;
    const resolved = this.currentTool();
    if (!resolved) return;
    this.toolMarkers.show([{ position: resolved.position(), direction: resolved.direction(), highlighted: true }], this.modelSize);
  }
}
