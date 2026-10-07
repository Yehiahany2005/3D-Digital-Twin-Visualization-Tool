export const STATION_DEFINITION = {
  units: 'm',
  floor: { y: 0 },
  conveyor: {
    length: 4.8,
    width: 1.05,
    beltHeight: 0.82,
    beltThickness: 0.08,
    frameHeight: 0.72,
    supportInset: 0.42,
    rollerCount: 13,
  },
  box: {
    length: 0.62,
    width: 0.42,
    height: 0.42,
    beltClearance: 0.012,
  },
  stack: {
    columns: 3,
    rows: 3,
    layers: 3,
    spacing: 0.02,
  },
  /** First-box bottom-left cell origin (XZ). Y is resolved to pallet top at layout time. */
  stackDropOrigin: { x: -0.5, y: 0, z: 2.2 },
  pallet: {
    height: 0.144,
    overhang: 0.08,
  },
  sourceMachine: {
    depth: 1.55,
    width: 1.45,
    height: 1.85,
  },
  wrapMachine: {
    /** Nominal bay size; replaced by loaded Wrapping.STEP bounds at station build time. */
    bayLength: 3.67,
    bayWidth: 1.4,
    height: 2.1,
    /** Offset from pallet center to wrap-bay / turntable center (station space). */
    offsetFromPallet: { x: 4.2, y: 0, z: 0 },
  },
  outbound: {
    workerSpawnGap: 2.4,
    /** Distance from pallet/wrap center to worker root so cargoAnchor (local x=0.55) sits on target. */
    engageGap: 0.55,
    withdrawGap: 2.2,
    /** Clear the turntable deck (~0.44 m) while carrying the pallet into the wrap bay. */
    liftHeight: 0.55,
    approachDuration: 2.4,
    insertDuration: 1.6,
    liftDuration: 1.0,
    transportDuration: 4.2,
    placeDuration: 1.8,
    lowerDuration: 0.9,
    releaseDuration: 0.5,
    withdrawDuration: 2.4,
    stowDuration: 0.6,
    wrapDuration: 12,
  },
  robot: {
    assetId: 'abb_irb6760',
    side: 'near',
    clearance: 0.42,
    alignment: 'pickup',
    facing: 'conveyor',
  },
};

export function getStackFootprint(definition) {
  const { box, stack } = definition;
  const length = stack.columns * box.length + (stack.columns - 1) * stack.spacing;
  const width = stack.rows * box.width + (stack.rows - 1) * stack.spacing;
  const centerOffsetX = ((stack.columns - 1) / 2) * (box.length + stack.spacing);
  const centerOffsetZ = ((stack.rows - 1) / 2) * (box.width + stack.spacing);
  return { length, width, centerOffsetX, centerOffsetZ };
}

export function resolveStationLayout(definition, robotSize = { x: 1, z: 1 }) {
  const { conveyor, box, robot, pallet } = definition;
  const conveyorOrigin = { x: 0, y: definition.floor.y, z: 0 };
  const halfLength = conveyor.length / 2;
  const pickupX = halfLength * 0.08;
  const robotZ = (conveyor.width / 2) + robot.clearance + (robotSize.z / 2);
  const robotX = robot.alignment === 'pickup' ? pickupX : conveyorOrigin.x;

  const footprint = getStackFootprint(definition);
  const palletTopY = definition.floor.y + pallet.height;
  const palletLength = footprint.length + pallet.overhang * 2;
  const palletWidth = footprint.width + pallet.overhang * 2;
  const palletCenter = {
    x: definition.stackDropOrigin.x + footprint.centerOffsetX,
    y: definition.floor.y,
    z: definition.stackDropOrigin.z + footprint.centerOffsetZ,
  };

  const wrapOffset = definition.wrapMachine.offsetFromPallet;
  const wrapCenter = {
    x: palletCenter.x + wrapOffset.x,
    y: definition.floor.y + wrapOffset.y,
    z: palletCenter.z + wrapOffset.z,
  };
  // Worker approaches from -X so forks slide under the pallet along +X.
  const workerYaw = 0;
  const engageX = palletCenter.x - definition.outbound.engageGap;
  const spawnX = palletCenter.x - definition.outbound.workerSpawnGap;
  const withdrawX = wrapCenter.x - definition.outbound.withdrawGap;

  return {
    conveyorOrigin,
    stack: definition.stack,
    conveyor: {
      input: { x: -halfLength, y: conveyor.beltHeight, z: conveyorOrigin.z },
      pickup: { x: pickupX, y: conveyor.beltHeight, z: conveyorOrigin.z },
      output: { x: halfLength, y: conveyor.beltHeight, z: conveyorOrigin.z },
        drop: { x: halfLength * 0.72, y: conveyor.beltHeight, z: conveyorOrigin.z },
      beltSurface: { x: conveyorOrigin.x, y: conveyor.beltHeight, z: conveyorOrigin.z },
      center: conveyorOrigin,
    },
    floorDrop: {
      x: robotX + (conveyor.width / 2) + robot.clearance * 0.5,
      y: definition.floor.y + box.height / 2,
      z: robot.side === 'near' ? robotZ + 0.2 : -robotZ - 0.2,
    },
    // Stack resting plane is the pallet top (not the floor).
    stackDropOrigin: { ...definition.stackDropOrigin, y: palletTopY },
    stackOrigin: { ...definition.stackDropOrigin, y: palletTopY },
    pallet: {
      center: palletCenter,
      length: palletLength,
      width: palletWidth,
      height: pallet.height,
      topY: palletTopY,
    },
    sourceMachine: {
      // Place so the exit opening sits at the conveyor input.
      position: {
        x: -halfLength,
        y: definition.floor.y,
        z: conveyorOrigin.z,
      },
    },
    wrapMachine: {
      center: wrapCenter,
      bayLength: definition.wrapMachine.bayLength,
      bayWidth: definition.wrapMachine.bayWidth,
      height: definition.wrapMachine.height,
    },
    outbound: {
      liftHeight: definition.outbound.liftHeight,
      durations: {
        approach: definition.outbound.approachDuration,
        insert: definition.outbound.insertDuration,
        lift: definition.outbound.liftDuration,
        transport: definition.outbound.transportDuration,
        place: definition.outbound.placeDuration,
        lower: definition.outbound.lowerDuration,
        release: definition.outbound.releaseDuration,
        withdraw: definition.outbound.withdrawDuration,
        stow: definition.outbound.stowDuration,
        wrap: definition.outbound.wrapDuration,
      },
      workerSpawn: { x: spawnX, y: definition.floor.y, z: palletCenter.z, yaw: workerYaw },
      workerEngage: { x: engageX, y: definition.floor.y, z: palletCenter.z, yaw: workerYaw },
      // Stop at wrap-bay entrance, then roll cargo to bay center.
      workerAtWrap: {
        x: wrapCenter.x - definition.wrapMachine.bayLength / 2 - definition.outbound.engageGap,
        y: definition.floor.y,
        z: wrapCenter.z,
        yaw: workerYaw,
      },
      workerPlace: { x: wrapCenter.x - definition.outbound.engageGap, y: definition.floor.y, z: wrapCenter.z, yaw: workerYaw },
      workerWithdraw: { x: withdrawX, y: definition.floor.y, z: wrapCenter.z, yaw: workerYaw },
      cargoAtStack: { ...palletCenter },
      cargoAtWrap: { x: wrapCenter.x, y: definition.floor.y, z: wrapCenter.z },
    },
    robot: {
      base: { x: robotX, y: definition.floor.y, z: robot.side === 'near' ? robotZ : -robotZ },
      yaw: robot.side === 'near' && robot.facing === 'conveyor' ? Math.PI : 0,
    },
    box: {
      center: {
        x: pickupX,
        y: conveyor.beltHeight + conveyor.beltThickness + box.height / 2 + box.beltClearance,
        z: conveyorOrigin.z,
      },
    },
  };
}
