import * as THREE from 'three';
import { anchorsOf, worldOf } from '../Anchors.js';
import { dependentsOf } from '../SceneDocument.js';
import { gridSpots } from './Program.js';

// Where program steps go, in the scene: named spots on objects (anchors), clicked points, and the
// spots of a grid. See Program.js for the target formats.

// Anchor types a program can go to, and what to call each anchor in plain words.
const SPOT_TYPES = new Set(['flow-in', 'flow-out', 'surface', 'grasp']);
const SPOT_NAMES = { input: 'start', output: 'end', surface: 'top', grasp: 'top' };
// Picking a point this close to a spot uses the spot instead.
const SNAP_DISTANCE = 0.25;

export function spotName(anchor) {
  return SPOT_NAMES[anchor.name] || anchor.label || anchor.name;
}

function usableAnchors(runtime) {
  return anchorsOf(runtime).filter((anchor) => SPOT_TYPES.has(anchor.type));
}

// The spots a robot can use: every object's named spots, except its own and those of what is
// mounted on it. [{ target, label, type }]
export function sceneSpots(editor, robotId, { types = null } = {}) {
  const skip = robotId ? new Set([robotId, ...dependentsOf(editor.document, robotId)]) : new Set();
  const spots = [];
  editor.items.forEach((item) => {
    if (skip.has(item.id)) return;
    usableAnchors(editor.runtimes.get(item.id)).forEach((anchor) => {
      if (types && !types.includes(anchor.type)) return;
      spots.push({ target: { kind: 'spot', item: item.id, anchor: anchor.name }, label: `${item.name} · ${spotName(anchor)}`, type: anchor.type });
    });
  });
  return spots;
}

// Where a spot or point is in the world, with the turn of the object it is on:
// { position, quaternion }, or null if its object is gone.
export function targetFrame(editor, target) {
  if (!target) return null;
  if (target.kind === 'spot') {
    const anchor = usableAnchors(editor.runtimes.get(target.item)).find((candidate) => candidate.name === target.anchor);
    if (!anchor) return null;
    return { position: worldOf(anchor).position, quaternion: anchor.object.getWorldQuaternion(new THREE.Quaternion()) };
  }
  if (target.kind === 'point') {
    if (!target.item) return { position: new THREE.Vector3(...target.offset), quaternion: new THREE.Quaternion() };
    const runtime = editor.runtimes.get(target.item);
    if (!runtime || runtime.destroyed) return null;
    runtime.root.updateMatrixWorld(true);
    return {
      position: new THREE.Vector3(...target.offset).applyMatrix4(runtime.root.matrixWorld),
      quaternion: runtime.root.getWorldQuaternion(new THREE.Quaternion()),
    };
  }
  return null;
}

export function targetLabel(editor, target) {
  if (!target) return 'nowhere yet';
  if (target.kind === 'grid') return 'the next spot on the grid';
  if (target.kind === 'box') return `the box at ${targetLabel(editor, target.at)}`;
  const item = target.item ? editor.item(target.item) : null;
  if (target.item && !item) return 'a spot that was deleted';
  if (target.kind === 'point') return item ? `a point on ${item.name}` : 'a point on the floor';
  const anchor = usableAnchors(editor.runtimes.get(target.item)).find((candidate) => candidate.name === target.anchor);
  return `${item.name} · ${anchor ? spotName(anchor) : target.anchor}`;
}

// A target from a click in the view: the object's spot if the click was near one, else the point
// clicked on that object (in its own frame, so it moves with it), or on the floor.
export function targetFromHit(editor, hit, floor) {
  if (!hit) return null;
  if (hit.object === floor) return { kind: 'point', item: null, offset: hit.point.toArray().map((value) => Math.round(value * 1000) / 1000) };
  const itemId = editor.itemIdFor(hit.object);
  const runtime = itemId && editor.runtimes.get(itemId);
  if (!runtime) return null;
  let nearest = null;
  usableAnchors(runtime).forEach((anchor) => {
    const distance = worldOf(anchor).position.distanceTo(hit.point);
    if (distance < SNAP_DISTANCE && (!nearest || distance < nearest.distance)) nearest = { anchor, distance };
  });
  if (nearest) return { kind: 'spot', item: itemId, anchor: nearest.anchor.name };
  runtime.root.updateMatrixWorld(true);
  const offset = runtime.root.worldToLocal(hit.point.clone());
  return { kind: 'point', item: itemId, offset: offset.toArray().map((value) => Math.round(value * 1000) / 1000) };
}

// ---- Grids ----------------------------------------------------------------------------------

// Objects a grid can be laid on (those with a top surface), as grid targets.
export function gridSurfaces(editor, robotId) {
  return sceneSpots(editor, robotId, { types: ['surface'] });
}

// Every spot of a grid in the world: [{ index, position, quaternion }] (bottom middle of a box
// placed there, turned with the surface), or null if the surface is gone.
export function gridWorldSpots(editor, grid) {
  const frame = targetFrame(editor, grid.on);
  if (!frame) return null;
  return gridSpots(grid).map((spot) => ({
    ...spot,
    position: new THREE.Vector3(...spot.position).applyQuaternion(frame.quaternion).add(frame.position),
    quaternion: frame.quaternion.clone(),
  }));
}

// ---- Workers with a pallet jack -------------------------------------------------------------

export function isPallet(item) {
  return item?.source.kind === 'catalog' && item.source.id === 'pallet';
}

// The scene's pallets, in scene order: [{ id, label }]. With more than one, they are numbered:
// the first pallet keeps the plain name ("Pallet") in the Explorer, so it is shown as "Pallet 1"
// next to "Pallet 2", "Pallet 3"… Renamed pallets keep their own names.
export function palletChoices(editor) {
  const pallets = editor.items.filter(isPallet);
  return pallets.map((item) => {
    const numbered = pallets.length > 1 && !/ \d+$/.test(item.name) && pallets.some((other) => other.name.startsWith(`${item.name} `));
    return { id: item.id, label: numbered ? `${item.name} 1` : item.name };
  });
}

export function palletLabel(editor, id) {
  if (!id) return null;
  return palletChoices(editor).find((choice) => choice.id === id)?.label || 'a pallet that was deleted';
}

// Where a worker can go: every object standing on its own (not the worker, not things mounted on
// or attached to others, not loose boxes), pallets with their numbered names: [{ target, label }].
export function destinationChoices(editor, workerId) {
  const pallets = new Map(palletChoices(editor).map((choice) => [choice.id, choice.label]));
  return editor.items
    .filter((item) => item.id !== workerId && !item.mount && !item.attach && !(item.source.kind === 'catalog' && item.source.id === 'box'))
    .map((item) => ({ target: { kind: 'item', item: item.id }, label: pallets.get(item.id) || item.name }));
}

export function destinationLabel(editor, target) {
  if (!target) return null;
  if (target.kind === 'start') return 'where it started';
  if (target.kind === 'point') return 'a point on the floor';
  if (target.kind === 'item') {
    if (isPallet(editor.item(target.item))) return palletLabel(editor, target.item);
    return editor.item(target.item)?.name || 'an object that was deleted';
  }
  return null;
}

// The middle of an object on the floor and its turn, in the world, or null if it is gone.
export function itemFrame(editor, id) {
  const runtime = editor.runtimes.get(id);
  if (!runtime || runtime.destroyed) return null;
  runtime.root.updateMatrixWorld(true);
  return {
    position: runtime.root.getWorldPosition(new THREE.Vector3()),
    quaternion: runtime.root.getWorldQuaternion(new THREE.Quaternion()),
  };
}
