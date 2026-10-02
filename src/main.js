import * as THREE from 'three';
import {
  Box,
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
import { JointGizmo, SelectionOutline, ViewportPicker } from './scene/RigHelpers.js';
import { loadSavedRig } from './motion/RigStore.js';
import { AssetManager } from './scene/AssetManager.js';
import { AssetSelectionPanel } from './ui/AssetSelectionPanel.js';
import { DigitalTwinViewManager } from './scene/DigitalTwinViewManager.js';
import { fitEnvironment } from './scene/fitEnvironment.js';
import './style.css';

createIcons({ icons: { Box, Cpu, Move3d, PlayCircle, SlidersHorizontal, TerminalSquare, Wrench } });

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
let visualizationManager;
let activeAsset;

const jointControls = new JointControls({
  container: document.querySelector('[data-joints-list]'),
  filter: (joint) => joint.kind === 'joint',
  emptyMessage: 'This model has no movable joints yet.',
  emptyAction: { label: 'Set up joints', onClick: () => rigEditor.open() },
});
const objectMotionControls = new JointControls({
  container: document.querySelector('[data-object-motion-list]'),
  filter: (joint) => joint.kind === 'base',
  emptyMessage: '',
});
const commandsPanel = new CommandsPanel({
  card: document.querySelector('[data-commands-card]'),
  list: document.querySelector('[data-commands-list]'),
  statusElement: document.querySelector('[data-motion-status]'),
  stopButton: document.querySelector('[data-motion-stop]'),
});

const rigEditor = new RigEditorPanel({
  card: document.querySelector('[data-rig-editor]'),
  picker: new ViewportPicker({ domElement: rendererManager.renderer.domElement, camera: cameraManager.camera }),
  outline: new SelectionOutline(sceneManager.scene),
  gizmo: new JointGizmo(sceneManager.scene),
});

document.querySelector('[data-object-reset]').addEventListener('click', () => {
  if (!activeAsset) return;
  activeAsset.player.stop();
  activeAsset.rig.setValues(Object.fromEntries(activeAsset.rig.baseJoints.map((joint) => [joint.id, 0])));
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
  objectMotionControls.setRig(asset.rig, asset.player);
  commandsPanel.setRig(asset.rig, asset.player);
  rigEditor.setAsset(asset);
  assetSelectionPanel.update(asset);
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
  selectElement: document.querySelector('[data-asset-select]'),
  infoTitle: document.querySelector('[data-asset-info-title]'),
  nameElement: document.querySelector('[data-asset-name]'),
  typeElement: document.querySelector('[data-asset-type]'),
  animationCountElement: document.querySelector('[data-asset-animation-count]'),
  animationCard: document.querySelector('[data-animation-card]'),
  animationSelect: document.querySelector('[data-animation-select]'),
  playButton: document.querySelector('[data-animation-play]'),
  pauseButton: document.querySelector('[data-animation-pause]'),
  restartButton: document.querySelector('[data-animation-restart]'),
  messageElement: document.querySelector('[data-asset-message]'),
});

assetManager.select('abb_irb6760');

function handleResize() {
  cameraManager.updateAspectRatio();
  rendererManager.resize(container);
}

window.addEventListener('resize', handleResize);

function render() {
  const deltaTime = Math.min(clock.getDelta(), 0.1);
  activeAsset?.player.update(deltaTime);
  jointControls.update();
  objectMotionControls.update();
  rigEditor.update();
  assetManager.update(deltaTime);
  visualizationManager?.update(deltaTime);
  controls.update();
  rendererManager.renderer.render(sceneManager.scene, cameraManager.camera);
  requestAnimationFrame(render);
}

render();
