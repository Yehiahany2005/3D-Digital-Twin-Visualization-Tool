import * as THREE from 'three';
import { StationEnvironment } from '../common/StationEnvironment.js';
import { CASE_PACKING_DEFINITION, CASE_PACKING_STATES } from './CasePackingDefinition.js';
import { createOilStationMaterials } from '../station-1/OilMaterials.js';
import { group } from '../station-1/OilGeometry.js';
import { createCapFactory, createJerryCanFactory } from '../station-1/JerryCan.js';
import { createSensors } from '../station-1/OilSensors.js';
import { createControlPanel } from '../station-1/ControlPanel.js';
import { createStationBase } from '../station-1/StationBase.js';
import { createCardboardCaseFactory, getCardboardMaterials } from './CardboardCase.js';
import { createPickAndPlaceRobot } from './PickAndPlaceRobot.js';
import { createBoxConveyors, createInputConveyor } from './PackingLineEquipment.js';
import { CasePackingCycle } from './CasePackingCycle.js';

const PANEL_REFRESH_SECONDS = 0.1;

const PANEL_STATE_COLORS = {
  EMPTY: '#8fa3ae',
  JERRYCANS_ARRIVE: '#4fb3e8',
  PICK_4_CANS: '#e3a52b',
  PLACE_INTO_BOX: '#e3a52b',
  BOX_COMPLETED: '#c98d16',
  OUTPUT: '#39c46a',
};

function describeCasePacking(status) {
  return {
    rows: [
      ['Input conveyor', status.inputConveyor],
      ['Case conveyor', status.boxConveyor],
      ['Robot', status.robot],
      ['Gripper', status.gripper],
      ['Cans in case', `${status.cansInBox} / 4`],
      ['Cases completed', status.boxesCompleted],
    ],
    bar: { fraction: status.cansInBox / 4, label: `Case fill ${status.cansInBox}/4   ·   Speed ${status.speed}×` },
  };
}

/**
 * Builds the Station 2 hierarchy:
 *
 * CasePackingStation
 * ├── StationBase
 * ├── InputConveyor (InputBelt, LaneDivider, EndStop, InfeedTunnel, jerry cans on the belt)
 * ├── BoxConveyor (BoxInfeedBelt, CaseErectorTunnel, BoxStop, cases at the packing position)
 * ├── OutputConveyor (OutputBelt, CaseTaper, OutputTunnel)
 * ├── PickAndPlaceRobot (GantryFrame, Carriage, VerticalAxis › GripperHead › Gripper_01…04)
 * ├── Sensors (Sensors_Cans, Sensors_Cases)
 * └── ControlPanel
 */
export function buildCasePackingStation(definition = CASE_PACKING_DEFINITION) {
  const materials = createOilStationMaterials();
  const cardboard = getCardboardMaterials(definition.box);
  const root = group(null, 'CasePackingStation');
  root.userData.stationDefinition = definition;
  const { line, input, boxLine, robot: robotDef } = definition;

  const createCap = createCapFactory(definition.can, materials);
  const createCan = createJerryCanFactory(definition.can, materials);
  const createCase = createCardboardCaseFactory(definition.box, cardboard);
  const handleGrip = createCan().root.getObjectByName('Handle grip').position;

  const base = createStationBase({
    materials,
    bounds: { minX: input.start - 0.7, maxX: boxLine.output.end + 0.4, minZ: -2.2, maxZ: 2.2 },
    walkwayZ: 1.45,
  });
  root.add(base.root);

  const inputConveyor = createInputConveyor({ materials, definition });
  root.add(inputConveyor.root);
  const conveyors = createBoxConveyors({ materials, definition, tapeMaterial: cardboard.tape });
  root.add(conveyors.boxRoot, conveyors.outputRoot);

  const pickY = line.beltHeight + handleGrip.y;
  const robot = createPickAndPlaceRobot({
    materials,
    x: robotDef.x,
    columnZ: robotDef.columnZ,
    beamY: robotDef.beamY,
    gripXs: input.stopX.map((x) => x + handleGrip.x),
    homeZ: input.z,
    homeY: pickY + robotDef.travelLift,
  });
  // Robot root sits at z = 0, so carriage/vertical Z values are station-space Z.
  root.add(robot.root);

  const sensorsRoot = group(root, 'Sensors');
  const canSensors = createSensors({
    materials,
    beltHeight: line.beltHeight,
    beltWidth: line.beltWidth,
    canLength: definition.can.length,
    zones: [{ name: 'Sensor_CansInPosition', x: Math.max(...input.stopX) }],
  });
  canSensors.root.name = 'Sensors_Cans';
  canSensors.root.position.z = input.z;
  const boxSensors = createSensors({
    materials,
    beltHeight: line.beltHeight,
    beltWidth: line.beltWidth,
    canLength: definition.box.length,
    zones: [
      { name: 'Sensor_CaseInPosition', x: boxLine.packX - 0.15 },
      { name: 'Sensor_CaseAtTaper', x: boxLine.taperX - 0.45 },
    ],
  });
  boxSensors.root.name = 'Sensors_Cases';
  boxSensors.root.position.z = boxLine.z;
  sensorsRoot.add(canSensors.root, boxSensors.root);

  const controlPanel = createControlPanel({
    materials,
    title: 'STATION 2 · JERRY CAN CASE PACKING',
    describe: describeCasePacking,
    stateColors: PANEL_STATE_COLORS,
  });
  controlPanel.root.position.set(-1.7, 0, 1.75);
  controlPanel.root.rotation.y = 0.35;
  root.add(controlPanel.root);

  root.traverse((object) => {
    if (object.isMesh && object.material?.transparent) object.castShadow = false;
  });

  return {
    root,
    materials,
    input: inputConveyor,
    conveyors,
    robot,
    sensors: { cans: canSensors, boxes: boxSensors },
    controlPanel,
    createCan,
    createCap,
    createCase,
  };
}

/** Station 2 scene controller. Independent from Station 1 and Station 3. */
export class CasePackingStation {
  constructor({ scene, renderer, cameraManager, controls, definition = CASE_PACKING_DEFINITION }) {
    this.scene = scene;
    this.cameraManager = cameraManager;
    this.controls = controls;
    this.definition = definition;
    this.parts = null;
    this.cycle = null;
    this.environment = new StationEnvironment({ scene, renderer });
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
    this.parts = buildCasePackingStation(this.definition);
    const { root } = this.parts;
    const center = new THREE.Box3().setFromObject(root).getCenter(new THREE.Vector3());
    root.position.set(-center.x, 0, -center.z);
    root.visible = false;
    this.scene.add(root);
    this.cycle = new CasePackingCycle({
      definition: this.definition,
      parts: this.parts,
      onUpdate: (cycle) => this.onCycleUpdate?.(cycle),
    });
    this.refreshPanel();
  }

  show() {
    if (!this.parts) this.build();
    this.root.visible = true;
    this.environment.apply();
    this.cameraManager.frameObject(this.root, this.controls);
    this.refreshPanel();
    this.onCycleUpdate?.(this.cycle);
  }

  hide() {
    if (!this.parts) return;
    this.cycle.reset();
    this.root.visible = false;
    this.environment.restore();
  }

  setCycleUpdateHandler(handler) {
    this.onCycleUpdate = handler;
  }

  startCycle() {
    this.cycle?.start();
  }

  resetCycle() {
    this.cycle?.reset();
    this.refreshPanel();
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
    this.panelTimer += delta;
    if (this.panelTimer >= PANEL_REFRESH_SECONDS) this.refreshPanel();
  }

  refreshPanel() {
    this.panelTimer = 0;
    this.parts?.controlPanel.update(this.cycle?.status ?? {});
  }
}

export { CASE_PACKING_STATES };
