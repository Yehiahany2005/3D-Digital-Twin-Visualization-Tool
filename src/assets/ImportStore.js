// Keeps imported model files in this browser so they are still there after a page refresh.
//
// Files go into IndexedDB, the browser's built-in database for large data (localStorage holds
// only a few megabytes). Nothing leaves the device. Each model's joints, poses and sequences are
// saved separately by RigStore, keyed by file name and size, so they come back with the file.

const DB_NAME = 'digital-twin';
const STORE = 'imported-models';
const LAST_ASSET_KEY = 'digital-twin:last-asset';

let dbPromise = null;

function openDb() {
  dbPromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

// Runs one request against the store and resolves when its transaction has finished.
async function withStore(mode, makeRequest) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, mode);
    const request = makeRequest(transaction.objectStore(STORE));
    transaction.oncomplete = () => resolve(request.result);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error('Saving was cancelled.'));
  });
}

// The same file imported twice gets the same id, so it is stored (and listed) once.
export function storedImportId(file) {
  return `import:${file.name}:${file.size}:${file.lastModified}`;
}

// Saved models, oldest first: [{ id, file }].
export async function listStoredImports() {
  try {
    const records = await withStore('readonly', (store) => store.getAll());
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
  await withStore('readwrite', (store) => store.put({ id, file, addedAt: Date.now() }));
  // Ask the browser not to clear this data when space runs low. It may say no; that is fine.
  navigator.storage?.persist?.().catch(() => {});
  return id;
}

export async function removeStoredImport(id) {
  await withStore('readwrite', (store) => store.delete(id));
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
