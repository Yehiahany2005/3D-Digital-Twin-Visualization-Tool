// Saves scenes in this browser (IndexedDB), plus which scene and which mode were open last.
// Scenes are small (they refer to models, they don't contain them), so this is cheap.

import { STORES, requestPersistentStorage, withStore } from '../assets/db.js';
import { normalizeScene } from './SceneDocument.js';

const LAST_SCENE_KEY = 'digital-twin:last-scene';
const LAST_MODE_KEY = 'digital-twin:last-mode';

// [{ id, name, updatedAt, itemCount }], most recently changed first.
export async function listScenes() {
  try {
    const records = await withStore(STORES.scenes, 'readonly', (store) => store.getAll());
    return records
      .map(({ id, scene, updatedAt }) => ({ id, name: scene?.name || 'Untitled scene', updatedAt, itemCount: scene?.items?.length || 0 }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  } catch (error) {
    console.warn('Saved scenes could not be read from this browser.', error);
    return [];
  }
}

export async function loadScene(id) {
  const record = await withStore(STORES.scenes, 'readonly', (store) => store.get(id));
  return record ? normalizeScene(record.scene) : null;
}

let persistAsked = false;

export async function saveScene(scene) {
  await withStore(STORES.scenes, 'readwrite', (store) => store.put({ id: scene.id, scene, updatedAt: Date.now() }));
  if (!persistAsked) {
    persistAsked = true;
    requestPersistentStorage();
  }
}

export async function deleteScene(id) {
  await withStore(STORES.scenes, 'readwrite', (store) => store.delete(id));
}

function readKey(key) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeKey(key, value) {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // Storage unavailable: the app just starts in its defaults next time.
  }
}

export const lastSceneId = () => readKey(LAST_SCENE_KEY);
export const rememberLastScene = (id) => writeKey(LAST_SCENE_KEY, id);
export const lastMode = () => readKey(LAST_MODE_KEY);
export const rememberLastMode = (mode) => writeKey(LAST_MODE_KEY, mode);
