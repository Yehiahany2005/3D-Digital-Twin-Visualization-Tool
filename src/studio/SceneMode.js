import * as THREE from 'three';
import { ASSET_REGISTRY, getAssetConfig, registerImportedAsset } from '../assets/AssetRegistry.js';
import { getStoredImport, storeImport } from '../assets/ImportStore.js';
import { formatLabel, UNIT_SCALES, unsupportedFormatMessage } from '../loaders/ModelLoader.js';
import { loadRigByKey, saveRigByKey } from '../motion/RigStore.js';
import { cloneScene, dependentsOf, emptyScene, newId, parentOf } from './SceneDocument.js';
import { describeBody, Simulation } from './Simulation.js';
import { anchorNamed, anchorsOf } from './Anchors.js';
import { deleteScene, lastSceneId, listScenes, loadScene, rememberLastScene, saveScene } from './SceneStore.js';
import { buildBundle, downloadBlob, readBundle } from './SceneBundle.js';
import { currentRigDefinition, ModelTemplates } from './ModelTemplates.js';
import { SceneEditor } from './SceneEditor.js';
import { CATALOG, getComponent, resolveParams } from './catalog/index.js';
import { ExplorerPanel } from './ui/ExplorerPanel.js';
import { PropertiesPanel } from './ui/PropertiesPanel.js';
import { AddDrawer } from './ui/AddDrawer.js';
import { ThumbnailRenderer } from './thumbnails.js';
import { SelectionHighlight } from './SelectionHighlight.js';
import { ProgramPanel } from './ui/ProgramPanel.js';
import { ProgramMarkers } from './program/ProgramMarkers.js';
import { ProgramRunner } from './program/ProgramRunner.js';
import { WorkerRunner } from './program/WorkerRunner.js';
import { ReachChecker } from './program/ReachChecker.js';
import { targetFrame, targetFromHit, targetLabel } from './program/targets.js';
import { resolveTool } from '../motion/InverseKinematics.js';
import { reachFor } from './program/reachFor.js';
import { ContextMenu } from '../ui/ContextMenu.js';

const SAVE_DELAY_MS = 600;
const CAMERA_FLIGHT_SECONDS = 0.45;
const TOAST_MS = 6000;
const GRID_KEY = 'digital-twin:scene-grid';
// A right-click that moves further than this is a pan (right-drag), not a click.
const CLICK_TOLERANCE_PX = 5;
const POSE_CHECK_MS = 3000;
// Smallest area framed and lit, so an empty or tiny scene still has a sensible view.
const MIN_SCENE_SIZE = 6;

function readSetting(key) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeSetting(key, value) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Storage unavailable: the setting just isn't remembered.
  }
}

function isTyping(event) {
  return Boolean(event.target.closest?.('input, select, textarea, [contenteditable="true"]'));
}

// The scene editor: several models and parts together, built by drag and drop like a studio
// (Explorer, Properties, Add drawer, move/turn gizmo, Play). It is the "My scenes" half of the
// Scene tab (src/app/SceneTab.js); built-in scenes made in code are the other half.
//
// onSceneChange(scene) tells the tab the open scene's name or contents changed; onScenesSaved()
// that the list of saved scenes may have changed.
export class SceneMode {
  constructor({ scene, cameraManager, controls, renderer, picker, outline, reachPanel, floor, templates, ui, onStatus, onError, onEditInMachine, onEnvironmentChange, onSceneChange, onScenesSaved }) {
    this.scene = scene;
    this.floor = floor;
    this.cameraManager = cameraManager;
    this.controls = controls;
    this.picker = picker;
    this.reachPanel = reachPanel;
    this.ui = ui;
    this.onStatus = onStatus;
    this.onError = onError;
    this.onEditInMachine = onEditInMachine;
    this.onEnvironmentChange = onEnvironmentChange;
    this.onSceneChange = onSceneChange;
    this.onScenesSaved = onScenesSaved;
    this.active = false;
    this.opened = false;

    this.templates = templates || new ModelTemplates({ onStatus });
    this.thumbnails = new ThumbnailRenderer(renderer);
    this.editor = new SceneEditor({
      scene,
      camera: cameraManager.camera,
      domElement: renderer.domElement,
      controls,
      templates: this.templates,
      resolveConfig: (source) => this.resolveConfig(source),
      outline,
    });

    this.explorer = new ExplorerPanel({
      list: ui.explorerList,
      count: ui.explorerCount,
      filter: ui.explorerFilter,
      editor: this.editor,
      onFrame: (id) => this.frame(id),
      iconFor: (item, runtime) => this.iconFor(item, runtime),
      onContextMenu: (id, event) => this.openItemMenu(id, event.clientX, event.clientY),
      onHover: (id) => this.setHover(id),
    });
    this.menu = new ContextMenu();
    // What the pointer is over, lit up faintly (and named next to the pointer).
    this.hoverHighlight = new SelectionHighlight({ color: 0xffffff, opacity: 0.16 });
    this.hoveredId = null;
    // A floor grid of 1 m squares while laying things out, sized to the scene (see fitGrid).
    this.grid = this.makeGrid(20);
    this.gridWanted = readSetting(GRID_KEY) !== 'off';
    this.speed = 1;
    this.paused = false;
    // Robot programs: what each robot does when the scene plays.
    this.programMarkers = new ProgramMarkers(scene);
    this.programPanel = new ProgramPanel({
      editor: this.editor,
      markers: this.programMarkers,
      checker: new ReachChecker(),
      pickTarget: (options) => this.startTargetPick(options),
      previewReach: (itemId, point, orient) => this.previewReach(itemId, point, orient),
      runnerFor: (itemId) => this.runners?.get(itemId) || null,
    });
    this.properties = new PropertiesPanel({
      container: ui.properties,
      editor: this.editor,
      describeSource: (item, runtime) => this.describeSource(item, runtime),
      onEditInMachine: (item) => this.editInMachine(item),
      onRelink: (item) => this.relink(item),
      iconFor: (item, runtime) => this.iconFor(item, runtime),
      extraSections: [
        (item, runtime, panel) => this.paramsSection(item, runtime, panel),
        (item, runtime, panel) => this.programPanel.section(item, runtime, panel),
        (item, runtime, panel) => this.connectionsSection(item, runtime, panel),
        (item, runtime, panel) => this.physicsSection(item, runtime, panel),
      ],
    });
    this.drawer = new AddDrawer({
      drawer: ui.drawer,
      toggleButton: ui.addButton,
      editor: this.editor,
      picker,
      camera: cameraManager.camera,
      domElement: renderer.domElement,
      scene,
      entries: () => this.entries(),
      preview: (entry) => this.preview(entry),
      place: (entry, placement) => this.place(entry, placement),
      onImport: (file) => this.importFile(file),
      onOpenChange: (open) => {
        if (open) this.loadThumbnails();
        this.updateGuides();
      },
    });

    this.editor.onChange((type, detail) => {
      if (type === 'document') {
        this.scheduleSave();
        this.updateTitle();
        this.updateHistoryButtons();
        this.updateGuides();
      }
      if (type === 'history') this.updateHistoryButtons();
      if (type === 'selection') {
        this.setHover(null);
        if (this.attachPick && this.attachPick.item.id !== this.editor.selectedId) this.endAttachPick();
        if (this.targetPick && this.targetPick.robotId !== this.editor.selectedId) this.endTargetPick();
        this.bindReach();
        this.updateGuides();
      }
      if (type === 'item-ready') {
        if (detail?.id === this.editor.selectedId) this.bindReach();
        this.environmentChanged();
      }
      if (type === 'frame') this.frame(detail);
      if (type === 'removed') this.toast(`Deleted ${detail.names.length === 1 ? detail.names[0] : `${detail.names.length} objects`}`, { undo: true });
      if (type === 'status') this.onStatus?.(detail);
    });

    this.bindToolbar();
    this.bindFileControls();
    this.bindKeys();
    this.bindGuides();
    this.bindViewport(renderer.domElement);
  }

  // ---- Models, components and the Add drawer -----------------------------------------------------

  // A model referred to by a scene: built-in, or imported (kept in this browser).
  async resolveConfig(source) {
    if (source.kind === 'builtin') return getAssetConfig(source.id) || null;
    if (source.kind !== 'import') return null;
    const known = getAssetConfig(source.id);
    if (known) return known;
    const file = await getStoredImport(source.id);
    return file ? registerImportedAsset(file, { id: source.id, stored: true }) : null;
  }

  entries() {
    const models = ASSET_REGISTRY.filter((config) => !config.file && config.inScenes !== false).map((config) => ({
      key: `builtin:${config.id}`,
      name: config.name,
      subtitle: config.type,
      category: 'Robots & models',
      icon: config.rig ? 'Bot' : 'Box',
      source: { kind: 'builtin', id: config.id },
    }));
    const imports = ASSET_REGISTRY.filter((config) => config.file && config.stored).map((config) => ({
      key: `import:${config.id}`,
      name: config.name,
      subtitle: formatLabel(config.file.name),
      category: 'My models',
      icon: config.rig ? 'Bot' : 'Box',
      source: { kind: 'import', id: config.id, name: config.file.name },
    }));
    const components = CATALOG.map((component) => ({
      key: `catalog:${component.id}`,
      name: component.name,
      subtitle: component.description,
      category: component.category,
      icon: component.icon,
      thumbnail: this.thumbnails.get(component.id),
      source: { kind: 'catalog', id: component.id },
    }));
    return [...components, ...models, ...imports];
  }

  // Pictures for the drawer, drawn one at a time; the grid updates as each one is ready.
  loadThumbnails() {
    CATALOG.forEach((component) => {
      if (this.thumbnails.get(component.id) !== undefined) return;
      this.thumbnails.request(component.id, async () => component.build(resolveParams(component, {}))).then(() => {
        if (this.drawer.isOpen) this.drawer.renderGrid();
      });
    });
  }

  // What follows the pointer while placing: the real component (cheap), or for models a box of
  // the model's size (loading the model itself is the slow part, so it happens once, on placing).
  async preview(entry) {
    if (entry.source.kind === 'catalog') {
      const definition = getComponent(entry.source.id);
      const built = await definition.build(resolveParams(definition, entry.params));
      return { object: built.root, ghost: true, dispose: built.dispose };
    }
    const config = await this.resolveConfig(entry.source);
    if (!config) throw new Error('the model file is not on this computer.');
    const template = await this.templates.template(config);
    return { size: this.templateSize(template) };
  }

  // A model's size in metres, standing upright, without building a copy of it.
  templateSize(template) {
    if (!template.size) {
      const size = new THREE.Box3().setFromObject(template.content).getSize(new THREE.Vector3());
      if (template.upAxis === 'z') [size.y, size.z] = [size.z, size.y];
      template.size = size.multiplyScalar(UNIT_SCALES[template.units] ?? 1);
    }
    return template.size;
  }

  place(entry, { position, rotation }) {
    const { ready } = this.editor.addItem({ source: entry.source, name: entry.name, position, rotation, params: entry.params });
    ready.then(() => this.environmentChanged());
  }

  async importFile(file) {
    const formatError = unsupportedFormatMessage(file.name);
    if (formatError) {
      this.onError?.(formatError);
      return;
    }
    let id = null;
    try {
      id = await storeImport(file);
    } catch (error) {
      console.warn('Imported model could not be saved in this browser.', error);
      this.onError?.("This model couldn't be saved on this device (the browser may be out of space), so it can't be added to a scene.");
      return;
    }
    const config = getAssetConfig(id) || registerImportedAsset(file, { id, stored: true });
    this.drawer.setOpen(false);
    const placement = await this.freeSpotFor(config);
    const { ready } = this.editor.addItem({ source: { kind: 'import', id, name: file.name }, name: file.name.replace(/\.[^.]+$/, ''), position: placement.toArray() });
    this.onStatus?.(`Adding ${file.name}…`);
    await ready;
    this.onStatus?.(null);
    this.environmentChanged();
    this.frame(this.editor.selectedId);
  }

  // A spot on the floor beside everything already placed, so a new model doesn't land inside
  // another one.
  async freeSpotFor(config) {
    if (!this.editor.items.length) return this.dropPoint();
    let size = new THREE.Vector3(1, 1, 1);
    try {
      size = this.templateSize(await this.templates.template(config));
    } catch {
      // Unreadable files fail again (with a proper message) when the item is built.
    }
    const box = this.bounds();
    const center = box.getCenter(new THREE.Vector3());
    const spot = new THREE.Vector3(box.max.x + size.x / 2 + 0.5, 0, center.z);
    const snap = this.editor.snap || 0.1;
    spot.x = Math.ceil(spot.x / snap) * snap;
    spot.z = Math.round(spot.z / snap) * snap;
    return spot;
  }

  // The floor point in the middle of the view: where things go when there is nowhere better.
  dropPoint() {
    const target = this.controls.target.clone();
    target.y = 0;
    const snap = this.editor.snap || 0.1;
    target.x = Math.round(target.x / snap) * snap;
    target.z = Math.round(target.z / snap) * snap;
    return target;
  }

  async relink(item) {
    const input = document.createElement('input');
    input.type = 'file';
    input.addEventListener('change', async () => {
      const [file] = input.files;
      if (!file) return;
      let id;
      try {
        id = await storeImport(file);
      } catch {
        this.onError?.("The file couldn't be saved in this browser (it may be out of space).");
        return;
      }
      if (!getAssetConfig(id)) registerImportedAsset(file, { id, stored: true });
      // Every item that used the missing file now uses this one.
      const missingId = item.source.id;
      this.editor.commit(`Use ${file.name}`, (document) => {
        document.items.forEach((candidate) => {
          if (candidate.source.kind === 'import' && candidate.source.id === missingId) candidate.source = { kind: 'import', id, name: file.name };
        });
      });
    });
    input.click();
  }

  // Settings of a catalog part (length, speed…). Changing one rebuilds the part.
  paramsSection(item, runtime, panel) {
    if (item.source.kind !== 'catalog' || this.editor.playing) return null;
    const definition = getComponent(item.source.id);
    const specs = Object.entries(definition?.params || {});
    if (!specs.length) return null;
    const { node, body } = panel.group('settings', 'Settings');
    const grid = document.createElement('div');
    grid.className = 'placement-fields';
    const checks = [];
    const current = () => resolveParams(definition, this.editor.item(item.id)?.params);
    const write = (key, value) => {
      const params = { ...(this.editor.item(item.id).params || {}), [key]: value };
      this.editor.updateItem(item.id, { params }, `Change ${definition.params[key].label.toLowerCase()} of ${this.editor.item(item.id).name}`);
    };
    specs.forEach(([key, spec]) => {
      if (spec.type === 'number') {
        grid.append(panel.field({ label: spec.label, unit: spec.unit, step: spec.step, read: () => current()[key], write: (value) => write(key, value) }));
        return;
      }
      const wrapper = document.createElement('label');
      wrapper.className = spec.type === 'boolean' ? 'editor-check' : 'editor-field';
      if (spec.type === 'boolean') {
        const input = document.createElement('input');
        input.type = 'checkbox';
        const show = () => { input.checked = Boolean(current()[key]); };
        input.addEventListener('change', () => write(key, input.checked));
        show();
        panel.fields.push(show);
        wrapper.append(input, ` ${spec.label}`);
        checks.push(wrapper);
      } else {
        const select = document.createElement('select');
        spec.options.forEach((option) => select.append(new Option(option.label, option.value)));
        const show = () => { if (document.activeElement !== select) select.value = current()[key]; };
        select.addEventListener('change', () => write(key, select.value));
        show();
        panel.fields.push(show);
        wrapper.append(Object.assign(document.createElement('span'), { textContent: spec.label }), select);
        grid.append(wrapper);
      }
    });
    body.append(grid, ...checks);
    if (runtime?.kind === 'loading') body.append(Object.assign(document.createElement('p'), { className: 'editor-hint', textContent: 'Updating…' }));
    return node;
  }

  // Putting a tool on a robot, or making an object move along with another one (or one robot joint).
  connectionsSection(item, runtime, panel) {
    if (!runtime || runtime.kind === 'loading' || runtime.kind === 'missing' || this.editor.playing) return null;
    const { editor } = this;
    const linked = Boolean(item.mount || item.attach);
    const mountAnchor = anchorsOf(runtime).find((anchor) => anchor.type === 'tool-mount');
    // Open when it matters: the object is attached, or is a tool waiting for a robot.
    const { node, body } = panel.group(linked || mountAnchor ? 'attach-active' : 'attach', 'Attach', { open: Boolean(linked || mountAnchor) });
    const hint = (text) => body.append(Object.assign(document.createElement('p'), { className: 'editor-hint', textContent: text }));
    const row = () => {
      const element = document.createElement('div');
      element.className = 'button-row connection-row';
      body.append(element);
      return element;
    };
    const button = (label, run, title = label) => Object.assign(document.createElement('button'), { type: 'button', textContent: label, title, onclick: run });

    if (linked) {
      const parent = editor.item(parentOf(item));
      const joint = item.attach?.joint && editor.runtimes.get(item.attach.to)?.asset?.rig?.jointsById.get(item.attach.joint);
      hint(item.mount
        ? `On ${parent?.name}'s tool flange: it moves with the robot, and Reach uses its tip.`
        : `Moves with ${parent?.name}${joint ? ` (${joint.name})` : ''}.`);
      row().append(button(item.mount ? 'Take off the robot' : 'Stop moving with it', () => editor.unlinkItem(item.id), 'Leave it where it is, on its own'));
      return node;
    }

    // A tool can go on any robot that has a tool flange (its tool tip set up).
    if (mountAnchor) {
      const robots = editor.items.filter((other) => other.id !== item.id && anchorNamed(editor.runtimes.get(other.id), 'tool'));
      if (robots.length) {
        const select = document.createElement('select');
        select.setAttribute('aria-label', 'Robot');
        robots.forEach((robot) => select.append(new Option(robot.name, robot.id)));
        row().append(select, button('Put on', () => editor.mountItem(item.id, select.value, 'tool', mountAnchor.name), 'Put this tool on the robot\'s flange'));
        hint('Or drag it onto the end of the robot\'s arm: it snaps on.');
      } else {
        hint('Add a robot with a tool tip set up, then put this tool on it.');
      }
    }

    // Any object can move along with another one (a camera on a robot arm, a box on a pallet):
    // pick it in the view, or choose the object from a short list, then (for a robot) which part.
    const excluded = dependentsOf(editor.document, item.id);
    const targets = editor.items.filter((other) => other.id !== item.id && !excluded.has(other.id));
    if (targets.length) {
      body.append(Object.assign(document.createElement('span'), { className: 'editor-subtitle', textContent: 'Move along with' }));
      const pick = button('Pick it in the view', () => this.startAttachPick(item), 'Click the object (or the exact robot part) it should move with');
      pick.className = 'primary-button';
      row().append(pick);

      const target = document.createElement('select');
      target.setAttribute('aria-label', 'Object to move along with');
      target.append(new Option('…or choose an object', ''), ...targets.map((other) => new Option(other.name, other.id)));
      const attach = button('Attach', () => editor.attachItem(item.id, target.value, partRow.hidden ? null : part.value || null), 'It keeps its place and moves whenever that object moves');
      attach.disabled = true;
      row().append(target, attach);

      // Robots: the whole robot, or one of its arm parts (axes).
      const part = document.createElement('select');
      part.setAttribute('aria-label', 'Which part');
      const partRow = row();
      partRow.append(part);
      partRow.hidden = true;
      target.addEventListener('change', () => {
        const rig = editor.runtimes.get(target.value)?.asset?.rig;
        const joints = rig?.joints.filter((joint) => joint.kind === 'joint' && !joint.driven) || [];
        part.replaceChildren(new Option('The whole robot', ''), ...joints.map((joint) => new Option(`Its ${joint.name}`, joint.id)));
        partRow.hidden = !joints.length;
        attach.disabled = !target.value;
      });
    }
    return body.children.length ? node : null;
  }

  // How the object behaves when the scene plays; models can be made solid.
  physicsSection(item, runtime, panel) {
    if (!runtime || runtime.kind === 'loading' || runtime.kind === 'missing' || this.editor.playing) return null;
    const text = describeBody(item, runtime);
    if (runtime.kind !== 'model' && !text) return null;
    const { node, body } = panel.group('physics', 'When playing', { open: false });
    if (runtime.kind === 'model') {
      const label = document.createElement('label');
      label.className = 'editor-check';
      const input = Object.assign(document.createElement('input'), { type: 'checkbox', checked: Boolean(item.solid) });
      input.addEventListener('change', () => this.editor.updateItem(item.id, { solid: input.checked || undefined }, `${input.checked ? 'Make' : 'Stop making'} ${item.name} solid`));
      label.append(input, ' Solid: boxes bump into it');
      label.title = 'Boxes collide with its actual shape, part by part (moving parts too), and pass through the gaps between parts.';
      body.append(label);
    } else {
      body.append(Object.assign(document.createElement('p'), { className: 'editor-hint', textContent: text }));
    }
    return node;
  }

  // ---- Playing (physics, conveyors, box sources) -----------------------------------------------

  async togglePlay() {
    if (this.simulation) this.stopPlaying();
    else await this.startPlaying();
  }

  async startPlaying() {
    if (this.simulation || this.startingPlay) return;
    this.startingPlay = true;
    this.drawer.setOpen(false);
    await this.saveNow();
    clearInterval(this.poseTimer);
    this.editor.capturePoses();
    this.playStart = cloneScene(this.editor.document);
    const simulation = new Simulation(this.editor);
    this.ui.play.disabled = true;
    this.onStatus?.('Starting the simulation…');
    try {
      await simulation.start();
    } catch (error) {
      console.error('The simulation could not start.', error);
      this.onError?.(`The simulation couldn't start: ${error.message}`);
      this.ui.play.disabled = false;
      this.startingPlay = false;
      this.startPoseTimer();
      return;
    }
    this.onStatus?.(null);
    this.simulation = simulation;
    this.startingPlay = false;
    this.editor.playing = true;
    this.startPrograms(simulation);
    this.editor.updateGizmo();
    this.editor.emit('selection');
    this.updatePlayButton();
  }

  stopPlaying() {
    if (!this.simulation) return;
    this.runners?.forEach((runner) => runner.stop());
    this.runners = null;
    this.simulation.stop();
    this.simulation = null;
    this.editor.playing = false;
    // Everything back where the scene says it is: positions, poses, hidden items.
    this.editor.runtimes.forEach((runtime) => runtime.asset?.player.stop());
    this.editor.document = this.playStart;
    this.editor.reconcile({ applyPoses: true });
    this.editor.updateGizmo();
    this.editor.emit('selection');
    this.updatePlayButton();
    this.startPoseTimer();
  }

  updatePlayButton() {
    const playing = Boolean(this.simulation);
    this.ui.play.disabled = false;
    this.ui.play.classList.toggle('is-playing', playing);
    this.ui.playLabel.textContent = playing ? 'Stop' : 'Play';
    this.ui.play.title = playing ? 'Stop: everything goes back to where it was' : 'Play: gravity, conveyors and box sources run. Stop puts everything back.';
    this.ui.playStatus.hidden = !playing;
    this.ui.pause.hidden = !playing;
    this.ui.speed.hidden = !playing;
    if (!playing) this.setPaused(false);
    this.ui.toolbar.classList.toggle('is-playing', playing);
    [this.ui.addButton, this.ui.undo, this.ui.redo, this.ui.freeRotate, ...this.ui.toolButtons].forEach((button) => { button.disabled = playing; });
    if (!playing) this.updateHistoryButtons();
    this.updateGuides();
  }

  startPoseTimer() {
    clearInterval(this.poseTimer);
    this.poseTimer = setInterval(() => {
      if (this.editor.playing) return;
      this.editor.capturePoses();
      if (JSON.stringify(this.editor.document.items) !== this.lastSaved) this.scheduleSave();
    }, POSE_CHECK_MS);
  }

  iconFor(item, runtime) {
    if (item.source.kind === 'catalog') return getComponent(item.source.id)?.icon || 'Package';
    return runtime?.asset?.rig?.joints.length ? 'Bot' : 'Box';
  }

  describeSource(item, runtime) {
    if (item.source.kind === 'catalog') {
      const definition = getComponent(item.source.id);
      return definition ? `${definition.name} · ${definition.category}` : `Unknown part "${item.source.id}"`;
    }
    if (item.source.kind === 'builtin') return `${getAssetConfig(item.source.id)?.type || 'Model'} · built-in model`;
    const joints = runtime?.asset?.rig?.joints.length;
    return `Imported ${formatLabel(item.source.name || '')} file: ${item.source.name || item.source.id}${joints ? ` · ${joints} joints` : ''}`;
  }

  editInMachine(item) {
    this.saveNow();
    this.onEditInMachine?.(item.source.id);
  }

  // ---- Scene files ---------------------------------------------------------------------------------

  bindFileControls() {
    const { ui } = this;
    ui.sceneName.addEventListener('change', () => {
      const name = ui.sceneName.value.trim();
      if (!name) {
        ui.sceneName.value = this.editor.document.name;
        return;
      }
      this.editor.commit(`Rename scene to ${name}`, (document) => { document.name = name; });
    });
    ui.sceneName.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') ui.sceneName.blur();
    });
    ui.sceneDelete.addEventListener('click', () => this.deleteCurrent());
    ui.sceneCopy.addEventListener('click', () => this.duplicateScene());
    ui.sceneExport.addEventListener('click', () => this.exportScene());
  }

  // The scene to open: the one asked for, else the last one open, else the latest saved.
  async openLastOrNew(preferredId = null) {
    const id = preferredId || lastSceneId();
    let scene = id ? await loadScene(id).catch(() => null) : null;
    if (!scene) {
      const [latest] = await listScenes();
      scene = latest ? await loadScene(latest.id).catch(() => null) : null;
    }
    await this.show(scene || emptyScene('My first scene'));
  }

  async openScene(id) {
    if (id === this.editor.document.id) return;
    await this.saveNow();
    const scene = await loadScene(id).catch((error) => {
      this.onError?.(`Couldn't open that scene: ${error.message}`);
      return null;
    });
    if (scene) await this.show(scene);
    else this.onScenesSaved?.();
  }

  async newScene() {
    await this.saveNow();
    const names = new Set((await listScenes()).map((scene) => scene.name));
    let name = 'New scene';
    for (let counter = 2; names.has(name); counter += 1) name = `New scene ${counter}`;
    await this.show(emptyScene(name));
    await this.saveNow();
    this.ui.sceneName.focus();
    this.ui.sceneName.select();
  }

  async deleteCurrent() {
    const scene = this.editor.document;
    if (!window.confirm(`Delete the scene "${scene.name}" from this browser? Models it uses stay; only the layout is deleted.`)) return;
    clearTimeout(this.saveTimer);
    await deleteScene(scene.id).catch(() => {});
    const [next] = await listScenes();
    await this.show(next ? (await loadScene(next.id).catch(() => null)) || emptyScene('New scene') : emptyScene('New scene'));
    this.onStatus?.(`Scene "${scene.name}" deleted.`);
  }

  async show(scene) {
    this.stopPlaying();
    this.onStatus?.(`Opening ${scene.name}…`);
    try {
      await this.editor.setDocument(scene);
    } finally {
      this.onStatus?.(null);
    }
    rememberLastScene(scene.id);
    this.ui.sceneName.value = scene.name;
    this.updateTitle();
    this.onScenesSaved?.();
    if (scene.camera) this.restoreCamera(scene.camera);
    else this.applyFrame(null);
    this.environmentChanged();
    const missing = [...this.editor.runtimes.values()].filter((runtime) => runtime.kind === 'missing');
    if (missing.length) {
      this.onError?.(`${missing.length} model${missing.length === 1 ? ' is' : 's are'} not on this computer and show${missing.length === 1 ? 's' : ''} as a grey box. Select ${missing.length === 1 ? 'it' : 'one'} and use "Locate file…".`);
    }
  }

  scheduleSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveNow(), SAVE_DELAY_MS);
  }

  async saveNow() {
    clearTimeout(this.saveTimer);
    if (!this.opened) return;
    const scene = this.editor.document;
    this.editor.capturePoses();
    scene.camera = {
      position: this.cameraManager.camera.position.toArray().map((value) => Math.round(value * 1000) / 1000),
      target: this.controls.target.toArray().map((value) => Math.round(value * 1000) / 1000),
    };
    try {
      await saveScene(structuredClone(scene));
      this.lastSaved = JSON.stringify(scene.items);
      this.ui.saveState.textContent = 'Saved automatically';
      this.ui.saveState.title = 'Saved in this browser as you go. Export (the download button) makes a .dtscene file to keep it safe or send it to someone.';
      this.ui.saveState.classList.remove('is-error');
      this.onScenesSaved?.();
    } catch (error) {
      console.warn('Scene could not be saved.', error);
      this.ui.saveState.textContent = 'Not saved: the browser is out of space. Use Export to keep it.';
      this.ui.saveState.title = "Couldn't save in this browser (it may be out of space). Export (the download button) keeps this scene as a file.";
      this.ui.saveState.classList.add('is-error');
    }
  }

  async exportScene() {
    await this.saveNow();
    this.onStatus?.('Packing the scene…');
    try {
      const { blob, missing } = await buildBundle(structuredClone(this.editor.document), (source) => this.resolveConfig(source));
      downloadBlob(blob, `${this.editor.document.name.replace(/[^\w.-]+/g, '_') || 'scene'}.dtscene`);
      this.onStatus?.(null);
      if (missing.length) this.onError?.(`Exported, but ${missing.join(', ')} ${missing.length === 1 ? 'was' : 'were'} not on this computer and could not be included.`);
      else this.onStatus?.(`Exported "${this.editor.document.name}" (${(blob.size / 1e6).toFixed(1)} MB).`);
    } catch (error) {
      this.onStatus?.(null);
      this.onError?.(`Couldn't export the scene: ${error.message}`);
    }
  }

  async openFile(file) {
    await this.saveNow();
    this.onStatus?.(`Reading ${file.name}…`);
    let bundle;
    try {
      bundle = await readBundle(file);
    } catch (error) {
      this.onStatus?.(null);
      this.onError?.(`Couldn't open ${file.name}: ${error.message}`);
      return;
    }
    // The models travel with the scene: keep them in this browser like any import.
    const remap = new Map();
    for (const { id, file: model } of bundle.models) {
      try {
        const storedId = await storeImport(model);
        if (!getAssetConfig(storedId)) registerImportedAsset(model, { id: storedId, stored: true });
        remap.set(id, storedId);
      } catch {
        this.onError?.(`${model.name} couldn't be saved in this browser (it may be out of space).`);
      }
    }
    // Rigs: use the file's, unless this computer already has its own for that model.
    const kept = [];
    Object.entries(bundle.rigs).forEach(([key, rig]) => {
      const local = loadRigByKey(key);
      if (!local) saveRigByKey(key, rig);
      else if (JSON.stringify(local) !== JSON.stringify(rig)) kept.push(key.replace(/^(asset|file):/, '').split(':')[0]);
    });
    const scene = bundle.scene;
    scene.items.forEach((item) => {
      if (item.source.kind === 'import' && remap.has(item.source.id)) item.source.id = remap.get(item.source.id);
    });
    // Opened as a new scene, so it never overwrites one already here.
    scene.id = newId('scene');
    const names = new Set((await listScenes()).map((saved) => saved.name));
    if (names.has(scene.name)) {
      let counter = 2;
      while (names.has(`${scene.name} (${counter})`)) counter += 1;
      scene.name = `${scene.name} (${counter})`;
    }
    await this.show(scene);
    await this.saveNow();
    this.onStatus?.(`Opened "${scene.name}".`);
    if (kept.length) this.onError?.(`Kept this computer's own joint setup for ${kept.join(', ')} (the file had a different one).`);
  }

  // ---- Toolbar & keys ----------------------------------------------------------------------------

  bindToolbar() {
    const { ui } = this;
    ui.toolButtons.forEach((button) => {
      button.addEventListener('click', () => this.setTool(button.dataset.sceneTool));
    });
    ui.snap.addEventListener('change', () => this.editor.setSnap(Number(ui.snap.value)));
    ui.undo.addEventListener('click', () => this.editor.undo());
    ui.redo.addEventListener('click', () => this.editor.redo());
    ui.play.addEventListener('click', () => this.togglePlay());
    ui.pause.addEventListener('click', () => this.setPaused(!this.paused));
    ui.speed.addEventListener('change', () => { this.speed = Number(ui.speed.value) || 1; });
    ui.viewButtons.forEach((button) => button.addEventListener('click', () => this.view(button.dataset.sceneView)));
    ui.gridToggle.addEventListener('click', () => this.setGrid(!this.gridWanted));
    ui.freeRotate.addEventListener('click', () => this.setFreeRotation(!this.editor.freeRotation));
    this.setTool('move');
  }

  setTool(tool) {
    this.editor.setTool(tool);
    this.ui.toolButtons.forEach((button) => {
      const active = button.dataset.sceneTool === tool;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    this.updateGuides();
  }

  // Turning on the floor (default) or tilting freely about all three axes.
  setFreeRotation(free) {
    this.editor.setFreeRotation(free);
    this.ui.freeRotate.setAttribute('aria-pressed', String(free));
    this.ui.freeRotate.classList.toggle('is-active', free);
    if (free) this.setTool('rotate');
    this.onStatus?.(free ? 'Tilt on: Turn can now tip objects over in any direction (Tilt X / Tilt Z under Position).' : 'Tilt off: objects stay level and only turn on the floor.');
    this.updateGuides();
  }

  updateHistoryButtons() {
    const { ui, editor } = this;
    ui.undo.disabled = !editor.canUndo;
    ui.redo.disabled = !editor.canRedo;
    ui.undo.title = editor.canUndo ? `Undo ${editor.undoLabel} (Ctrl+Z)` : 'Nothing to undo';
    ui.redo.title = editor.canRedo ? `Redo ${editor.redoLabel} (Ctrl+Shift+Z)` : 'Nothing to redo';
  }

  bindKeys() {
    document.addEventListener('keydown', (event) => {
      if (!this.active || isTyping(event) || this.drawer.placing) return;
      const { editor } = this;
      if (event.key === 'Escape' && (this.attachPick || this.targetPick)) {
        event.preventDefault();
        this.endAttachPick();
        this.endTargetPick();
        return;
      }
      if (event.key === '?' || (event.key === 'Escape' && !this.ui.helpPanel.hidden)) {
        event.preventDefault();
        this.setHelpOpen(event.key === '?' && this.ui.helpPanel.hidden);
        return;
      }
      // While playing only selecting and framing work (and Ctrl+Enter stops).
      if (editor.playing && event.key === ' ') {
        event.preventDefault();
        this.setPaused(!this.paused);
        return;
      }
      if (editor.playing && !['escape', 'f', 'home'].includes(event.key.toLowerCase()) && !((event.ctrlKey || event.metaKey) && event.key === 'Enter')) return;
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault();
        this.togglePlay();
        return;
      }
      const key = event.key.toLowerCase();
      const command = event.ctrlKey || event.metaKey;
      const selected = editor.selectedId;
      let handled = true;
      if (command && key === 'z' && !event.shiftKey) editor.undo();
      else if (command && (key === 'y' || (key === 'z' && event.shiftKey))) editor.redo();
      else if (command && key === 'd' && selected) editor.duplicate(selected);
      else if (command && key === 's') this.saveNow();
      else if (command && key === 'c' && selected) this.copy(selected);
      else if (command && key === 'v') this.paste();
      else if (command) handled = false;
      // Not while working in the Selected panel (e.g. on a program step): that would delete the robot.
      else if ((key === 'delete' || key === 'backspace') && selected && !event.target.closest?.('.scene-selected-body')) editor.removeItems([selected]);
      else if (key === 'f') this.frame(selected);
      else if (key === 'home') this.frame(null);
      else if (key === 'f2') this.rename();
      else if (key === 'r' && selected) editor.turn(event.shiftKey ? -90 : 90);
      else if (key === 'q') this.setTool('select');
      else if (key === 'w') this.setTool('move');
      else if (key === 'e') this.setTool('rotate');
      else if (key === 't') this.setFreeRotation(!editor.freeRotation);
      else if (key === 'a') this.drawer.setOpen(!this.drawer.isOpen);
      else if (key === 'escape' && selected && !this.reachPanel.active) editor.select(null);
      else if (key === 'arrowleft' && selected) editor.nudge(-1, 0);
      else if (key === 'arrowright' && selected) editor.nudge(1, 0);
      else if (key === 'arrowup' && selected) editor.nudge(0, -1);
      else if (key === 'arrowdown' && selected) editor.nudge(0, 1);
      else handled = false;
      if (handled) event.preventDefault();
    });
  }

  // ---- Attaching by clicking in the view ---------------------------------------------------------

  // The next click in the view chooses what `item` moves along with: an object, or the robot
  // part (joint) under the pointer. The hint line names it while hovering.
  startAttachPick(item) {
    const { editor } = this;
    const excluded = dependentsOf(editor.document, item.id);
    const resolve = (hit) => {
      const targetId = hit && editor.itemIdFor(hit.object);
      if (!targetId || targetId === item.id || excluded.has(targetId)) return null;
      const rig = editor.runtimes.get(targetId)?.asset?.rig;
      let joint = null;
      for (let current = hit.object; current && !current.userData.sceneItemId && !joint; current = current.parent) {
        const candidate = current.userData.rigJointId !== undefined && rig?.jointsById.get(current.userData.rigJointId);
        if (candidate && candidate.kind === 'joint' && !candidate.driven) joint = candidate;
      }
      return { target: editor.item(targetId), joint };
    };
    // What a click would attach to, tinted amber: the object, or the arm from that joint outward.
    this.pickHighlight ??= new SelectionHighlight({ color: 0xf2c46d });
    this.attachPick = { item, label: null };
    this.picker.setHandler((hit) => {
      const found = resolve(hit);
      if (!found) {
        this.onStatus?.(hit ? 'Pick something else: not the object itself, nor anything that moves with it.' : 'Click an object in the view, or Esc to cancel.');
        return;
      }
      this.endAttachPick();
      editor.attachItem(item.id, found.target.id, found.joint?.id ?? null);
    }, () => editor.root, {
      owner: 'attach',
      hover: (hit) => {
        if (!this.attachPick) return;
        const found = resolve(hit);
        this.attachPick.label = found ? `${found.target.name}${found.joint ? ` (${found.joint.name})` : ''}` : null;
        this.pickHighlight.set(found ? [found.joint ? found.joint.group : editor.runtimes.get(found.target.id).root] : []);
        this.updateGuides();
      },
      onRelease: () => this.endAttachPick({ released: true }),
    });
    this.updateGuides();
  }

  endAttachPick({ released = false } = {}) {
    if (!this.attachPick) return;
    this.attachPick = null;
    this.pickHighlight?.clear();
    if (!released && this.picker.owner === 'attach') this.picker.setHandler(null);
    this.updateGuides();
  }

  // ---- Robot programs ------------------------------------------------------------------------------

  // Every robot (and worker) with a program starts it when the scene plays.
  startPrograms(simulation) {
    this.runners = new Map();
    this.reportedErrors = new Set();
    this.editor.items.forEach((item) => {
      const runtime = this.editor.runtimes.get(item.id);
      if (!item.program?.steps?.length || item.hidden) return;
      const Runner = runtime?.asset?.rig ? ProgramRunner : runtime?.component?.palletJack ? WorkerRunner : null;
      if (!Runner) return;
      this.runners.set(item.id, new Runner({ editor: this.editor, simulation, itemId: item.id, onChange: (runner) => this.programChanged(runner) }));
    });
    this.runners.forEach((runner) => runner.start());
  }

  // A robot that had to stop says why (once), over the 3D view.
  programChanged(runner) {
    if (!runner.error || this.reportedErrors?.has(runner.itemId)) return;
    this.reportedErrors.add(runner.itemId);
    this.onError?.(`${runner.name} stopped: ${runner.error.message}`);
  }

  // The next click in the view chooses a spot for a program step (snapping to conveyor ends and
  // tops of things), on another object or the floor.
  startTargetPick({ purpose, onPicked }) {
    this.endAttachPick();
    this.endTargetPick();
    const { editor } = this;
    const robotId = editor.selectedId;
    const own = new Set([robotId, ...dependentsOf(editor.document, robotId)]);
    const resolve = (hit) => {
      const target = targetFromHit(editor, hit, this.floor);
      return target && !(target.item && own.has(target.item)) ? target : null;
    };
    this.targetPick = { purpose, robotId, label: null };
    this.picker.setHandler((hit) => {
      const target = resolve(hit);
      if (!target) {
        this.onStatus?.('Click a spot on another object, or on the floor. Esc cancels.');
        return;
      }
      this.endTargetPick();
      onPicked(target);
    }, () => [editor.root, this.floor].filter(Boolean), {
      owner: 'program-target',
      hover: (hit) => {
        if (!this.targetPick) return;
        const target = resolve(hit);
        this.targetPick.label = target ? targetLabel(editor, target) : null;
        this.programMarkers.showHover(target ? targetFrame(editor, target)?.position : null);
        this.updateGuides();
      },
      onRelease: () => this.endTargetPick({ released: true }),
    });
    this.updateGuides();
  }

  endTargetPick({ released = false } = {}) {
    if (!this.targetPick) return;
    this.targetPick = null;
    this.programMarkers.clear();
    if (!released && this.picker.owner === 'program-target') this.picker.setHandler(null);
    this.updateGuides();
  }

  // "Show me": moves the robot's tool tip to a step's spot now, while editing.
  async previewReach(itemId, point, orient = 'down') {
    if (!point || this.editor.playing) return;
    const asset = this.editor.runtimes.get(itemId)?.asset;
    const rig = asset?.rig;
    const tool = rig?.tools[0] ? resolveTool(rig, rig.tools[0]) : null;
    if (!tool) {
      this.onError?.('This robot has no tool tip yet: put a gripper on it, or set its tool tip with Reach → Tool tip.');
      return;
    }
    const result = reachFor(rig, tool, point, orient === 'any' ? null : new THREE.Vector3(0, -1, 0));
    if (!result.reached) {
      this.onError?.('The robot can\'t reach that spot with its tool pointing that way.');
      return;
    }
    await asset.player.moveTo(result.values, { label: 'Showing the spot' });
  }

  // ---- Pointer in the 3D view: hover, right-click -----------------------------------------------

  bindViewport(domElement) {
    this.domElement = domElement;
    let rightDown = null;
    domElement.addEventListener('pointermove', (event) => {
      this.pointer = { x: event.clientX, y: event.clientY };
    });
    domElement.addEventListener('pointerleave', () => {
      this.pointer = null;
      this.setHover(null);
    });
    domElement.addEventListener('pointerdown', (event) => {
      // Clicking in the view finishes typing in a field (saving it), so shortcuts work again.
      if (document.activeElement?.matches?.('input, select, textarea')) document.activeElement.blur();
      if (event.button === 2) rightDown = { x: event.clientX, y: event.clientY };
      else this.setHover(null);
    });
    // Right-click (not right-drag, which pans) opens the menu for what is under the pointer.
    domElement.addEventListener('pointerup', (event) => {
      if (event.button !== 2 || !rightDown || !this.active) return;
      const moved = Math.hypot(event.clientX - rightDown.x, event.clientY - rightDown.y);
      rightDown = null;
      if (moved > CLICK_TOLERANCE_PX || this.picker.owner !== 'scene') return;
      const hit = this.hitAt(event.clientX, event.clientY);
      const id = hit?.object && this.editor.itemIdFor(hit.object);
      if (id) {
        this.editor.select(id);
        this.openItemMenu(id, event.clientX, event.clientY);
      } else {
        this.openSceneMenu(event.clientX, event.clientY, this.floorPointAt(event.clientX, event.clientY));
      }
    });
  }

  raycastAt(x, y) {
    const rect = this.domElement.getBoundingClientRect();
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(new THREE.Vector2(((x - rect.left) / rect.width) * 2 - 1, -((y - rect.top) / rect.height) * 2 + 1), this.cameraManager.camera);
    return raycaster;
  }

  hitAt(x, y) {
    return this.raycastAt(x, y).intersectObject(this.editor.root, true)
      .find((hit) => hit.object.isMesh && hit.object.visible && !hit.object.userData.helper) || null;
  }

  floorPointAt(x, y) {
    return this.raycastAt(x, y).ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), new THREE.Vector3());
  }

  hoverAt(hit, event) {
    if (!event || this.editor.gizmoBusy || this.menu.isOpen) {
      this.setHover(null);
      return;
    }
    this.setHover(hit ? this.editor.itemIdFor(hit.object) : null, event);
  }

  // Lights up an item the pointer is over (not the selected one), and names it by the pointer.
  setHover(id, event = null) {
    const item = id && id !== this.editor.selectedId ? this.editor.item(id) : null;
    const hoveredId = item?.id || null;
    if (hoveredId !== this.hoveredId) {
      this.hoveredId = hoveredId;
      this.hoverHighlight.set(item ? [this.editor.runtimes.get(item.id)?.root].filter(Boolean) : []);
      if (this.picker.owner === 'scene') this.domElement.style.cursor = item ? 'pointer' : 'default';
    }
    const label = this.ui.hoverLabel;
    label.hidden = !item || !event;
    if (item && event) {
      const rect = this.domElement.getBoundingClientRect();
      label.textContent = item.name;
      label.style.transform = `translate(${event.clientX - rect.left + 14}px, ${event.clientY - rect.top + 16}px)`;
    }
  }

  openItemMenu(id, x, y) {
    const { editor } = this;
    const item = editor.item(id);
    if (!item) return;
    this.setHover(null);
    const playing = editor.playing;
    const runtime = editor.runtimes.get(id);
    const linked = Boolean(item.mount || item.attach);
    const robot = runtime?.asset?.rig?.joints.length;
    const toggle = (key, label) => editor.updateItem(id, { [key]: item[key] ? undefined : true }, `${label} ${item.name}`);
    const items = [
      { label: 'Zoom to it', icon: 'Focus', shortcut: 'F', run: () => this.frame(id) },
      { label: 'Rename', icon: 'Pencil', shortcut: 'F2', run: () => this.rename(), disabled: playing },
      'separator',
      { label: 'Duplicate', icon: 'Copy', shortcut: 'Ctrl+D', run: () => editor.duplicate(id), disabled: playing },
      { label: 'Copy', icon: 'ClipboardCopy', shortcut: 'Ctrl+C', run: () => this.copy(id) },
      { label: 'Paste', icon: 'ClipboardPaste', shortcut: 'Ctrl+V', run: () => this.paste(), disabled: playing || !this.clipboard },
      'separator',
      { label: item.hidden ? 'Show' : 'Hide', icon: item.hidden ? 'Eye' : 'EyeOff', run: () => toggle('hidden', item.hidden ? 'Show' : 'Hide'), disabled: playing },
      { label: item.locked ? 'Unlock' : 'Lock in place', icon: item.locked ? 'LockOpen' : 'Lock', run: () => toggle('locked', item.locked ? 'Unlock' : 'Lock'), disabled: playing },
      linked
        ? { label: item.mount ? 'Take off the robot' : 'Stop moving with it', icon: 'Unlink', run: () => editor.unlinkItem(id), disabled: playing }
        : { label: 'Move along with…', icon: 'Link', run: () => this.startAttachPick(item), disabled: playing || editor.items.length < 2 },
    ];
    if (robot) items.push({ label: 'Edit its program', icon: 'ListVideo', run: () => this.revealGroup('Program') });
    items.push('separator', { label: 'Delete', icon: 'Trash2', shortcut: 'Del', danger: true, run: () => editor.removeItems([id]), disabled: playing });
    this.menu.open({ x, y, title: item.name, items });
  }

  openSceneMenu(x, y, point) {
    const playing = this.editor.playing;
    this.menu.open({
      x,
      y,
      items: [
        { label: this.clipboard ? `Paste ${this.clipboard.name} here` : 'Paste here', icon: 'ClipboardPaste', shortcut: 'Ctrl+V', run: () => this.paste(point), disabled: playing || !this.clipboard || !point },
        { label: 'Add something…', icon: 'Plus', shortcut: 'A', run: () => this.drawer.setOpen(true), disabled: playing },
        'separator',
        { label: 'See everything', icon: 'Scan', shortcut: 'Home', run: () => this.frame(null) },
        { label: 'View from above', icon: 'Eye', run: () => this.view('top') },
        { label: 'View from the front', icon: 'Eye', run: () => this.view('front') },
      ],
    });
  }

  // Opens a group of the Selected panel (e.g. a robot's Program) and scrolls to it.
  revealGroup(title) {
    const group = [...this.ui.properties.querySelectorAll('.prop-group')].find((node) => node.querySelector(':scope > summary span')?.textContent === title);
    if (!group) return;
    group.open = true;
    group.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }

  // F2: rename the selected object (its name in the Selected panel), or the scene.
  rename() {
    const field = this.editor.selectedId ? this.ui.properties.querySelector('.prop-name') : this.ui.sceneName;
    field?.focus();
    field?.select();
  }

  // ---- Copy & paste -------------------------------------------------------------------------------

  copy(id) {
    const item = this.editor.item(id);
    if (!item) return;
    this.editor.capturePoses();
    const fresh = this.editor.item(id);
    const root = this.editor.runtimes.get(id)?.root;
    root?.updateMatrixWorld(true);
    const position = root ? root.getWorldPosition(new THREE.Vector3()).toArray() : fresh.position;
    this.clipboard = { ...this.editor.copyFields(fresh), name: fresh.name, position, rotation: [...fresh.rotation] };
    this.pastes = 0;
    this.onStatus?.(`Copied ${fresh.name}. Ctrl+V pastes it where the pointer is.`);
  }

  // Pastes where the pointer is on the floor (or at `point`); otherwise next to the original.
  paste(point = null) {
    const copy = this.clipboard;
    if (!copy || this.editor.playing) return;
    const snap = this.editor.snap || 0;
    const at = point || (this.pointer && this.floorPointAt(this.pointer.x, this.pointer.y));
    this.pastes = (this.pastes || 0) + 1;
    const position = at
      ? [at.x, copy.position[1], at.z]
      : [copy.position[0] + 0.5 * this.pastes, copy.position[1], copy.position[2] + 0.5 * this.pastes];
    if (snap > 0) [0, 2].forEach((axis) => { position[axis] = Math.round(position[axis] / snap) * snap; });
    const { ready } = this.editor.addItem({ ...copy, position, label: `Paste ${copy.name}` });
    ready.then(() => this.environmentChanged());
  }

  // ---- Toast with Undo ------------------------------------------------------------------------------

  toast(text, { undo = false } = {}) {
    const { ui } = this;
    clearTimeout(this.toastTimer);
    ui.toastText.textContent = text;
    ui.toastUndo.hidden = !undo;
    ui.toast.hidden = false;
    this.toastTimer = setTimeout(() => { ui.toast.hidden = true; }, TOAST_MS);
  }

  // ---- Playing: pause and speed ---------------------------------------------------------------------

  setPaused(paused) {
    this.paused = Boolean(paused && this.simulation);
    this.ui.pause.classList.toggle('is-paused', this.paused);
    this.ui.pauseLabel.textContent = this.paused ? 'Resume' : 'Pause';
    this.ui.toolbar.classList.toggle('is-paused', this.paused);
    this.updateGuides();
  }

  // ---- Scene copies -----------------------------------------------------------------------------------

  async duplicateScene() {
    await this.saveNow();
    const copy = cloneScene(this.editor.document);
    copy.id = newId('scene');
    const names = new Set((await listScenes()).map((scene) => scene.name));
    let name = `${copy.name} copy`;
    for (let counter = 2; names.has(name); counter += 1) name = `${copy.name} copy ${counter}`;
    copy.name = name;
    await this.show(copy);
    await this.saveNow();
    this.onStatus?.(`Made a copy: "${name}". The original is unchanged.`);
  }

  // ---- Guidance: empty scene card, hint line, help -------------------------------------------------

  bindGuides() {
    const { ui } = this;
    ui.toastUndo.addEventListener('click', () => {
      this.editor.undo();
      ui.toast.hidden = true;
    });
    ui.emptyAdd.addEventListener('click', () => this.drawer.setOpen(true));
    ui.help.addEventListener('click', () => this.setHelpOpen(ui.helpPanel.hidden));
    ui.helpClose.addEventListener('click', () => this.setHelpOpen(false));
    document.addEventListener('pointerdown', (event) => {
      if (!ui.helpPanel.hidden && !ui.helpPanel.contains(event.target) && !ui.help.contains(event.target)) this.setHelpOpen(false);
    });
  }

  setHelpOpen(open) {
    this.ui.helpPanel.hidden = !open;
    this.ui.help.setAttribute('aria-expanded', String(open));
    this.ui.help.classList.toggle('is-active', open);
  }

  // An empty scene shows how to start; otherwise one line says what can be done right now.
  updateGuides() {
    const { ui, editor } = this;
    const quiet = !this.active || this.drawer.isOpen;
    const empty = !editor.items.length;
    ui.empty.hidden = quiet || !empty || editor.playing;
    const text = quiet || empty ? '' : this.hintText();
    ui.hint.hidden = !text;
    ui.hint.textContent = text;
  }

  hintText() {
    const { editor } = this;
    if (editor.playing && this.paused) return 'Paused · Space carries on · Stop (Ctrl+Enter) puts everything back.';
    if (editor.playing) return 'Playing: conveyors run and boxes fall · Space pauses · Stop (Ctrl+Enter) puts everything back.';
    if (this.targetPick) {
      const { purpose, label } = this.targetPick;
      return `Click where to ${purpose}${label ? `: ${label}` : ' (on an object or the floor)'} · Esc cancels`;
    }
    if (this.attachPick) {
      const { item, label } = this.attachPick;
      return `Click what ${item.name} should move with${label ? `: ${label}` : ''} · Esc cancels`;
    }
    const item = editor.selectedItem;
    if (!item) return 'Click an object to select it · right-click for more · drag empty space to look around · A adds more';
    const blocker = editor.moveBlocker(item);
    if (blocker) return blocker;
    if (editor.tool === 'select') return `${item.name} selected · W to move it · E to turn it · F to frame it`;
    if (editor.tool === 'rotate') {
      return editor.freeRotation ? `Drag a ring to tip ${item.name} over · T to stop tilting` : `Drag the ring to turn ${item.name} · R turns it 90°`;
    }
    return `Drag an arrow to slide ${item.name} · drag a square to slide it flat · R turns it 90° · Delete removes it`;
  }

  // ---- Selecting in the 3D view & Reach ------------------------------------------------------------

  handleClick(hit) {
    if (this.editor.gizmoBusy) return;
    this.editor.select(hit ? this.editor.itemIdFor(hit.object) : null);
  }

  // Reach (and its tool tip) works on the selected item when it is a machine with joints.
  bindReach() {
    if (!this.active) return;
    const asset = this.editor.selectedRuntime?.asset;
    if (asset?.rig?.joints.length) {
      if (this.reachPanel.asset !== asset) {
        this.reachPanel.setActive(false);
        this.reachPanel.setAsset(asset);
      }
      this.reachPanel.setHidden(false);
    } else {
      this.reachPanel.setActive(false);
      this.reachPanel.setHidden(true);
    }
  }

  // ---- Camera & environment ------------------------------------------------------------------------

  // Bounds of an item or of the whole scene, never smaller than MIN_SCENE_SIZE.
  bounds(id = null) {
    const box = new THREE.Box3();
    const roots = id ? [this.editor.runtimes.get(id)?.root].filter(Boolean) : this.editor.itemRoots();
    roots.forEach((root) => box.expandByObject(root));
    if (box.isEmpty()) box.setFromCenterAndSize(new THREE.Vector3(0, 1, 0), new THREE.Vector3(MIN_SCENE_SIZE, 2, MIN_SCENE_SIZE));
    return box;
  }

  // Points the camera at an item (or the whole scene), flying there smoothly.
  frame(id) {
    this.flyTo(() => this.applyFrame(id));
  }

  applyFrame(id) {
    const box = this.bounds(id);
    const helper = new THREE.Mesh(new THREE.BoxGeometry(...box.getSize(new THREE.Vector3()).toArray()));
    box.getCenter(helper.position);
    helper.updateMatrixWorld(true);
    this.cameraManager.frameObject(helper, this.controls);
    helper.geometry.dispose();
  }

  // apply() puts the camera where it should end up; the camera then flies there from where it is.
  flyTo(apply) {
    const { camera } = this.cameraManager;
    const from = { position: camera.position.clone(), target: this.controls.target.clone() };
    apply();
    const to = { position: camera.position.clone(), target: this.controls.target.clone() };
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    camera.position.copy(from.position);
    this.controls.target.copy(from.target);
    this.cameraFlight = { from, to, start: performance.now() };
  }

  // Timed by the clock, not by frames, so a slow frame doesn't make the flight drag on.
  updateCameraFlight() {
    const flight = this.cameraFlight;
    if (!flight) return;
    const t = Math.min(1, (performance.now() - flight.start) / (CAMERA_FLIGHT_SECONDS * 1000));
    const eased = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
    this.cameraManager.camera.position.lerpVectors(flight.from.position, flight.to.position, eased);
    this.controls.target.lerpVectors(flight.from.target, flight.to.target, eased);
    if (t >= 1) this.cameraFlight = null;
  }

  // The camera buttons: everything, the selection, from above, from the front.
  view(kind) {
    if (kind === 'all') return this.frame(null);
    if (kind === 'selected') return this.frame(this.editor.selectedId);
    const direction = kind === 'top' ? new THREE.Vector3(0, 1, 0.001) : new THREE.Vector3(0, 0.3, 1);
    return this.flyTo(() => {
      this.applyFrame(null);
      const distance = this.cameraManager.camera.position.distanceTo(this.controls.target);
      this.cameraManager.camera.position.copy(this.controls.target).addScaledVector(direction.normalize(), distance);
    });
  }

  // A grid `size` metres across. Kept within the camera's range: lines that run far past it can
  // be dropped whole by some graphics drivers instead of being cut short.
  makeGrid(size) {
    const grid = new THREE.GridHelper(size, size, 0x3a4045, 0x4b5258);
    grid.material.transparent = true;
    grid.material.opacity = 0.45;
    grid.material.depthWrite = false;
    // A centimetre up: any closer and the floor can hide it (depth precision).
    grid.position.y = 0.01;
    grid.visible = false;
    grid.userData.helper = true;
    grid.userData.size = size;
    grid.raycast = () => {};
    this.scene.add(grid);
    return grid;
  }

  // Grows the grid with the scene: three times its width (at least 20 m), centred under it.
  fitGrid(box) {
    const size = box.getSize(new THREE.Vector3());
    const span = Math.min(200, Math.max(20, Math.ceil((Math.max(size.x, size.z) * 3) / 2) * 2));
    if (span !== this.grid.userData.size) {
      const visible = this.grid.visible;
      this.grid.removeFromParent();
      this.grid.geometry.dispose();
      this.grid.material.dispose();
      this.grid = this.makeGrid(span);
      this.grid.visible = visible;
    }
    const center = box.getCenter(new THREE.Vector3());
    this.grid.position.x = Math.round(center.x);
    this.grid.position.z = Math.round(center.z);
  }

  setGrid(on) {
    this.gridWanted = on;
    writeSetting(GRID_KEY, on ? 'on' : 'off');
    this.ui.gridToggle.setAttribute('aria-pressed', String(on));
    this.ui.gridToggle.classList.toggle('is-on', on);
    this.grid.visible = this.active && on;
  }

  restoreCamera({ position, target }) {
    if (!position || !target) return;
    this.cameraManager.camera.position.fromArray(position);
    this.controls.target.fromArray(target);
    this.controls.update();
  }

  // The floor, lights and Digital Twin View follow the scene's size and contents.
  environmentChanged() {
    if (!this.active) return;
    clearTimeout(this.environmentTimer);
    this.environmentTimer = setTimeout(() => {
      const box = this.bounds();
      const size = box.getSize(new THREE.Vector3());
      const span = Math.max(size.x, size.z, MIN_SCENE_SIZE);
      this.onEnvironmentChange?.(this.editor.root, span);
      this.fitGrid(box);
    }, 50);
  }

  // ---- Entering and leaving ----------------------------------------------------------------------------

  // sceneId: open that saved scene (default: the one open last time).
  async enter(sceneId = null) {
    this.active = true;
    this.ui.toolbar.hidden = false;
    this.editor.setShown(true);
    this.picker.setDefault((hit) => this.handleClick(hit), () => this.editor.root, {
      owner: 'scene',
      cursor: 'default',
      hover: (hit, event) => this.hoverAt(hit, event),
    });
    this.ui.viewTools.hidden = false;
    this.setGrid(this.gridWanted);
    this.reachPanel.setExtraTargets(() => this.editor.itemRoots());
    if (!this.opened) {
      this.opened = true;
      await this.openLastOrNew(sceneId);
    } else if (sceneId && sceneId !== this.editor.document.id) {
      await this.openScene(sceneId);
    } else {
      // Rigs edited in Machine mode meanwhile: rebuild the copies that use them.
      const rebuilt = this.editor.refreshRigs((config) => JSON.stringify(currentRigDefinition(config)));
      if (rebuilt) this.onStatus?.(`Updated ${rebuilt} model${rebuilt === 1 ? '' : 's'} with the joints set up in Machine mode.`);
      if (this.editor.document.camera) this.restoreCamera(this.editor.document.camera);
      this.environmentChanged();
    }
    this.bindReach();
    this.startPoseTimer();
    this.updateGuides();
  }

  exit() {
    if (!this.active) return;
    this.stopPlaying();
    this.saveNow();
    clearInterval(this.poseTimer);
    this.active = false;
    this.endAttachPick();
    this.endTargetPick();
    this.programPanel.detach();
    this.setHover(null);
    this.menu.close();
    this.cameraFlight = null;
    this.ui.viewTools.hidden = true;
    this.ui.toast.hidden = true;
    this.grid.visible = false;
    this.drawer.setOpen(false);
    this.ui.toolbar.hidden = true;
    this.setHelpOpen(false);
    this.editor.select(null);
    this.editor.setShown(false);
    this.picker.setDefault(null);
    // Reach belongs to the selected item; nothing selected here once the editor is left.
    this.reachPanel.setHidden(true);
    this.reachPanel.setExtraTargets(null);
    this.editor.runtimes.forEach((runtime) => runtime.asset?.player.stop());
    this.updateGuides();
  }

  updateTitle() {
    const scene = this.editor.document;
    this.onSceneChange?.(scene);
    if (document.activeElement !== this.ui.sceneName) this.ui.sceneName.value = scene.name;
  }

  update(frameTime) {
    if (!this.active) return;
    this.updateCameraFlight();
    // Paused: everything holds still. Otherwise the scene runs at the chosen speed.
    const deltaTime = this.simulation ? (this.paused ? 0 : frameTime * this.speed) : frameTime;
    // Programs decide first, robots then move, and physics follows (held boxes go with the tool).
    this.runners?.forEach((runner) => runner.update(deltaTime));
    if (deltaTime > 0) this.editor.update(deltaTime);
    if (this.simulation && deltaTime > 0) {
      this.simulation.step(deltaTime);
      this.playTime = (this.playTime || 0) + deltaTime;
      if (this.playTime > 0.25) {
        this.playTime = 0;
        const count = this.simulation.boxCount;
        this.ui.playStatus.textContent = `${this.paused ? 'Paused' : 'Playing'} · ${count} box${count === 1 ? '' : 'es'}`;
      }
    }
    this.properties.update();
    this.programPanel.update();
  }
}
