import * as THREE from 'three';
import { StepSequencer } from '../common/StepSequencer.js';
import { smoother } from '../oil/OilGeometry.js';
import { CASE_PACKING_SPEEDS, CASE_PACKING_STATES as STATES } from './CasePackingDefinition.js';

/** Distance over which an accumulating object eases into its stop (m). */
const STOP_BLEND = 0.06;

/** Polynomial smooth minimum: equals min(a, b) once |a − b| ≥ k, C1-smooth in between. */
function smoothMin(a, b, k) {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

/** Belt travel after time `t` when accelerating to speed `v` over `ramp` seconds, then running. */
function rampedTravel(t, v, ramp) {
  if (t < ramp) return 0.5 * (v / ramp) * t * t;
  return 0.5 * v * ramp + v * (t - ramp);
}

/** Trapezoidal belt move covering exactly `distance`: accelerate, run, decelerate. */
function trapezoidTravel(t, distance, v, ramp) {
  const total = distance / v + ramp;
  const a = v / ramp;
  if (t <= ramp) return 0.5 * a * t * t;
  if (t >= total - ramp) return distance - 0.5 * a * Math.max(total - t, 0) ** 2;
  return 0.5 * v * ramp + v * (t - ramp);
}

const easeOut = (t) => 1 - (1 - t) ** 3;

function initialStatus(speed) {
  return {
    state: STATES.EMPTY,
    step: 'Line empty',
    inputConveyor: 'STOPPED',
    boxConveyor: 'STOPPED',
    robot: 'HOME',
    gripper: 'OPEN',
    boxStop: 'CLOSED',
    cansInBox: 0,
    boxesCompleted: 0,
    cansPacked: 0,
    cycles: 0,
    speed,
  };
}

/**
 * Case packing process controller. One machine cycle:
 * EMPTY → JERRYCANS_ARRIVE → PICK_4_CANS → PLACE_INTO_BOX → BOX_COMPLETED → OUTPUT.
 * All motion is evaluated from absolute start/end values, so any speed
 * multiplier produces identical, collision-free paths.
 */
export class CasePackingCycle {
  constructor({ definition, parts, onUpdate }) {
    this.definition = definition;
    this.parts = parts;
    this.onUpdate = onUpdate;
    this.speedMultiplier = 1;
    this.running = false;
    this.cans = [];
    this.box = null;
    this.sequencer = new StepSequencer({
      plan: () => this.planCycle(),
      onStepStart: (step) => Object.assign(this.status, { state: step.state, step: step.label }, step.status),
    });

    const { line, robot, input, boxLine, box, can, boxLayout } = definition;
    const probe = parts.createCan();
    this.gripLocal = probe.root.getObjectByName('Handle grip').position.clone();
    this.heights = {
      pick: line.beltHeight + this.gripLocal.y,
      place: line.beltHeight + box.wall + this.gripLocal.y,
    };
    this.heights.travel = this.heights.pick + robot.travelLift;
    this.pitch = {
      pick: input.laneZ[1] - input.laneZ[0],
      box: boxLayout.z[1] - boxLayout.z[0],
    };
    this.zones = { pick: input.z, place: boxLine.z };
    this.canFootprint = { x: can.length, z: can.width };
    this.status = initialStatus(1);
    this.reset();
  }

  get state() {
    return this.status.state;
  }

  // ---- Public controls ---------------------------------------------------------------

  start() {
    if (this.running) return;
    this.running = true;
    this.notify();
  }

  reset() {
    this.running = false;
    this.sequencer.clear();
    this.cans.forEach((entry) => entry.can.root.removeFromParent());
    this.cans = [];
    if (this.box) this.box.root.removeFromParent();
    this.box = null;
    const { robot, conveyors, input, sensors } = this.parts;
    robot.setZ(this.zones.pick);
    robot.setY(this.heights.travel);
    robot.setPitch(this.pitch.pick);
    robot.setGrip(0);
    robot.setBeacon(false);
    conveyors.setStopOpen(0);
    input.belt.reset();
    conveyors.infeed.reset();
    conveyors.output.reset();
    sensors.cans.reset();
    sensors.boxes.reset();
    this.status = initialStatus(this.speedMultiplier);
    this.notify();
  }

  setSpeed(multiplier) {
    if (!CASE_PACKING_SPEEDS.includes(multiplier)) throw new Error(`Unsupported station speed: ${multiplier}`);
    this.speedMultiplier = multiplier;
    this.status.speed = multiplier;
    this.notify();
  }

  update(delta) {
    if (!this.running) return;
    this.sequencer.advance(delta * this.speedMultiplier);
    this.parts.robot.setBeacon(true);
    const onInput = this.cans.filter((entry) => entry.stage === 'CONVEYOR').map((entry) => entry.can.root.position.x);
    this.parts.sensors.cans.update(onInput);
    this.parts.sensors.boxes.update(this.box ? [this.box.root.position.x] : []);
    this.notify();
  }

  // ---- Cycle plan --------------------------------------------------------------------

  planCycle() {
    const { timings } = this.definition;
    const queue = (...args) => this.sequencer.queue(...args);
    this.status.cycles += 1;

    queue(STATES.EMPTY, 'Line empty', timings.lineEmpty, { cansInBox: 0, robot: 'HOME', gripper: 'OPEN' });
    this.planArrival();
    this.planPick();
    this.planPlace();
    this.planCompletion();
    this.planOutput();
  }

  planArrival() {
    const { line, input, boxLine, timings } = this.definition;
    const queue = (...args) => this.sequencer.queue(...args);
    const v = line.beltSpeed;
    const ramp = line.beltAcceleration;
    // Cans: leading can of each lane stops at the end stop, the trailing can accumulates behind it.
    const canTravels = input.stopX.map((stopX, index) => stopX - input.spawnX[index]);
    const boxTravel = boxLine.packX - boxLine.spawnX;
    const travel = Math.max(...canTravels, boxTravel) + STOP_BLEND;
    const duration = ramp + (travel - 0.5 * v * ramp) / v;

    let movers = [];
    queue(STATES.JERRYCANS_ARRIVE, 'Jerry cans & empty case arriving', duration, {
      inputConveyor: 'RUNNING',
      boxConveyor: 'RUNNING',
      boxStop: 'CLOSED',
    }, {
      onStart: () => {
        this.spawnCans();
        this.spawnBox();
        movers = [
          ...this.cans.map((entry) => ({ object: entry.can.root, start: entry.can.root.position.x, travel: entry.target.x - entry.can.root.position.x })),
          { object: this.box.root, start: boxLine.spawnX, travel: boxTravel },
        ];
      },
      onUpdate: (progress, previous) => {
        const s = rampedTravel(progress * duration, v, ramp);
        const delta = s - rampedTravel(previous * duration, v, ramp);
        this.parts.input.belt.advance(delta);
        this.parts.conveyors.infeed.advance(delta);
        movers.forEach((mover) => {
          mover.object.position.x = mover.start + smoothMin(s, mover.travel, STOP_BLEND);
        });
        // Box stop swings back across the belt while the case is still far upstream.
        this.parts.conveyors.setStopOpen(1 - smoother(Math.min((progress * duration) / 0.5, 1)));
      },
      onEnd: () => movers.forEach((mover) => { mover.object.position.x = mover.start + mover.travel; }),
    });
    queue(STATES.JERRYCANS_ARRIVE, 'Conveyors stopping', ramp, { inputConveyor: 'STOPPING', boxConveyor: 'STOPPING' }, {
      // Belts decelerate under the accumulated cans; product is already held by the stops.
      onUpdate: (progress, previous) => {
        const at = (p) => v * p * ramp - 0.5 * (v / ramp) * (p * ramp) ** 2;
        const delta = at(progress) - at(previous);
        this.parts.input.belt.advance(delta);
        this.parts.conveyors.infeed.advance(delta);
      },
    });
    queue(STATES.JERRYCANS_ARRIVE, 'Cans in 2×2 position', timings.cansSettle, { inputConveyor: 'STOPPED', boxConveyor: 'STOPPED' });
  }

  planPick() {
    const { timings } = this.definition;
    const { robot } = this.parts;
    const queue = (...args) => this.sequencer.queue(...args);
    const { travel, pick } = this.heights;

    queue(STATES.PICK_4_CANS, 'Lowering to can handles', timings.lowerToCans, { robot: 'LOWERING' }, {
      onUpdate: (progress) => robot.setY(THREE.MathUtils.lerp(travel, pick, smoother(progress))),
    });
    queue(STATES.PICK_4_CANS, 'Closing grippers', timings.gripClose, { robot: 'GRIPPING', gripper: 'CLOSING' }, {
      onUpdate: (progress) => robot.setGrip(smoother(progress)),
      onEnd: () => this.gripCans(),
    });
    queue(STATES.PICK_4_CANS, 'Lifting 4 cans', timings.liftCans, { robot: 'LIFTING', gripper: 'CLOSED' }, {
      onUpdate: (progress) => robot.setY(THREE.MathUtils.lerp(pick, travel, smoother(progress))),
    });
  }

  planPlace() {
    const { timings } = this.definition;
    const { robot } = this.parts;
    const queue = (...args) => this.sequencer.queue(...args);
    const { travel, place } = this.heights;

    queue(STATES.PLACE_INTO_BOX, 'Transferring to case', timings.transfer, { robot: 'TRANSFERRING' }, {
      onUpdate: (progress) => {
        robot.setZ(THREE.MathUtils.lerp(this.zones.pick, this.zones.place, smoother(progress)));
        // Rows close up to carton spacing mid-flight.
        robot.setPitch(THREE.MathUtils.lerp(this.pitch.pick, this.pitch.box, smoother((progress - 0.15) / 0.6)));
      },
    });
    queue(STATES.PLACE_INTO_BOX, 'Lowering cans into case', timings.lowerIntoBox, { robot: 'PLACING' }, {
      onUpdate: (progress) => robot.setY(THREE.MathUtils.lerp(travel, place, smoother(progress))),
    });
    queue(STATES.PLACE_INTO_BOX, 'Releasing cans', timings.gripOpen, { robot: 'RELEASING', gripper: 'OPENING' }, {
      onStart: () => this.releaseCans(),
      onUpdate: (progress) => robot.setGrip(1 - smoother(progress)),
    });
    queue(STATES.PLACE_INTO_BOX, 'Retracting from case', timings.retract, { robot: 'RETRACTING', gripper: 'OPEN' }, {
      onUpdate: (progress) => robot.setY(THREE.MathUtils.lerp(place, travel, smoother(progress))),
    });
  }

  planCompletion() {
    const { timings } = this.definition;
    const { robot } = this.parts;
    const queue = (...args) => this.sequencer.queue(...args);

    queue(STATES.BOX_COMPLETED, 'Folding end flaps · robot returning', timings.returnAndFoldEnds, { robot: 'RETURNING' }, {
      onUpdate: (progress) => {
        robot.setZ(THREE.MathUtils.lerp(this.zones.place, this.zones.pick, smoother(progress)));
        robot.setPitch(THREE.MathUtils.lerp(this.pitch.box, this.pitch.pick, smoother(progress)));
        this.box.setMinorFlaps(smoother(progress / 0.6));
      },
    });
    queue(STATES.BOX_COMPLETED, 'Folding side flaps', timings.foldSides, { robot: 'HOME' }, {
      onUpdate: (progress) => this.box.setMajorFlaps(smoother(progress)),
    });
    queue(STATES.BOX_COMPLETED, 'Case closed', timings.boxClosed);
  }

  planOutput() {
    const { line, boxLine, box, timings } = this.definition;
    const { conveyors } = this.parts;
    const queue = (...args) => this.sequencer.queue(...args);
    const v = line.beltSpeed;
    const ramp = line.beltAcceleration;
    const distance = boxLine.exitX - boxLine.packX;
    const duration = distance / v + ramp;

    queue(STATES.OUTPUT, 'Releasing box stop', timings.releaseStop, { boxStop: 'OPEN' }, {
      onUpdate: (progress) => conveyors.setStopOpen(smoother(progress)),
    });
    queue(STATES.OUTPUT, 'Taping & discharging case', duration, { boxConveyor: 'RUNNING' }, {
      onUpdate: (progress, previous) => {
        const s = trapezoidTravel(progress * duration, distance, v, ramp);
        const delta = s - trapezoidTravel(previous * duration, distance, v, ramp);
        conveyors.infeed.advance(delta);
        conveyors.output.advance(delta);
        const x = boxLine.packX + s;
        this.box.root.position.x = x;
        // Taping head lays tape from the leading edge back as the case passes.
        const headLocal = boxLine.taperX - x;
        if (headLocal < box.length / 2) {
          this.box.setTape(headLocal);
          if (headLocal > -box.length / 2) conveyors.spinTaper(delta);
        }
      },
      onEnd: () => {
        this.box.root.removeFromParent();
        this.box = null;
        this.cans = [];
        this.status.boxesCompleted += 1;
        this.status.boxConveyor = 'STOPPED';
      },
    });
    queue(STATES.OUTPUT, 'Case delivered', timings.outputDone, { boxConveyor: 'STOPPED', cansInBox: 0 });
  }

  // ---- Product hand-over --------------------------------------------------------------

  spawnCans() {
    const { input, line, can: canDef } = this.definition;
    input.laneZ.forEach((laneZ, row) => {
      input.stopX.forEach((stopX, column) => {
        const can = this.parts.createCan();
        can.setLevel(canDef.fillLevel);
        const cap = this.parts.createCap();
        cap.position.copy(can.references.capSeat);
        can.root.add(cap);
        can.cap = cap;
        can.root.position.set(input.spawnX[column], line.beltHeight, laneZ);
        this.parts.input.root.add(can.root);
        this.cans.push({ can, row, column, stage: 'CONVEYOR', target: new THREE.Vector3(stopX, line.beltHeight, laneZ) });
      });
    });
  }

  spawnBox() {
    const { boxLine, line } = this.definition;
    this.box = this.parts.createCase();
    this.box.root.position.set(boxLine.spawnX, line.beltHeight, 0);
    this.parts.conveyors.boxRoot.add(this.box.root);
  }

  gripperFor(entry) {
    const { grippers } = this.parts.robot;
    return grippers.find((gripper) => gripper.row === (entry.row === 0 ? -1 : 1) && Math.abs(gripper.unit.position.x - (this.definition.input.stopX[entry.column] + this.gripLocal.x)) < 1e-6);
  }

  gripCans() {
    this.parts.root.updateMatrixWorld(true);
    this.cans.forEach((entry) => {
      this.gripperFor(entry).unit.attach(entry.can.root);
      entry.stage = 'GRIPPED';
    });
    this.status.cansInBox = 0;
  }

  releaseCans() {
    const { boxLayout, box } = this.definition;
    this.parts.root.updateMatrixWorld(true);
    this.cans.forEach((entry) => {
      this.box.contents.attach(entry.can.root);
      // Exact slot in the case (removes float drift from the hand-over).
      entry.can.root.position.set(boxLayout.x[entry.column], box.wall, boxLayout.z[entry.row]);
      entry.can.root.quaternion.identity();
      entry.stage = 'IN_BOX';
    });
    this.status.cansInBox = this.cans.length;
    this.status.cansPacked += this.cans.length;
  }

  notify() {
    this.onUpdate?.(this);
  }
}
