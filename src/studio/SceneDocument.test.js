import { describe, expect, it } from 'vitest';
import { dependentsOf, emptyScene, normalizeScene, uniqueName } from './SceneDocument.js';
import { buildBundle, readBundle } from './SceneBundle.js';

const robot = (id, extra = {}) => ({ id, name: id, source: { kind: 'builtin', id: 'abb_irb6760' }, position: [0, 0, 0], rotation: [0, 0, 0], ...extra });

describe('scene document', () => {
  it('fills defaults, drops broken items and duplicate ids, keeps unknown fields', () => {
    const scene = normalizeScene({
      name: 'Cell',
      future: { keep: true },
      items: [robot('a', { position: [1, 2] }), robot('a'), { id: 'b' }, robot('c', { custom: 7 })],
    });
    expect(scene.items.map((item) => item.id)).toEqual(['a', 'c']);
    expect(scene.items[0].position).toEqual([0, 0, 0]);
    expect(scene.items[1].custom).toBe(7);
    expect(scene.future).toEqual({ keep: true });
  });

  it('drops links to items that are not there', () => {
    const scene = normalizeScene({ items: [robot('a', { mount: { to: 'gone', anchor: 'tool' } })] });
    expect(scene.items[0].mount).toBeUndefined();
  });

  it('rejects things that are not scenes', () => {
    expect(() => normalizeScene({ joints: [] })).toThrow(/not a scene/);
    expect(() => normalizeScene({ format: 'digital-twin-rig', items: [] })).toThrow(/not a scene/);
  });

  it('names copies without mangling numbers that belong to the name', () => {
    const scene = { items: [robot('a', { name: 'ABB IRB 6760' })] };
    expect(uniqueName(scene, 'ABB IRB 6760')).toBe('ABB IRB 6760 2');
    scene.items.push(robot('b', { name: 'ABB IRB 6760 2' }));
    expect(uniqueName(scene, 'ABB IRB 6760 2')).toBe('ABB IRB 6760 3');
    expect(uniqueName(scene, 'Conveyor')).toBe('Conveyor');
  });

  it('finds everything hanging off an item', () => {
    const scene = { items: [robot('r'), robot('g', { mount: { to: 'r' } }), robot('box', { attach: { to: 'g' } }), robot('other')] };
    expect([...dependentsOf(scene, 'r')].sort()).toEqual(['box', 'g']);
  });
});

describe('scene bundle', () => {
  it('round-trips a scene with an imported model file', async () => {
    const file = new File([new Uint8Array([1, 2, 3, 4])], 'part.glb', { lastModified: 1700000000000 });
    const scene = emptyScene('Shared');
    scene.items.push({ id: 'p', name: 'Part', source: { kind: 'import', id: 'import:part.glb:4:1700000000000', name: 'part.glb' }, position: [1, 0, 2], rotation: [0, 90, 0] });
    scene.items.push(robot('r'));
    const { blob, missing } = await buildBundle(scene, async (source) => (source.kind === 'import' ? { id: source.id, file } : { id: source.id }));
    expect(missing).toEqual([]);
    const opened = await readBundle(new File([blob], 'shared.dtscene'));
    expect(opened.scene.name).toBe('Shared');
    expect(opened.scene.items).toHaveLength(2);
    expect(opened.models).toHaveLength(1);
    expect(opened.models[0].id).toBe('import:part.glb:4:1700000000000');
    expect(opened.models[0].file.lastModified).toBe(1700000000000);
    expect([...new Uint8Array(await opened.models[0].file.arrayBuffer())]).toEqual([1, 2, 3, 4]);
  });

  it('opens a plain scene .json too', async () => {
    const opened = await readBundle(new File([JSON.stringify({ items: [robot('a')] })], 'scene.json'));
    expect(opened.scene.items).toHaveLength(1);
  });
});
