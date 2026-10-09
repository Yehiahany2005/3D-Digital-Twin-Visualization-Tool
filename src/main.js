import * as THREE from 'three';
import {
  Box,
  Clapperboard,
  Cpu,
  Crosshair,
  Factory,
  LayoutGrid,
  ListTree,
  MousePointer2,
  Move,
  Play,
  PlayCircle,
  Plus,
  Redo2,
  Rotate3d,
  RotateCw,
  SlidersHorizontal,
  TerminalSquare,
  Undo2,
  Upload,
  Wrench,
  createIcons,
} from 'lucide';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { SceneManager } from './scene/SceneManager.js';
import { CameraManager } from './scene/CameraManager.js';
import { LightingManager } from './scene/LightingManager.js';
import { RendererManager } from './scene/RendererManager.js';
import { DigitalTwinViewManager } from './scene/DigitalTwinViewManager.js';
import { fitEnvironment } from './scene/fitEnvironment.js';
import { ReachMarker, SelectionOutline, ToolMarkers, ViewportPicker } from './scene/RigHelpers.js';
import { ReachPanel } from './ui/ReachPanel.js';
import { StatusMessage } from './ui/StatusMessage.js';
import { listStoredImports } from './assets/ImportStore.js';
import { getAssetConfig, registerImportedAsset } from './assets/AssetRegistry.js';
import { ModelTemplates } from './studio/ModelTemplates.js';
import { SceneMode } from './studio/SceneMode.js';
import { lastMode, rememberLastMode } from './studio/SceneStore.js';
import { MachineTab } from './app/MachineTab.js';
import { SceneTab } from './app/SceneTab.js';
import './style.css';

// The app has two tabs that share one 3D view:
//   Machine (src/app/MachineTab.js): one model at a time, its joints, animations and Reach.
//   Scene (src/app/SceneTab.js): whole scenes, built-in (made in code) or made by drag and drop.
// This file builds the shared view, switches tabs and runs the frame loop. Each tab's exit()
// puts away everything it owns, so nothing of one tab shows or reacts in the other.

createIcons({ icons: { Box, Clapperboard, Cpu, Crosshair, Factory, LayoutGrid, ListTree, MousePointer2, Move, Play, PlayCircle, Plus, Redo2, Rotate3d, RotateCw, SlidersHorizontal, TerminalSquare, Undo2, Upload, Wrench } });

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

// ---- The shared 3D view ------------------------------------------------------------------------

const container = $('#viewport');
const sceneManager = new SceneManager();
const cameraManager = new CameraManager(container);
const rendererManager = new RendererManager(container);
const controls = new OrbitControls(cameraManager.camera, rendererManager.renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.screenSpacePanning = true;

const lightingGroup = new LightingManager().createLights();
sceneManager.add(lightingGroup);

const floor = new THREE.Mesh(
  new THREE.PlaneGeometry(200, 200),
  new THREE.MeshStandardMaterial({ color: 0x777b7e, roughness: 0.82, metalness: 0.05 }),
);
floor.rotation.x = -Math.PI / 2;
floor.position.y = -0.005;
floor.receiveShadow = true;
sceneManager.add(floor);

const viewManager = new DigitalTwinViewManager({
  scene: sceneManager.scene,
  robot: null,
  floor,
  lightingGroup,
  toggleButton: $('[data-view-toggle]'),
  modeElement: $('[data-view-mode]'),
});
const lightGroups = [lightingGroup, viewManager.digitalLights];

// Floor, fog, grid and lights sized to what is shown. span: the size to fit when it shouldn't be
// measured from root. tightShadows: fit the shadow area to root, so a whole cell keeps crisp shadows.
function fitTo(root, { span, tightShadows = false } = {}) {
  fitEnvironment({ model: root, span, scene: sceneManager.scene, floor, grid: viewManager.grid, lightGroups });
  if (!tightShadows) return;
  const radius = new THREE.Box3().setFromObject(root).getBoundingSphere(new THREE.Sphere()).radius;
  lightGroups.forEach((group) => group.traverse((light) => {
    if (!light.isDirectionalLight || !light.castShadow) return;
    const camera = light.shadow.camera;
    camera.left = -radius;
    camera.right = radius;
    camera.top = radius;
    camera.bottom = -radius;
    camera.updateProjectionMatrix();
    light.shadow.normalBias = 0.02;
  }));
}

const picker = new ViewportPicker({ domElement: rendererManager.renderer.domElement, camera: cameraManager.camera });
const status = new StatusMessage($('[data-asset-status]'));
// Reach works on the Machine tab's model and on machines in the scene editor.
const reach = new ReachPanel({
  bar: $('[data-reach-bar]'),
  picker,
  marker: new ReachMarker(sceneManager.scene),
  toolMarkers: new ToolMarkers(sceneManager.scene),
  floor,
  onNeedJoints: () => {
    if (mode === 'machine') machine.rigEditor.open();
  },
});

const view = {
  container,
  scene: sceneManager.scene,
  renderer: rendererManager.renderer,
  cameraManager,
  controls,
  floor,
  viewManager,
  picker,
  reach,
  status,
  fitTo,
};

// ---- Tabs -----------------------------------------------------------------------------------

const machine = new MachineTab({
  view,
  ui: {
    pickerRoot: $('[data-asset-picker]'),
    jointsList: $('[data-joints-list]'),
    commands: {
      card: $('[data-commands-card]'),
      list: $('[data-commands-list]'),
      statusElement: $('[data-motion-status]'),
      stopButton: $('[data-motion-stop]'),
    },
    rigEditorCard: $('[data-rig-editor]'),
    animationEditorCard: $('[data-animation-editor]'),
    assetInfo: {
      nameElement: $('[data-asset-name]'),
      typeElement: $('[data-asset-type]'),
      animationCountElement: $('[data-asset-animation-count]'),
      animationCard: $('[data-animation-card]'),
      animationSelect: $('[data-animation-select]'),
      playButton: $('[data-animation-play]'),
      pauseButton: $('[data-animation-pause]'),
      restartButton: $('[data-animation-restart]'),
      messageElement: $('[data-asset-message]'),
    },
  },
});

// Parsed model files, shared by the scene editor and the built-in scenes' robot.
const templates = new ModelTemplates({ onStatus: (message) => status.show(message) });

const sceneEditor = new SceneMode({
  scene: sceneManager.scene,
  cameraManager,
  controls,
  renderer: rendererManager.renderer,
  picker,
  outline: new SelectionOutline(sceneManager.scene),
  reachPanel: reach,
  templates,
  ui: {
    toolbar: $('[data-scene-toolbar]'),
    toolButtons: $$('[data-scene-tool]'),
    snap: $('[data-scene-snap]'),
    undo: $('[data-scene-undo]'),
    redo: $('[data-scene-redo]'),
    play: $('[data-scene-play]'),
    playLabel: $('[data-scene-play-label]'),
    freeRotate: $('[data-scene-free-rotate]'),
    playStatus: $('[data-scene-play-status]'),
    addButton: $('[data-scene-add]'),
    drawer: $('[data-add-drawer]'),
    explorerList: $('[data-explorer-list]'),
    explorerCount: $('[data-explorer-count]'),
    properties: $('[data-properties]'),
    sceneName: $('[data-scene-name]'),
    sceneDelete: $('[data-scene-delete]'),
    sceneExport: $('[data-scene-export]'),
    saveState: $('[data-scene-save-state]'),
  },
  onStatus: (message) => status.show(message),
  onError: (message) => status.error(message),
  // "Joints & animations" on a scene item: open that model in the Machine tab.
  onEditInMachine: async (assetId) => {
    await setMode('machine', { assetId });
    machine.rigEditor.open();
  },
  onEnvironmentChange: (root, span) => {
    viewManager.replaceRobot(root, { force: true });
    fitTo(root, { span });
  },
  onSceneChange: () => sceneTab.sceneChanged(),
  onScenesSaved: () => sceneTab.refreshSaved(),
});

const sceneTab = new SceneTab({
  view,
  templates,
  editor: sceneEditor,
  ui: {
    pickerRoot: $('[data-scene-picker]'),
    newScene: $('[data-scene-new]'),
    openFile: $('[data-scene-open-file]'),
    fileInput: $('[data-scene-file-input]'),
    builtInPane: $('[data-scene-source="builtin"]'),
    editorPane: $('[data-scene-source="editor"]'),
    builtInCard: {
      card: $('[data-builtin-card]'),
      title: $('[data-builtin-title]'),
      description: $('[data-builtin-description]'),
      start: $('[data-builtin-start]'),
      reset: $('[data-builtin-reset]'),
      speed: $('[data-builtin-speed]'),
      debugRow: $('[data-builtin-debug-row]'),
      debug: $('[data-builtin-debug]'),
      status: $('[data-builtin-status]'),
    },
  },
});

const tabs = { machine, scene: sceneTab };
const modeTabs = $$('[data-mode-tab]');
const modePanes = $$('[data-mode-pane]');
let mode = null;
let switching = Promise.resolve();

modeTabs.forEach((tab) => tab.addEventListener('click', () => setMode(tab.dataset.modeTab)));

// Tab switches run one after another, so a quick double switch can't leave both half-open.
// options go to the tab's enter() (the Machine tab takes { assetId }).
function setMode(next, options = {}) {
  switching = switching.then(async () => {
    if (next === mode || !tabs[next]) return;
    const previous = tabs[mode];
    mode = next;
    rememberLastMode(next);
    modeTabs.forEach((tab) => tab.setAttribute('aria-selected', String(tab.dataset.modeTab === next)));
    modePanes.forEach((pane) => { pane.hidden = pane.dataset.modePane !== next; });
    document.body.dataset.mode = next;
    previous?.exit();
    await tabs[next].enter(options);
  }).catch((error) => {
    console.error('Switching tabs failed.', error);
    status.error(`Something went wrong: ${error.message || 'unknown error'}`);
  });
  return switching;
}

// Lists the models saved on this device, then opens the tab (and its model or scene) in use
// before the page was refreshed.
async function startUp() {
  (await listStoredImports()).forEach(({ id, file }) => {
    if (!getAssetConfig(id)) registerImportedAsset(file, { id, stored: true });
  });
  await setMode(lastMode() === 'scene' ? 'scene' : 'machine');
}

void startUp();

// ---- Frame loop -----------------------------------------------------------------------------

window.addEventListener('resize', () => {
  cameraManager.updateAspectRatio();
  rendererManager.resize(container);
});

const timer = new THREE.Timer();
// Pauses with the page, so a hidden tab doesn't come back with one huge step.
timer.connect(document);

function render(timestamp) {
  timer.update(timestamp);
  const deltaTime = Math.min(timer.getDelta(), 0.1);
  machine.update(deltaTime);
  sceneTab.update(deltaTime);
  reach.update();
  viewManager.update(deltaTime);
  controls.update();
  rendererManager.renderer.render(sceneManager.scene, cameraManager.camera);
  requestAnimationFrame(render);
}

render();

// Development only (npm run dev): lets automated browser checks look inside the app.
if (import.meta.env.DEV) {
  window.__twin = {
    machine,
    sceneTab,
    sceneEditor,
    rendererManager,
    get mode() { return mode; },
    get activeAsset() { return machine.asset; },
  };
}
