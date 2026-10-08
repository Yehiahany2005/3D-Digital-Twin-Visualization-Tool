import { OIL_STATION_DEFINITION } from '../station-1/OilFillingDefinition.js';
import { CASE_PACKING_DEFINITION } from '../station-2/CasePackingDefinition.js';
import { STATION_DEFINITION } from '../station-3/StationDefinition.js';

/**
 * Factory layout (world space, metres). Station 3 (the ABB robot cell) must stay
 * at the world origin because its cycle mixes station-local and world
 * coordinates; Stations 1 and 2 are placed upstream along −X so that product
 * flows left → right: raw materials → filling/capping → case packing →
 * palletizing → wrapping → finished pallet.
 *
 * Alignment rules:
 * - Station 1's single-file centre line (its local z = 0) lines up with
 *   Station 2's two-lane can input (its local z = input.z).
 * - Station 2's carton line (its local z = boxLine.z) lines up with Station 3's
 *   box conveyor (world z = 0) and its box source cabinet.
 */

/** Station 1 runs on the packable can so the same can fits Station 2's / Station 3's carton. */
export const FACTORY_STATION1_DEFINITION = {
  ...OIL_STATION_DEFINITION,
  can: { ...CASE_PACKING_DEFINITION.can },
};

const S3_INPUT_X = -STATION_DEFINITION.conveyor.length / 2;
const S3_CABINET_BACK_X = S3_INPUT_X - STATION_DEFINITION.sourceMachine.depth;
const CASE_TRANSFER_LENGTH = 1.6;
const CAN_TRANSFER_LENGTH = 3.0;

const s2OutputTunnelEnd = CASE_PACKING_DEFINITION.boxLine.outputTunnel.end;
const s2X = S3_CABINET_BACK_X - CASE_TRANSFER_LENGTH - s2OutputTunnelEnd - 0.01;
const s2Z = -CASE_PACKING_DEFINITION.boxLine.z;
const s1OutfeedTunnelEnd = OIL_STATION_DEFINITION.conveyor.outfeedTunnel.end;
const s2InfeedTunnelStart = CASE_PACKING_DEFINITION.input.tunnel.start;
const s1X = s2X + s2InfeedTunnelStart - CAN_TRANSFER_LENGTH - s1OutfeedTunnelEnd;
const s1Z = s2Z + CASE_PACKING_DEFINITION.input.z;

/** Offset from Station 1 local X to Station 2 local X along the shared can centre line. */
const S1_TO_S2_X = s2X - s1X;
const canLength = CASE_PACKING_DEFINITION.can.length;
const caseLength = CASE_PACKING_DEFINITION.box.length;

export const FACTORY_LAYOUT = {
  station1: { x: s1X, z: s1Z },
  station2: { x: s2X, z: s2Z },
  station3: { x: 0, z: 0 },

  /** Station 1 → Station 2 can transfer, in Station 1 local coordinates (centre line z = 0). */
  canTransfer: {
    start: s1OutfeedTunnelEnd,
    end: s1OutfeedTunnelEnd + CAN_TRANSFER_LENGTH,
    singleFileGuideEnd: s1OutfeedTunnelEnd + 1.6,
    /** Pair positions when a pair stands in front of the pushers. */
    pusherPair: [s1OutfeedTunnelEnd + 1.85, s1OutfeedTunnelEnd + 2.25],
    pusherCenter: s1OutfeedTunnelEnd + 2.05,
    laneDividerStart: s1OutfeedTunnelEnd + 2.45,
    laneZ: CASE_PACKING_DEFINITION.input.laneZ,
    /**
     * Where each lane's leading/trailing can waits for Station 2 (inside its
     * infeed tunnel). Leading = Station 2's spawn X; trailing sits one Station 1
     * pitch behind, i.e. no further back than Station 2's own spawn.
     */
    staging: {
      leading: CASE_PACKING_DEFINITION.input.spawnX[1] + S1_TO_S2_X,
      trailing: CASE_PACKING_DEFINITION.input.spawnX[1] + S1_TO_S2_X - OIL_STATION_DEFINITION.line.pitch,
    },
    s2InputStart: CASE_PACKING_DEFINITION.input.start + S1_TO_S2_X,
    s1OutfeedEnd: OIL_STATION_DEFINITION.conveyor.outfeed.end,
    pusherRetracted: 0.25,
    canHalfWidth: CASE_PACKING_DEFINITION.can.width / 2,
    canLength,
  },

  /** Station 2 → Station 3 case transfer, world space along z = 0. */
  caseTransfer: {
    start: s2X + s2OutputTunnelEnd + 0.01,
    end: S3_CABINET_BACK_X - 0.02,
    /** Case centre X when Station 2 discharges it inside its output tunnel. */
    exitX: s2X + CASE_PACKING_DEFINITION.boxLine.exitX,
    s2OutputBeltEnd: s2X + CASE_PACKING_DEFINITION.boxLine.output.end,
    cabinetBackX: S3_CABINET_BACK_X,
    /** Queue slots, front first: hidden buffer inside the cabinet, then two on the transfer belt. */
    slots: [
      S3_CABINET_BACK_X + caseLength / 2 + 0.44,
      S3_CABINET_BACK_X - caseLength / 2 - 0.03,
      S3_CABINET_BACK_X - caseLength * 1.5 - 0.07,
    ],
    s3InputX: S3_INPUT_X,
    /** Inside the cabinet the case steps down from Station 2's belt to Station 3's. */
    dropFromX: S3_CABINET_BACK_X + caseLength / 2 + 0.05,
    dropToX: S3_CABINET_BACK_X + caseLength / 2 + 0.35,
  },

  supply: {
    /** Empty jerry can rack behind Station 1's infeed tunnel (Station 1 local). */
    cans: { x: -6.0, z: 0 },
    /** Carton rack behind Station 2's case erector (Station 2 local). */
    cases: { x: -5.85, z: CASE_PACKING_DEFINITION.boxLine.z },
  },

  beltSpeed: 0.6,
  beltRamp: 0.5,
  stopBlend: 0.06,
  palletBoxes: STATION_DEFINITION.stack.columns * STATION_DEFINITION.stack.rows * STATION_DEFINITION.stack.layers,
};
