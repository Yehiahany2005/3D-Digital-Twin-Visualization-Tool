import * as THREE from 'three';
import { OIL_STATION_SPEEDS, OIL_STATION_STATES as STATES, getIndexDistance, getSlotX } from './OilFillingDefinition.js';
import { smoother } from './OilGeometry.js';

const POSITION_TOLERANCE = 0.01;

/** Per-can product states. */
export const CAN_STATES = Object.freeze({
  EMPTY: 'EMPTY',
  FILLING: 'FILLING',
  FILLED: 'FILLED',
  CAPPING: 'CAPPING',
  CAPPED: 'CAPPED',
});

/** Process phases run in this order every machine cycle; phases with nothing to do are skipped. */
const PHASES = ['transport', 'output', 'filling', 'capping'];

const easeOut = (t) => 1 - (1 - t) * (1 - t);

/** Two-stage fill: fast bulk fill, then a slow top-off as the valve throttles. */
function fillCurve(t) {
  if (t < 0.75) return 0.85 * (t / 0.75);
  return 0.85 + 0.15 * easeOut((t - 0.75) / 0.25);
}

function initialStatus() {
  return {
    state: STATES.IDLE,
    step: 'Ready',
    mainConveyor: 'STOPPED',
    outfeedConveyor: 'STOPPED',
    fillingHead: 'RAISED',
    cappingHead: 'RAISED',
    valves: 'CLOSED',
    filledCount: 0,
    cappedCount: 0,
    outputCount: 0,
    cycles: 0,
    fillLevel: 0,
    speed: 1,
    cansOnLine: 0,
  };
}

/**
 * Indexed filling & capping line controller.
 *
 * The cycle is a queue of timed steps (state, label, duration, callbacks).
 * Each machine cycle plans: TRANSPORTING (one belt index) → OUTPUT (outfeed
 * discharge) → FILLING → CAPPING. Every motion is evaluated from absolute
 * start/end values with a quintic ease, so speed changes never skip or
 * teleport objects — at 10× several steps simply complete in one frame.
 */
export class OilFillingCycle {
  constructor({ definition, canGroup, createCan, conveyors, filling, capping, sensors, tank, onUpdate }) {
    this.definition = definition;
    this.canGroup = canGroup;
    this.createCan = createCan;
    this.conveyors = conveyors;
    this.filling = filling;
    this.capping = capping;
    this.sensors = sensors;
    this.tank = tank;
    this.onUpdate = onUpdate;
    this.indexDistance = getIndexDistance(definition);
    this.speedMultiplier = 1;
    this.cans = [];
    this.steps = [];
    this.active = null;
    this.phaseIndex = 0;
    this.running = false;
    this.clock = 0;
    this.tankRefilling = false;
    this.status = initialStatus();
    this.reset();
  }

  get state() {
    return this.status.state;
  }

  // ---- Public controls ---------------------------------------------------------------

  start() {
    if (this.running) return;
    this.running = true;
    this.status.step = 'Starting';
    this.notify();
  }

  reset() {
    this.running = false;
    this.steps = [];
    this.active = null;
    this.phaseIndex = 0;
    this.tankRefilling = false;
    [...this.cans].forEach((entry) => this.removeCan(entry));
    this.filling.setHeadTravel(0);
    this.hideStreams();
    this.capping.reset();
    this.conveyors.main.reset();
    this.conveyors.outfeed.reset();
    this.tank.setLevel(this.definition.tank.refillTo);
    this.sensors.reset();
    this.status = { ...initialStatus(), speed: this.speedMultiplier };
    // A batch of empty cans already waits at the infeed so the line looks ready.
    this.spawnBatch(this.definition.positions.staging);
    this.sensors.update(this.cans.map((entry) => entry.x));
    this.notify();
  }

  setSpeed(multiplier) {
    if (!OIL_STATION_SPEEDS.includes(multiplier)) throw new Error(`Unsupported station speed: ${multiplier}`);
    this.speedMultiplier = multiplier;
    this.status.speed = multiplier;
    this.notify();
  }

  update(delta) {
    if (!this.running) return;
    let remaining = delta * this.speedMultiplier;
    this.clock += remaining;
    for (let guard = 0; remaining > 1e-9 && this.running && guard < 64; guard += 1) {
      if (!this.active) this.beginNextStep();
      const step = this.active;
      const previous = step.duration > 0 ? step.elapsed / step.duration : 0;
      const used = Math.min(remaining, step.duration - step.elapsed);
      step.elapsed += used;
      remaining -= used;
      const progress = step.duration > 0 ? step.elapsed / step.duration : 1;
      step.onUpdate?.(progress, previous);
      if (step.elapsed >= step.duration - 1e-9) {
        step.onEnd?.();
        this.active = null;
      }
    }
    this.updateTank(delta * this.speedMultiplier);
    this.sensors.update(this.cans.map((entry) => entry.x));
    this.notify();
  }

  // ---- Step queue --------------------------------------------------------------------

  queue(state, label, duration, status = {}, callbacks = {}) {
    this.steps.push({ state, label, duration, status, elapsed: 0, ...callbacks });
  }

  /** Queues a synchronised belt move of the selected cans by `distance`. */
  queueMove(state, label, duration, distance, selectCans, belts, status, onEnd) {
    let moving = [];
    let from = [];
    this.queue(state, label, duration, status, {
      onStart: () => {
        moving = selectCans();
        from = moving.map((entry) => entry.x);
      },
      onUpdate: (progress, previous) => {
        const eased = smoother(progress);
        moving.forEach((entry, index) => this.setCanX(entry, from[index] + distance * eased));
        const travel = distance * (eased - smoother(previous));
        belts.forEach((belt) => this.conveyors[belt].advance(travel));
      },
      onEnd,
    });
  }

  beginNextStep() {
    if (!this.steps.length) this.planNextPhase();
    this.active = this.steps.shift();
    this.active.elapsed = 0;
    Object.assign(this.status, { state: this.active.state, step: this.active.label }, this.active.status);
    this.active.onStart?.();
  }

  planNextPhase() {
    for (let attempt = 0; attempt < PHASES.length; attempt += 1) {
      const phase = PHASES[this.phaseIndex];
      this.phaseIndex = (this.phaseIndex + 1) % PHASES.length;
      const planned = {
        transport: () => this.planTransport(),
        output: () => this.planOutput(),
        filling: () => this.planFilling(),
        capping: () => this.planCapping(),
      }[phase]();
      if (planned) return;
    }
  }

  // ---- Phases ------------------------------------------------------------------------

  planTransport() {
    const { timings, positions } = this.definition;
    this.status.cycles += 1;
    this.queue(STATES.TRANSPORTING, 'Conveyor starting', timings.conveyorStart, { mainConveyor: 'STARTING', outfeedConveyor: 'STARTING' }, {
      onStart: () => this.spawnBatch(positions.spawn),
    });
    this.queueMove(STATES.TRANSPORTING, 'Indexing conveyor', timings.index, this.indexDistance, () => [...this.cans], ['main', 'outfeed'], {
      mainConveyor: 'RUNNING',
      outfeedConveyor: 'RUNNING',
    });
    this.queue(STATES.TRANSPORTING, 'Conveyor stopped', timings.conveyorSettle, { mainConveyor: 'STOPPED', outfeedConveyor: 'STOPPED' });
    return true;
  }

  planOutput() {
    const { timings, positions, conveyor } = this.definition;
    const leaving = this.cans.filter((entry) => entry.state === CAN_STATES.CAPPED && entry.x > conveyor.outfeed.start);
    if (!leaving.length) return false;
    this.queue(STATES.OUTPUT, 'Outfeed starting', timings.outputStart, { outfeedConveyor: 'STARTING' });
    this.queueMove(STATES.OUTPUT, 'Discharging finished cans', timings.output, positions.exit - positions.outfeed, () => leaving, ['outfeed'], {
      outfeedConveyor: 'RUNNING',
    }, () => {
      leaving.forEach((entry) => this.removeCan(entry));
      this.status.outputCount += leaving.length;
      this.status.outfeedConveyor = 'STOPPED';
    });
    return true;
  }

  planFilling() {
    const { timings, positions, can } = this.definition;
    const batch = this.batchAt(positions.filling, CAN_STATES.EMPTY);
    if (!batch) return false;
    const setLevel = (level) => {
      batch.forEach((entry) => entry.can.setLevel(level));
      this.status.fillLevel = level / can.fillLevel;
    };

    this.queue(STATES.FILLING, 'Cans in position', timings.inPosition, { fillingHead: 'RAISED', fillLevel: 0 }, {
      onStart: () => batch.forEach((entry) => { entry.state = CAN_STATES.FILLING; }),
    });
    this.queue(STATES.FILLING, 'Filling head descending', timings.fillDescend, { fillingHead: 'DESCENDING' }, {
      onUpdate: (progress) => this.filling.setHeadTravel(smoother(progress)),
    });
    this.queue(STATES.FILLING, 'Nozzles engaged', timings.nozzleEngage, { fillingHead: 'LOWERED' });
    this.queue(STATES.FILLING, 'Valves opening', timings.valveOpen, { valves: 'OPEN' }, {
      // Oil front accelerates under gravity from the tip to the can bottom.
      onUpdate: (progress) => this.updateStreams(batch, { front: progress * progress }),
    });
    this.queue(STATES.FILLING, 'Dispensing oil', timings.dispense, { valves: 'OPEN' }, {
      onUpdate: (progress) => {
        setLevel(fillCurve(progress) * can.fillLevel);
        this.updateStreams(batch, { widthScale: progress < 0.75 ? 1 : 0.6 });
      },
    });
    this.queue(STATES.FILLING, 'Valves closing', timings.valveClose, { valves: 'CLOSED' }, {
      // The last of the jet drops away from the closed nozzle.
      onUpdate: (progress) => this.updateStreams(batch, { tail: progress * progress, widthScale: 0.6 }),
      onEnd: () => this.hideStreams(),
    });
    this.queue(STATES.FILLING, 'Drip settle', timings.dripSettle);
    this.queue(STATES.FILLING, 'Filling head retracting', timings.fillRetract, { fillingHead: 'RETRACTING' }, {
      onUpdate: (progress) => this.filling.setHeadTravel(1 - smoother(progress)),
    });
    this.queue(STATES.FILLING, 'Fill complete', timings.afterFill, { fillingHead: 'RAISED' }, {
      onEnd: () => {
        batch.forEach((entry) => { entry.state = CAN_STATES.FILLED; });
        this.status.filledCount += batch.length;
        this.consumeTank();
      },
    });
    return true;
  }

  planCapping() {
    const { timings, positions, capping, line } = this.definition;
    const batch = this.batchAt(positions.capping, CAN_STATES.FILLED);
    if (!batch) return false;
    const seatY = line.beltHeight + batch[0].can.references.capSeat.y;
    const engageY = seatY + capping.threadLead;
    const raisedY = seatY + capping.stroke;
    const fullTurn = -Math.PI * 2 * capping.tighteningTurns;

    this.queue(STATES.CAPPING, 'Cans in position', timings.inPosition, { cappingHead: 'RAISED' }, {
      onStart: () => batch.forEach((entry) => { entry.state = CAN_STATES.CAPPING; }),
    });
    this.queue(STATES.CAPPING, 'Capping head descending', timings.capDescend, { cappingHead: 'DESCENDING' }, {
      onUpdate: (progress) => this.capping.setHeadY(THREE.MathUtils.lerp(raisedY, engageY, smoother(progress))),
    });
    this.queue(STATES.CAPPING, 'Caps engaging threads', timings.capEngage, { cappingHead: 'ENGAGED' });
    this.queue(STATES.CAPPING, 'Tightening caps', timings.tighten, { cappingHead: 'TIGHTENING' }, {
      // Spindles slow down as torque builds; the cap screws down by the thread lead.
      onUpdate: (progress) => {
        const eased = easeOut(progress);
        this.capping.setHeadY(THREE.MathUtils.lerp(engageY, seatY, eased));
        this.capping.setChuckRotation(fullTurn * eased);
      },
    });
    this.queue(STATES.CAPPING, 'Torque reached', timings.torqueHold, { cappingHead: 'TORQUE OK' }, {
      onEnd: () => this.transferCaps(batch),
    });
    this.queue(STATES.CAPPING, 'Capping head retracting', timings.capRetract, { cappingHead: 'RETRACTING' }, {
      onUpdate: (progress) => this.capping.setHeadY(THREE.MathUtils.lerp(seatY, raisedY, smoother(progress))),
    });
    this.queue(STATES.CAPPING, 'Feeding new caps', timings.capFeed, { cappingHead: 'RAISED' }, {
      onStart: () => {
        // Whole turns: resetting the angle is visually seamless.
        this.capping.setChuckRotation(0);
        this.capping.feedCaps();
      },
      onUpdate: (progress) => this.capping.setFeedProgress(smoother(progress)),
      onEnd: () => {
        batch.forEach((entry) => { entry.state = CAN_STATES.CAPPED; });
        this.status.cappedCount += batch.length;
      },
    });
    return true;
  }

  // ---- Helpers -----------------------------------------------------------------------

  spawnBatch(center) {
    const { line } = this.definition;
    for (let index = 0; index < line.cansPerBatch; index += 1) {
      const can = this.createCan();
      const entry = { can, x: getSlotX(center, index, this.definition), state: CAN_STATES.EMPTY };
      can.root.position.set(entry.x, line.beltHeight, 0);
      this.canGroup.add(can.root);
      this.cans.push(entry);
    }
    this.status.cansOnLine = this.cans.length;
  }

  removeCan(entry) {
    entry.can.root.removeFromParent();
    this.cans.splice(this.cans.indexOf(entry), 1);
    this.status.cansOnLine = this.cans.length;
  }

  setCanX(entry, x) {
    entry.x = x;
    entry.can.root.position.x = x;
  }

  /** Full batch of cans in `state` sitting exactly in the slots around `center`, or null. */
  batchAt(center, state) {
    const batch = [];
    for (let index = 0; index < this.definition.line.cansPerBatch; index += 1) {
      const slotX = getSlotX(center, index, this.definition);
      const entry = this.cans.find((candidate) => candidate.state === state && Math.abs(candidate.x - slotX) < POSITION_TOLERANCE);
      if (!entry) return null;
      batch.push(entry);
    }
    return batch;
  }

  /**
   * Oil jets from each nozzle tip to the oil surface in its can.
   * `front` (0..1) is how far the jet has fallen; `tail` (0..1) how far its
   * top has dropped after the valve closed.
   */
  updateStreams(batch, { front = 1, tail = 0, widthScale = 1 } = {}) {
    const tipY = this.filling.getTipY();
    batch.forEach((entry, index) => {
      const surfaceY = this.definition.line.beltHeight + entry.can.surfaceY();
      const drop = Math.max(tipY - surfaceY, 0);
      this.filling.setStream(index, {
        visible: true,
        top: drop * tail,
        bottom: drop * front,
        widthScale,
        phase: this.clock,
      });
    });
  }

  hideStreams() {
    this.filling.nozzles.forEach((_, index) => this.filling.setStream(index, { visible: false }));
  }

  transferCaps(batch) {
    this.canGroup.updateMatrixWorld(true);
    this.capping.head.updateMatrixWorld(true);
    const caps = this.capping.releaseCaps();
    batch.forEach((entry, index) => {
      const cap = caps[index];
      if (!cap) return;
      entry.can.root.attach(cap);
      // Exact seat on the neck (removes floating-point drift from the hand-over).
      cap.position.copy(entry.can.references.capSeat);
      cap.rotation.set(0, cap.rotation.y, 0);
      entry.can.cap = cap;
    });
  }

  consumeTank() {
    const { tank } = this.definition;
    this.tank.setLevel(this.tank.level - tank.consumptionPerBatch);
    if (this.tank.level < tank.refillBelow) this.tankRefilling = true;
  }

  updateTank(scaledDelta) {
    if (!this.tankRefilling) return;
    const { tank } = this.definition;
    this.tank.setLevel(Math.min(tank.refillTo, this.tank.level + scaledDelta * 0.05));
    if (this.tank.level >= tank.refillTo) this.tankRefilling = false;
  }

  notify() {
    this.onUpdate?.(this);
  }
}
