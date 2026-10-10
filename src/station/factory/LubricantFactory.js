import * as THREE from 'three';
import { StationEnvironment } from '../common/StationEnvironment.js';
import { StepSequencer } from '../common/StepSequencer.js';
import { group, smoother } from '../station-1/OilGeometry.js';
import { OilFillingStation } from '../station-1/OilFillingStation.js';
import { CAN_STATES as OIL_CAN_STATES, OilFillingCycle } from '../station-1/OilFillingCycle.js';
import { OIL_STATION_STATES } from '../station-1/OilFillingDefinition.js';
import { brandLabel } from '../station-1/OilMaterials.js';
import { applyLabelLayout, setCanLook as restyleCans } from '../station-1/JerryCan.js';
import { CasePackingStation } from '../station-2/CasePackingStation.js';
import { CasePackingCycle } from '../station-2/CasePackingCycle.js';
import { CASE_PACKING_DEFINITION, CASE_PACKING_STATES } from '../station-2/CasePackingDefinition.js';
import { getCardboardMaterials } from '../station-2/CardboardCase.js';
import { StationScene } from '../station-3/StationScene.js';
import { StationCycle } from '../station-3/StationCycle.js';
import { STATION_DEFINITION } from '../station-3/StationDefinition.js';
import { FACTORY_LAYOUT as LAYOUT, FACTORY_STATION1_DEFINITION } from './FactoryLayout.js';
import { createInstancedStock, createRackFrame, createSign } from './SupplyRack.js';
import { createCanTransfer, createCaseTransfer, createFloorBay } from './TransferLines.js';
import logoUrl from '../../assets/logo.png?url';
import canLabelUrl from '../../assets/can-label.png?url';

export const FACTORY_STATES = Object.freeze({
  IDLE: 'IDLE',
  RUNNING: 'RUNNING',
  FINISHED_PALLET: 'FINISHED_PALLET',
});

const NO_CAMERA = { frameObject() {} };
const CAN_DEF = CASE_PACKING_DEFINITION.can;
const CASE_DEF = CASE_PACKING_DEFINITION.box;
const BELT_HEIGHT = CASE_PACKING_DEFINITION.line.beltHeight;
/** Case base height on Station 3's belt (its box centre minus half the height). */
const S3_CASE_BASE = STATION_DEFINITION.conveyor.beltHeight + STATION_DEFINITION.box.beltClearance;

// ---- Belt motion profiles (same shapes the stations use) ------------------------------

function smoothMin(a, b, k) {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

function rampedTravel(t, v, ramp) {
  if (t < ramp) return 0.5 * (v / ramp) * t * t;
  return 0.5 * v * ramp + v * (t - ramp);
}

function trapezoidTravel(t, distance, v, ramp) {
  const total = distance / v + ramp;
  const a = v / ramp;
  if (t <= ramp) return 0.5 * a * t * t;
  if (t >= total - ramp) return distance - 0.5 * a * Math.max(total - t, 0) ** 2;
  return 0.5 * v * ramp + v * (t - ramp);
}

function reparentPreservingWorld(object, parent, worldMatrix) {
  parent.updateMatrixWorld(true);
  parent.matrixWorld.clone().invert().multiply(worldMatrix).decompose(object.position, object.quaternion, object.scale);
  parent.add(object);
}

/**
 * Unified lubricant line: Station 1 (filling/capping) → Station 2 (case
 * packing) → Station 3 (palletizing & wrapping), fed from two supply racks.
 *
 * The three stations are the existing, unmodified station builders and
 * cycles. The factory only:
 * - feeds Station 1 / Station 2 from the jerry-can and carton racks,
 * - receives each station's real output objects at the moment the station
 *   would discharge them, and carries them (same objects) to the next station,
 * - forms Station 1's single file into Station 2's two lanes,
 * - holds an upstream station at its cycle boundary while the downstream
 *   buffer is full (back-pressure instead of timed delays).
 */
export class LubricantFactory {
  constructor({ scene, renderer }) {
    this.scene = scene;
    this.root = null;
    this.speed = 1;
    this.running = false;
    this.state = FACTORY_STATES.IDLE;
    this.canBatch = null;
    this.stagedCans = null;
    this.cases = [];
    this.pendingS3Box = null;
    this.environment = new StationEnvironment({ scene, renderer });
    this.onUpdate = null;
    this.canLook = 'classic';
  }

  get visible() {
    return Boolean(this.root?.visible);
  }

  // ---- Build ---------------------------------------------------------------------------

  build() {
    const root = group(null, 'LubricantFactory');
    root.visible = false;
    this.scene.add(root);
    this.root = root;

    this.s1 = new OilFillingStation({ scene: root, renderer: null, cameraManager: NO_CAMERA, controls: null, definition: FACTORY_STATION1_DEFINITION });
    this.s1.build();
    this.s1.root.position.set(LAYOUT.station1.x, 0, LAYOUT.station1.z);
    this.s1.root.visible = true;

    this.s2 = new CasePackingStation({ scene: root, renderer: null, cameraManager: NO_CAMERA, controls: null });
    this.s2.build();
    this.s2.root.position.set(LAYOUT.station2.x, 0, LAYOUT.station2.z);
    this.s2.root.visible = true;

    // Station 3 needs the ABB robot asset, so its cell is built on show().
    this.s3 = new StationScene({ scene: root, cameraManager: NO_CAMERA, controls: null, floor: { visible: true } });

    // Tunnels that products now pass through become open-ended hoods.
    this.openTunnel(this.s1.root.getObjectByName('OutfeedTunnel'));
    this.openTunnel(this.s2.parts.input.root.getObjectByName('InfeedTunnel'));
    this.openTunnel(this.s2.parts.conveyors.outputRoot.getObjectByName('OutputTunnel'));

    const materials = this.s1.parts.materials;
    // The factory's own Station 1 materials: branding them leaves the stand-alone Station 1 as it is.
    brandLabel(materials.label, logoUrl);
    this.buildSupplies(materials);
    this.buildTransfers(materials);
    this.buildSigns(materials);

    this.patchStation1();
    this.patchStation2();
    this.canSequencer = new StepSequencer({ plan: () => this.planCanTransfer() });
  }

  openTunnel(tunnel) {
    ['End wall', 'Interior lining'].forEach((name) => {
      const part = tunnel?.getObjectByName(name);
      if (part) part.visible = false;
    });
  }

  /** The rack's empty cans, drawn in the current can look (instanced, so rebuilt on a change). */
  buildCanStock() {
    const remaining = this.canStock?.remaining;
    if (this.canStock) this.canSupply.remove(this.canStock.root);
    const template = this.s1.parts.createCan().root;
    applyLabelLayout(template, this.canLook);
    this.canStock = createInstancedStock({ name: 'EmptyJerryCans', template, slots: this.canSlots });
    this.canStock.root.userData.ownLook = this.canLook === 'branded';
    if (remaining !== undefined) while (this.canStock.remaining > remaining) this.canStock.take();
    this.canSupply.add(this.canStock.root);
  }

  /** 'classic' (the station's own can) or 'branded' (yellow retail can from a product photo). */
  setCanLook(look) {
    if (look === this.canLook || !this.root) return;
    this.canLook = look;
    if (look === 'branded' && !this.brandedLabelMap && typeof document !== 'undefined') {
      this.brandedLabelMap = new THREE.TextureLoader().load(canLabelUrl);
      this.brandedLabelMap.colorSpace = THREE.SRGBColorSpace;
      this.brandedLabelMap.anisotropy = 4;
    }
    restyleCans(this.s1.parts.materials, look, this.brandedLabelMap ?? null);
    applyLabelLayout(this.root, look);
    this.buildCanStock();
  }

  buildSupplies(materials) {
    // Empty jerry cans: 3 deck levels × 6 × 6 = 108 cans = one full pallet of cases.
    const canSupply = group(this.root, 'JerryCanSupply', [LAYOUT.station1.x + LAYOUT.supply.cans.x, 0, LAYOUT.station1.z + LAYOUT.supply.cans.z]);
    const canDecks = [0.14, 0.74, 1.34];
    canSupply.add(createRackFrame({ name: 'CanRack', length: 1.95, depth: 1.35, deckHeights: canDecks, height: 1.95, bays: 2 }));
    const canSlots = [];
    canDecks.forEach((deckY) => {
      for (let row = 0; row < 6; row += 1) {
        for (let column = 0; column < 6; column += 1) {
          canSlots.push(new THREE.Matrix4().makeTranslation((column - 2.5) * 0.3, deckY, (row - 2.5) * 0.205));
        }
      }
    });
    this.canSupply = canSupply;
    this.canSlots = canSlots;
    this.buildCanStock();

    // Cartons: 2 deck levels × 2 bays × 2 × 2 × 2 high = 32 cases (27 needed per pallet).
    const caseSupply = group(this.root, 'CartonSupply', [LAYOUT.station2.x + LAYOUT.supply.cases.x, 0, LAYOUT.station2.z + LAYOUT.supply.cases.z]);
    const caseDecks = [0.15, 1.15];
    caseSupply.add(createRackFrame({ name: 'CartonRack', length: 1.8, depth: 1.4, deckHeights: caseDecks, height: 2.2, bays: 2 }));
    const cardboard = getCardboardMaterials(CASE_DEF);
    const template = group(null, 'Carton');
    template.add(new THREE.Mesh(new THREE.BoxGeometry(CASE_DEF.length, CASE_DEF.height, CASE_DEF.width).translate(0, CASE_DEF.height / 2, 0), cardboard.cardboard));
    template.add(new THREE.Mesh(new THREE.BoxGeometry(CASE_DEF.length, 0.002, 0.004).translate(0, CASE_DEF.height + 0.001, 0), new THREE.MeshStandardMaterial({ color: 0x7a4f25, roughness: 0.8 })));
    template.children.forEach((mesh) => { mesh.castShadow = true; });
    const caseSlots = [];
    const turn = new THREE.Matrix4().makeRotationY(Math.PI / 2);
    caseDecks.forEach((deckY) => {
      [0, 1].forEach((layer) => {
        [-0.32, 0.32].forEach((z) => {
          [-0.665, -0.235, 0.235, 0.665].forEach((x) => {
            caseSlots.push(new THREE.Matrix4().makeTranslation(x, deckY + layer * (CASE_DEF.height + 0.002), z).multiply(turn));
          });
        });
      });
    });
    this.caseStock = createInstancedStock({ name: 'EmptyCartons', template, slots: caseSlots });
    caseSupply.add(this.caseStock.root);
  }

  buildTransfers(materials) {
    this.canTransfer = createCanTransfer({ materials, layout: LAYOUT.canTransfer, beltHeight: BELT_HEIGHT });
    this.canTransfer.root.position.set(LAYOUT.station1.x, 0, LAYOUT.station1.z);
    this.root.add(this.canTransfer.root);
    // Cans in transit live in Station 1 local coordinates (shared centre line).
    this.cansInTransit = group(this.canTransfer.root, 'CansInTransit');

    this.caseTransfer = createCaseTransfer({ materials, layout: LAYOUT.caseTransfer, beltHeight: BELT_HEIGHT, caseWidth: CASE_DEF.width });
    this.root.add(this.caseTransfer.root);
    this.casesInTransit = group(this.root, 'CasesInTransit');

    // Pallet-jack parking bay where Station 3's worker starts.
    const s3 = STATION_DEFINITION;
    const palletCenterX = s3.stackDropOrigin.x + ((s3.stack.columns - 1) / 2) * (s3.box.length + s3.stack.spacing);
    const palletCenterZ = s3.stackDropOrigin.z + ((s3.stack.rows - 1) / 2) * (s3.box.width + s3.stack.spacing);
    this.root.add(createFloorBay({
      materials,
      name: 'PalletJackBay',
      center: { x: palletCenterX - s3.outbound.workerSpawnGap + 0.2, z: palletCenterZ },
      size: [2.3, 1.1],
    }));
  }

  /** Fixed supply-area signs. Station names and KPIs live in the interactive overlay. */
  buildSigns(materials) {
    const signs = group(this.root, 'SupplySigns');
    [
      { title: 'RAW MATERIALS', subtitle: 'Empty HDPE jerry cans', accent: '#8fa3ae', x: LAYOUT.station1.x + LAYOUT.supply.cans.x, z: LAYOUT.station1.z - 0.95 },
      { title: 'CARTON SUPPLY', subtitle: 'Empty cases for packing', accent: '#b8793c', x: LAYOUT.station2.x + LAYOUT.supply.cases.x, z: LAYOUT.station2.z + LAYOUT.supply.cases.z - 0.95 },
    ].forEach(({ x, z, ...options }) => {
      const sign = createSign({ ...options, materials });
      sign.position.set(x, 0, z);
      signs.add(sign);
    });
  }

  /** Station roots in line order, for overlay hit-testing and camera framing. */
  get stationRoots() {
    return [this.s1?.root, this.s2?.root, this.s3?.root];
  }

  // ---- Station hooks (instance-level, station source unchanged) --------------------------

  patchStation1() {
    const factory = this;
    const cycle = this.s1.cycle;
    const parts = this.s1.parts;
    const proto = OilFillingCycle.prototype;
    // Each new can is taken from the supply rack.
    cycle.createCan = () => {
      factory.canStock.take();
      const can = parts.createCan();
      applyLabelLayout(can.root, factory.canLook);
      return can;
    };
    cycle.spawnBatch = function spawnFromRack(center) {
      if (factory.canStock.remaining < this.definition.line.cansPerBatch) return;
      proto.spawnBatch.call(this, center);
    };
    // Back-pressure: same phase order as Station 1's own planner, but a new machine
    // cycle (the transport phase) only starts when its output can be accepted.
    cycle.planNextPhase = function planWithBackPressure() {
      const planners = [
        () => this.planTransport(),
        () => this.planOutput(),
        () => this.planFilling(),
        () => this.planCapping(),
      ];
      for (let attempt = 0; attempt < planners.length; attempt += 1) {
        if (this.phaseIndex === 0) {
          const hold = factory.station1HoldReason();
          if (hold) {
            this.queue(OIL_STATION_STATES.IDLE, hold, 0.1, { mainConveyor: 'STOPPED', outfeedConveyor: 'STOPPED' });
            return;
          }
        }
        const phase = this.phaseIndex;
        this.phaseIndex = (phase + 1) % planners.length;
        if (planners[phase]()) return;
      }
    };
    // Discharged cans are handed to the transfer instead of disappearing.
    cycle.beginNextStep = function beginWithHandover() {
      proto.beginNextStep.call(this);
      const step = this.active;
      if (step.label !== 'Discharging finished cans') return;
      const discharge = step.onEnd;
      step.onEnd = () => {
        const leaving = this.cans.filter((entry) => entry.state === OIL_CAN_STATES.CAPPED && entry.x > this.definition.conveyor.outfeed.start);
        const worlds = leaving.map((entry) => {
          entry.can.root.updateMatrixWorld(true);
          return entry.can.root.matrixWorld.clone();
        });
        discharge();
        factory.receiveCanBatch(leaving.map((entry, index) => ({ can: entry.can, world: worlds[index] })));
      };
    };
  }

  patchStation2() {
    const factory = this;
    const cycle = this.s2.cycle;
    const proto = CasePackingCycle.prototype;
    cycle.spawnCans = function adoptStagedCans() {
      factory.handCansToStation2(this);
    };
    cycle.planCycle = function planWhenSupplied() {
      const hold = factory.station2HoldReason();
      if (hold) {
        this.sequencer.queue(CASE_PACKING_STATES.EMPTY, hold, 0.1, { inputConveyor: 'STOPPED', boxConveyor: 'STOPPED' });
        return;
      }
      proto.planCycle.call(this);
    };
    const createCase = this.s2.parts.createCase;
    this.s2.parts.createCase = () => {
      factory.caseStock.take();
      return createCase();
    };
    const onStepStart = cycle.sequencer.onStepStart;
    cycle.sequencer.onStepStart = (step) => {
      onStepStart(step);
      if (step.label !== 'Taping & discharging case') return;
      const discharge = step.onEnd;
      step.onEnd = () => {
        const kase = cycle.box;
        kase.root.updateMatrixWorld(true);
        const world = kase.root.matrixWorld.clone();
        discharge();
        factory.receiveCase(kase, world);
      };
    };
  }

  patchStation3() {
    const factory = this;
    const cycle = this.s3.cycle;
    // Drop the stand-alone procedural box StationScene spawns on show.
    cycle.reset();
    cycle.boxFactory = () => {
      const box = factory.pendingS3Box;
      factory.pendingS3Box = null;
      return box;
    };
    // Station 3 asks for its next box here; it only gets one that Station 2 delivered.
    cycle.createBoxAtInput = function createDeliveredBox() {
      if (this.box || !factory.pendingS3Box) return;
      StationCycle.prototype.createBoxAtInput.call(this);
    };
  }

  station1HoldReason() {
    if (this.canBatch) return 'Holding · transfer to Station 2 busy';
    if (this.canStock.remaining < FACTORY_STATION1_DEFINITION.line.cansPerBatch && this.s1.cycle.cans.length === 0) return 'Can supply used · run complete';
    return null;
  }

  station2HoldReason() {
    if (!this.stagedCans) return 'Waiting for jerry cans from Station 1';
    if (this.caseStock.remaining === 0) return 'Carton supply empty';
    if (this.cases.length >= LAYOUT.caseTransfer.slots.length) return 'Holding · Station 3 infeed full';
    return null;
  }

  // ---- Station 1 → Station 2: single file → two lanes ------------------------------------

  receiveCanBatch(entries) {
    if (!entries.length) return;
    const cans = entries.map(({ can, world }) => {
      reparentPreservingWorld(can.root, this.cansInTransit, world);
      return { can, x: can.root.position.x, z: can.root.position.z };
    }).sort((a, b) => a.x - b.x);
    this.canBatch = { cans, phase: 'RECEIVED' };
  }

  setCanX(record, x) {
    record.x = x;
    record.can.root.position.x = x;
  }

  setCanZ(record, z) {
    record.z = z;
    record.can.root.position.z = z;
  }

  /** Belt textures move with the product: transfer belt always, adjoining station belts when idle. */
  advanceCanBelts(distance, records, { s1Outfeed = false } = {}) {
    this.canTransfer.belt.advance(distance);
    if (s1Outfeed && this.s1.cycle.status.outfeedConveyor === 'STOPPED') this.s1.parts.conveyors.outfeed.advance(distance);
    const s2Busy = ['RUNNING', 'STOPPING'].includes(this.s2.cycle.status.inputConveyor);
    const onS2 = records.some((record) => record.x + LAYOUT.canTransfer.canLength / 2 > LAYOUT.canTransfer.s2InputStart);
    if (onS2 && !s2Busy) this.s2.parts.input.belt.advance(distance);
  }

  queueRigidMove(label, records, distance, options) {
    const { beltSpeed: v, beltRamp: ramp } = LAYOUT;
    const duration = distance / v + ramp;
    let from = [];
    this.canSequencer.queue('TRANSFER', label, duration, {}, {
      onStart: () => { from = records.map((record) => record.x); },
      onUpdate: (progress, previous) => {
        const s = trapezoidTravel(progress * duration, distance, v, ramp);
        records.forEach((record, index) => this.setCanX(record, from[index] + s));
        this.advanceCanBelts(s - trapezoidTravel(previous * duration, distance, v, ramp), records, options);
      },
      onEnd: () => records.forEach((record, index) => this.setCanX(record, from[index] + distance)),
    });
  }

  /** Side pusher shifts a pair of cans from the centre line into lane `lane`. */
  queuePush(side, records, lane) {
    const layout = LAYOUT.canTransfer;
    const laneZ = layout.laneZ[lane];
    const halfWidth = layout.canHalfWidth;
    const retracted = side * layout.pusherRetracted;
    const extended = laneZ + side * halfWidth;
    this.canSequencer.queue('TRANSFER', `Pusher ${side > 0 ? 'A' : 'B'} forming lane ${lane + 1}`, 0.7, {}, {
      onUpdate: (progress) => {
        const face = THREE.MathUtils.lerp(retracted, extended, smoother(progress));
        this.canTransfer.setPusherFace(side, face);
        records.forEach((record) => this.setCanZ(record, side > 0 ? Math.min(0, face - halfWidth) : Math.max(0, face + halfWidth)));
      },
      onEnd: () => records.forEach((record) => {
        this.setCanZ(record, laneZ);
        record.row = lane;
      }),
    });
    this.canSequencer.queue('TRANSFER', 'Pusher retracting', 0.45, {}, {
      onUpdate: (progress) => this.canTransfer.setPusherFace(side, THREE.MathUtils.lerp(extended, retracted, smoother(progress))),
    });
  }

  planCanTransfer() {
    const batch = this.canBatch;
    const queue = (...args) => this.canSequencer.queue(...args);
    const layout = LAYOUT.canTransfer;
    if (!batch) {
      queue('IDLE', 'Idle', 0.1);
      return;
    }
    if (batch.phase === 'RECEIVED') {
      // Single file in Station 1 order: [c0 trailing … c3 leading].
      const [c0, c1, c2, c3] = batch.cans;
      c3.column = 1;
      c2.column = 0;
      c1.column = 1;
      c0.column = 0;
      const toPushers = layout.pusherPair[1] - c3.x;
      this.queueRigidMove('Single-file transfer to row former', batch.cans, toPushers, { s1Outfeed: true });
      this.queuePush(1, [c3, c2], 0);
      this.queueRigidMove('Indexing second pair', batch.cans, c3.x - c1.x);
      this.queuePush(-1, [c1, c0], 1);
      queue('TRANSFER', 'Two lanes formed', 0.2, {}, { onEnd: () => { batch.phase = 'FORMED'; } });
      return;
    }
    if (this.stagedCans) {
      queue('TRANSFER', 'Waiting for Station 2 infeed', 0.1);
      return;
    }
    // Accumulate both lanes against the infeed metering gate inside Station 2's tunnel.
    const { beltSpeed: v, beltRamp: ramp, stopBlend } = LAYOUT;
    const targets = batch.cans.map((record) => (record.column === 1 ? layout.staging.leading : layout.staging.trailing));
    const travels = batch.cans.map((record, index) => targets[index] - record.x);
    const travel = Math.max(...travels) + stopBlend;
    const duration = ramp + (travel - 0.5 * v * ramp) / v;
    let from = [];
    queue('TRANSFER', 'Feeding Station 2 infeed', duration, {}, {
      onStart: () => { from = batch.cans.map((record) => record.x); },
      onUpdate: (progress, previous) => {
        const s = rampedTravel(progress * duration, v, ramp);
        batch.cans.forEach((record, index) => this.setCanX(record, from[index] + smoothMin(s, travels[index], stopBlend)));
        this.advanceCanBelts(s - rampedTravel(previous * duration, v, ramp), batch.cans);
      },
      onEnd: () => {
        batch.cans.forEach((record, index) => this.setCanX(record, targets[index]));
        this.stagedCans = batch.cans.map(({ can, row, column }) => ({ can, row, column }));
        this.canBatch = null;
      },
    });
    queue('TRANSFER', 'Transfer belt stopping', ramp, {}, {
      onUpdate: (progress, previous) => {
        const at = (p) => v * p * ramp - 0.5 * (v / ramp) * (p * ramp) ** 2;
        this.canTransfer.belt.advance(at(progress) - at(previous));
      },
    });
  }

  /** Station 2's arrival step adopts the staged cans as its own (no new cans are created). */
  handCansToStation2(cycle) {
    const staged = this.stagedCans;
    this.stagedCans = null;
    const { input, line } = CASE_PACKING_DEFINITION;
    const inputRoot = this.s2.parts.input.root;
    staged.forEach(({ can, row, column }) => {
      inputRoot.attach(can.root);
      cycle.cans.push({ can, row, column, stage: 'CONVEYOR', target: new THREE.Vector3(input.stopX[column], line.beltHeight, input.laneZ[row]) });
    });
  }

  // ---- Station 2 → Station 3: packed cases ------------------------------------------------

  receiveCase(kase, world) {
    const position = new THREE.Vector3().setFromMatrixPosition(world);
    // Station 3 handles boxes by their centre; wrap the same case in a centred carrier.
    const carrier = new THREE.Group();
    carrier.name = 'PackedCase';
    carrier.position.set(position.x, position.y + CASE_DEF.height / 2, position.z);
    this.casesInTransit.add(carrier);
    kase.root.position.set(0, -CASE_DEF.height / 2, 0);
    kase.root.quaternion.identity();
    carrier.add(kase.root);
    this.cases.push({ carrier, kase, x: position.x, motion: null, delivering: false });
  }

  caseBaseY(x) {
    const { dropFromX, dropToX } = LAYOUT.caseTransfer;
    return THREE.MathUtils.lerp(BELT_HEIGHT, S3_CASE_BASE, smoother((x - dropFromX) / (dropToX - dropFromX)));
  }

  updateCases(scaledDelta) {
    const layout = LAYOUT.caseTransfer;
    const { beltSpeed: v, beltRamp: ramp } = LAYOUT;
    const station3 = this.s3.cycle;
    const requesting = station3 && station3.state === 'CONVEYOR_RUNNING' && !station3.box && !this.pendingS3Box && station3.boxNumber < LAYOUT.palletBoxes;
    let transferBelt = 0;
    let s2Belt = 0;
    const offset = this.cases[0]?.delivering ? 1 : 0;
    [...this.cases].forEach((item, index) => {
      if (!item.motion) {
        if (index === 0 && !item.delivering && requesting && Math.abs(item.x - layout.slots[0]) < 1e-6) {
          item.delivering = true;
          item.motion = { from: item.x, to: layout.s3InputX, elapsed: 0 };
        } else if (!item.delivering) {
          const target = layout.slots[index - offset];
          if (target !== undefined && item.x < target - 1e-6) item.motion = { from: item.x, to: target, elapsed: 0 };
        }
        if (item.motion) item.motion.duration = (item.motion.to - item.motion.from) / v + ramp;
      }
      if (!item.motion) return;
      const { motion } = item;
      const before = item.x;
      motion.elapsed = Math.min(motion.elapsed + scaledDelta, motion.duration);
      item.x = motion.from + trapezoidTravel(motion.elapsed, motion.to - motion.from, v, ramp);
      if (motion.elapsed >= motion.duration) item.x = motion.to;
      item.carrier.position.set(item.x, this.caseBaseY(item.x) + CASE_DEF.height / 2, 0);
      const moved = item.x - before;
      const half = CASE_DEF.length / 2;
      if (item.x + half > layout.start && item.x - half < layout.end) transferBelt = Math.max(transferBelt, moved);
      if (item.x - half < layout.s2OutputBeltEnd) s2Belt = Math.max(s2Belt, moved);
      if (item.x === motion.to) {
        item.motion = null;
        if (item.delivering) this.deliverToStation3(item);
      }
    });
    if (transferBelt > 0) this.caseTransfer.belt.advance(transferBelt);
    if (s2Belt > 0 && this.s2.cycle.status.boxConveyor === 'STOPPED') this.s2.parts.conveyors.output.advance(s2Belt);
  }

  deliverToStation3(item) {
    this.cases.splice(this.cases.indexOf(item), 1);
    const half = CASE_DEF.height / 2;
    this.pendingS3Box = {
      root: item.carrier,
      references: {
        center: new THREE.Vector3(0, 0, 0),
        bottom: new THREE.Vector3(0, -half, 0),
        grasp: new THREE.Vector3(0, half, 0),
        topSurface: new THREE.Vector3(0, half, 0),
      },
    };
    this.s3.cycle.createBoxAtInput();
  }

  // ---- Lifecycle ---------------------------------------------------------------------------

  async show(asset) {
    if (!this.root) this.build();
    this.root.visible = true;
    await this.s3.show(asset);
    this.patchStation3();
    this.environment.apply();
    this.reset();
    this.setSpeed(this.speed);
  }

  /** Returns the robot model so the app can put it back in the asset view. */
  hide() {
    if (!this.root) return null;
    this.reset();
    const gripper = this.s3.root.userData.gripper;
    const robot = this.s3.hide();
    gripper?.removeFromParent();
    this.root.visible = false;
    this.environment.restore();
    return robot;
  }

  start() {
    if (this.state === FACTORY_STATES.FINISHED_PALLET) this.reset();
    if (this.running || !this.s3.cycle) return;
    this.running = true;
    this.state = FACTORY_STATES.RUNNING;
    this.s1.startCycle();
    this.s2.startCycle();
    this.s3.cycle.start();
    this.notify();
  }

  reset() {
    this.running = false;
    this.state = FACTORY_STATES.IDLE;
    this.canSequencer.clear();
    [...(this.canBatch?.cans ?? []), ...(this.stagedCans ?? [])].forEach(({ can }) => can.root.removeFromParent());
    this.canBatch = null;
    this.stagedCans = null;
    this.cases.forEach((item) => item.carrier.removeFromParent());
    this.cases = [];
    this.pendingS3Box = null;
    this.canTransfer.retractPushers();
    this.canStock.refill();
    this.caseStock.refill();
    this.s1.resetCycle();
    this.s2.resetCycle();
    this.s3.cycle?.reset();
    this.notify();
  }

  setSpeed(multiplier) {
    this.speed = multiplier;
    this.s1.setCycleSpeed(multiplier);
    this.s2.setCycleSpeed(multiplier);
    this.s3.cycle?.setSpeed(multiplier);
    this.notify();
  }

  update(delta) {
    if (!this.visible) return;
    this.s1.update(delta);
    this.s2.update(delta);
    this.s3.update(delta);
    if (this.running) {
      const scaled = delta * this.speed;
      this.canSequencer.advance(scaled);
      this.updateCases(scaled);
      if (this.s3.cycle?.state === 'COMPLETE') {
        this.running = false;
        this.state = FACTORY_STATES.FINISHED_PALLET;
      }
    }
    this.notify();
  }

  get status() {
    const s1 = this.s1?.cycle?.status;
    const s2 = this.s2?.cycle?.status;
    const s3 = this.s3?.cycle;
    return {
      state: this.state,
      speed: this.speed,
      canStock: this.canStock?.remaining ?? 0,
      caseStock: this.caseStock?.remaining ?? 0,
      station1: s1 ? `${s1.state} · ${s1.step}` : '—',
      station2: s2 ? `${s2.state.replace(/_/g, ' ')} · ${s2.step}` : '—',
      station3: s3 ? s3.state.replace(/_/g, ' ') : '—',
      cansFilled: s1?.filledCount ?? 0,
      cansCapped: s1?.cappedCount ?? 0,
      casesPacked: s2?.boxesCompleted ?? 0,
      palletBoxes: s3 ? Math.min(s3.boxNumber, LAYOUT.palletBoxes) : 0,
      palletTotal: LAYOUT.palletBoxes,
      canTransfer: this.canBatch ? (this.canSequencer.active?.label ?? 'In transit') : this.stagedCans ? 'Staged at Station 2' : 'Empty',
      caseTransfer: `${this.cases.length} case${this.cases.length === 1 ? '' : 's'}`,
    };
  }

  notify() {
    this.onUpdate?.(this);
  }

  getBounds() {
    return this.root ? new THREE.Box3().setFromObject(this.root) : null;
  }
}
