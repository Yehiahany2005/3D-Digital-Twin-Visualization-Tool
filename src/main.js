import * as THREE from 'three';
import {
  Box,
  Clapperboard,
  Crosshair,
  Cpu,
  Move3d,
  PlayCircle,
  SlidersHorizontal,
  TerminalSquare,
  Wrench,
  createIcons,
} from 'lucide';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { SceneManager } from './scene/SceneManager.js';
import { CameraManager } from './scene/CameraManager.js';
import { LightingManager } from './scene/LightingManager.js';
import { RendererManager } from './scene/RendererManager.js';
import { Rig, emptyRigDefinition } from './motion/Rig.js';
import { MotionPlayer } from './motion/MotionPlayer.js';
import { JointControls } from './ui/JointControls.js';
import { CommandsPanel } from './ui/CommandsPanel.js';
import { RigEditorPanel } from './ui/RigEditorPanel.js';
import { AnimationEditorPanel } from './ui/AnimationEditorPanel.js';
import { ReachPanel } from './ui/ReachPanel.js';
import { JointGizmo, LinePickPreview, PartHighlight, ReachMarker, SelectionOutline, SurfacePreview, ToolMarkers, ViewportPicker } from './scene/RigHelpers.js';
import { loadSavedRig } from './motion/RigStore.js';
import { AssetManager } from './scene/AssetManager.js';
import { AssetSelectionPanel } from './ui/AssetSelectionPanel.js';
import { DigitalTwinViewManager } from './scene/DigitalTwinViewManager.js';
import { fitEnvironment } from './scene/fitEnvironment.js';
import { StationScene } from './station/StationScene.js';
import { lastAsset, listStoredImports, rememberLastAsset } from './assets/ImportStore.js';
import { getAssetConfig } from './assets/AssetRegistry.js';
import './style.css';

createIcons({ icons: { Box, Clapperboard, Crosshair, Cpu, Move3d, PlayCircle, SlidersHorizontal, TerminalSquare, Wrench } });

function updateClock() {
  const timeElement = document.querySelector('[data-current-time]');
  if (timeElement) timeElement.textContent = new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date());
}

updateClock();
window.setInterval(updateClock, 1000);

const container = document.querySelector('#viewport');
const visualizationButton = document.querySelector('[data-view-toggle]');
const visualizationMode = document.querySelector('[data-view-mode]');
const stationCard = document.querySelector('[data-station-card]');
const stationDebug = document.querySelector('[data-station-debug]');
const stationExit = document.querySelector('[data-station-exit]');
const stationStart = document.querySelector('[data-station-start]');
const stationReset = document.querySelector('[data-station-reset]');
const stationSpeed = document.querySelector('[data-station-speed]');
const stationRobotState = document.querySelector('[data-station-robot-state]');
const stationConveyorState = document.querySelector('[data-station-conveyor-state]');
const stationGripperState = document.querySelector('[data-station-gripper-state]');
const stationBoxState = document.querySelector('[data-station-box-state]');
const stationBoxNumber = document.querySelector('[data-station-box-number]');
const stationTcpPosition = document.querySelector('[data-station-tcp-position]');
const stationBoxPosition = document.querySelector('[data-station-box-position]');
const stationDistance = document.querySelector('[data-station-distance]');
const stationStackTarget = document.querySelector('[data-station-stack-target]');
const stationPositionError = document.querySelector('[data-station-position-error]');
const stationBottomHeight = document.querySelector('[data-station-bottom-height]');
const stationBoxRotation = document.querySelector('[data-station-box-rotation]');
const stationState = document.querySelector('[data-station-state]');
const sceneManager = new SceneManager();
const cameraManager = new CameraManager(container);
const rendererManager = new RendererManager(container);
const controls = new OrbitControls(cameraManager.camera, rendererManager.renderer.domElement);
let lightingGroup;

controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.screenSpacePanning = true;
lightingGroup = new LightingManager().createLights();
sceneManager.add(lightingGroup);

const floor = new THREE.Mesh(
  new THREE.PlaneGeometry(200, 200),
  new THREE.MeshStandardMaterial({ color: 0x777b7e, roughness: 0.82, metalness: 0.05 }),
);
floor.rotation.x = -Math.PI / 2;
floor.position.y = -0.005;
floor.receiveShadow = true;
sceneManager.add(floor);

const clock = new THREE.Clock();
const DEFAULT_ASSET_ID = 'abb_irb6760';
let visualizationManager;
let activeAsset;
let stationMode = false;
const stationScene = new StationScene({
  scene: sceneManager.scene,
  cameraManager,
  controls,
  floor,
});
stationScene.setCycleUpdateHandler((cycle) => {
  stationConveyorState.textContent = cycle.conveyorState;
  stationRobotState.textContent = cycle.robotState;
  stationGripperState.textContent = cycle.gripperState;
  stationBoxState.textContent = cycle.boxState;
  const totalBoxes = cycle.layout.stack.columns * cycle.layout.stack.rows * cycle.layout.stack.layers;
  stationBoxNumber.textContent = `${Math.min(cycle.boxNumber + 1, totalBoxes)}/${totalBoxes}`;
  stationTcpPosition.textContent = cycle.getSuctionWorld().toArray().map((value) => value.toFixed(2)).join(', ');
  stationBoxPosition.textContent = cycle.box
    ? cycle.getBoxCenter().toArray().map((value) => value.toFixed(2)).join(', ')
    : '—';
  stationDistance.textContent = Number.isFinite(cycle.distance) ? `${cycle.distance.toFixed(3)} m` : '—';
  stationStackTarget.textContent = cycle.stackTarget
    ? cycle.stackTarget.toArray().map((value) => value.toFixed(2)).join(', ')
    : '—';
  stationPositionError.textContent = Number.isFinite(cycle.positionError) ? `${cycle.positionError.toFixed(3)} m` : '—';
  stationBottomHeight.textContent = cycle.bottomHeight ? `${cycle.bottomHeight.toFixed(3)} m` : '—';
  stationBoxRotation.textContent = cycle.rotation.toArray().slice(0, 3).map((value) => value.toFixed(2)).join(', ');
  stationState.textContent = cycle.state;
  stationStart.disabled = cycle.state !== 'IDLE' && cycle.state !== 'COMPLETE';
});

const jointControls = new JointControls({
  container: document.querySelector('[data-joints-list]'),
  filter: (joint) => joint.kind === 'joint',
  emptyMessage: 'This model has no movable joints yet.',
  emptyAction: { label: 'Set up joints', onClick: () => rigEditor.open() },
});
const commandsPanel = new CommandsPanel({
  card: document.querySelector('[data-commands-card]'),
  list: document.querySelector('[data-commands-list]'),
  statusElement: document.querySelector('[data-motion-status]'),
  stopButton: document.querySelector('[data-motion-stop]'),
});

const picker = new ViewportPicker({ domElement: rendererManager.renderer.domElement, camera: cameraManager.camera });
const rigEditor = new RigEditorPanel({
  card: document.querySelector('[data-rig-editor]'),
  picker,
  surfacePreview: new SurfacePreview(sceneManager.scene),
  linePreview: new LinePickPreview(sceneManager.scene),
  outline: new SelectionOutline(sceneManager.scene),
  highlight: new PartHighlight(sceneManager.scene),
  gizmo: new JointGizmo(sceneManager.scene),
});

const reachPanel = new ReachPanel({
  bar: document.querySelector('[data-reach-bar]'),
  picker,
  marker: new ReachMarker(sceneManager.scene),
  toolMarkers: new ToolMarkers(sceneManager.scene),
  floor,
  onNeedJoints: () => rigEditor.open(),
});

const animationEditorCard = document.querySelector('[data-animation-editor]');
const animationEditor = new AnimationEditorPanel({
  card: animationEditorCard,
  // The exported file should carry the model's own materials, not the Digital Twin View tint.
  beforeExport: () => visualizationManager?.useOriginalMaterials(),
});

// Each asset keeps its own rig and player, so switching assets preserves its pose.
function ensureRig(asset) {
  if (asset.rig) return;
  const fallback = asset.config.rig ? structuredClone(asset.config.rig) : emptyRigDefinition();
  const saved = loadSavedRig(asset.config);
  asset.rig = new Rig({ root: asset.model, content: asset.content, definition: emptyRigDefinition() });
  try {
    asset.rig.setDefinition(saved || fallback);
  } catch (error) {
    console.warn('Rig could not be built; using the default rig instead.', error);
    asset.rig.setDefinition(saved ? fallback : emptyRigDefinition());
  }
  asset.rig.warnings.forEach((warning) => console.warn(warning));
  asset.player = new MotionPlayer(asset.rig);
}

function handleAssetLoaded(asset) {
  activeAsset?.player?.stop();
  activeAsset = asset;
  rememberLastAsset(asset.config.id);
  ensureRig(asset);
  if (visualizationManager) {
    visualizationManager.replaceRobot(asset.model);
  } else {
    visualizationManager = new DigitalTwinViewManager({
      scene: sceneManager.scene,
      robot: asset.model,
      floor,
      lightingGroup,
      toggleButton: visualizationButton,
      modeElement: visualizationMode,
    });
  }
  fitEnvironment({
    model: asset.model,
    scene: sceneManager.scene,
    floor,
    grid: visualizationManager.grid,
    lightGroups: [lightingGroup, visualizationManager.digitalLights],
  });

  jointControls.setRig(asset.rig, asset.player);
  commandsPanel.setRig(asset.rig, asset.player);
  rigEditor.setAsset(asset);
  animationEditor.setAsset(asset);
  reachPanel.setAsset(asset);
  assetSelectionPanel.update(asset);
  if (stationMode && asset.config.id === 'abb_irb6760') void stationScene.show(asset);
}

const assetManager = new AssetManager({
  scene: sceneManager.scene,
  cameraManager,
  controls,
  onAssetLoaded: handleAssetLoaded,
  onAssetError: (config, error) => {
    console.error(`Asset selection failed for ${config.name}:`, error);
    assetSelectionPanel.showError(`Unable to load ${config.name}: ${error.message || 'unknown error'}`);
  },
  onStatus: (message) => assetSelectionPanel.setStatus(message),
});

const assetSelectionPanel = new AssetSelectionPanel({
  assetManager,
  nameElement: document.querySelector('[data-asset-name]'),
  typeElement: document.querySelector('[data-asset-type]'),
  animationCountElement: document.querySelector('[data-asset-animation-count]'),
  animationCard: document.querySelector('[data-animation-card]'),
  animationSelect: document.querySelector('[data-animation-select]'),
  playButton: document.querySelector('[data-animation-play]'),
  pauseButton: document.querySelector('[data-animation-pause]'),
  restartButton: document.querySelector('[data-animation-restart]'),
  messageElement: document.querySelector('[data-asset-message]'),
  onStationSelect: openStation,
  // Picking a model while the station runs leaves the station first.
  onAssetSelect: async (id) => {
    if (stationMode) closeStation();
    await assetManager.select(id);
  },
  defaultAssetId: DEFAULT_ASSET_ID,
});

// Lists the models saved on this device, then reopens the one in use before the page was refreshed.
async function startUp() {
  (await listStoredImports()).forEach(({ id, file }) => assetSelectionPanel.addStoredModel(id, file));
  const last = lastAsset();
  const first = last && last !== 'station' && getAssetConfig(last) ? last : DEFAULT_ASSET_ID;
  assetSelectionPanel.setLoading(true);
  await assetManager.select(first);
  if (!assetManager.currentAsset) await assetManager.select(DEFAULT_ASSET_ID);
  assetSelectionPanel.setLoading(false);
}

void startUp();

async function openStation() {
  stationMode = true;
  // The station cycle drives the robot itself, so sequences and Reach would fight it.
  animationEditorCard.hidden = true;
  reachPanel.setHidden(true);
  await assetManager.select('abb_irb6760');
  if (activeAsset?.config.id === 'abb_irb6760') await stationScene.show(activeAsset);
  stationCard.hidden = false;
  stationCard.open = true;
  assetSelectionPanel.setCurrent('station');
}

function closeStation() {
  stationMode = false;
  const robot = stationScene.hide();
  if (robot && activeAsset) {
    // The station moved the robot through its base joints; put those back too, or the next
    // joint change would send the robot back to its station spot.
    activeAsset.rig.setValues({ 'base.x': 0, 'base.y': 0, 'base.z': 0, 'base.yaw': 0 });
    robot.position.set(0, 0, 0);
    robot.rotation.set(0, 0, 0);
    assetManager.applyPlacement(activeAsset);
    sceneManager.add(robot);
    cameraManager.frameObject(robot, controls);
  }
  stationCard.hidden = true;
  animationEditorCard.hidden = false;
  reachPanel.setHidden(false);
  assetSelectionPanel.setCurrent(activeAsset?.config.id || DEFAULT_ASSET_ID);
  stationDebug.checked = false;
}

stationExit.addEventListener('click', closeStation);
stationDebug.addEventListener('change', () => stationScene.setDebug(stationDebug.checked));
stationStart.addEventListener('click', () => stationScene.startCycle());
stationReset.addEventListener('click', () => stationScene.resetCycle());
stationSpeed.addEventListener('change', () => stationScene.setCycleSpeed(Number(stationSpeed.value)));

function handleResize() {
  cameraManager.updateAspectRatio();
  rendererManager.resize(container);
}

window.addEventListener('resize', handleResize);

function render() {
  const deltaTime = Math.min(clock.getDelta(), 0.1);
  activeAsset?.player.update(deltaTime);
  jointControls.update();
  rigEditor.update();
  reachPanel.update();
  assetManager.update(deltaTime);
  stationScene.update(deltaTime);
  visualizationManager?.update(deltaTime);
  controls.update();
  rendererManager.renderer.render(sceneManager.scene, cameraManager.camera);
  requestAnimationFrame(render);
}

render();
