import * as THREE from 'three';
import { diagnoseReach, resolveTool } from '../../motion/InverseKinematics.js';
import { reachFor } from './reachFor.js';
import { DEFAULT_APPROACH, STEP_TYPES, normalizeProgram } from './Program.js';
import { gridWorldSpots, targetFrame, targetLabel } from './targets.js';

const UP = new THREE.Vector3(0, 1, 0);
const DOWN = new THREE.Vector3(0, -1, 0);
// A box being put down is let go this far above where it will rest, so it settles onto what is
// below instead of being pressed into it.
const PLACE_CLEARANCE = 0.01;

class Stopped extends Error {}

// A step that can't be done; the message says why, in plain words.
export class ProgramError extends Error {
  constructor(step, message) {
    super(message);
    this.step = step;
  }
}

function centimetres(metres) {
  return metres >= 1 ? `${metres.toFixed(2)} m` : `${Math.max(1, Math.round(metres * 100))} cm`;
}

// Runs one robot's program while the scene plays.
//
// Steps run one after another (moves take as long as the joints' speeds allow). Waiting (for
// time, for a box) is checked every frame in update(), so nothing blocks the view. Anything that
// can't be done stops this robot only, with the step and the reason in `error`.
export class ProgramRunner {
  constructor({ editor, simulation, itemId, onChange }) {
    this.editor = editor;
    this.simulation = simulation;
    this.itemId = itemId;
    this.onChange = onChange;
    this.runtime = editor.runtimes.get(itemId);
    this.program = normalizeProgram(editor.item(itemId)?.program);
    this.waits = [];
    this.held = null;
    this.currentId = null;
    this.status = 'Starting';
    this.error = null;
    this.finished = false;
    this.stopped = false;
  }

  get asset() {
    return this.runtime.asset;
  }

  get name() {
    return this.editor.item(this.itemId)?.name || 'Robot';
  }

  start() {
    this.running = this.run();
    return this.running;
  }

  async run() {
    try {
      do {
        await this.runSteps(this.program?.steps || [], {});
        // Even a loop of instant steps lets a frame be drawn in between.
        await this.nextFrame();
      } while (this.program?.loop);
      this.currentId = null;
      this.finished = true;
      this.setStatus('Finished');
    } catch (error) {
      if (error instanceof Stopped) return;
      if (!(error instanceof ProgramError)) console.error(`${this.name}'s program failed.`, error);
      this.error = { stepId: error.step?.id ?? this.currentId, message: error.message };
      this.asset?.player.stop();
      this.setStatus(`Stopped: ${error.message}`);
    }
  }

  setStatus(status) {
    this.status = status;
    this.onChange?.(this);
  }

  async runSteps(steps, context) {
    for (const step of steps) {
      this.check();
      this.currentId = step.id;
      this.setStatus(STEP_TYPES[step.type]?.label || step.type);
      await this.runStep(step, context);
    }
  }

  async runStep(step, context) {
    const { rig, player } = this.asset;
    switch (step.type) {
      case 'pose': {
        const pose = rig.poses.find((candidate) => candidate.id === step.pose);
        if (!pose) throw new ProgramError(step, 'Choose which pose to go to.');
        this.setStatus(`Going to ${pose.name}`);
        return this.move(pose.values, pose.name);
      }
      case 'sequence': {
        const sequence = rig.sequences.find((candidate) => candidate.id === step.sequence);
        if (!sequence) throw new ProgramError(step, 'Choose which sequence to play.');
        this.setStatus(`Playing ${sequence.name}`);
        if (!(await player.playSequence(sequence, { loop: false }))) this.interrupted();
        return undefined;
      }
      case 'reach': return this.reach(step, context);
      case 'grip': return this.grip(step);
      case 'release': return this.release();
      case 'wait': {
        const seconds = Math.max(0, Number(step.seconds) || 0);
        this.setStatus(`Waiting ${seconds} s`);
        let elapsed = 0;
        return this.until((deltaTime) => {
          elapsed += deltaTime;
          return elapsed >= seconds;
        });
      }
      case 'wait-box': {
        const frame = this.frameOf(step, step.at, 'Choose where to wait for a box.');
        this.setStatus(`Waiting for a box at ${targetLabel(this.editor, step.at)}`);
        return this.until(() => this.simulation.boxAt(frame.position));
      }
      case 'grid': {
        const spots = step.on ? gridWorldSpots(this.editor, step) : null;
        if (!spots) throw new ProgramError(step, 'Choose what the grid is on (e.g. a pallet).');
        for (const spot of spots) {
          await this.runSteps(step.steps || [], { ...context, grid: { spot, count: spots.length } });
        }
        return undefined;
      }
      case 'repeat': {
        const times = Math.max(0, Math.round(Number(step.times) || 0));
        for (let index = 0; index < times; index += 1) await this.runSteps(step.steps || [], context);
        return undefined;
      }
      case 'conveyor': {
        if (!step.item || !this.simulation.setBeltRunning(step.item, Boolean(step.running))) throw new ProgramError(step, 'Choose which conveyor to switch.');
        return undefined;
      }
      default:
        throw new ProgramError(step, `This app doesn't know the step "${step.type}".`);
    }
  }

  // ---- Reach, grip, release ------------------------------------------------------------------

  // The robot's tool tip, ready for inverse kinematics (a mounted gripper's tip if it has one).
  tool(step) {
    const rig = this.asset?.rig;
    const resolved = rig?.tools[0] ? resolveTool(rig, rig.tools[0]) : null;
    if (!resolved) throw new ProgramError(step, 'This robot has no tool tip: mount a gripper on it, or set its tool tip (Reach bar → Tool tip).');
    return resolved;
  }

  frameOf(step, target, missing) {
    if (!target) throw new ProgramError(step, missing);
    const frame = targetFrame(this.editor, target);
    if (!frame) throw new ProgramError(step, `${targetLabel(this.editor, target)} is no longer in the scene.`);
    return frame;
  }

  // Where the tool tip has to go: { position, label, square (turn a held box to match) }.
  async goalFor(step, context) {
    const target = step.target;
    if (!target) throw new ProgramError(step, 'Choose where to reach.');
    // Holding a box, the tip goes as high above the spot as the box hangs below it, so the box
    // is put down on the spot.
    const putDown = (position) => (this.held ? position.clone().addScaledVector(UP, this.heldDrop + PLACE_CLEARANCE) : position);
    if (target.kind === 'grid') {
      if (!context.grid) throw new ProgramError(step, '"The next spot on the grid" only works inside a "Repeat across a grid" step.');
      const { spot, count } = context.grid;
      return { position: putDown(spot.position), label: `grid spot ${spot.index + 1} of ${count}`, square: spot.quaternion };
    }
    if (target.kind === 'box') {
      const frame = this.frameOf(step, target.at, 'Choose where the box is.');
      this.setStatus(`Waiting for a box at ${targetLabel(this.editor, target.at)}`);
      const box = await this.until(() => this.simulation.boxAt(frame.position));
      return { position: this.simulation.boxTop(box), label: 'the box' };
    }
    const frame = this.frameOf(step, target, 'Choose where to reach.');
    return { position: putDown(frame.position), label: targetLabel(this.editor, target), square: frame.quaternion };
  }

  // With an approach: straight up, across at one safe height, then straight down onto the goal.
  // The safe height clears where it starts and where it goes by `approach`; carrying a box, it
  // also adds the box's height, so the box passes over boxes already put down beside the goal.
  // Without an approach: straight there.
  async reach(step, context) {
    const tool = this.tool(step);
    const goal = await this.goalFor(step, context);
    const orient = step.orient === 'any' ? null : DOWN;
    const approach = Math.max(0, Number(step.approach ?? DEFAULT_APPROACH) || 0);
    const waypoints = [];
    if (approach > 0) {
      const tip = tool.position();
      const carried = this.held ? this.held.size[1] : 0;
      const height = Math.max(tip.y + approach, goal.position.y + approach + carried);
      const lift = new THREE.Vector3(tip.x, height, tip.z);
      // Optional: a robot already near the top of its reach just goes across from where it is.
      if (lift.distanceTo(tip) > 0.005) waypoints.push({ point: lift, label: 'Lifting', optional: true });
      waypoints.push({
        point: new THREE.Vector3(goal.position.x, height, goal.position.z),
        lower: goal.position.clone().addScaledVector(UP, approach + carried),
        label: `Above ${goal.label}`,
        square: goal.square,
      });
    }
    waypoints.push({ point: goal.position, label: `Reaching ${goal.label}` });
    for (const waypoint of waypoints) {
      this.check();
      if (waypoint.square && this.held) this.simulation.squareHeld(this.held, waypoint.square);
      // Above the goal at the travel height, or failing that, just above the goal.
      const values = (waypoint.lower && this.solve(step, tool, waypoint.point, orient, goal.label, true))
        || this.solve(step, tool, waypoint.lower || waypoint.point, orient, goal.label, waypoint.optional);
      if (!values) continue;
      this.setStatus(waypoint.label);
      await this.move(values, waypoint.label);
    }
  }

  solve(step, tool, point, orient, label, optional) {
    const { rig } = this.asset;
    const result = reachFor(rig, tool, point, orient);
    if (result.reached) return result.values;
    if (optional) return null;
    const diagnosis = diagnoseReach(rig, tool, point, { orient, floorY: 0 });
    if (diagnosis.status === 'reachable') return diagnosis.values;
    const reason = {
      'below-floor': 'that is below the floor',
      'joint-limit': `${diagnosis.overLimits?.[0]?.joint.name || 'a joint'} would have to turn past its range`,
      orientation: 'not with the tool pointing straight down (try "Any angle")',
    }[diagnosis.status] || `it is about ${centimetres(diagnosis.shortBy ?? diagnosis.error ?? 0)} too far`;
    throw new ProgramError(step, `Can't reach ${label}: ${reason}.`);
  }

  grip(step) {
    if (this.held) throw new ProgramError(step, 'It is already holding a box: release it first.');
    const tool = this.tool(step);
    const tip = tool.position();
    const box = this.simulation.boxUnder(tip);
    if (!box) throw new ProgramError(step, 'There is no box at the tool tip to grip: reach the box first.');
    this.simulation.hold(box, tool.joint.group);
    // How far the box's bottom hangs below the tip, for putting it down later.
    this.heldDrop = tip.y - (this.simulation.boxTop(box).y - box.size[1]);
    this.held = box;
    this.setGripper('HOLDING');
  }

  release() {
    if (!this.held) return;
    this.simulation.release(this.held);
    this.held = null;
    this.setGripper('OPEN');
  }

  // A mounted gripper shows what it is doing (its light changes colour).
  setGripper(state) {
    const tool = this.editor.items.find((item) => item.mount?.to === this.itemId);
    this.editor.runtimes.get(tool?.id)?.component?.setState?.(state);
  }

  // ---- Moving and waiting ----------------------------------------------------------------------

  async move(values, label) {
    const done = await this.asset.player.moveTo(values, { label });
    if (!done) this.interrupted();
  }

  interrupted() {
    this.check();
    throw new Stopped();
  }

  // Resolves with check's first truthy result; check(deltaTime) is asked every frame.
  until(check) {
    this.check();
    return new Promise((resolve, reject) => this.waits.push({ check, resolve, reject }));
  }

  nextFrame() {
    return this.until(() => true);
  }

  check() {
    if (this.stopped) throw new Stopped();
  }

  update(deltaTime) {
    if (this.stopped || !this.waits.length) return;
    const waits = this.waits;
    this.waits = [];
    waits.forEach((wait) => {
      const result = wait.check(deltaTime);
      if (result) wait.resolve(result);
      else this.waits.push(wait);
    });
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.asset?.player.stop();
    this.waits.forEach((wait) => wait.reject(new Stopped()));
    this.waits = [];
    this.held = null;
    this.setGripper('OPEN');
  }
}
