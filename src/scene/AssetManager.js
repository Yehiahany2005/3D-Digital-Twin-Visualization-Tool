import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import * as THREE from 'three';
import { AnimationController } from './AnimationController.js';
import { getAssetConfig } from '../assets/AssetRegistry.js';

const isUnitreeAsset = (config) => config.id === 'Unitree_robot' || config.name.toLowerCase().includes('unitree');

function formatVector(vector) {
  return { x: Number(vector.x.toFixed(4)), y: Number(vector.y.toFixed(4)), z: Number(vector.z.toFixed(4)) };
}

function formatEuler(euler) {
  return { x: Number(euler.x.toFixed(4)), y: Number(euler.y.toFixed(4)), z: Number(euler.z.toFixed(4)) };
}

function modelState(model) {
  return {
    position: formatVector(model.position),
    rotation: formatEuler(model.rotation),
    scale: formatVector(model.scale),
    visible: model.visible,
    parent: model.parent?.type || null,
    sceneContainsModel: model.parent !== null,
  };
}

export class AssetManager {
  constructor({ scene, cameraManager, controls, floor, onAssetLoaded, onAssetError }) {
    this.scene = scene;
    this.cameraManager = cameraManager;
    this.controls = controls;
    this.floor = floor;
    this.onAssetLoaded = onAssetLoaded;
    this.onAssetError = onAssetError;
    this.loader = new GLTFLoader();
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
    }
  }

  load(config) {
    return new Promise((resolve, reject) => {
      this.loader.load(config.model, (gltf) => {
        const model = gltf.scene;
        const unitree = isUnitreeAsset(config);
        if (unitree) this.logUnitreeLoadStart(config, gltf, model);
        const beforeBounds = unitree ? this.boundsReport(model) : null;
        const bounds = new THREE.Box3().setFromObject(model);
        model.position.sub(bounds.getCenter(new THREE.Vector3()));
        model.traverse((object) => {
          if (!object.isMesh) return;
          object.castShadow = true;
          object.receiveShadow = true;
        });

        const asset = {
          config,
          gltf,
          model,
          bounds,
          animations: gltf.animations,
          animationController: new AnimationController(model, gltf.animations),
        };
        if (unitree) this.logUnitreeLoadComplete(asset, beforeBounds);
        console.info(`Asset loaded successfully: ${config.name}`);
        console.info(`Animations: ${gltf.animations.length}`);
        gltf.animations.forEach((clip, index) => console.info(`Animation ${index + 1}: ${clip.name || '(unnamed)'}`));
        this.cache.set(config.id, asset);
        resolve(asset);
      }, undefined, reject);
    });
  }

  replaceCurrent(asset) {
    if (this.currentAsset) {
      this.currentAsset.animationController.stop();
      this.scene.remove(this.currentAsset.model);
    }

    this.scene.add(asset.model);
    const bounds = new THREE.Box3().setFromObject(asset.model);
    if (this.floor) this.floor.position.y = bounds.min.y - 0.01;
    this.cameraManager.frameObject(asset.model, this.controls);
    if (isUnitreeAsset(asset.config)) {
      console.info('G1 added to scene', asset.model);
      console.info('G1 still in scene:', asset.model.parent !== null);
      console.info('G1 camera framing', {
        cameraPosition: formatVector(this.cameraManager.camera.position),
        cameraNear: this.cameraManager.camera.near,
        cameraFar: this.cameraManager.camera.far,
        controlsTarget: formatVector(this.controls.target),
        bounds: this.boundsReport(asset.model),
      });
      asset.debugState = modelState(asset.model);
    }
  }

  update(deltaTime) {
    this.currentAsset?.animationController.update(deltaTime);
    if (this.currentAsset && isUnitreeAsset(this.currentAsset.config)) this.updateUnitreeDiagnostics();
  }

  get currentAnimations() {
    return this.currentAsset?.animations || [];
  }

  dispose() {
    this.currentAsset?.animationController.stop();
    this.cache.forEach((asset) => asset.animationController.dispose());
    this.cache.clear();
  }

  boundsReport(model) {
    const bounds = new THREE.Box3().setFromObject(model);
    const size = bounds.getSize(new THREE.Vector3());
    const sphere = bounds.getBoundingSphere(new THREE.Sphere());
    return {
      min: formatVector(bounds.min),
      max: formatVector(bounds.max),
      width: Number(size.x.toFixed(4)),
      height: Number(size.y.toFixed(4)),
      depth: Number(size.z.toFixed(4)),
      sphereCenter: formatVector(sphere.center),
      sphereRadius: Number(sphere.radius.toFixed(4)),
    };
  }

  logUnitreeLoadStart(config, gltf, model) {
    console.groupCollapsed('UNITREE G1 LOAD');
    console.info('Asset ID:', config.id);
    console.info('GLB path:', config.model);
    console.info('Loaded:', true);
    console.info('gltf.scene:', gltf.scene);
    console.info('Children:', model.children.length);
    console.info('Meshes:', this.countMeshes(model));
    console.info('Animations:', gltf.animations.length);
    console.info('BoundingBox before generic setup:', this.boundsReport(model));
    console.info('Model state before generic setup:', modelState(model));
    console.groupEnd();
  }

  logUnitreeLoadComplete(asset, beforeBounds) {
    console.groupCollapsed('UNITREE G1 AFTER GENERIC ASSET SETUP');
    console.info('BoundingBox after generic setup:', this.boundsReport(asset.model));
    console.info('Model state after generic setup:', modelState(asset.model));
    console.info('Bounds before generic setup:', beforeBounds);
    console.info('Animation mixer created:', asset.animationController.mixer !== null);
    console.info('Animation automatically played:', false);
    this.inspectMaterials(asset.model);
    console.groupEnd();
  }

  updateUnitreeDiagnostics() {
    const asset = this.currentAsset;
    const state = modelState(asset.model);
    const previous = asset.debugState;
    if (!previous || JSON.stringify(previous) !== JSON.stringify(state)) {
      console.info('G1 render state changed', {
        previous,
        current: state,
        'G1 still in scene': asset.model.parent !== null,
        sceneContainsModel: this.scene.children.includes(asset.model),
      });
      asset.debugState = state;
    }
    asset.debugFrameCount = (asset.debugFrameCount || 0) + 1;
    if (asset.debugFrameCount % 120 === 0) {
      console.info('G1 still in scene:', asset.model.parent !== null);
      console.info('G1 periodic bounds:', this.boundsReport(asset.model));
    }
  }

  countMeshes(model) {
    let count = 0;
    model.traverse((object) => {
      if (object.isMesh) count += 1;
    });
    return count;
  }

  inspectMaterials(model) {
    model.traverse((object) => {
      if (!object.isMesh) return;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      materials.forEach((material, index) => {
        console.info('G1 mesh material', {
          mesh: object.name || '(unnamed)',
          materialIndex: index,
          material: material?.name || '(unnamed)',
          type: material?.type,
          visible: object.visible,
          materialVisible: material?.visible,
          opacity: material?.opacity,
          transparent: material?.transparent,
          depthWrite: material?.depthWrite,
          layers: object.layers.mask,
          frustumCulled: object.frustumCulled,
          renderOrder: object.renderOrder,
        });
      });
    });
  }
}
