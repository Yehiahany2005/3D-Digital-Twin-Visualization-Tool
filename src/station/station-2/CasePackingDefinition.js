import { STATION_DEFINITION } from '../StationDefinition.js';
import { OIL_STATION_DEFINITION } from '../oil/OilFillingDefinition.js';

/** Process states of the case packer, in cycle order. */
export const CASE_PACKING_STATES = Object.freeze({
  EMPTY: 'EMPTY',
  JERRYCANS_ARRIVE: 'JERRYCANS_ARRIVE',
  PICK_4_CANS: 'PICK_4_CANS',
  PLACE_INTO_BOX: 'PLACE_INTO_BOX',
  BOX_COMPLETED: 'BOX_COMPLETED',
  OUTPUT: 'OUTPUT',
});

/** Same speed steps as the other stations: 1×, 2× and 10× (debug). */
export const CASE_PACKING_SPEEDS = Object.freeze([1, 2, 10]);

/**
 * Station 2 — jerry can case packing. Metres / seconds.
 * Product flows along +X. The can input conveyor runs at +Z (operator side),
 * the carton conveyor at −Z; a Cartesian gantry transfers along Z between them.
 */
export const CASE_PACKING_DEFINITION = {
  units: 'm',
  /** Exactly the carton used by the robot palletising station (Station 3). */
  box: {
    ...STATION_DEFINITION.box,
    wall: 0.006,
    flap: 0.005,
  },
  /** Station 1 jerry can, with a shorter body so four fit upright in the carton. */
  can: {
    ...OIL_STATION_DEFINITION.can,
    height: 0.33,
  },
  line: {
    beltHeight: 0.86,
    beltWidth: 0.52,
    beltSpeed: 0.6,
    beltAcceleration: 0.5,
  },
  input: {
    z: 0.75,
    start: -4.2,
    end: 0.55,
    tunnel: { start: -4.25, end: -2.4 },
    /** Lane centre lines relative to the conveyor (two lanes → 2×2 group). */
    laneZ: [-0.13, 0.13],
    /** Can centres along X when accumulated against the end stop (cans touch). */
    stopX: [-0.14, 0.14],
    /** Spawn X of [trailing, leading] can in each lane, inside the infeed tunnel. */
    spawnX: [-3.3, -2.7],
    guideHalfGap: 0.237,
  },
  boxLine: {
    z: -0.75,
    infeed: { start: -4.3, end: 0.9 },
    output: { start: 0.96, end: 5.6 },
    erectorTunnel: { start: -4.35, end: -2.4, clearHeight: 0.7 },
    outputTunnel: { start: 3.95, end: 5.65 },
    spawnX: -3.3,
    packX: 0,
    taperX: 2.3,
    exitX: 4.8,
  },
  /** Can centres inside the carton (relative to carton centre): cans touch along X. */
  boxLayout: {
    x: [-0.14, 0.14],
    z: [-0.1, 0.1],
  },
  robot: {
    x: 0,
    columnZ: 1.65,
    beamY: 2.45,
    /** Gripper origin sits at the handle-grip centre; travel keeps cans above open flaps. */
    travelLift: 0.7,
  },
  timings: {
    lineEmpty: 0.3,
    conveyorStop: 0.5,
    cansSettle: 0.4,
    lowerToCans: 1.1,
    gripClose: 0.4,
    liftCans: 1.2,
    transfer: 2.2,
    lowerIntoBox: 1.5,
    gripOpen: 0.35,
    retract: 1.0,
    returnAndFoldEnds: 1.8,
    foldSides: 1.0,
    boxClosed: 0.3,
    releaseStop: 0.35,
    outputDone: 0.2,
  },
};
