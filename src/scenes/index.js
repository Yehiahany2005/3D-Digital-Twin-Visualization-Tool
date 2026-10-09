import { normalizeScene } from '../studio/SceneDocument.js';

// Built-in scenes saved as files: every *.json scene document in this folder ships with the app.
// They are ordinary scenes made in the scene editor (only built-in models and catalog parts, so
// they need no imported files) and saved here with "Save to project" (npm run dev only).
//
// Each opens in the scene editor under the id "file:<file name>". Changing one keeps your
// version in this browser; deleting that version brings the file's back.

export const FILE_SCENE_PREFIX = 'file:';

const files = import.meta.glob('./*.json', { eager: true, import: 'default' });

export const SCENE_FILES = Object.entries(files)
  .map(([path, data]) => {
    const slug = path.replace(/^\.\//, '').replace(/\.json$/, '');
    return { id: `${FILE_SCENE_PREFIX}${slug}`, slug, name: data.name || slug, description: data.description || '', data };
  })
  .sort((a, b) => a.name.localeCompare(b.name));

export const isFileScene = (id) => typeof id === 'string' && id.startsWith(FILE_SCENE_PREFIX);

// A fresh copy of a scene file's document, or null.
export function sceneFromFile(id) {
  const entry = SCENE_FILES.find((candidate) => candidate.id === id);
  if (!entry) return null;
  const scene = normalizeScene(structuredClone(entry.data));
  scene.id = entry.id;
  return scene;
}

// The file name a scene is saved under: its own if it came from a file, else from its name.
export function sceneSlug(scene) {
  if (isFileScene(scene.id)) return scene.id.slice(FILE_SCENE_PREFIX.length);
  return scene.name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'scene';
}
