import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { loadRigByKey, rigStorageKey } from '../motion/RigStore.js';
import { normalizeScene } from './SceneDocument.js';

// A .dtscene file: one zip holding everything needed to open a scene on another computer.
//
//   scene.json    the scene document
//   bundle.json   { format, version, models: [{ id, path, name, lastModified, type }], rigs: { key: rig } }
//   models/…      the imported model files the scene uses
//
// Built-in models aren't copied: every copy of the app has them. Rigs (joints, tool tip, poses,
// sequences) are included for every model in the scene that has one saved, built-in or imported.

const BUNDLE_FORMAT = 'digital-twin-scene-bundle';

function safeName(name) {
  return name.replace(/[^\w.-]+/g, '_');
}

// resolveConfig(source) → the model's config (with .file for imports), or null.
export async function buildBundle(scene, resolveConfig) {
  const files = { 'scene.json': strToU8(JSON.stringify(scene, null, 2)) };
  const manifest = { format: BUNDLE_FORMAT, version: 1, models: [], rigs: {} };
  const missing = [];
  const seen = new Set();
  for (const item of scene.items) {
    const { source } = item;
    if (source.kind === 'catalog' || seen.has(`${source.kind}:${source.id}`)) continue;
    seen.add(`${source.kind}:${source.id}`);
    const config = await resolveConfig(source);
    if (!config) {
      missing.push(source.name || source.id);
      continue;
    }
    const rig = loadRigByKey(rigStorageKey(config));
    if (rig) manifest.rigs[rigStorageKey(config)] = rig;
    if (source.kind === 'import' && config.file) {
      const path = `models/${manifest.models.length + 1}-${safeName(config.file.name)}`;
      // Model files are usually compressed already: store them as they are, it is much faster.
      files[path] = [new Uint8Array(await config.file.arrayBuffer()), { level: 0 }];
      manifest.models.push({ id: source.id, path, name: config.file.name, lastModified: config.file.lastModified, type: config.file.type });
    }
  }
  files['bundle.json'] = strToU8(JSON.stringify(manifest, null, 2));
  return { blob: new Blob([zipSync(files, { level: 6 })], { type: 'application/zip' }), missing };
}

export function downloadBlob(blob, fileName) {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = fileName;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

// Reads a .dtscene file (or a plain scene .json). Returns { scene, models: [{ id, file }], rigs }.
export async function readBundle(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  // A zip starts with "PK"; anything else is treated as a plain scene document.
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    let data;
    try {
      data = JSON.parse(strFromU8(bytes));
    } catch {
      throw new Error('This file is neither a .dtscene file nor a scene .json file.');
    }
    return { scene: normalizeScene(data), models: [], rigs: {} };
  }
  let entries;
  try {
    entries = unzipSync(bytes);
  } catch {
    throw new Error('This .dtscene file is damaged (it could not be unpacked).');
  }
  if (!entries['scene.json']) throw new Error('This file has no scene in it (scene.json is missing).');
  const scene = normalizeScene(JSON.parse(strFromU8(entries['scene.json'])));
  const manifest = entries['bundle.json'] ? JSON.parse(strFromU8(entries['bundle.json'])) : { models: [], rigs: {} };
  const models = (manifest.models || [])
    .filter((model) => entries[model.path])
    // The same name, size and date give the same id on this computer as on the one that made it.
    .map((model) => ({ id: model.id, file: new File([entries[model.path]], model.name, { lastModified: model.lastModified, type: model.type || '' }) }));
  return { scene, models, rigs: manifest.rigs || {} };
}
