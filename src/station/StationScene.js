import * as THREE from 'three';
import { createProceduralBox } from './ProceduralBox.js';
import { createProceduralBoxSourceMachine } from './ProceduralBoxSourceMachine.js';
import { createProceduralConveyor } from './ProceduralConveyor.js';
import { createProceduralPallet } from './ProceduralPallet.js';
import { createAssetWrapMachine } from './AssetWrapMachine.js';
import { getStackFootprint, resolveStationLayout, STATION_DEFINITION } from './StationDefinition.js';
import { createVacuumGripper, StationCycle } from './StationCycle.js';

const POINT_COLORS = { input: 0x50c7e8, pickup: 0xffc857, output: 0x65d68b, drop: 0xff9f43, beltSurface: 0xffffff, center: 0xb07cff, base: 0xff5f56, tcp: 0xff78c8, bottom: 0xffffff, grasp: 0xff78c8 };

function addDebugFrame(parent, references, visible) {
  const debug = new THREE.Group();
  debug.name = 'ReferencePointsAndAxes';
  Object.entries(references).forEach(([name, point]) => {
    const marker = new THREE.Mesh(
      new THREE.SphereGeometry(0.045, 12, 8),
      new THREE.MeshBasicMaterial({ color: POINT_COLORS[name] || 0xffffff }),
    );
    marker.name = `Reference: ${name}`;
    marker.position.copy(point);
    debug.add(marker);
  });
  const axes = new THREE.AxesHelper(0.45);
  axes.name = 'Local reference axes';
  debug.add(axes);
  debug.visible = visible;
  parent.add(debug);
  return debug;
}

export class StationScene {
  constructor({ scene, cameraManager, controls, floor }) {
    this.scene = scene;
    this.cameraManager = cameraManager;
    this.controls = controls;
    this.floor = floor;
    this.root = new THREE.Group();
    this.root.name = 'StationScene';
    this.root.visible = false;
    this.scene.add(this.root);
    this.debug = false;
    this.robot = null;
    this.robotDebug = null;
    this.cycle = null;
    this.loading = false;
  }

  async show(asset) {
    if (!asset?.model || this.loading) return;
    this.loading = true;
    try {
      this.root.children.slice().forEach((child) => {
        if (child !== asset.model) this.root.remove(child);
      });
      this.hideAsset(asset);
      this.robot = asset.model;
      const robotSize = new THREE.Box3().setFromObject(asset.model).getSize(new THREE.Vector3());
      const layout = resolveStationLayout(STATION_DEFINITION, robotSize);
      const conveyor = createProceduralConveyor(STATION_DEFINITION.conveyor);
      conveyor.root.position.set(layout.conveyorOrigin.x, layout.conveyorOrigin.y, layout.conveyorOrigin.z);
      const conveyorDebug = addDebugFrame(conveyor.root, conveyor.references, this.debug);

      const sourceMachine = createProceduralBoxSourceMachine({
        ...STATION_DEFINITION.sourceMachine,
        beltHeight: STATION_DEFINITION.conveyor.beltHeight,
        boxHeight: STATION_DEFINITION.box.height,
        openingWidth: STATION_DEFINITION.box.width + 0.22,
        openingHeight: STATION_DEFINITION.box.height + 0.16,
      });
      sourceMachine.root.position.set(
        layout.sourceMachine.position.x,
        layout.sourceMachine.position.y,
        layout.sourceMachine.position.z,
      );

      const pallet = createProceduralPallet({
        length: layout.pallet.length,
        width: layout.pallet.width,
        height: layout.pallet.height,
      });
      pallet.root.position.set(layout.pallet.center.x, layout.pallet.center.y, layout.pallet.center.z);

      const stackHeight = STATION_DEFINITION.stack.layers * STATION_DEFINITION.box.height;
      const footprint = getStackFootprint(STATION_DEFINITION);
      const wrapMachine = await createAssetWrapMachine({
        stackLength: footprint.length,
        stackWidth: footprint.width,
        stackHeight,
        palletHeight: layout.pallet.height,
        filmClearance: 0.012,
      });
      wrapMachine.root.position.set(layout.wrapMachine.center.x, layout.wrapMachine.center.y, layout.wrapMachine.center.z);

      // Keep layout bay sizes in sync with the loaded asset for approach poses.
      layout.wrapMachine.bayLength = wrapMachine.bayLength;
      layout.wrapMachine.bayWidth = wrapMachine.bayWidth;
      layout.wrapMachine.height = wrapMachine.height;
      layout.wrapMachine.deckHeight = wrapMachine.deckHeight;
      layout.outbound.workerAtWrap = {
        x: layout.wrapMachine.center.x - wrapMachine.bayLength * 0.35 - STATION_DEFINITION.outbound.engageGap,
        y: STATION_DEFINITION.floor.y,
        z: layout.wrapMachine.center.z,
        yaw: layout.outbound.workerAtWrap.yaw,
      };

      asset.model.position.set(layout.robot.base.x, layout.robot.base.y, layout.robot.base.z);
      asset.model.rotation.set(0, layout.robot.yaw, 0);
      this.root.add(conveyor.root, sourceMachine.root, pallet.root, wrapMachine.root, asset.model);
      asset.rig.setValues({
        'base.x': layout.robot.base.x * 1000,
        'base.y': layout.robot.base.y * 1000,
        'base.z': layout.robot.base.z * 1000,
        'base.yaw': THREE.MathUtils.radToDeg(layout.robot.yaw),
      });
      const tcpJoint = asset.rig?.jointsById.get('axis6')?.group;
      if (!tcpJoint) throw new Error('ABB station requires the axis6 rig joint to attach the end-effector.');
      const gripper = createVacuumGripper();
      tcpJoint.add(gripper);
      const boxFactory = () => {
        const box = createProceduralBox(STATION_DEFINITION.box);
        box.root.userData.debugGroup = addDebugFrame(box.root, box.references, this.debug);
        return box;
      };
      let stackDebug;
      const cycle = new StationCycle({
        stationRoot: this.root,
        robot: asset.model,
        rig: asset.rig,
        boxFactory,
        boxDefinition: STATION_DEFINITION.box,
        conveyor,
        gripper,
        layout,
        pallet,
        wrapMachine,
        rootWorldMatrix: asset.model.matrixWorld,
        onUpdate: (state) => {
          if (stackDebug && state.stackTarget) stackDebug.getObjectByName('Reference: stackTarget').position.copy(state.stackTarget);
          this.onCycleUpdate?.(state);
        },
      });
      this.cycle = cycle;
      cycle.createBoxAtInput();
      stackDebug = addDebugFrame(this.root, {
        stackDropOrigin: new THREE.Vector3(layout.stackDropOrigin.x, layout.stackDropOrigin.y, layout.stackDropOrigin.z),
        stackTarget: new THREE.Vector3(layout.stackDropOrigin.x, layout.stackDropOrigin.y, layout.stackDropOrigin.z),
      }, this.debug);
      const robotReferences = {
        base: new THREE.Vector3(0, 0, 0),
        tcp: asset.model.worldToLocal(tcpJoint.getWorldPosition(new THREE.Vector3())),
      };
      this.robotDebug = addDebugFrame(asset.model, robotReferences, this.debug);
      this.root.userData.stationLayout = layout;
      this.root.userData.references = {
        conveyor: conveyor.references,
        box: cycle.box.references,
        robot: robotReferences,
        floorDrop: new THREE.Vector3(layout.floorDrop.x, layout.floorDrop.y, layout.floorDrop.z),
        stackDropOrigin: new THREE.Vector3(layout.stackDropOrigin.x, layout.stackDropOrigin.y, layout.stackDropOrigin.z),
        stackOrigin: new THREE.Vector3(layout.stackOrigin.x, layout.stackOrigin.y, layout.stackOrigin.z),
      };
      this.root.userData.debugGroups = [conveyorDebug, this.robotDebug, stackDebug];
      this.root.userData.gripper = gripper;
      this.root.visible = true;
      this.floor.visible = true;
      this.cameraManager.frameObject(this.root, this.controls);
    } finally {
      this.loading = false;
    }
  }

  hideAsset(asset) {
    if (asset?.model?.parent === this.root) this.root.remove(asset.model);
  }

  setDebug(enabled) {
    this.debug = enabled;
    this.root.userData.debugGroups?.forEach((group) => { group.visible = enabled; });
    this.root.traverse((object) => {
      if (object.name === 'ReferencePointsAndAxes') object.visible = enabled;
    });
  }

  setCycleUpdateHandler(handler) {
    this.onCycleUpdate = handler;
  }

  startCycle() {
    this.cycle?.start();
  }

  resetCycle() {
    this.cycle?.reset();
  }

  setCycleSpeed(multiplier) {
    this.cycle?.setSpeed(multiplier);
  }

  update(delta) {
    this.cycle?.update(delta);
  }

  hide() {
    this.root.visible = false;
    const robot = this.robot;
    this.cycle?.reset();
    this.cycle = null;
    if (robot) robot.parent?.remove(robot);
    return robot;
  }
}
