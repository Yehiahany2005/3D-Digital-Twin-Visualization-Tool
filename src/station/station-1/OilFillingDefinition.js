/** Top-level process states exposed by the oil filling & capping cycle. */
export const OIL_STATION_STATES = Object.freeze({
  IDLE: 'IDLE',
  FILLING: 'FILLING',
  TRANSPORTING: 'TRANSPORTING',
  CAPPING: 'CAPPING',
  OUTPUT: 'OUTPUT',
});

/** Same speed steps as the robot station: 1×, 2× and 10× (debug). */
export const OIL_STATION_SPEEDS = Object.freeze([1, 2, 10]);

/**
 * Station 1 — industrial oil filling & capping line. All values in metres / seconds.
 * Product flows along +X. Z = 0 is the belt centre line, +Z is the operator (front) side.
 */
export const OIL_STATION_DEFINITION = {
  units: 'm',
  can: {
    // 20 L HDPE lubricant jerry can (body only; handle and neck sit on top).
    length: 0.28,
    width: 0.19,
    height: 0.36,
    cornerRadius: 0.03,
    neckOffsetX: 0.075,
    neckRadius: 0.021,
    neckHeight: 0.03,
    capRadius: 0.027,
    capHeight: 0.032,
    fillLevel: 0.9,
  },
  line: {
    beltHeight: 0.86,
    beltWidth: 0.34,
    pitch: 0.4,
    cansPerBatch: 4,
  },
  /** Batch centre positions along X. Consecutive positions are one conveyor index apart. */
  positions: {
    spawn: -3.2,
    staging: -1.6,
    filling: 0,
    buffer: 1.6,
    capping: 3.2,
    outfeed: 4.8,
    exit: 8.0,
  },
  conveyor: {
    main: { start: -4.3, end: 4.1 },
    outfeed: { start: 4.16, end: 8.9 },
    infeedTunnel: { start: -4.35, end: -2.4 },
    outfeedTunnel: { start: 7.15, end: 8.95 },
  },
  filling: {
    /** Nozzle tip depth below the neck rim while filling. */
    nozzleInsertion: 0.045,
    stroke: 0.25,
  },
  capping: {
    stroke: 0.26,
    threadLead: 0.012,
    tighteningTurns: 3,
  },
  tank: {
    position: { x: -1.3, z: -1.5 },
    radius: 0.45,
    height: 1.3,
    legHeight: 0.55,
    consumptionPerBatch: 0.04,
    refillBelow: 0.35,
    refillTo: 0.88,
  },
  timings: {
    conveyorStart: 0.35,
    index: 2.4,
    conveyorSettle: 0.3,
    outputStart: 0.3,
    output: 2.8,
    inPosition: 0.4,
    fillDescend: 1.5,
    nozzleEngage: 0.3,
    valveOpen: 0.35,
    dispense: 5.0,
    valveClose: 0.35,
    dripSettle: 0.3,
    fillRetract: 1.4,
    afterFill: 0.3,
    capDescend: 1.3,
    capEngage: 0.15,
    tighten: 1.2,
    torqueHold: 0.25,
    capRetract: 1.3,
    capFeed: 0.7,
  },
};

export function getIndexDistance(definition = OIL_STATION_DEFINITION) {
  return definition.line.pitch * definition.line.cansPerBatch;
}

/** X position of slot `index` (0..cansPerBatch-1) in a batch centred at `center`. */
export function getSlotX(center, index, definition = OIL_STATION_DEFINITION) {
  const { pitch, cansPerBatch } = definition.line;
  return center + (index - (cansPerBatch - 1) / 2) * pitch;
}
