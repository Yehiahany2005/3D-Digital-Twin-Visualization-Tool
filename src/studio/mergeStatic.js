import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// Fewer draw calls for big CAD models in scenes.
//
// A robot exported from CAD can have 500–900 separate meshes; the GPU draws each one separately,
// so a few of them make the view crawl. But most of those meshes never move relative to each
// other: everything carried by one joint moves as one piece. So, per joint (and for the parts no
// joint carries), meshes sharing a material are merged into one. Joints keep working; the original
// meshes stay (hidden) so bounds, Reach's floor check and the rig itself are unchanged.
//
// All copies of a model with the same rig have the same structure, so the merged geometry is
// built once per model and rig, and shared by every copy.

const MIN_GROUP = 2; // merging a single mesh gains nothing

function attributeSignature(geometry) {
  return Object.entries(geometry.attributes)
    .map(([name, attribute]) => `${name}:${attribute.itemSize}:${attribute.normalized}:${attribute.array.constructor.name}`)
    .sort()
    .join('|');
}

// Materials that look the same (CAD exports often give every part its own copy of the same
// paint) share a key, so their parts can be merged too. Colours within 1/32 per channel count as
// the same; anything with a texture or other special settings keeps its own identity.
const quantize = (value, steps) => Math.round(value * steps);
function materialKey(material) {
  const textured = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'alphaMap', 'aoMap'].some((slot) => material[slot]);
  if (textured || !material.color) return material.uuid;
  const color = material.color;
  return [
    material.type,
    quantize(color.r, 32), quantize(color.g, 32), quantize(color.b, 32),
    quantize(material.roughness ?? 0, 10), quantize(material.metalness ?? 0, 10),
    material.emissive ? material.emissive.getHexString() : '',
    material.transparent, quantize(material.opacity, 20), material.side, material.vertexColors, material.wireframe,
  ].join(',');
}

function canMerge(mesh) {
  return mesh.isMesh && !mesh.isSkinnedMesh && !mesh.userData.mergedParts && !mesh.isInstancedMesh && !Array.isArray(mesh.material)
    && mesh.geometry?.attributes.position && !Object.keys(mesh.geometry.morphAttributes || {}).length
    && mesh.visible;
}

// Objects the model's own animation clips move (clips address them by name or uuid).
function animatedObjects(asset) {
  const animated = new Set();
  (asset.animations || []).forEach((clip) => clip.tracks.forEach((track) => {
    const { nodeName } = THREE.PropertyBinding.parseTrackName(track.name);
    const node = THREE.PropertyBinding.findNode(asset.content, nodeName);
    if (node) animated.add(node);
  }));
  return animated;
}

// owners: the objects that move as one (the content root, each joint group, and everything an
// animation clip moves), keyed by a name that is the same in every copy of the model.
function collectGroups(asset) {
  const owners = new Map([[asset.content, 'content']]);
  asset.rig.joints.forEach((joint) => owners.set(joint.group, `joint:${joint.id}`));
  animatedObjects(asset).forEach((object) => {
    if (!owners.has(object)) owners.set(object, `animated:${object.userData.partPath ?? object.name}`);
  });
  const groups = new Map();
  asset.content.updateMatrixWorld(true);
  asset.content.traverse((object) => {
    if (!canMerge(object)) return;
    let owner = object.parent;
    while (owner && !owners.has(owner)) owner = owner.parent;
    if (!owner) return;
    const key = `${owners.get(owner)}|${materialKey(object.material)}|${attributeSignature(object.geometry)}`;
    if (!groups.has(key)) groups.set(key, { owner, ownerKey: owners.get(owner), material: object.material, meshes: [] });
    groups.get(key).meshes.push(object);
  });
  return [...groups.values()].filter((group) => group.meshes.length >= MIN_GROUP);
}

function buildMerged(group) {
  const ownerInverse = group.owner.matrixWorld.clone().invert();
  const anyNonIndexed = group.meshes.some((mesh) => !mesh.geometry.index);
  const pieces = group.meshes.map((mesh) => {
    let geometry = mesh.geometry.clone();
    if (anyNonIndexed && geometry.index) {
      const flat = geometry.toNonIndexed();
      geometry.dispose();
      geometry = flat;
    }
    // Only what every piece has can be merged; per-piece extras (like CAD face ranges) go.
    geometry.userData = {};
    geometry.applyMatrix4(ownerInverse.clone().multiply(mesh.matrixWorld));
    return geometry;
  });
  const merged = mergeGeometries(pieces, false);
  pieces.forEach((piece) => piece.dispose());
  if (merged) merged.computeBoundingSphere();
  return merged;
}

// cache: a Map kept on the model's template, keyed by rig signature.
export function mergeStaticMeshes(asset, cache) {
  const groups = collectGroups(asset);
  if (!groups.length) return { merged: 0, before: 0 };
  let built = cache.get(asset.rigSignature);
  if (!built) {
    built = new Map(groups.map((group) => [`${group.ownerKey}|${materialKey(group.material)}|${attributeSignature(group.meshes[0].geometry)}`, buildMerged(group)]));
    cache.set(asset.rigSignature, built);
  }
  let hidden = 0;
  groups.forEach((group) => {
    const geometry = built.get(`${group.ownerKey}|${materialKey(group.material)}|${attributeSignature(group.meshes[0].geometry)}`);
    if (!geometry) return;
    const mesh = new THREE.Mesh(geometry, group.material);
    mesh.name = `Merged ${group.meshes.length} parts`;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.mergedParts = group.meshes;
    group.owner.add(mesh);
    group.meshes.forEach((original) => { original.visible = false; });
    hidden += group.meshes.length;
  });
  return { merged: groups.length, before: hidden };
}
