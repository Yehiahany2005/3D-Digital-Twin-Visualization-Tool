import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import * as THREE from 'three';

function describeNode(node) {
  const labels = [];
  if (node.isMesh) labels.push('Mesh');
  if (node.isGroup) labels.push('Group');
  if (node.isSkinnedMesh) labels.push('SkinnedMesh');
  if (node.isBone) labels.push('Bone');

  const type = labels.length > 0 ? labels.join(', ') : node.type;
  return `${node.name || '(unnamed)'} [${type}]`;
}

function printNodeTree(node, prefix = '', isLast = true) {
  console.info(`${prefix}${isLast ? '└── ' : '├── '}${describeNode(node)}`);

  const childPrefix = `${prefix}${isLast ? '    ' : '│   '}`;
  node.children.forEach((child, index) => {
    printNodeTree(child, childPrefix, index === node.children.length - 1);
  });
}

function inspectModel(gltf) {
  const nodes = [];
  const meshNodes = [];
  const groupNodes = [];
  const skinnedMeshes = [];
  const bones = [];

  gltf.scene.traverse((node) => {
    nodes.push(node);
    if (node.isMesh) meshNodes.push(node);
    if (node.isGroup) groupNodes.push(node);
    if (node.isSkinnedMesh) skinnedMeshes.push(node);
    if (node.isBone) bones.push(node);
  });

  console.groupCollapsed('GLB model inspection');
  console.info(`Total animations: ${gltf.animations.length}`);
  console.info('Animation clips:');
  if (gltf.animations.length === 0) console.info('(none)');
  gltf.animations.forEach((clip, index) => console.info(`${index + 1}. ${clip.name || '(unnamed)'}`));

  console.info('Complete node hierarchy:');
  printNodeTree(gltf.scene);

  console.info('All node names:');
  nodes.forEach((node, index) => console.info(`${index + 1}. ${node.name || '(unnamed)'}`));

  console.info('Mesh nodes:');
  if (meshNodes.length === 0) console.info('(none)');
  meshNodes.forEach((node) => console.info(`- ${node.name || '(unnamed)'}`));

  console.info('Group nodes:');
  if (groupNodes.length === 0) console.info('(none)');
  groupNodes.forEach((node) => console.info(`- ${node.name || '(unnamed)'}`));

  console.info(`SkinnedMesh present: ${skinnedMeshes.length > 0}`);
  skinnedMeshes.forEach((node) => console.info(`- ${node.name || '(unnamed)'}`));
  console.info(`Bones present: ${bones.length > 0}`);
  bones.forEach((node) => console.info(`- ${node.name || '(unnamed)'}`));
  console.groupEnd();
}

export class RobotLoader {
  constructor() {
    this.loader = new GLTFLoader();
  }

  load(url) {
    return new Promise((resolve, reject) => {
      this.loader.load(url, (gltf) => {
        const robot = gltf.scene;
        inspectModel(gltf);
        const bounds = new THREE.Box3().setFromObject(robot);
        robot.position.sub(bounds.getCenter(new THREE.Vector3()));
        let meshCount = 0;
        const materials = new Set();

        robot.traverse((object) => {
          if (!object.isMesh) return;
          meshCount += 1;
          object.castShadow = true;
          object.receiveShadow = true;
          if (Array.isArray(object.material)) object.material.forEach((material) => materials.add(material));
          else if (object.material) materials.add(object.material);
        });

        console.info('Robot loaded successfully');
        console.info(`Number of meshes: ${meshCount}`);
        console.info(`Number of materials: ${materials.size}`);
        resolve(robot);
      }, undefined, (error) => {
        console.error('Unable to load robot model:', error);
        reject(new Error('The robot model could not be loaded.'));
      });
    });
  }
}