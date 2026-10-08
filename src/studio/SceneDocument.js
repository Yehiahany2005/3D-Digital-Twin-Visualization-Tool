// A scene document: the small JSON that describes a scene. It never holds meshes, only what is
// placed where; models are referred to and rebuilt when the scene is opened.
//
//   {
//     format: 'digital-twin-scene', version: 1, id, name, units: 'm',
//     items: [{
//       id, name,
//       source: { kind: 'builtin', id }                 a model in AssetRegistry
//             | { kind: 'import', id, name }            a file kept in ImportStore (name for messages)
//             | { kind: 'catalog', id },                a built-in component (conveyor, pallet…)
//       position: [x, y, z]  metres, rotation: [x, y, z]  degrees (Euler order YXZ: yaw first),
//       params:  { … }       a catalog component's settings (length, speed…),
//       pose:    { jointId: value }   where a machine's joints were left,
//       animation: 'clip name'        a clip the item plays on a loop,
//       mount:   { to: itemId, anchor }                       snapped onto another item's anchor,
//       attach:  { to: itemId, joint, position, rotation }    follows another item, kept where it was,
//       solid: true          blocks falling boxes (physics), hidden: true, locked: true,
//     }],
//     camera: { position, target },
//   }
//
// Unknown fields are kept, so a file written by a newer version loses nothing when re-saved.

export const SCENE_FORMAT = 'digital-twin-scene';
export const SCENE_VERSION = 1;

const ROTATION_ORDER = 'YXZ';
export { ROTATION_ORDER };

function finite3(value, fallback) {
  return Array.isArray(value) && value.length === 3 && value.every(Number.isFinite) ? [...value] : [...fallback];
}

export function newId(prefix = 'item') {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function emptyScene(name = 'New scene') {
  return { format: SCENE_FORMAT, version: SCENE_VERSION, id: newId('scene'), name, units: 'm', items: [], camera: null };
}

function normalizeItem(item) {
  if (!item || typeof item !== 'object' || !item.source?.kind || !item.source?.id) return null;
  return {
    ...item,
    id: String(item.id || newId()),
    name: String(item.name || item.source.name || item.source.id),
    position: finite3(item.position, [0, 0, 0]),
    rotation: finite3(item.rotation, [0, 0, 0]),
  };
}

// Brings any older or hand-edited document up to the current version. Throws on something that
// isn't a scene at all.
export function normalizeScene(data) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.items)) throw new Error('This is not a scene file (no "items" list).');
  if (data.format && data.format !== SCENE_FORMAT) throw new Error(`This file is a "${data.format}", not a scene.`);
  if (Number(data.version) > SCENE_VERSION) {
    console.warn(`Scene version ${data.version} is newer than this app (${SCENE_VERSION}); unknown parts are kept as they are.`);
  }
  const ids = new Set();
  const items = data.items.map(normalizeItem).filter((item) => {
    if (!item || ids.has(item.id)) return false;
    ids.add(item.id);
    return true;
  });
  // A mount or attachment to an item that isn't there would hide the item: drop the link instead.
  items.forEach((item) => {
    if (item.mount && !ids.has(item.mount.to)) delete item.mount;
    if (item.attach && !ids.has(item.attach.to)) delete item.attach;
  });
  return {
    ...data,
    format: SCENE_FORMAT,
    version: Math.max(SCENE_VERSION, Number(data.version) || 0),
    id: String(data.id || newId('scene')),
    name: String(data.name || 'Untitled scene'),
    units: 'm',
    items,
    camera: data.camera || null,
  };
}

export function cloneScene(scene) {
  return structuredClone(scene);
}

// A name not used by any other item: "Conveyor", "Conveyor 2", …
export function uniqueName(scene, name) {
  const names = new Set(scene.items.map((item) => item.name));
  if (!names.has(name)) return name;
  // "Conveyor 2" copied gives "Conveyor 3", not "Conveyor 2 2"; but a number that is part of the
  // name itself ("ABB IRB 6760") stays.
  const stripped = name.replace(/ \d+$/, '');
  const base = stripped !== name && names.has(stripped) ? stripped : name;
  let counter = 2;
  while (names.has(`${base} ${counter}`)) counter += 1;
  return `${base} ${counter}`;
}

// Items that hang off `id` (mounted on or attached to it), recursively.
export function dependentsOf(scene, id) {
  const result = new Set();
  let grew = true;
  while (grew) {
    grew = false;
    scene.items.forEach((item) => {
      const parent = item.mount?.to || item.attach?.to;
      if (parent && (parent === id || result.has(parent)) && !result.has(item.id)) {
        result.add(item.id);
        grew = true;
      }
    });
  }
  return result;
}

// What an item hangs off, if anything.
export function parentOf(item) {
  return item.mount?.to || item.attach?.to || null;
}
