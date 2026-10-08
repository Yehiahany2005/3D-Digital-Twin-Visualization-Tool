// Keeps imported model files in this browser so they are still there after a page refresh.
//
// Files go into IndexedDB, the browser's built-in database for large data (localStorage holds
// only a few megabytes). Nothing leaves the device. Each model's joints, poses and sequences are
// saved separately by RigStore, keyed by file name and size, so they come back with the file.

import { STORES, requestPersistentStorage, withStore } from './db.js';

const LAST_ASSET_KEY = 'digital-twin:last-asset';

// The same file imported twice gets the same id, so it is stored (and listed) once.
export function storedImportId(file) {
  return `import:${file.name}:${file.size}:${file.lastModified}`;
}

// One saved model's file, or null.
export async function getStoredImport(id) {
  try {
    const record = await withStore(STORES.imports, 'readonly', (store) => store.get(id));
    return record?.file || null;
  } catch {
    return null;
  }
}

// Saved models, oldest first: [{ id, file }].
export async function listStoredImports() {
  try {
    const records = await withStore(STORES.imports, 'readonly', (store) => store.getAll());
    return records
      .sort((a, b) => a.addedAt - b.addedAt)
      .map(({ id, file }) => ({ id, file }));
  } catch (error) {
    console.warn('Saved models could not be read from this browser.', error);
    return [];
  }
}

// Saves a file and returns its id; throws if the browser refuses (e.g. out of space).
export async function storeImport(file) {
  const id = storedImportId(file);
  await withStore(STORES.imports, 'readwrite', (store) => store.put({ id, file, addedAt: Date.now() }));
  requestPersistentStorage();
  return id;
}

export async function removeStoredImport(id) {
  await withStore(STORES.imports, 'readwrite', (store) => store.delete(id));
}

// The model to reopen after a refresh.
export function rememberLastAsset(id) {
  try {
    window.localStorage.setItem(LAST_ASSET_KEY, id);
  } catch {
    // Storage unavailable: the app just opens the default model next time.
  }
}

export function lastAsset() {
  try {
    return window.localStorage.getItem(LAST_ASSET_KEY);
  } catch {
    return null;
  }
}
