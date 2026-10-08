import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { OIL_STATION_DEFINITION, OIL_STATION_STATES, getSlotX } from './OilFillingDefinition.js';
import { createOilStationMaterials } from './OilMaterials.js';
import { group } from './OilGeometry.js';
import { createBeltConveyor, createConveyorTunnel } from './OilConveyor.js';
import { createFillingMachine } from './FillingMachine.js';
import { createCappingMachine } from './CappingMachine.js';
import { createOilTank, createTransferPump } from './OilTank.js';
import { createHoses } from './OilHoses.js';
import { createSensors } from './OilSensors.js';
import { createControlPanel } from './ControlPanel.js';
import { createStationBase } from './StationBase.js';
import { createCapFactory, createJerryCanFactory } from './JerryCan.js';
import { OilFillingCycle } from './OilFillingCycle.js';

const PANEL_REFRESH_SECONDS = 0.1;
const ENVIRONMENT_INTENSITY = 0.55;

/**
 * Builds the complete Station 1 hierarchy from a definition:
 *
 * OilFillingStation
 * ├── StationBase
 * ├── Conveyor (MainConveyor, OutfeedConveyor, InfeedTunnel, OutfeedTunnel)
 * ├── FillingMachine
 * │   └── FillingHead (Nozzle_01 … Nozzle_04)
 * ├── OilTank (+ TransferPump)
 * ├── Hoses
 * ├── Sensors
 * ├── CappingMachine
 * │   └── CappingHead
 * ├── JerryCans
 * └── ControlPanel
 *
 * Everything is procedural; no external models are loaded.
 */
export function buildOilFillingStation(definition = OIL_STATION_DEFINITION) {
  const materials = createOilStationMaterials();
  const { line, positions, conveyor: conveyorLayout, can, filling: fillingDef, capping: cappingDef, tank: tankDef } = definition;
  const root = group(null, 'OilFillingStation');
  root.userData.stationDefinition = definition;

  const createCap = createCapFactory(can, materials);
  const createCan = createJerryCanFactory(can, materials);
  const canReferences = createCan().references;

  // Conveyor sections and tunnels.
  const conveyorGroup = group(root, 'Conveyor');
  const guideHalfGap = can.width / 2 + 0.012;
  const main = createBeltConveyor({ name: 'MainConveyor', ...conveyorLayout.main, beltHeight: line.beltHeight, beltWidth: line.beltWidth, guideHalfGap, materials });
  const outfeed = createBeltConveyor({ name: 'OutfeedConveyor', ...conveyorLayout.outfeed, beltHeight: line.beltHeight, beltWidth: line.beltWidth, guideHalfGap, materials });
  const infeedTunnel = createConveyorTunnel({ name: 'InfeedTunnel', ...conveyorLayout.infeedTunnel, beltHeight: line.beltHeight, beltWidth: line.beltWidth, materials, openSide: 1 });
  const outfeedTunnel = createConveyorTunnel({ name: 'OutfeedTunnel', ...conveyorLayout.outfeedTunnel, beltHeight: line.beltHeight, beltWidth: line.beltWidth, materials, openSide: -1 });
  conveyorGroup.add(main.root, outfeed.root, infeedTunnel.root, outfeedTunnel.root);

  // Filling machine: nozzles line up with the can necks of the filling batch.
  const slotXs = (center) => Array.from({ length: line.cansPerBatch }, (_, index) => getSlotX(center, index, definition) + can.neckOffsetX);
  const tipLowered = line.beltHeight + canReferences.neckTop.y - fillingDef.nozzleInsertion;
  const filling = createFillingMachine({
    materials,
    centerX: positions.filling + can.neckOffsetX,
    nozzleXs: slotXs(positions.filling),
    tipLowered,
    stroke: fillingDef.stroke,
  });
  root.add(filling.root);

  const capping = createCappingMachine({
    materials,
    centerX: positions.capping + can.neckOffsetX,
    chuckXs: slotXs(positions.capping),
    capSeatY: line.beltHeight + canReferences.capSeat.y,
    stroke: cappingDef.stroke,
    createCap,
  });
  root.add(capping.root);

  // Supply: tank → transfer pump → riser into the filler cabinet.
  const tank = createOilTank({ materials, ...tankDef });
  tank.root.position.set(tankDef.position.x, 0, tankDef.position.z);
  const pump = createTransferPump({ materials });
  const riserX = filling.root.position.x + filling.anchors.rearInlet.position.x;
  pump.root.position.set(riserX, 0, tankDef.position.z);
  tank.root.add(pump.root);
  pump.root.position.sub(tank.root.position);
  root.add(tank.root);

  const hoses = createHoses({ materials });
  root.add(hoses.root);
  const outlet = tank.references.outlet.clone().add(tank.root.position);
  const suction = pump.references.suction.clone().add(new THREE.Vector3(riserX, 0, tankDef.position.z));
  const discharge = pump.references.discharge.clone().add(new THREE.Vector3(riserX, 0, tankDef.position.z));
  const inlet = filling.anchors.rearInlet.position.clone().add(filling.root.position);
  hoses.addRigid('SuctionLine', [
    outlet.toArray(),
    [outlet.x, suction.y, outlet.z],
    suction.toArray(),
  ], 0.03, materials.stainless, { flanges: [[suction.x - 0.02, suction.y, suction.z, 'x']] });
  hoses.addRigid('ProductRiser', [
    discharge.toArray(),
    [discharge.x, inlet.y, discharge.z],
    inlet.toArray(),
  ], 0.026, materials.stainless, { flanges: [[discharge.x, discharge.y + 0.02, discharge.z], [inlet.x, inlet.y, inlet.z - 0.02, 'z']] });
  hoses.addValve('SuctionValve', [(outlet.x + suction.x) / 2, suction.y, suction.z], 'z');
  hoses.addValve('DischargeValve', [discharge.x, 0.95, discharge.z], 'y', 0.03);
  hoses.addGauge('DischargePressureGauge', [discharge.x, 1.45, discharge.z + 0.03]);
  const productHose = hoses.addFlexible('ProductHose', filling.anchors.productBulkhead, filling.anchors.productInlet, {
    radius: 0.019,
    sag: [-0.2, 0, 0],
    startTangent: [0, -0.14, 0],
    endTangent: [-0.14, 0, 0],
  });
  const airHose = hoses.addFlexible('PneumaticLine', filling.anchors.airBulkhead, filling.anchors.airInlet, {
    radius: 0.007,
    material: materials.airLine,
    sag: [0.16, 0, 0],
    startTangent: [0, -0.1, 0],
    endTangent: [0, 0.1, 0],
  });

  // Photo-eyes at the lead slot of each process position + tank level transmitter.
  const sensors = createSensors({
    materials,
    beltHeight: line.beltHeight,
    beltWidth: line.beltWidth,
    canLength: can.length,
    tankLevelMount: tank.references.levelSensorMount.clone().add(tank.root.position),
    zones: [
      { name: 'Sensor_Infeed', x: getSlotX(positions.staging, line.cansPerBatch - 1, definition) },
      { name: 'Sensor_Filling', x: getSlotX(positions.filling, line.cansPerBatch - 1, definition) },
      { name: 'Sensor_Capping', x: getSlotX(positions.capping, line.cansPerBatch - 1, definition) },
      { name: 'Sensor_Outfeed', x: getSlotX(positions.outfeed, line.cansPerBatch - 1, definition) },
    ],
  });
  root.add(sensors.root);

  const canGroup = group(root, 'JerryCans');

  const controlPanel = createControlPanel({ materials });
  controlPanel.root.position.set(positions.staging - 0.5, 0, 1.35);
  controlPanel.root.rotation.y = 0.35;
  root.add(controlPanel.root);

  const base = createStationBase({
    materials,
    bounds: { minX: conveyorLayout.main.start - 0.6, maxX: conveyorLayout.outfeed.end + 0.4, minZ: -2.4, maxZ: 2.0 },
  });
  root.add(base.root);
  // Keep StationBase first in the outliner.
  root.children.splice(root.children.indexOf(base.root), 1);
  root.children.unshift(base.root);

  root.traverse((object) => {
    if (object.isMesh && object.material?.transparent) object.castShadow = false;
  });

  return {
    root,
    materials,
    conveyors: { main, outfeed },
    filling,
    capping,
    tank,
    pump,
    hoses: Object.assign(hoses, { productHose, airHose }),
    sensors,
    controlPanel,
    canGroup,
    createCan,
    createCap,
  };
}

/**
 * Station 1 scene controller: owns the procedural station, its process cycle,
 * environment lighting and UI status. Independent from the robot StationScene.
 */
export class OilFillingStation {
  constructor({ scene, renderer, cameraManager, controls, definition = OIL_STATION_DEFINITION }) {
    this.scene = scene;
    this.renderer = renderer;
    this.cameraManager = cameraManager;
    this.controls = controls;
    this.definition = definition;
    this.parts = null;
    this.cycle = null;
    this.environment = null;
    this.previousEnvironment = null;
    this.panelTimer = 0;
    this.onCycleUpdate = null;
  }

  get root() {
    return this.parts?.root ?? null;
  }

  get visible() {
    return Boolean(this.root?.visible);
  }

  build() {
    this.parts = buildOilFillingStation(this.definition);
    const { root } = this.parts;
    // Centre the cell on the world origin so shadows and framing stay tight.
    const center = new THREE.Box3().setFromObject(root).getCenter(new THREE.Vector3());
    root.position.set(-center.x, 0, -center.z);
    root.visible = false;
    this.scene.add(root);
    this.cycle = new OilFillingCycle({
      definition: this.definition,
      canGroup: this.parts.canGroup,
      createCan: this.parts.createCan,
      conveyors: this.parts.conveyors,
      filling: this.parts.filling,
      capping: this.parts.capping,
      sensors: this.parts.sensors,
      tank: this.parts.tank,
      onUpdate: (cycle) => this.onCycleUpdate?.(cycle),
    });
    this.root.updateMatrixWorld(true);
    this.parts.hoses.update();
    this.refreshIndicators(true);
  }

  show() {
    if (!this.parts) this.build();
    this.root.visible = true;
    this.applyEnvironment();
    this.cameraManager.frameObject(this.root, this.controls);
    this.refreshIndicators(true);
    this.onCycleUpdate?.(this.cycle);
  }

  hide() {
    if (!this.parts) return;
    this.cycle.reset();
    this.root.visible = false;
    this.restoreEnvironment();
  }

  setCycleUpdateHandler(handler) {
    this.onCycleUpdate = handler;
  }

  startCycle() {
    this.cycle?.start();
    this.refreshIndicators(true);
  }

  resetCycle() {
    this.cycle?.reset();
    this.parts?.hoses.update();
    this.refreshIndicators(true);
  }

  setCycleSpeed(multiplier) {
    this.cycle?.setSpeed(multiplier);
  }

  getBounds() {
    return this.root ? new THREE.Box3().setFromObject(this.root) : null;
  }

  update(delta) {
    if (!this.visible) return;
    this.cycle.update(delta);
    this.parts.hoses.update();
    this.panelTimer += delta;
    this.refreshIndicators(this.panelTimer >= PANEL_REFRESH_SECONDS);
  }

  refreshIndicators(refreshPanel) {
    if (!this.cycle) return;
    const running = this.cycle.running;
    this.parts.filling.setStackLight({ green: running, amber: !running, red: false });
    if (!refreshPanel) return;
    this.panelTimer = 0;
    this.parts.controlPanel.update(this.cycle.status);
  }

  applyEnvironment() {
    if (!this.environment && this.renderer) {
      const generator = new THREE.PMREMGenerator(this.renderer);
      this.environment = generator.fromScene(new RoomEnvironment(), 0.04).texture;
      generator.dispose();
    }
    if (!this.environment || this.previousEnvironment) return;
    this.previousEnvironment = { map: this.scene.environment, intensity: this.scene.environmentIntensity };
    this.scene.environment = this.environment;
    this.scene.environmentIntensity = ENVIRONMENT_INTENSITY;
  }

  restoreEnvironment() {
    if (!this.previousEnvironment) return;
    this.scene.environment = this.previousEnvironment.map;
    this.scene.environmentIntensity = this.previousEnvironment.intensity;
    this.previousEnvironment = null;
  }
}

export { OIL_STATION_STATES };
