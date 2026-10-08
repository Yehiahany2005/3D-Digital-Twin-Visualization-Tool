import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneWithSkeletons } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { createProceduralWorker } from '../../station/ProceduralWorker.js';
import { downloadModel } from '../../loaders/download.js';
import personUrl from '../../assets/people/KayKit_Rogue.glb?url';
import { choice, disposeObject, number, toggle } from './shared.js';

// Simple worker with a pallet jack, built from boxes. Origin on the floor; faces +X.
export const worker = {
  id: 'worker',
  name: 'Worker with pallet jack',
  category: 'People',
  description: 'Simple figure with a hand pallet jack',
  icon: 'User',
  params: {
    forkHeight: number('Fork height', 0, { min: 0, max: 0.2, step: 0.01, unit: 'm' }),
  },
  build({ forkHeight }) {
    const built = createProceduralWorker();
    built.setForkHeight(0.045 + forkHeight);
    return {
      root: built.root,
      anchors: {},
      colliders: [],
      body: 'none',
      dispose: () => disposeObject(built.root),
    };
  },
};

// The animated person: KayKit "Rogue" by Kay Lousberg (CC0, www.kaylousberg.com; see
// src/assets/people/LICENSE-KayKit.txt) without the fantasy props, so it reads as a plain worker.
const HIDDEN_PROPS = /knife|crossbow|throwable|cape/i;
const ANIMATIONS = [
  ['Idle', 'Standing'],
  ['Walking_A', 'Walking'],
  ['Walking_C', 'Walking (relaxed)'],
  ['Running_A', 'Running'],
  ['PickUp', 'Picking up'],
  ['Interact', 'Working at something'],
  ['Use_Item', 'Using a tool'],
  ['Sit_Chair_Idle', 'Sitting'],
  ['Cheer', 'Cheering'],
];

let personTemplate = null;
function loadPerson() {
  personTemplate ??= downloadModel(personUrl, 'the person model')
    .then((buffer) => new GLTFLoader().parseAsync(buffer, ''))
    .then((gltf) => {
      gltf.scene.traverse((child) => {
        if (child.isMesh) {
          child.castShadow = true;
          child.receiveShadow = true;
          if (HIDDEN_PROPS.test(child.name)) child.visible = false;
        }
      });
      return gltf;
    })
    .catch((error) => {
      personTemplate = null;
      throw error;
    });
  return personTemplate;
}

export const person = {
  id: 'person',
  name: 'Person (animated)',
  category: 'People',
  description: 'Walks, works or stands; plays on a loop',
  icon: 'User',
  params: {
    animation: choice('Doing', 'Idle', ANIMATIONS.map(([value, label]) => ({ value, label }))),
    height: number('Height', 1.75, { min: 1, max: 2.2, step: 0.01, unit: 'm' }),
    walkAround: toggle('Walk in a loop when playing', false),
    walkRadius: number('Loop size', 2, { min: 0.5, max: 20, step: 0.1, unit: 'm' }),
  },
  async build({ animation, height, walkAround, walkRadius }) {
    const gltf = await loadPerson();
    const figure = cloneWithSkeletons(gltf.scene);
    const root = new THREE.Group();
    root.name = 'Person';
    const body = new THREE.Group();
    body.add(figure);
    root.add(body);
    // Scale to the asked height, feet on the floor.
    figure.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(figure, true);
    const scale = height / Math.max(bounds.max.y - bounds.min.y, 0.01);
    figure.scale.setScalar(scale);
    figure.position.y = -bounds.min.y * scale;
    const mixer = new THREE.AnimationMixer(figure);
    const action = (name) => {
      const clip = gltf.animations.find((candidate) => candidate.name === name) || gltf.animations.find((candidate) => candidate.name === 'Idle');
      return clip ? mixer.clipAction(clip) : null;
    };
    const chosen = action(animation);
    const walking = action('Walking_A');
    let current = chosen;
    current?.play();
    const use = (next) => {
      if (!next || next === current) return;
      next.reset().play();
      current?.crossFadeTo(next, 0.3, false);
      current = next;
    };
    let angle = 0;
    return {
      root,
      anchors: {},
      colliders: [],
      body: 'none',
      update(deltaTime, editor) {
        mixer.update(deltaTime);
        // Walking a circle when the scene plays (and back where it was placed when it stops).
        // The figure faces +Z; it walks the circle starting along +X.
        if (walkAround && editor?.playing) {
          use(walking);
          angle += (deltaTime * 1.1) / walkRadius;
          body.position.set(Math.sin(angle) * walkRadius, 0, (1 - Math.cos(angle)) * walkRadius);
          body.rotation.y = Math.PI / 2 - angle;
        } else {
          use(chosen);
          if (angle !== 0) {
            angle = 0;
            body.position.set(0, 0, 0);
            body.rotation.y = 0;
          }
        }
      },
      dispose: () => mixer.stopAllAction(),
    };
  },
};
