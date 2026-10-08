// Saves rigs per model in this browser, and reads/writes .rig.json files.
//
// Browser storage is only a convenience for one person on one machine; the
// exported .rig.json file is the way to keep or share a rig.

const STORAGE_PREFIX = 'digital-twin-rig:v1:';
const FILE_FORMAT = 'digital-twin-rig';

export function rigStorageKey(config) {
  // Imported files have no stable id, so they are recognised by name and size.
  return config.file ? `file:${config.file.name}:${config.file.size}` : `asset:${config.id}`;
}

export function loadSavedRig(config) {
  return loadRigByKey(rigStorageKey(config));
}

// By storage key (see rigStorageKey), for rigs travelling inside scene files.
export function loadRigByKey(key) {
  try {
    const text = window.localStorage.getItem(STORAGE_PREFIX + key);
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

export function saveRigByKey(key, definition) {
  try {
    window.localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(definition));
    return true;
  } catch {
    return false;
  }
}

export function saveRig(config, definition) {
  try {
    window.localStorage.setItem(STORAGE_PREFIX + rigStorageKey(config), JSON.stringify(definition));
    return true;
  } catch {
    return false;
  }
}

export function forgetSavedRig(config) {
  try {
    window.localStorage.removeItem(STORAGE_PREFIX + rigStorageKey(config));
  } catch {
    // Storage unavailable (private mode, blocked site data): nothing to forget.
  }
}

export function downloadRig(definition, assetName) {
  const file = { format: FILE_FORMAT, asset: assetName, ...definition };
  const blob = new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `${assetName.replace(/[^\w.-]+/g, '_')}.rig.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

export async function readRigFile(file) {
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    throw new Error('This file is not valid JSON.');
  }
  if (!data || !Array.isArray(data.joints)) throw new Error('This file does not contain a rig (no "joints" list).');
  const { format, asset, ...definition } = data;
  return definition;
}
