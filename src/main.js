import * as THREE from 'three';
import {
  Activity,
  Box,
  Cpu,
  PlayCircle,
  SlidersHorizontal,
  TerminalSquare,
  createIcons,
} from 'lucide';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { SceneManager } from './scene/SceneManager.js';
import { CameraManager } from './scene/CameraManager.js';
import { LightingManager } from './scene/LightingManager.js';
import { RendererManager } from './scene/RendererManager.js';
import { RobotController } from './scene/RobotController.js';
import { RobotControlPanel } from './ui/RobotControlPanel.js';
import { JointJogPanel } from './ui/JointJogPanel.js';
import { AssetManager } from './scene/AssetManager.js';
import { AssetSelectionPanel } from './ui/AssetSelectionPanel.js';
import { DigitalTwinViewManager } from './scene/DigitalTwinViewManager.js';
import './style.css';

createIcons({ icons: { Activity, Box, Cpu, PlayCircle, SlidersHorizontal, TerminalSquare } });

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
floor.position.y = -0.02;
floor.receiveShadow = true;
sceneManager.add(floor);

const clock = new THREE.Clock();
let robotController;
let jointJogPanel;
let robotControlPanel;
let visualizationManager;
let activeAsset;

function setRobotOnlyVisibility(isRobot) {
  document.querySelectorAll('[data-robot-only]').forEach((element) => {
    element.hidden = !isRobot;
  });
}

function destroyRobotPanels() {
  robotControlPanel?.destroy();
  jointJogPanel?.destroy();
  robotControlPanel = null;
  jointJogPanel = null;
  robotController = null;
}

function handleAssetLoaded(asset) {
  activeAsset = asset;
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
  if (asset.config.id === 'Unitree_robot') {
    console.info('G1 Digital Twin material processing active:', visualizationManager.isDigitalTwin);
    console.info('G1 diagnostic animation playback:', 'No automatic animation started');
  }

  destroyRobotPanels();
  setRobotOnlyVisibility(asset.config.robotController);
  if (asset.config.robotController) {
    robotController = new RobotController(asset.model);
    robotControlPanel = new RobotControlPanel(robotController, document.querySelector('.control-panel'));
    jointJogPanel = new JointJogPanel(robotController, document.querySelector('.jog-panel'));
  }
  assetSelectionPanel.update(asset);
}

const assetManager = new AssetManager({
  scene: sceneManager.scene,
  cameraManager,
  controls,
  floor,
  onAssetLoaded: handleAssetLoaded,
  onAssetError: (config, error) => {
    console.error(`Asset selection failed for ${config.name}:`, error);
    assetSelectionPanel.showError('Unable to load asset.');
  },
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
  robotController?.update(deltaTime);
  jointJogPanel?.update();
  assetManager.update(deltaTime);
  visualizationManager?.update(deltaTime);
  controls.update();
  rendererManager.renderer.render(sceneManager.scene, cameraManager.camera);
  requestAnimationFrame(render);
}

render();