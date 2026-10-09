import { getAssetConfig } from '../assets/AssetRegistry.js';
import { OilFillingStation } from './station-1/OilFillingStation.js';
import { CasePackingStation } from './station-2/CasePackingStation.js';
import { StationScene } from './station-3/StationScene.js';
import { LubricantFactory } from './factory/LubricantFactory.js';
import { FactoryOverlay } from './factory/FactoryOverlay.js';

// Built-in scenes: production lines built in code (this folder). Unlike scenes made in the
// editor they can't be changed, only run: Start, Reset, Speed and a live status read-out, all in
// one sidebar card that each scene fills from its `fields`.
//
// One is shown at a time. Station 3 and the factory get their own copy of the ABB robot with its
// built-in rig, so Machine mode's model is never borrowed and joint edits there can't break them.

const ROBOT_ID = 'abb_irb6760';
// The status read-out changes every frame; people can't read faster than this anyway.
const STATUS_REFRESH_SECONDS = 0.1;

const xyz = (vector) => vector.toArray().slice(0, 3).map((value) => value.toFixed(2)).join(', ');
const metres = (value) => (Number.isFinite(value) ? `${value.toFixed(3)} m` : '—');
const words = (value) => String(value).replace(/_/g, ' ');

// Station 1 and Station 2 share one interface: show/hide/startCycle/resetCycle/setCycleSpeed.
function cycleStation(station) {
  return {
    get root() { return station.root; },
    show: () => station.show(),
    hide: () => station.hide(),
    start: () => station.startCycle(),
    reset: () => station.resetCycle(),
    setSpeed: (speed) => station.setCycleSpeed(speed),
    update: (delta) => station.update(delta),
    // Station 1/2 report { status, running }.
    listen: (report) => station.setCycleUpdateHandler(({ status, running }) => report(status, running)),
  };
}

export const BUILT_IN_SCENES = [
  {
    id: 'factory',
    name: 'Factory · Lubricant Line',
    type: 'Station 1 → 2 → 3 as one continuous production line',
    description: 'Raw materials → filling → capping → case packing → palletizing → wrapping → finished pallet. Click a station to inspect it.',
    robot: true,
    create: ({ scene, renderer, cameraManager, controls, container }) => {
      const factory = new LubricantFactory({ scene, renderer });
      const overlay = new FactoryOverlay({ container, camera: cameraManager.camera, controls, domElement: renderer.domElement, factory });
      return {
        get root() { return factory.root; },
        async show(robot) {
          await factory.show(robot);
          cameraManager.frameObject(factory.root, controls);
          overlay.activate();
        },
        hide() {
          overlay.deactivate();
          factory.hide();
        },
        start: () => factory.start(),
        reset: () => factory.reset(),
        setSpeed: (speed) => factory.setSpeed(speed),
        update(delta) {
          factory.update(delta);
          overlay.update(delta);
        },
        listen: (report) => { factory.onUpdate = (line) => report(line.status, line.running); },
      };
    },
    fields: [
      ['Line State', (s) => words(s.state)],
      ['Jerry Can Supply', (s) => `${s.canStock} cans`],
      ['Carton Supply', (s) => `${s.caseStock} cartons`],
      ['Station 1', (s) => s.station1],
      ['Transfer 1 → 2', (s) => s.canTransfer],
      ['Station 2', (s) => s.station2],
      ['Transfer 2 → 3', (s) => s.caseTransfer],
      ['Station 3', (s) => s.station3],
      ['Cans Filled / Capped', (s) => `${s.cansFilled} / ${s.cansCapped}`],
      ['Cases Packed', (s) => s.casesPacked],
      ['Cases on Pallet', (s) => `${s.palletBoxes} / ${s.palletTotal}`],
    ],
  },
  {
    id: 'oil-station',
    name: 'Station 1 · Oil Filling & Capping',
    type: 'Procedural lubricant filling and capping line',
    description: 'Procedural lubricant line: conveyor, 4-head filler, oil tank and servo capper.',
    create: ({ scene, renderer, cameraManager, controls }) => cycleStation(new OilFillingStation({ scene, renderer, cameraManager, controls })),
    fields: [
      ['Process State', (s) => s.state],
      ['Current Step', (s) => s.step],
      ['Conveyor', (s) => s.mainConveyor],
      ['Outfeed', (s) => s.outfeedConveyor],
      ['Filling Head', (s) => s.fillingHead],
      ['Valves', (s) => s.valves],
      ['Capping Head', (s) => s.cappingHead],
      ['Fill Level', (s) => `${Math.round(s.fillLevel * 100)} %`],
      ['Filled / Capped', (s) => `${s.filledCount} / ${s.cappedCount}`],
      ['Output', (s) => s.outputCount],
      ['Machine Cycles', (s) => s.cycles],
    ],
  },
  {
    id: 'packing-station',
    name: 'Station 2 · Jerry Can Case Packing',
    type: 'Gantry robot packs 4 jerry cans per case',
    description: 'Two-lane can infeed, gantry pick-and-place with 2×2 handle grippers, carton line and case taper.',
    create: ({ scene, renderer, cameraManager, controls }) => cycleStation(new CasePackingStation({ scene, renderer, cameraManager, controls })),
    fields: [
      ['Process State', (s) => words(s.state)],
      ['Current Step', (s) => s.step],
      ['Input Conveyor', (s) => s.inputConveyor],
      ['Case Conveyor', (s) => s.boxConveyor],
      ['Robot', (s) => s.robot],
      ['Gripper', (s) => s.gripper],
      ['Cans in Case', (s) => `${s.cansInBox} / 4`],
      ['Cases Completed', (s) => s.boxesCompleted],
      ['Machine Cycles', (s) => s.cycles],
    ],
  },
  {
    id: 'station-3',
    name: 'Station 3 · Palletizing & Wrapping',
    type: 'Robot cell: conveyor, ABB robot and wrapping machine',
    description: 'ABB robot, procedural conveyor, pallet and stretch wrapper in a metre-based layout.',
    robot: true,
    debug: true,
    create: ({ scene, cameraManager, controls, floor }) => {
      const station = new StationScene({ scene, cameraManager, controls, floor });
      return {
        get root() { return station.root; },
        show: (robot) => station.show(robot),
        hide: () => {
          station.setDebug(false);
          station.hide();
        },
        start: () => station.startCycle(),
        reset: () => station.resetCycle(),
        setSpeed: (speed) => station.setCycleSpeed(speed),
        update: (delta) => station.update(delta),
        setDebug: (enabled) => station.setDebug(enabled),
        // Station 3 reports its cycle; it is busy unless idle or finished.
        listen: (report) => station.setCycleUpdateHandler((cycle) => report(cycle, cycle.state !== 'IDLE' && cycle.state !== 'COMPLETE')),
      };
    },
    fields: [
      ['Current Station State', (c) => c.state],
      ['Conveyor', (c) => c.conveyorState],
      ['Robot State', (c) => c.robotState],
      ['Gripper State', (c) => c.gripperState],
      ['Box State', (c) => c.boxState],
      ['Current Box', (c) => {
        const { columns, rows, layers } = c.layout.stack;
        const total = columns * rows * layers;
        return `${Math.min(c.boxNumber + 1, total)}/${total}`;
      }],
      ['TCP Position', (c) => xyz(c.getSuctionWorld())],
      ['Box Position', (c) => (c.box ? xyz(c.getBoxCenter()) : '—')],
      ['TCP → Box Distance', (c) => metres(c.distance)],
      ['Stack Target', (c) => (c.stackTarget ? xyz(c.stackTarget) : '—')],
      ['Position Error', (c) => metres(c.positionError)],
      ['Bottom Height', (c) => (c.bottomHeight ? metres(c.bottomHeight) : '—')],
      ['Box Rotation', (c) => xyz(c.rotation)],
    ],
  },
];

export const getBuiltInScene = (id) => BUILT_IN_SCENES.find((entry) => entry.id === id) || null;

export class BuiltInScenes {
  // context: { scene, renderer, cameraManager, controls, container, floor } for building scenes.
  // ui: the built-in scene card. onShown(root) fits floor and lights to a scene once it shows.
  constructor({ context, templates, ui, onShown, onError }) {
    this.context = context;
    this.templates = templates;
    this.ui = ui;
    this.onShown = onShown;
    this.onError = onError;
    this.runtimes = new Map();
    this.active = null;
    this.robot = null;
    this.opening = 0;
    this.refreshTimer = 0;

    // Start and Reset show their effect at once rather than at the next status refresh.
    ui.start.addEventListener('click', () => {
      this.active?.runtime.start();
      this.renderStatus();
    });
    ui.reset.addEventListener('click', () => {
      this.active?.runtime.reset();
      this.renderStatus();
    });
    ui.speed.addEventListener('change', () => this.active?.runtime.setSpeed(Number(ui.speed.value)));
    ui.debug.addEventListener('change', () => this.active?.runtime.setDebug?.(ui.debug.checked));
  }

  get activeId() {
    return this.active?.entry.id || null;
  }

  runtimeFor(entry) {
    if (!this.runtimes.has(entry.id)) {
      const runtime = entry.create(this.context);
      // Kept per scene: the first report comes while the scene is still opening.
      runtime.listen((status, running) => { runtime.latest = { status, running }; });
      this.runtimes.set(entry.id, runtime);
    }
    return this.runtimes.get(entry.id);
  }

  // The ABB copy Station 3 and the factory share (only one of them is shown at a time).
  async loadRobot() {
    if (!this.robot) {
      const config = getAssetConfig(ROBOT_ID);
      this.robot = await this.templates.createInstance(config, { rig: config.rig });
    }
    return this.robot;
  }

  async open(id) {
    const entry = getBuiltInScene(id);
    if (!entry) return false;
    this.close();
    const ticket = ++this.opening;
    const runtime = this.runtimeFor(entry);
    this.renderCard(entry);
    try {
      const robot = entry.robot ? await this.loadRobot() : null;
      if (ticket !== this.opening) return false;
      await runtime.show(robot);
    } catch (error) {
      console.error(`${entry.name} could not be opened.`, error);
      this.onError?.(`Couldn't open ${entry.name}: ${error.message || 'unknown error'}`);
      this.ui.card.hidden = true;
      return false;
    }
    // Leaving (or opening another scene) while this one was still loading.
    if (ticket !== this.opening) {
      runtime.hide();
      return false;
    }
    this.active = { entry, runtime };
    runtime.setSpeed(Number(this.ui.speed.value));
    this.onShown?.(runtime.root);
    this.renderStatus();
    return true;
  }

  close() {
    this.opening += 1;
    if (!this.active) {
      this.ui.card.hidden = true;
      return;
    }
    this.active.runtime.hide();
    this.active = null;
    this.ui.card.hidden = true;
    this.ui.debug.checked = false;
  }

  // ---- Sidebar card -----------------------------------------------------------------------

  renderCard(entry) {
    const { ui } = this;
    ui.title.textContent = entry.name;
    ui.description.textContent = entry.description;
    ui.debugRow.hidden = !entry.debug;
    ui.debug.checked = false;
    ui.start.disabled = false;
    this.valueCells = entry.fields.map(([label]) => {
      const row = document.createElement('div');
      const term = document.createElement('dt');
      term.textContent = label;
      const value = document.createElement('dd');
      value.textContent = '—';
      row.append(term, value);
      return { row, value };
    });
    ui.status.replaceChildren(...this.valueCells.map(({ row }) => row));
    ui.card.hidden = false;
    ui.card.open = true;
  }

  renderStatus() {
    const latest = this.active?.runtime.latest;
    if (!latest) return;
    const { status, running } = latest;
    this.active.entry.fields.forEach(([, read], index) => {
      let text;
      try {
        text = String(read(status) ?? '—');
      } catch {
        text = '—';
      }
      const cell = this.valueCells[index].value;
      if (cell.textContent !== text) cell.textContent = text;
    });
    this.ui.start.disabled = running;
  }

  update(deltaTime) {
    if (!this.active) return;
    this.active.runtime.update(deltaTime);
    this.refreshTimer += deltaTime;
    if (this.refreshTimer >= STATUS_REFRESH_SECONDS) {
      this.refreshTimer = 0;
      this.renderStatus();
    }
  }
}
