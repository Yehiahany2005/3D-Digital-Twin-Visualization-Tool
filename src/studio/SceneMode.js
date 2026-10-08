import * as THREE from 'three';
import { ASSET_REGISTRY, getAssetConfig, registerImportedAsset } from '../assets/AssetRegistry.js';
import { getStoredImport, storeImport } from '../assets/ImportStore.js';
import { formatLabel, UNIT_SCALES, unsupportedFormatMessage } from '../loaders/ModelLoader.js';
import { loadRigByKey, saveRigByKey } from '../motion/RigStore.js';
import { emptyScene, newId } from './SceneDocument.js';
import { deleteScene, lastSceneId, listScenes, loadScene, rememberLastScene, saveScene } from './SceneStore.js';
import { buildBundle, downloadBlob, readBundle } from './SceneBundle.js';
import { currentRigDefinition, ModelTemplates } from './ModelTemplates.js';
import { resolveParams, SceneEditor } from './SceneEditor.js';
import { CATALOG, getComponent } from './catalog/index.js';
import { ExplorerPanel } from './ui/ExplorerPanel.js';
import { PropertiesPanel } from './ui/PropertiesPanel.js';
import { AddDrawer } from './ui/AddDrawer.js';

const SAVE_DELAY_MS = 600;
const POSE_CHECK_MS = 3000;
// Smallest area framed and lit, so an empty or tiny scene still has a sensible view.
const MIN_SCENE_SIZE = 6;

function isTyping(event) {
  return Boolean(event.target.closest?.('input, select, textarea, [contenteditable="true"]'));
}

// Scene mode: several models and parts together, edited like a studio (Explorer, Properties,
// Add drawer, move/turn gizmo). Machine mode is untouched; main.js switches between the two.
export class SceneMode {
  constructor({ scene, cameraManager, controls, renderer, picker, outline, reachPanel, ui, onStatus, onError, onEditInMachine, onEnvironmentChange }) {
    this.scene = scene;
    this.cameraManager = cameraManager;
    this.controls = controls;
    this.picker = picker;
    this.reachPanel = reachPanel;
    this.ui = ui;
    this.onStatus = onStatus;
    this.onError = onError;
    this.onEditInMachine = onEditInMachine;
    this.onEnvironmentChange = onEnvironmentChange;
    this.active = false;
    this.opened = false;

    this.templates = new ModelTemplates({ onStatus });
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
      editor: this.editor,
      onFrame: (id) => this.frame(id),
      iconFor: (item, runtime) => this.iconFor(item, runtime),
    });
    this.properties = new PropertiesPanel({
      container: ui.properties,
      editor: this.editor,
      describeSource: (item, runtime) => this.describeSource(item, runtime),
      onEditInMachine: (item) => this.editInMachine(item),
      onRelink: (item) => this.relink(item),
      onAdd: () => this.drawer.setOpen(true),
      extraSections: [],
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
    });

    this.editor.onChange((type, detail) => {
      if (type === 'document') {
        this.scheduleSave();
        this.updateTitle();
        this.updateHistoryButtons();
      }
      if (type === 'history') this.updateHistoryButtons();
      if (type === 'selection') this.bindReach();
      if (type === 'item-ready') {
        if (detail?.id === this.editor.selectedId) this.bindReach();
        this.environmentChanged();
      }
      if (type === 'frame') this.frame(detail);
      if (type === 'status') this.onStatus?.(detail);
    });

    this.bindToolbar();
    this.bindFileControls();
    this.bindKeys();
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
    const models = ASSET_REGISTRY.filter((config) => !config.file).map((config) => ({
      key: `builtin:${config.id}`,
      name: config.name,
      subtitle: config.type,
      category: 'Robots & machines',
      icon: config.rig ? 'Bot' : 'Box',
      source: { kind: 'builtin', id: config.id },
    }));
    const imports = ASSET_REGISTRY.filter((config) => config.file && config.stored).map((config) => ({
      key: `import:${config.id}`,
      name: config.name,
      subtitle: formatLabel(config.file.name),
      category: 'My models',
      icon: 'Box',
      source: { kind: 'import', id: config.id, name: config.file.name },
    }));
    const components = CATALOG.map((component) => ({
      key: `catalog:${component.id}`,
      name: component.name,
      subtitle: component.description,
      category: component.category,
      icon: component.icon,
      thumbnail: this.thumbnails?.get(component.id),
      source: { kind: 'catalog', id: component.id },
    }));
    return [...components, ...models, ...imports];
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
    ui.sceneList.addEventListener('change', () => this.openScene(ui.sceneList.value));
    ui.sceneNew.addEventListener('click', () => this.newScene());
    ui.sceneDelete.addEventListener('click', () => this.deleteCurrent());
    ui.sceneExport.addEventListener('click', () => this.exportScene());
    ui.sceneOpenFile.addEventListener('click', () => ui.sceneFileInput.click());
    ui.sceneFileInput.addEventListener('change', () => {
      const [file] = ui.sceneFileInput.files;
      ui.sceneFileInput.value = '';
      if (file) this.openFile(file);
    });
  }

  async refreshSceneList() {
    const scenes = await listScenes();
    const current = this.editor.document;
    if (!scenes.some((scene) => scene.id === current.id)) scenes.unshift({ id: current.id, name: current.name, itemCount: current.items.length });
    this.ui.sceneList.replaceChildren(...scenes.map((scene) => {
      const option = new Option(`${scene.id === current.id ? current.name : scene.name} (${scene.id === current.id ? current.items.length : scene.itemCount})`, scene.id);
      return option;
    }));
    this.ui.sceneList.value = current.id;
  }

  async openLastOrNew() {
    const id = lastSceneId();
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
    else this.refreshSceneList();
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
    this.onStatus?.(`Opening ${scene.name}…`);
    try {
      await this.editor.setDocument(scene);
    } finally {
      this.onStatus?.(null);
    }
    rememberLastScene(scene.id);
    this.ui.sceneName.value = scene.name;
    this.updateTitle();
    await this.refreshSceneList();
    if (scene.camera) this.restoreCamera(scene.camera);
    else this.frame(null);
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
      this.ui.saveState.textContent = 'Saved in this browser. Export a .dtscene file to keep it safe or send it to someone.';
      this.ui.saveState.classList.remove('is-error');
      this.refreshSceneList();
    } catch (error) {
      console.warn('Scene could not be saved.', error);
      this.ui.saveState.textContent = "Couldn't save in this browser (it may be out of space). Use Export to keep this scene.";
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
    this.setTool('move');
  }

  setTool(tool) {
    this.editor.setTool(tool);
    this.ui.toolButtons.forEach((button) => {
      const active = button.dataset.sceneTool === tool;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    });
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
      const key = event.key.toLowerCase();
      const command = event.ctrlKey || event.metaKey;
      const selected = editor.selectedId;
      let handled = true;
      if (command && key === 'z' && !event.shiftKey) editor.undo();
      else if (command && (key === 'y' || (key === 'z' && event.shiftKey))) editor.redo();
      else if (command && key === 'd' && selected) editor.duplicate(selected);
      else if (command && key === 's') this.saveNow();
      else if (command) handled = false;
      else if ((key === 'delete' || key === 'backspace') && selected) editor.removeItems([selected]);
      else if (key === 'f') this.frame(selected);
      else if (key === 'r' && selected) editor.turn(event.shiftKey ? -90 : 90);
      else if (key === 'q') this.setTool('select');
      else if (key === 'w') this.setTool('move');
      else if (key === 'e') this.setTool('rotate');
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

  frame(id) {
    const box = this.bounds(id);
    const helper = new THREE.Mesh(new THREE.BoxGeometry(...box.getSize(new THREE.Vector3()).toArray()));
    box.getCenter(helper.position);
    helper.updateMatrixWorld(true);
    this.cameraManager.frameObject(helper, this.controls);
    helper.geometry.dispose();
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
    }, 50);
  }

  // ---- Entering and leaving ----------------------------------------------------------------------------

  async enter() {
    this.active = true;
    this.ui.toolbar.hidden = false;
    this.editor.setShown(true);
    this.picker.setDefault((hit) => this.handleClick(hit), () => this.editor.root, { owner: 'scene', cursor: 'default' });
    this.reachPanel.setExtraTargets(() => this.editor.itemRoots());
    if (!this.opened) {
      this.opened = true;
      await this.openLastOrNew();
    } else {
      // Rigs edited in Machine mode meanwhile: rebuild the copies that use them.
      const rebuilt = this.editor.refreshRigs((config) => JSON.stringify(currentRigDefinition(config)));
      if (rebuilt) this.onStatus?.(`Updated ${rebuilt} model${rebuilt === 1 ? '' : 's'} with the joints set up in Machine mode.`);
      if (this.editor.document.camera) this.restoreCamera(this.editor.document.camera);
      this.environmentChanged();
    }
    this.bindReach();
    this.poseTimer = setInterval(() => {
      this.editor.capturePoses();
      if (JSON.stringify(this.editor.document.items) !== this.lastSaved) this.scheduleSave();
    }, POSE_CHECK_MS);
  }

  exit() {
    if (!this.active) return;
    this.saveNow();
    clearInterval(this.poseTimer);
    this.active = false;
    this.drawer.setOpen(false);
    this.ui.toolbar.hidden = true;
    this.editor.select(null);
    this.editor.setShown(false);
    this.picker.setDefault(null);
    this.reachPanel.setExtraTargets(null);
    this.editor.runtimes.forEach((runtime) => runtime.asset?.player.stop());
  }

  updateTitle() {
    const scene = this.editor.document;
    this.ui.titleName.textContent = scene.name;
    this.ui.titleMeta.textContent = `Scene · ${scene.items.length} item${scene.items.length === 1 ? '' : 's'}`;
    if (document.activeElement !== this.ui.sceneName) this.ui.sceneName.value = scene.name;
  }

  update(deltaTime) {
    if (!this.active) return;
    this.editor.update(deltaTime);
    this.properties.update();
  }
}
