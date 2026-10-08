// The app's browser database (IndexedDB): large data that has to survive a page refresh.
// Nothing leaves the device.
//
//   imported-models: model files the user imported (ImportStore)
//   scenes:          saved scenes (SceneStore)

const DB_NAME = 'digital-twin';
const DB_VERSION = 2;
export const STORES = { imports: 'imported-models', scenes: 'scenes' };

let dbPromise = null;

function openDb() {
  dbPromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    // Version 1 had only the imported models; each version adds what is missing.
    request.onupgradeneeded = () => {
      const db = request.result;
      Object.values(STORES).forEach((name) => {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'id' });
      });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('The app is open in another tab with an older version. Close the other tab and reload.'));
  });
  return dbPromise;
}

// Runs one request against a store and resolves when its transaction has finished.
export async function withStore(storeName, mode, makeRequest) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, mode);
    const request = makeRequest(transaction.objectStore(storeName));
    transaction.oncomplete = () => resolve(request.result);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error('Saving was cancelled.'));
  });
}

// Asks the browser not to clear this data when space runs low. It may say no; that is fine.
export function requestPersistentStorage() {
  navigator.storage?.persist?.().catch(() => {});
}
