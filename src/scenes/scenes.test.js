import { describe, expect, it } from 'vitest';
import { getComponent } from '../studio/catalog/index.js';
import { normalizeProgram } from '../studio/program/Program.js';
import { SCENE_FILES, sceneFromFile, sceneSlug } from './index.js';

// Built-in scene files ship with the app, so they may only use what every copy of it has, and
// everything in them has to point at something that is there.

const BUILT_IN_MODELS = ['abb_irb6760'];

// Every item id a program step refers to (pallets, conveyors, spots, grid surfaces, destinations).
function referencedItems(steps) {
  const ids = [];
  const visit = (value) => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    Object.entries(value).forEach(([key, inner]) => {
      if (['item', 'pallet'].includes(key) && typeof inner === 'string') ids.push(inner);
      else visit(inner);
    });
  };
  visit(steps);
  return ids;
}

describe('built-in scene files', () => {
  it('are named after the scene', () => {
    expect(sceneSlug({ id: 'scene_1', name: 'Station 3 · Palletizing & Wrapping' })).toBe('station-3-palletizing-wrapping');
    expect(sceneSlug({ id: 'file:my-line', name: 'Renamed' })).toBe('my-line');
  });

  SCENE_FILES.forEach((entry) => {
    it(`${entry.name}: uses only parts that ship with the app, and its links point at its own items`, () => {
      const scene = sceneFromFile(entry.id);
      expect(scene.id).toBe(entry.id);
      const ids = new Set(scene.items.map((item) => item.id));
      expect(ids.size).toBe(entry.data.items.length);
      scene.items.forEach((item) => {
        if (item.source.kind === 'catalog') expect(getComponent(item.source.id), item.name).not.toBeNull();
        else expect(item.source.kind === 'builtin' && BUILT_IN_MODELS.includes(item.source.id), item.name).toBe(true);
        if (item.mount) expect(ids.has(item.mount.to), `${item.name} is mounted on a missing item`).toBe(true);
        if (item.attach) expect(ids.has(item.attach.to), `${item.name} is attached to a missing item`).toBe(true);
        referencedItems(normalizeProgram(item.program).steps).forEach((id) => {
          expect(ids.has(id), `${item.name}'s program refers to a missing item`).toBe(true);
        });
      });
    });
  });
});
