import * as THREE from 'three';
import { ProgramError, ProgramRunner } from './ProgramRunner.js';
import { STEP_TYPES } from './Program.js';
import { destinationLabel, isPallet, itemFrame, palletLabel, targetFrame } from './targets.js';

const UP = new THREE.Vector3(0, 1, 0);
const ONE = new THREE.Vector3(1, 1, 1);

// Walking speeds (m/s), turning (radians a second) and the forks' lifting speed (m/s).
const WALK = 1.1;
const WALK_LOADED = 0.8;
const BACK_UP = 0.6;
const TURN = Math.PI / 2;
const FORK_SPEED = 0.12;
// How far the forks raise a pallet off what it stood on.
const LIFT = 0.06;
// The fork ends stop this far from a pallet before the forks go in, and from an object before
// a pallet is carried in.
const CLEARANCE = 0.3;
// The highest surface a pallet can be put down on (a wrapper's turntable or a low stand, not a table).
const MAX_DECK = 0.6;
const SIDES = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(-1, 0, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, -1)];

const yawOf = (heading) => Math.atan2(-heading.z, heading.x);
const headingOf = (yaw) => new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
const turnBetween = (from, to) => Math.atan2(Math.sin(to - from), Math.cos(to - from));

// A footprint's half size along a direction: [length, width] turned by `quaternion`.
function halfAlong(direction, quaternion, [length, width]) {
  const x = new THREE.Vector3(1, 0, 0).applyQuaternion(quaternion);
  const z = new THREE.Vector3(0, 0, 1).applyQuaternion(quaternion);
  return (Math.abs(direction.dot(x)) * length + Math.abs(direction.dot(z)) * width) / 2;
}

// Runs a worker's program while the scene plays: the worker walks with its pallet jack, picks
// pallets up (with the boxes on them), takes them somewhere and puts them down.
//
// It walks in straight lines (turning on the spot in between) and does not steer around things.
// Pallets are always taken square: the forks go in along one of the pallet's sides, and at an
// object the pallet ends up square with it.
export class WorkerRunner extends ProgramRunner {
  constructor(options) {
    super(options);
    this.cargo = null;
    this.restOn = null;
  }

  get jack() {
    return this.runtime.component.palletJack;
  }

  get name() {
    return this.editor.item(this.itemId)?.name || 'Worker';
  }

  start() {
    this.startPose = this.pose();
    return super.start();
  }

  async runStep(step, context) {
    switch (step.type) {
      case 'pick-pallet': return this.pickUp(step);
      case 'go-to': return this.goTo(step);
      case 'put-down': return this.putDown(step);
      case 'wait-load': return this.waitForLoad(step);
      case 'wait':
      case 'repeat':
        return super.runStep(step, context);
      default:
        throw new ProgramError(step, `A worker can't do "${STEP_TYPES[step.type]?.label || step.type}".`);
    }
  }

  // ---- Steps -----------------------------------------------------------------------------------

  palletFor(step, id) {
    if (!id) throw new ProgramError(step, 'Choose which pallet.');
    const item = this.editor.item(id);
    if (!isPallet(item)) throw new ProgramError(step, 'That pallet is no longer in the scene.');
    const frame = itemFrame(this.editor, id);
    if (!frame || item.hidden) throw new ProgramError(step, `${palletLabel(this.editor, id)} is not in the scene.`);
    const { length, width } = this.editor.runtimes.get(id).component.palletSize;
    return { item, label: palletLabel(this.editor, id), runtime: this.editor.runtimes.get(id), ...frame, size: [length, width] };
  }

  async pickUp(step) {
    if (this.cargo) throw new ProgramError(step, 'It is already carrying a pallet: put that one down first.');
    const pallet = this.palletFor(step, step.pallet);
    const jack = this.jack;
    const here = this.pose().position;
    // Come at it from whichever side is nearest, forks square to that side.
    const sides = SIDES.map((side) => {
      const heading = side.clone().applyQuaternion(pallet.quaternion).setY(0).normalize();
      const final = pallet.position.clone().addScaledVector(heading, -jack.cargo).setY(here.y);
      const leadIn = jack.forkEnd - jack.cargo + halfAlong(heading, pallet.quaternion, pallet.size) + CLEARANCE;
      const before = final.clone().addScaledVector(heading, -leadIn);
      return { heading, final, leadIn, distance: before.distanceTo(here) };
    });
    const side = sides.reduce((best, candidate) => (candidate.distance < best.distance ? candidate : best));
    this.setStatus(`Going to ${pallet.label}`);
    // Forks at the height of what the pallet stands on (the floor, or a low stand).
    await this.forksTo(jack.lowered + Math.max(0, pallet.position.y - here.y));
    await this.approach(side.final, side.heading, side.leadIn);
    this.setStatus(`Lifting ${pallet.label}`);
    pallet.runtime.root.updateMatrixWorld(true);
    jack.forks.updateMatrixWorld(true);
    this.cargo = {
      id: pallet.item.id,
      label: pallet.label,
      root: pallet.runtime.root,
      offset: jack.forks.matrixWorld.clone().invert().multiply(pallet.runtime.root.matrixWorld),
      leadIn: side.leadIn,
      carried: this.simulation.carry(pallet.item.id),
    };
    this.restOn = pallet.position.y;
    await this.forksTo(jack.getForkHeight() + LIFT);
  }

  // Where a "Go to" ends: { position (where the pallet's middle goes), heading, leadIn, deck }.
  destination(step) {
    const target = step.target;
    if (!target) throw new ProgramError(step, 'Choose where to go.');
    const label = destinationLabel(this.editor, target);
    const { position: here } = this.pose();
    const cargoPoint = this.cargoPoint();
    if (target.kind === 'start') {
      const { position, heading } = this.startPose;
      return { position: position.clone().addScaledVector(heading, this.jack.cargo), heading, leadIn: 0, deck: null, label };
    }
    if (target.kind === 'point') {
      if (!Array.isArray(target.offset)) throw new ProgramError(step, 'Choose where to go.');
      const position = new THREE.Vector3(...target.offset).setY(here.y);
      const heading = position.clone().sub(here).setY(0);
      if (heading.lengthSq() < 1e-6) heading.copy(this.pose().heading);
      return { position, heading: heading.normalize(), leadIn: 0, deck: null, label };
    }
    if (target.kind === 'item') {
      if (target.item === this.cargo?.id) throw new ProgramError(step, 'It can\'t go to the pallet it is carrying.');
      const frame = itemFrame(this.editor, target.item);
      if (!frame || this.editor.item(target.item)?.hidden) throw new ProgramError(step, `${label} is not in the scene.`);
      const position = frame.position.clone().setY(here.y);
      // Square with the object, along whichever of its sides is nearest the way it is coming.
      const coming = position.clone().sub(cargoPoint).setY(0).normalize();
      const heading = SIDES.map((side) => side.clone().applyQuaternion(frame.quaternion).setY(0).normalize())
        .reduce((best, side) => (side.dot(coming) > best.dot(coming) ? side : best));
      // A low surface on it (a turntable) is where a pallet is put down.
      const surface = targetFrame(this.editor, { kind: 'spot', item: target.item, anchor: 'surface' });
      const deck = surface && surface.position.y - here.y <= MAX_DECK ? surface.position.y : null;
      const runtime = this.editor.runtimes.get(target.item);
      const size = runtime?.component?.anchors?.surface?.size;
      const reach = (size ? halfAlong(heading, frame.quaternion, size) : 0.5) + (this.cargo ? this.cargoHalf(heading) : 0) + CLEARANCE;
      return { position, heading, leadIn: reach, deck, label };
    }
    throw new ProgramError(step, 'Choose where to go.');
  }

  async goTo(step) {
    const goal = this.destination(step);
    this.setStatus(`Going to ${goal.label}${this.cargo ? ` with ${this.cargo.label}` : ''}`);
    const floor = this.pose().position.y;
    // Carrying a pallet onto a raised surface: lift it clear of that first.
    if (this.cargo && goal.deck !== null) {
      const clearance = goal.deck + LIFT - this.cargoBottom();
      if (clearance > 0) await this.forksTo(this.jack.getForkHeight() + clearance);
    }
    const final = goal.position.clone().addScaledVector(goal.heading, -this.jack.cargo);
    if (goal.leadIn > 0) await this.approach(final, goal.heading, goal.leadIn);
    else {
      await this.walkTo(final);
      await this.turnTo(goal.heading);
    }
    this.restOn = goal.deck ?? floor;
  }

  async putDown(step) {
    if (!this.cargo) throw new ProgramError(step, 'It isn\'t carrying a pallet: pick one up first.');
    const jack = this.jack;
    const cargo = this.cargo;
    this.setStatus(`Putting ${cargo.label} down`);
    const restOn = this.restOn ?? this.pose().position.y;
    await this.forksTo(jack.getForkHeight() + restOn - this.cargoBottom());
    this.simulation.setDown(cargo.carried);
    this.cargo = null;
    // Back the forks out from under it, then lower them.
    this.setStatus('Backing away');
    const { position, heading } = this.pose();
    await this.walkTo(position.clone().addScaledVector(heading, -cargo.leadIn), { backwards: true });
    await this.forksTo(jack.lowered);
  }

  waitForLoad(step) {
    const pallet = this.palletFor(step, step.pallet);
    const count = Math.max(1, Math.round(Number(step.count) || 1));
    this.setStatus(`Waiting for ${count} box${count === 1 ? '' : 'es'} on ${pallet.label}`);
    return this.until(() => this.simulation.boxesOn(step.pallet).length >= count);
  }

  // ---- Moving --------------------------------------------------------------------------------

  // Where the worker stands (world, on the floor) and which way the forks point (across the floor).
  pose() {
    const root = this.runtime.root;
    root.updateWorldMatrix(true, false);
    return {
      position: root.getWorldPosition(new THREE.Vector3()),
      heading: new THREE.Vector3(1, 0, 0).transformDirection(root.matrixWorld).setY(0).normalize(),
    };
  }

  place(position, heading) {
    const root = this.runtime.root;
    root.parent.updateWorldMatrix(true, false);
    const world = new THREE.Matrix4().compose(position, new THREE.Quaternion().setFromAxisAngle(UP, yawOf(heading)), ONE);
    const local = root.parent.matrixWorld.clone().invert().multiply(world);
    local.decompose(root.position, root.quaternion, new THREE.Vector3());
    root.updateMatrixWorld(true);
    this.carryAlong();
  }

  // The carried pallet goes where the forks are.
  carryAlong() {
    if (!this.cargo) return;
    const { root, offset } = this.cargo;
    this.jack.forks.updateWorldMatrix(true, false);
    const world = this.jack.forks.matrixWorld.clone().multiply(offset);
    root.parent.updateWorldMatrix(true, false);
    root.parent.matrixWorld.clone().invert().multiply(world).decompose(root.position, root.quaternion, new THREE.Vector3());
    root.updateMatrixWorld(true);
  }

  // Where the middle of a carried pallet is (or would be), on the floor.
  cargoPoint() {
    const { position, heading } = this.pose();
    return position.addScaledVector(heading, this.jack.cargo);
  }

  cargoBottom() {
    return this.cargo ? this.cargo.root.getWorldPosition(new THREE.Vector3()).y : 0;
  }

  cargoHalf(heading) {
    const { length, width } = this.editor.runtimes.get(this.cargo.id).component.palletSize;
    return halfAlong(heading, this.cargo.root.getWorldQuaternion(new THREE.Quaternion()), [length, width]);
  }

  // Straight in to `final` along `heading`, from `leadIn` before it.
  async approach(final, heading, leadIn) {
    await this.walkTo(final.clone().addScaledVector(heading, -leadIn));
    await this.turnTo(heading);
    await this.walkTo(final);
  }

  async walkTo(point, { backwards = false } = {}) {
    const { position } = this.pose();
    const offset = point.clone().sub(position).setY(0);
    if (offset.length() < 0.005) return;
    if (!backwards) await this.turnTo(offset.clone().normalize());
    const speed = backwards ? BACK_UP : this.cargo ? WALK_LOADED : WALK;
    await this.until((deltaTime) => {
      const now = this.pose();
      const left = point.clone().sub(now.position).setY(0);
      const step = speed * deltaTime;
      const done = left.length() <= step;
      const next = done ? point.clone().setY(now.position.y) : now.position.addScaledVector(left.normalize(), step);
      this.place(next, now.heading);
      this.jack.setWalking(done ? 0 : speed);
      return done;
    });
  }

  async turnTo(heading) {
    const target = yawOf(heading);
    if (Math.abs(turnBetween(yawOf(this.pose().heading), target)) < 1e-3) return;
    await this.until((deltaTime) => {
      const now = this.pose();
      const current = yawOf(now.heading);
      const left = turnBetween(current, target);
      const step = TURN * deltaTime;
      const done = Math.abs(left) <= step;
      this.place(now.position, headingOf(done ? target : current + Math.sign(left) * step));
      this.jack.setWalking(done ? 0 : 0.5);
      return done;
    });
  }

  async forksTo(height) {
    const jack = this.jack;
    if (Math.abs(jack.getForkHeight() - height) < 1e-4) return;
    await this.until((deltaTime) => {
      const now = jack.getForkHeight();
      const step = FORK_SPEED * deltaTime;
      const done = Math.abs(height - now) <= step;
      jack.setForkHeight(done ? height : now + Math.sign(height - now) * step);
      this.carryAlong();
      return done;
    });
  }

  stop() {
    super.stop();
    this.jack?.setWalking(0);
    this.cargo = null;
  }
}
