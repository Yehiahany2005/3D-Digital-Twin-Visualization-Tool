import * as THREE from 'three';
import { AnimationController } from './AnimationController.js';
import { getAssetConfig } from '../assets/AssetRegistry.js';
import { ModelLoader, UNIT_SCALES } from '../loaders/ModelLoader.js';

const UP_AXIS_ROTATIONS = {
  y: new THREE.Euler(0, 0, 0),
  z: new THREE.Euler(-Math.PI / 2, 0, 0),
};

async function readSource(config) {
  if (config.file) return { buffer: await config.file.arrayBuffer(), fileName: config.file.name };
  const response = await fetch(config.model);
  if (!response.ok) throw new Error(`Could not download ${config.model} (HTTP ${response.status}).`);
  return { buffer: await response.arrayBuffer(), fileName: config.model };
}

export class AssetManager {
  constructor({ scene, cameraManager, controls, onAssetLoaded, onAssetError, onStatus }) {
    this.scene = scene;
    this.cameraManager = cameraManager;
    this.controls = controls;
    this.onAssetLoaded = onAssetLoaded;
    this.onAssetError = onAssetError;
    this.onStatus = onStatus;
    this.loader = new ModelLoader();
    this.cache = new Map();
    this.currentAsset = null;
    this.isLoading = false;
  }

  async select(assetId) {
    if (this.isLoading || this.currentAsset?.config.id === assetId) return;
    const config = getAssetConfig(assetId);
    if (!config) throw new Error(`Unknown asset: ${assetId}`);

    this.isLoading = true;
    try {
      const asset = this.cache.get(assetId) || await this.load(config);
      this.replaceCurrent(asset);
      this.currentAsset = asset;
      this.onAssetLoaded?.(asset);
    } catch (error) {
      console.error(`Unable to load asset ${config.name}:`, error);
      this.onAssetError?.(config, error);
    } finally {
      this.isLoading = false;
      this.onStatus?.(null);
    }
  }

  async load(config) {
    this.onStatus?.(`Reading ${config.name}…`);
    const { buffer, fileName } = await readSource(config);
    const parsed = await this.loader.parse(buffer, fileName, { onStatus: this.onStatus });
    this.onStatus?.('Preparing model…');

    // Hierarchy: root (whole-object motion + unit scale) → orientation (up axis) → content (the file's scene).
    const content = parsed.scene;
    const orientation = new THREE.Group();
    orientation.name = 'Orientation';
    orientation.add(content);
    const root = new THREE.Group();
    root.name = 'AssetRoot';
    root.add(orientation);

    content.traverse((object) => {
      if (!object.isMesh) return;
      object.castShadow = true;
      object.receiveShadow = true;
    });

    const asset = {
      config,
      model: root,
      orientation,
      content,
      animations: parsed.animations,
      animationController: new AnimationController(content, parsed.animations),
      units: parsed.units,
      unitsGuessed: parsed.unitsGuessed,
      upAxis: parsed.upAxis,
    };
    this.applyPlacement(asset);

    console.info(`Asset loaded: ${config.name} (units: ${asset.units}${asset.unitsGuessed ? ', guessed' : ''}, up: ${asset.upAxis})`);
    console.info(`Animations: ${parsed.animations.length}`);
    this.cache.set(config.id, asset);
    return asset;
  }

  // Applies unit scale and up axis, then rests the model on the floor (y = 0) centred on the origin.
  applyPlacement(asset) {
    const { model: root, orientation } = asset;
    const saved = { position: root.position.clone(), quaternion: root.quaternion.clone() };

    root.position.set(0, 0, 0);
    root.quaternion.identity();
    root.scale.setScalar(UNIT_SCALES[asset.units] ?? 1);
    orientation.rotation.copy(UP_AXIS_ROTATIONS[asset.upAxis] || UP_AXIS_ROTATIONS.y);
    orientation.position.set(0, 0, 0);
    root.updateMatrixWorld(true);

    const bounds = new THREE.Box3().setFromObject(orientation);
    const center = bounds.getCenter(new THREE.Vector3());
    const offset = new THREE.Vector3(center.x, bounds.min.y, center.z).divide(root.scale);
    orientation.position.sub(offset);

    root.position.copy(saved.position);
    root.quaternion.copy(saved.quaternion);
    root.updateMatrixWorld(true);
  }

  replaceCurrent(asset) {
    if (this.currentAsset) {
      this.currentAsset.animationController.stop();
      this.scene.remove(this.currentAsset.model);
    }

    this.scene.add(asset.model);
    this.cameraManager.frameObject(asset.model, this.controls);
  }

  update(deltaTime) {
    this.currentAsset?.animationController.update(deltaTime);
  }

  get currentAnimations() {
    return this.currentAsset?.animations || [];
  }

  dispose() {
    this.currentAsset?.animationController.stop();
    this.cache.forEach((asset) => asset.animationController.dispose());
    this.cache.clear();
  }
}
