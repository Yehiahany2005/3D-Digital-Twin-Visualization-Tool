import * as THREE from 'three';
import { createProceduralWorker } from './ProceduralWorker.js';

const GRIP_TOLERANCE = 0.035;
const CONVEYOR_SPEED = 0.7;
const TOOL_OFFSET = new THREE.Vector3(0, -0.275, 0);

function lerpPose(from, to, progress) {
  return Object.fromEntries(Object.keys(to).map((id) => [
    id,
    THREE.MathUtils.lerp(from[id] ?? 0, to[id], progress),
  ]));
}

function lerpWorkerPose(from, to, progress) {
  return {
    x: THREE.MathUtils.lerp(from.x, to.x, progress),
    y: THREE.MathUtils.lerp(from.y, to.y, progress),
    z: THREE.MathUtils.lerp(from.z, to.z, progress),
    yaw: THREE.MathUtils.lerp(from.yaw, to.yaw, progress),
  };
}

export function createVacuumGripper() {
  const root = new THREE.Group();
  root.name = 'ProceduralVacuumGripper';
  const metal = new THREE.MeshStandardMaterial({ color: 0x87949b, metalness: 0.88, roughness: 0.24 });
  const rubber = new THREE.MeshStandardMaterial({ color: 0x161a1c, metalness: 0.05, roughness: 0.88 });
  const indicatorMaterial = new THREE.MeshStandardMaterial({ color: 0x65727b, emissive: 0x101820, roughness: 0.32 });
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.08, 0.14, 24), metal);
  body.name = 'Vacuum mounting body';
  body.castShadow = true;
  root.add(body);
  const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.027, 0.027, 0.17, 16), metal);
  stem.name = 'Vacuum mounting stem';
  stem.position.y = -0.14;
  stem.castShadow = true;
  root.add(stem);
  const bellows = new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.105, 0.085, 24), rubber);
  bellows.name = 'Vacuum bellows';
  bellows.position.y = -0.245;
  bellows.castShadow = true;
  root.add(bellows);
  const cup = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.095, 0.055, 24), rubber);
  cup.name = 'Vacuum suction cup';
  cup.position.y = -0.305;
  cup.castShadow = true;
  root.add(cup);
  const indicator = new THREE.Mesh(new THREE.SphereGeometry(0.018, 12, 8), indicatorMaterial);
  indicator.name = 'Vacuum state indicator';
  indicator.position.set(0, 0.045, 0);
  root.add(indicator);
  root.userData.suctionPoint = TOOL_OFFSET.clone();
  root.userData.setState = (state) => {
    const color = {
      OPEN: 0x65727b,
      APPROACHING: 0xffc857,
      GRIPPING: 0x65d68b,
      HOLDING: 0x35c6e8,
      RELEASING: 0x65d68b,
    }[state] || 0x65727b;
    indicator.material.color.setHex(color);
    indicator.material.emissive.copy(indicator.material.color).multiplyScalar(0.22);
  };
  root.userData.setState('OPEN');
  return root;
}

export class StationCycle {
  constructor({ stationRoot, robot, rig, boxFactory, boxDefinition, conveyor, gripper, layout, rootWorldMatrix, onUpdate, pallet, wrapMachine }) {
    this.stationRoot = stationRoot;
    this.robot = robot;
    this.rig = rig;
    this.boxFactory = boxFactory;
    this.boxDefinition = boxDefinition;
    this.conveyor = conveyor;
    this.gripper = gripper;
    this.layout = layout;
    this.onUpdate = onUpdate;
    this.pallet = pallet;
    this.wrapMachine = wrapMachine;
    this.state = 'IDLE';
    this.conveyorState = 'STOPPED';
    this.robotState = 'HOME';
    this.boxState = 'ON BELT';
    this.gripperState = 'OPEN';
    this.speedMultiplier = 1;
    this.distance = Infinity;
    this.box = null;
    this.floorBoxes = [];
    this.boxNumber = 0;
    this.stackTarget = null;
    this.positionError = Infinity;
    this.bottomHeight = 0;
    this.rotation = new THREE.Euler();
    this.attached = false;
    this.attachedOffset = new THREE.Vector3();
    this.attachedQuaternion = new THREE.Quaternion();
    this.poseFrom = null;
    this.poseTo = null;
    this.elapsed = 0;
    this.duration = 0;
    this.home = this.getJointPose();
    this.rootWorldMatrix = rootWorldMatrix?.clone();
    this.targets = null;
    this.boxGraspLocal = new THREE.Vector3(0, 0, 0);
    this.worker = null;
    this.cargo = null;
    this.outboundActive = false;
    this.outboundTween = null;
    this.logReferences();
  }

  getJointPose() {
    return Object.fromEntries(this.rig.joints
      .filter((joint) => !joint.driven)
      .map((joint) => [joint.id, joint.value]));
  }

  assertRootTransform(expectedPosition, phase) {
    this.robot.updateMatrixWorld(true);
    const actualPosition = this.robot.getWorldPosition(new THREE.Vector3());
    const positionChanged = actualPosition.distanceTo(expectedPosition) > 1e-7;
    if (positionChanged) {
      console.error(`Station robot root changed during ${phase}; restoring the station transform.`, {
        expectedPosition: expectedPosition.toArray(),
        actualPosition: actualPosition.toArray(),
      });
      this.robot.position.copy(this.robot.parent.worldToLocal(expectedPosition.clone()));
      this.robot.updateMatrixWorld(true);
    }
  }

  logReferences() {
    const refs = this.layout;
    console.info('Station cycle references', {
      conveyorInput: refs.conveyor.input,
      conveyorPickup: refs.conveyor.pickup,
      conveyorDirection: this.getConveyorDirection().toArray(),
      beltSurfaceHeight: refs.conveyor.beltSurface.y,
      robotBase: refs.robot.base,
      floorDrop: refs.floorDrop,
      stackDropOrigin: refs.stackDropOrigin,
    });
  }

  getConveyorDirection() {
    return new THREE.Vector3(
      this.layout.conveyor.pickup.x - this.layout.conveyor.input.x,
      this.layout.conveyor.pickup.y - this.layout.conveyor.input.y,
      this.layout.conveyor.pickup.z - this.layout.conveyor.input.z,
    ).normalize();
  }

  get tcpGroup() {
    return this.rig.jointsById.get('axis6')?.group;
  }

  getSuctionWorld() {
    this.robot.updateMatrixWorld(true);
    return this.gripper.localToWorld(this.gripper.userData.suctionPoint.clone());
  }

  getBoxGraspWorld() {
    return this.box.root.localToWorld(this.box.references.grasp.clone());
  }

  getBoxCenter() {
    return this.box.root.getWorldPosition(new THREE.Vector3());
  }

  getBeltBoxCenterY() {
    return this.layout.conveyor.beltSurface.y + this.boxDefinition.height / 2 + this.boxDefinition.beltClearance;
  }

  createBoxAtInput() {
    if (this.box) return;
    this.box = this.boxFactory();
    this.boxGraspLocal.copy(this.box.references.grasp);
    const input = this.layout.conveyor.input;
    this.box.root.position.set(input.x, this.getBeltBoxCenterY(), input.z);
    this.box.root.rotation.set(0, 0, 0);
    this.stationRoot.add(this.box.root);
    this.boxState = 'ON BELT';
    this.distance = this.getSuctionWorld().distanceTo(this.getBoxGraspWorld());
    console.info('Station cycle physical references', {
      robotTcp: this.tcpGroup?.getWorldPosition(new THREE.Vector3()).toArray(),
      boxGrasp: this.getBoxGraspWorld().toArray(),
      floorDrop: [this.layout.floorDrop.x, this.layout.floorDrop.y, this.layout.floorDrop.z],
    });
    this.onUpdate?.(this);
  }

  getFloorDropGrasp() {
    return new THREE.Vector3(
      this.layout.floorDrop.x,
      this.layout.floorDrop.y + this.boxGraspLocal.y,
      this.layout.floorDrop.z,
    );
  }

  getStackTarget(index) {
    const { columns, rows, spacing } = this.layout.stack;
    const perLayer = columns * rows;
    const layer = Math.floor(index / perLayer);
    const layerIndex = index % perLayer;
    const column = layerIndex % columns;
    const row = Math.floor(layerIndex / columns);
    return new THREE.Vector3(
      this.layout.stackDropOrigin.x + column * (this.boxDefinition.length + spacing),
      this.layout.stackDropOrigin.y + layer * this.boxDefinition.height + this.boxDefinition.height / 2,
      this.layout.stackDropOrigin.z + row * (this.boxDefinition.width + spacing),
    );
  }

  setSpeed(multiplier) {
    if (![1, 2, 10].includes(multiplier)) throw new Error(`Unsupported station speed: ${multiplier}`);
    this.speedMultiplier = multiplier;
  }

  animateClaw(from, to, duration, state) {
    this.gripper.userData.motion = { from, to, duration, elapsed: 0 };
    this.beginHold(state, duration, { conveyor: 'STOPPED', robot: this.robotState, box: this.boxState, gripper: state });
  }

  getFlangeTarget(targetPoint) {
    const quaternion = this.gripper.getWorldQuaternion(new THREE.Quaternion());
    return targetPoint.clone().sub(this.gripper.userData.suctionPoint.clone().applyQuaternion(quaternion));
  }

  solveTarget(targetPoint, seed = this.rig.getPose()) {
    const ids = this.rig.joints.filter((joint) => !joint.driven).map((joint) => joint.id);
    const pose = Object.fromEntries(ids.map((id) => [id, seed[id] ?? this.rig.getValue(id)]));
    for (let iteration = 0; iteration < 120; iteration += 1) {
      this.rig.setValues(pose);
      const current = this.getSuctionWorld();
      const error = targetPoint.clone().sub(current);
      if (error.length() < 0.006) break;
      const columns = ids.map((id) => {
        this.rig.setValues({ ...pose, [id]: pose[id] + 0.5 });
        const displaced = this.getSuctionWorld().sub(current)
          .multiplyScalar(1 / THREE.MathUtils.degToRad(0.5));
        this.rig.setValues(pose);
        return displaced;
      });
      const damping = 0.018;
      const jjt = new THREE.Matrix3().set(
        damping, 0, 0,
        0, damping, 0,
        0, 0, damping,
      );
      columns.forEach((column) => {
        jjt.elements[0] += column.x * column.x;
        jjt.elements[1] += column.x * column.y;
        jjt.elements[2] += column.x * column.z;
        jjt.elements[3] += column.y * column.x;
        jjt.elements[4] += column.y * column.y;
        jjt.elements[5] += column.y * column.z;
        jjt.elements[6] += column.z * column.x;
        jjt.elements[7] += column.z * column.y;
        jjt.elements[8] += column.z * column.z;
      });
      const correction = error.applyMatrix3(jjt.invert());
      ids.forEach((id, index) => {
        const delta = THREE.MathUtils.clamp(columns[index].dot(correction), -0.12, 0.12);
        pose[id] = this.rig.clamp(this.rig.jointsById.get(id), pose[id] + THREE.MathUtils.radToDeg(delta));
      });
    }
    this.rig.setValues(pose);
    return pose;
  }

  prepareTargets() {
    const grasp = this.getBoxGraspWorld();
    const robotBase = this.rig.root.localToWorld(new THREE.Vector3());
    const sideDirection = grasp.clone().sub(robotBase);
    sideDirection.y = 0;
    sideDirection.normalize();
    const approach = grasp.clone().addScaledVector(sideDirection, -0.28);
    approach.y += 0.34;
    const lift = grasp.clone();
    lift.y += 0.52;
    this.stackTarget = this.getStackTarget(this.boxNumber);
    this.validateStackTarget(this.stackTarget);
    const stackGrasp = this.stackTarget.clone().add(this.boxGraspLocal);
    const stackCarry = stackGrasp.clone();
    stackCarry.y += 0.42;
    const approachPose = this.solveTarget(approach);
    const pickupPose = this.solveTarget(grasp);
    const liftPose = this.solveTarget(lift);
    const stackCarryPose = this.solveTarget(stackCarry, this.home);
    const stackLowerPose = this.solveTarget(stackGrasp);
    if (this.getSuctionWorld().distanceTo(stackGrasp) > 0.01) {
      this.solveTarget(stackGrasp, stackLowerPose);
    }
    this.targets = {
      approach: approachPose,
      pickup: pickupPose,
      lift: liftPose,
      stackCarry: stackCarryPose,
      stackLower: this.getJointPose(),
    };
    this.rig.setValues(this.home);
  }

  validateStackTarget(target) {
    const boxBounds = new THREE.Box3(
      target.clone().sub(new THREE.Vector3(this.boxDefinition.length / 2, this.boxDefinition.height / 2, this.boxDefinition.width / 2)),
      target.clone().add(new THREE.Vector3(this.boxDefinition.length / 2, this.boxDefinition.height / 2, this.boxDefinition.width / 2)),
    );
    const conveyorBounds = new THREE.Box3().setFromObject(this.conveyor.root);
    const intersectsConveyor = boxBounds.intersectsBox(conveyorBounds);
    const targetBottom = this.layout.stackDropOrigin.y + Math.floor(this.boxNumber / (this.layout.stack.columns * this.layout.stack.rows)) * this.boxDefinition.height;
    const onFloor = Math.abs(target.y - targetBottom - this.boxDefinition.height / 2) < 1e-6;
    if (intersectsConveyor || !onFloor) {
      throw new Error(`Invalid stack target ${this.boxNumber + 1}: intersectsConveyor=${intersectsConveyor}, onFloor=${onFloor}`);
    }
  }

  setState(state, { conveyor = this.conveyorState, robot = this.robotState, box = this.boxState, gripper = this.gripperState } = {}) {
    this.state = state;
    this.conveyorState = conveyor;
    this.robotState = robot;
    this.boxState = box;
    this.gripperState = gripper;
    this.gripper.userData.setState(gripper);
    this.onUpdate?.(this);
  }

  beginMove(state, target, duration, options = {}) {
    this.poseFrom = this.getJointPose();
    this.poseTo = target;
    this.elapsed = 0;
    this.duration = duration;
    this.setState(state, options);
  }

  start() {
    if (this.state !== 'IDLE' && this.state !== 'COMPLETE') return;
    this.robot.updateMatrixWorld(true);
    const rootBeforeStart = this.robot.getWorldPosition(new THREE.Vector3());
    this.reset();
    this.createBoxAtInput();
    this.setState('SPAWN_BOX', { conveyor: 'STOPPED', robot: 'HOME', box: 'ON BELT', gripper: 'OPEN' });
    this.beginHold('SPAWN_BOX', 0.2, { conveyor: 'STOPPED', robot: 'HOME', box: 'ON BELT', gripper: 'OPEN' });
    this.assertRootTransform(rootBeforeStart, 'START initialization');
  }

  beginHold(state, duration, options) {
    this.poseFrom = this.getJointPose();
    this.poseTo = this.poseFrom;
    this.elapsed = 0;
    this.duration = duration;
    this.setState(state, options);
  }

  reset() {
    this.resetOutbound();
    this.poseTo = null;
    this.attached = false;
    this.rig.setValues(this.home);
    if (this.box) {
      this.box.root.removeFromParent();
      this.box = null;
    }
    this.floorBoxes.forEach((box) => box.root.removeFromParent());
    this.floorBoxes = [];
    this.boxNumber = 0;
    this.stackTarget = null;
    this.setState('IDLE', { conveyor: 'STOPPED', robot: 'HOME', box: 'ON BELT', gripper: 'OPEN' });
  }

  resetOutbound() {
    this.outboundTween = null;
    this.outboundActive = false;
    if (this.cargo) {
      if (this.pallet?.root) {
        this.stationRoot.attach(this.pallet.root);
        this.pallet.root.position.set(
          this.layout.pallet.center.x,
          this.layout.pallet.center.y,
          this.layout.pallet.center.z,
        );
        this.pallet.root.rotation.set(0, 0, 0);
      }
      this.floorBoxes.forEach((box) => {
        if (box.root.parent === this.cargo) this.stationRoot.attach(box.root);
      });
      this.cargo.removeFromParent();
      this.cargo = null;
    }
    if (this.worker) {
      this.worker.root.removeFromParent();
      this.worker = null;
    }
    this.wrapMachine?.resetWrap();
  }

  getWorkerPose() {
    return {
      x: this.worker.root.position.x,
      y: this.worker.root.position.y,
      z: this.worker.root.position.z,
      yaw: this.worker.root.rotation.y,
    };
  }

  applyWorkerPose(pose) {
    this.worker.root.position.set(pose.x, pose.y, pose.z);
    this.worker.root.rotation.set(0, pose.yaw, 0);
  }

  buildCargo() {
    if (this.cargo) return;
    this.cargo = new THREE.Group();
    this.cargo.name = 'PalletCargo';
    this.stationRoot.add(this.cargo);
    this.cargo.attach(this.pallet.root);
    this.floorBoxes.forEach((box) => this.cargo.attach(box.root));
  }

  beginOutboundTween(state, tween, duration, status = {}) {
    this.outboundTween = tween;
    this.elapsed = 0;
    this.duration = duration;
    this.poseTo = null;
    this.setState(state, {
      conveyor: 'STOPPED',
      robot: 'HOME',
      box: status.box ?? 'ON PALLET',
      gripper: 'OPEN',
      ...status,
    });
  }

  startOutbound() {
    this.outboundActive = true;
    this.poseTo = null;
    this.worker = createProceduralWorker();
    const spawn = this.layout.outbound.workerSpawn;
    this.worker.root.position.set(spawn.x, spawn.y, spawn.z);
    this.worker.root.rotation.set(0, spawn.yaw, 0);
    this.worker.setForkHeight(0.045);
    this.stationRoot.add(this.worker.root);
    this.buildCargo();
    this.beginOutboundTween('WORKER_SPAWN', { kind: 'hold' }, 0.35, { box: 'ON PALLET' });
  }

  attachCargoToJack() {
    this.worker.cargoAnchor.attach(this.cargo);
  }

  detachCargoToStation() {
    this.stationRoot.attach(this.cargo);
  }

  applyOutboundTween(progress) {
    const tween = this.outboundTween;
    if (!tween || tween.kind === 'hold') return;
    if (tween.kind === 'worker') {
      this.applyWorkerPose(lerpWorkerPose(tween.from, tween.to, progress));
    } else if (tween.kind === 'fork') {
      this.worker.setForkHeight(THREE.MathUtils.lerp(tween.from, tween.to, progress));
    } else if (tween.kind === 'wrap') {
      this.wrapMachine.setWrapProgress(progress);
    }
  }

  finishOutboundStep() {
    const finished = this.state;
    const durations = this.layout.outbound.durations;
    const lift = this.layout.outbound.liftHeight;
    this.outboundTween = null;

    if (finished === 'WORKER_SPAWN') {
      this.beginOutboundTween('WORKER_APPROACH', {
        kind: 'worker',
        from: this.getWorkerPose(),
        to: { ...this.layout.outbound.workerEngage },
      }, durations.approach);
    } else if (finished === 'WORKER_APPROACH') {
      this.applyWorkerPose(this.layout.outbound.workerEngage);
      // Brief settle with forks under the pallet before lifting.
      this.beginOutboundTween('JACK_INSERT', { kind: 'hold' }, Math.max(0.4, durations.insert * 0.45));
    } else if (finished === 'JACK_INSERT') {
      this.attachCargoToJack();
      this.beginOutboundTween('JACK_LIFT', {
        kind: 'fork',
        from: this.worker.getForkHeight(),
        to: lift,
      }, durations.lift);
    } else if (finished === 'JACK_LIFT') {
      this.worker.setForkHeight(lift);
      this.beginOutboundTween('TRANSPORT_PALLET', {
        kind: 'worker',
        from: this.getWorkerPose(),
        to: { ...this.layout.outbound.workerAtWrap },
      }, durations.transport, { box: 'IN TRANSIT' });
    } else if (finished === 'TRANSPORT_PALLET') {
      this.applyWorkerPose(this.layout.outbound.workerAtWrap);
      this.beginOutboundTween('PLACE_IN_WRAP', {
        kind: 'worker',
        from: this.getWorkerPose(),
        to: { ...this.layout.outbound.workerPlace },
      }, durations.place, { box: 'IN TRANSIT' });
    } else if (finished === 'PLACE_IN_WRAP') {
      this.applyWorkerPose(this.layout.outbound.workerPlace);
      // Lower onto the turntable deck (pallet root was attached at forks ≈ 0.045).
      const deckHeight = this.wrapMachine?.deckHeight ?? this.layout.wrapMachine?.deckHeight ?? 0;
      const placeForkHeight = deckHeight + 0.045;
      this.beginOutboundTween('JACK_LOWER', {
        kind: 'fork',
        from: this.worker.getForkHeight(),
        to: placeForkHeight,
      }, durations.lower, { box: 'AT WRAPPER' });
    } else if (finished === 'JACK_LOWER') {
      const deckHeight = this.wrapMachine?.deckHeight ?? this.layout.wrapMachine?.deckHeight ?? 0;
      this.worker.setForkHeight(deckHeight + 0.045);
      this.detachCargoToStation();
      this.beginOutboundTween('WORKER_WITHDRAW', {
        kind: 'worker',
        from: this.getWorkerPose(),
        to: { ...this.layout.outbound.workerWithdraw },
      }, durations.withdraw, { box: 'AT WRAPPER' });
    } else if (finished === 'WORKER_WITHDRAW') {
      this.applyWorkerPose(this.layout.outbound.workerWithdraw);
      this.wrapMachine.resetWrap();
      this.beginOutboundTween('WRAPPING', { kind: 'wrap' }, durations.wrap, { box: 'WRAPPING' });
    } else if (finished === 'WRAPPING') {
      this.wrapMachine.setWrapProgress(1);
      this.outboundActive = false;
      this.setState('COMPLETE', { conveyor: 'STOPPED', robot: 'HOME', box: 'WRAPPED', gripper: 'OPEN' });
    }
    this.onUpdate?.(this);
  }

  updateOutbound(delta) {
    if (!this.outboundTween) return;
    this.elapsed = Math.min(this.elapsed + delta * this.speedMultiplier, this.duration);
    const progress = THREE.MathUtils.smoothstep(this.elapsed / Math.max(this.duration, 0.001), 0, 1);
    this.applyOutboundTween(progress);
    if (this.elapsed < this.duration) {
      this.onUpdate?.(this);
      return;
    }
    this.finishOutboundStep();
  }

  attachBox() {
    this.distance = this.getSuctionWorld().distanceTo(this.getBoxGraspWorld());
    if (this.distance > GRIP_TOLERANCE) {
      console.warn(`Grip prevented: TCP-to-grasp distance ${this.distance.toFixed(3)} m exceeds ${GRIP_TOLERANCE} m.`);
      return false;
    }
    const suction = this.getSuctionWorld();
    const boxWorldPosition = this.box.root.getWorldPosition(new THREE.Vector3());
    this.attachedOffset.copy(boxWorldPosition).sub(suction);
    this.attachedQuaternion.copy(this.box.root.getWorldQuaternion(new THREE.Quaternion()));
    this.gripper.attach(this.box.root);
    this.attached = true;
    this.setState('GRIP', { conveyor: 'STOPPED', robot: 'PICKING', box: 'GRIPPED', gripper: 'GRIPPING' });
    return true;
  }

  releaseBox() {
    if (!this.attached) return false;
    const worldQuaternion = this.box.root.getWorldQuaternion(new THREE.Quaternion());
    this.stationRoot.attach(this.box.root);
    const expected = this.stackTarget.clone();
    const actual = this.box.root.getWorldPosition(new THREE.Vector3());
    const placementError = actual.distanceTo(expected);
    const expectedQuaternion = new THREE.Quaternion();
    const rotationError = 1 - Math.abs(worldQuaternion.dot(expectedQuaternion));
    this.positionError = placementError;
    const bottomError = Math.abs(
      this.box.root.localToWorld(new THREE.Vector3(0, -this.boxDefinition.height / 2, 0)).y
      - (this.stackTarget.y - this.boxDefinition.height / 2),
    );
    const overlap = this.floorBoxes.some((placed, placedIndex) => {
      const center = this.getStackTarget(placed.root.userData.stackIndex ?? placedIndex);
      const clearance = 1e-3;
      return Math.abs(center.x - expected.x) < this.boxDefinition.length - clearance
        && Math.abs(center.z - expected.z) < this.boxDefinition.width - clearance
        && Math.abs(center.y - expected.y) < this.boxDefinition.height - clearance;
    });
    this.bottomHeight = this.box.root.localToWorld(new THREE.Vector3(0, -this.boxDefinition.height / 2, 0)).y;
    console.info('Stack placement validation', {
      target: expected.toArray(),
      actual: actual.toArray(),
      positionError: placementError,
      bottomHeight: this.box.root.localToWorld(new THREE.Vector3(0, -this.boxDefinition.height / 2, 0)).y,
      targetBottomHeight: this.stackTarget.y - this.boxDefinition.height / 2,
      rotation: this.box.root.rotation.toArray(),
      overlap,
    });
    if (placementError > 0.04 || bottomError > 0.04 || rotationError > 1e-4 || overlap) {
      console.error('Stack placement validation failed.', { placementError, bottomError, rotationError, overlap });
      return false;
    }
    // The motion solver may leave a few millimetres of numerical error. Once
    // verification passes, place the box at the exact grid target before
    // releasing it so every following layer starts from a stable reference.
    this.box.root.position.copy(this.stationRoot.worldToLocal(expected.clone()));
    this.box.root.quaternion.identity();
    this.box.root.userData.stackIndex = this.boxNumber;
    this.floorBoxes.push(this.box);
    this.boxNumber += 1;
    this.box = null;
    this.attached = false;
    return true;
  }

  updateConveyor(delta) {
    if (!this.box) return;
    const direction = this.getConveyorDirection();
    const pickup = new THREE.Vector3(
      this.layout.conveyor.pickup.x,
      this.getBeltBoxCenterY(),
      this.layout.conveyor.pickup.z,
    );
    const scaledDelta = delta * this.speedMultiplier;
    const remaining = pickup.clone().sub(this.box.root.position).dot(direction);
    const travel = Math.min(CONVEYOR_SPEED * scaledDelta, Math.max(remaining, 0));
    this.box.root.position.addScaledVector(direction, travel);
    this.conveyor.rollers?.forEach((roller) => {
      roller.rotation.z -= travel / 0.045;
    });
    if (remaining <= CONVEYOR_SPEED * scaledDelta + 1e-6) {
      this.box.root.position.copy(pickup);
      this.setState('BOX_AT_PICKUP', { conveyor: 'STOPPED', robot: 'HOME', box: 'ON BELT', gripper: 'OPEN' });
      this.beginHold('BOX_AT_PICKUP', 0.25, { conveyor: 'STOPPED', robot: 'HOME', box: 'ON BELT', gripper: 'OPEN' });
    }
  }

  update(delta) {
    this.gripper.userData.update?.(delta, this.speedMultiplier);
    if (this.outboundActive) {
      this.updateOutbound(delta);
      return;
    }
    if (this.state === 'CONVEYOR_RUNNING') {
      this.updateConveyor(delta);
      return;
    }
    if (!this.poseTo) return;
    this.elapsed = Math.min(this.elapsed + delta * this.speedMultiplier, this.duration);
    const progress = THREE.MathUtils.smoothstep(this.elapsed / Math.max(this.duration, 0.001), 0, 1);
    this.rig.setValues(lerpPose(this.poseFrom, this.poseTo, progress));
    if (this.attached && this.box) {
      const targetWorldPosition = this.getSuctionWorld().add(this.attachedOffset);
      const parentWorldQuaternion = this.box.root.parent.getWorldQuaternion(new THREE.Quaternion());
      this.box.root.position.copy(this.box.root.parent.worldToLocal(targetWorldPosition));
      this.box.root.quaternion.copy(parentWorldQuaternion.invert().multiply(this.attachedQuaternion));
    }
    if (this.box) this.distance = this.getSuctionWorld().distanceTo(this.getBoxGraspWorld());
    if (this.elapsed < this.duration) {
      this.onUpdate?.(this);
      return;
    }
    const finished = this.state;
    this.poseTo = null;
    if (finished === 'SPAWN_BOX') {
      this.beginMove('CONVEYOR_RUNNING', null, 0, { conveyor: 'RUNNING', robot: 'HOME', box: 'ON BELT', gripper: 'OPEN' });
    } else if (finished === 'BOX_AT_PICKUP') {
      this.prepareTargets();
      this.beginMove('APPROACH_BOX', this.targets.approach, 1.8, { conveyor: 'STOPPED', robot: 'APPROACH', box: 'ON BELT', gripper: 'APPROACHING' });
    } else if (finished === 'APPROACH_BOX') {
      this.beginMove('LOWER_TO_BOX', this.targets.pickup, 1.0, { robot: 'APPROACH', box: 'ON BELT', gripper: 'APPROACHING' });
    } else if (finished === 'LOWER_TO_BOX') {
      this.animateClaw(0.82, 0.68, 0.45, 'GRIPPING');
    } else if (finished === 'GRIPPING') {
      if (!this.attachBox()) {
        this.setState('IDLE', { conveyor: 'STOPPED', robot: 'HOME', box: 'ON BELT', gripper: 'OPEN' });
        return;
      }
      this.beginMove('LIFT', this.targets.lift, 1.1, { robot: 'CARRYING', box: 'GRIPPED', gripper: 'HOLDING' });
    } else if (finished === 'LIFT') {
      this.beginMove('MOVE_TO_STACK', this.targets.stackCarry, 2.0, { robot: 'CARRYING', box: 'GRIPPED', gripper: 'HOLDING' });
    } else if (finished === 'MOVE_TO_STACK') {
      this.beginMove('LOWER_TO_STACK', this.targets.stackLower, 0.9, { robot: 'PLACING', box: 'GRIPPED', gripper: 'HOLDING' });
    } else if (finished === 'LOWER_TO_STACK') {
      this.animateClaw(0.68, 0.82, 0.45, 'RELEASING');
    } else if (finished === 'RELEASING') {
      if (!this.releaseBox()) {
        console.error(`Placement verification failed for box ${this.boxNumber + 1}; retrying target calculation.`);
        this.prepareTargets();
        this.beginMove('LOWER_TO_STACK', this.targets.stackLower, 0.9, { robot: 'PLACING', box: 'GRIPPED', gripper: 'HOLDING' });
        return;
      }
      this.beginHold('VERIFY_PLACEMENT', 0.16, { robot: 'PLACING', box: 'ON FLOOR', gripper: 'OPEN' });
    } else if (finished === 'VERIFY_PLACEMENT') {
      this.beginMove('RETURN_HOME', this.home, 2.2, { robot: 'RETURNING HOME', box: 'ON FLOOR', gripper: 'OPEN' });
    } else if (finished === 'RETURN_HOME') {
      if (this.boxNumber >= this.layout.stack.columns * this.layout.stack.rows * this.layout.stack.layers) {
        // Stacking complete — stop box/conveyor process and begin outbound handling.
        this.startOutbound();
      } else {
        this.createBoxAtInput();
        this.beginHold('SPAWN_BOX', 0.2, { conveyor: 'STOPPED', robot: 'HOME', box: 'ON BELT', gripper: 'OPEN' });
      }
    }
    this.onUpdate?.(this);
  }
}
