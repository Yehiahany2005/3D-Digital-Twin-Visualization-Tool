import * as THREE from 'three';
import { clone as cloneWithSkeletons } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { ModelLoader } from '../loaders/ModelLoader.js';
import { placeOnFloor, readModelSource } from '../scene/AssetManager.js';
import { AnimationController } from '../scene/AnimationController.js';
import { emptyRigDefinition, Rig } from '../motion/Rig.js';
import { MotionPlayer } from '../motion/MotionPlayer.js';
import { loadSavedRig } from '../motion/RigStore.js';
import { mergeStaticMeshes } from './mergeStatic.js';

// Model files for scenes. Each file is parsed once into a template that is never shown or
// rigged; every placed copy is a clone of it with its own rig, motion player and animations.
//
// Clones share geometry, materials and textures with the template, so a second copy of a 50 MB
// robot costs scene nodes, not GPU memory. They are cloned from the untouched template and never
// from a rigged copy: a rig re-parents parts under joint groups, which a clone would copy too.
// SkeletonUtils' clone keeps skinned models (people, animated characters) bound to their bones.

// The rig a model type has right now: saved in this browser, else the built-in one, else none.
export function currentRigDefinition(config) {
  return loadSavedRig(config) || (config.rig ? structuredClone(config.rig) : emptyRigDefinition());
}

export class ModelTemplates {
  constructor({ onStatus } = {}) {
    this.onStatus = onStatus;
    this.loader = new ModelLoader();
    this.templates = new Map();
  }

  // Resolves to { config, content, animations, units, unitsGuessed, upAxis, stats }.
  template(config) {
    if (!this.templates.has(config.id)) {
      const loading = this.load(config).catch((error) => {
        this.templates.delete(config.id);
        throw error;
      });
      this.templates.set(config.id, loading);
    }
    return this.templates.get(config.id);
  }

  async load(config) {
    this.onStatus?.(`Reading ${config.name}…`);
    try {
      const { buffer, fileName } = await readModelSource(config);
      const parsed = await this.loader.parse(buffer, fileName, { onStatus: this.onStatus });
      let meshes = 0;
      let triangles = 0;
      parsed.scene.traverse((object) => {
        if (!object.isMesh) return;
        object.castShadow = true;
        object.receiveShadow = true;
        meshes += 1;
        const geometry = object.geometry;
        triangles += (geometry.index ? geometry.index.count : geometry.attributes.position?.count || 0) / 3;
      });
      return {
        config,
        content: parsed.scene,
        animations: parsed.animations,
        units: parsed.units,
        unitsGuessed: parsed.unitsGuessed,
        upAxis: parsed.upAxis,
        stats: { meshes, triangles: Math.round(triangles) },
      };
    } finally {
      this.onStatus?.(null);
    }
  }

  // A new placed copy, shaped like the assets Machine mode uses, so every tool works on it:
  // { config, model (root: unit scale + base motion), orientation, content, rig, player, … }.
  async createInstance(config) {
    const template = await this.template(config);
    const content = cloneWithSkeletons(template.content);
    const orientation = new THREE.Group();
    orientation.name = 'Orientation';
    orientation.add(content);
    const root = new THREE.Group();
    root.name = 'AssetRoot';
    root.add(orientation);

    const asset = {
      config,
      model: root,
      orientation,
      content,
      animations: template.animations,
      animationController: new AnimationController(content, template.animations),
      units: template.units,
      unitsGuessed: template.unitsGuessed,
      upAxis: template.upAxis,
      stats: template.stats,
    };
    placeOnFloor(asset);

    const definition = currentRigDefinition(config);
    asset.rig = new Rig({ root, content, definition: emptyRigDefinition() });
    try {
      asset.rig.setDefinition(definition);
    } catch (error) {
      console.warn(`The rig of ${config.name} could not be built; it is shown without joints.`, error);
      asset.rig.setDefinition(emptyRigDefinition());
    }
    // Remembered so the scene can tell when the model's rig was changed in Machine mode.
    asset.rigSignature = JSON.stringify(definition);
    asset.player = new MotionPlayer(asset.rig);
    // Draw what moves together as one piece (shared by every copy of this model and rig).
    template.mergeCache ??= new Map();
    const { merged, before } = mergeStaticMeshes(asset, template.mergeCache);
    asset.stats = { ...template.stats, drawn: template.stats.meshes - before + merged };
    return asset;
  }

  // Drops a parsed file once no scene uses it, so its memory can be freed.
  forget(configId) {
    this.templates.delete(configId);
  }
}

// Frees what only this copy owns (its rig's groups, its animation mixer). Geometry and materials
// belong to the template and are shared with other copies, so they stay.
export function disposeInstance(asset) {
  asset.player?.stop();
  asset.animationController?.dispose();
  asset.rig?.dispose();
  asset.model?.removeFromParent();
}
