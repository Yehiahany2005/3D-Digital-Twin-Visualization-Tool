import { describe, expect, it } from 'vitest';
import {
  duplicateStep, enclosingGrid, findStep, gridSpots, insertSteps, moveStep, newStep, normalizeProgram, pickAndPlaceSteps, removeStep, stepCount, updateStep,
} from './Program.js';

const ids = (steps) => steps.map((step) => step.type);

describe('program editing', () => {
  const grid = newStep('grid');
  const wait = newStep('wait-box');
  const reach = newStep('reach');
  const program = { loop: false, steps: [newStep('pose'), { ...grid, steps: [wait, reach] }, newStep('release')] };

  it('inserts at the end, inside a block, or after a step', () => {
    expect(ids(insertSteps(program, [newStep('wait')]).steps)).toEqual(['pose', 'grid', 'release', 'wait']);
    const inside = insertSteps(program, [newStep('grip')], { parentId: grid.id });
    expect(ids(findStep(inside.steps, grid.id).step.steps)).toEqual(['wait-box', 'reach', 'grip']);
    const after = insertSteps(program, [newStep('grip')], { afterId: wait.id });
    expect(ids(findStep(after.steps, grid.id).step.steps)).toEqual(['wait-box', 'grip', 'reach']);
  });

  it('moves, updates, duplicates and removes without touching the original', () => {
    const moved = moveStep(program, reach.id, -1);
    expect(ids(findStep(moved.steps, grid.id).step.steps)).toEqual(['reach', 'wait-box']);
    expect(ids(findStep(program.steps, grid.id).step.steps)).toEqual(['wait-box', 'reach']);
    expect(moveStep(program, program.steps[0].id, -1)).toEqual(program);
    expect(findStep(updateStep(program, reach.id, { approach: 0.5 }).steps, reach.id).step.approach).toBe(0.5);
    const copied = duplicateStep(program, grid.id);
    expect(stepCount(copied.steps)).toBe(stepCount(program.steps) + 3);
    expect(copied.steps[2].id).not.toBe(grid.id);
    expect(ids(removeStep(program, grid.id).steps)).toEqual(['pose', 'release']);
  });

  it('knows which grid a step is inside', () => {
    expect(enclosingGrid(program.steps, reach.id).id).toBe(grid.id);
    expect(enclosingGrid(program.steps, program.steps[0].id)).toBeNull();
  });

  it('cleans up programs read from files', () => {
    const clean = normalizeProgram({ steps: [{ type: 'grip' }, null, { type: 'grid', steps: [{ type: 'release' }] }], loop: 1 });
    expect(clean.loop).toBe(true);
    expect(ids(clean.steps)).toEqual(['grip', 'grid']);
    expect(clean.steps.every((step) => step.id)).toBe(true);
    expect(normalizeProgram(null)).toEqual({ loop: false, steps: [] });
  });
});

describe('grids', () => {
  it('fills layer by layer, row by row, centred on the surface', () => {
    const spots = gridSpots({ columns: 3, rows: 2, layers: 2, spacing: [1, 0.5], layerHeight: 0.4 });
    expect(spots).toHaveLength(12);
    expect(spots[0].position).toEqual([-1, 0, -0.25]);
    expect(spots[2].position).toEqual([1, 0, -0.25]);
    expect(spots[3].position).toEqual([-1, 0, 0.25]);
    expect(spots[6]).toMatchObject({ layer: 1, row: 0, column: 0 });
    expect(spots[6].position[1]).toBeCloseTo(0.4);
  });
});

describe('pick & place shortcut', () => {
  it('writes the usual cycle inside a grid, between two home moves', () => {
    const from = { kind: 'spot', item: 'conveyor', anchor: 'output' };
    const onto = { kind: 'spot', item: 'pallet', anchor: 'surface' };
    const steps = pickAndPlaceSteps({ from, onto, grid: { columns: 3, rows: 3, layers: 2 }, homePose: 'home' });
    expect(ids(steps)).toEqual(['pose', 'grid', 'pose']);
    expect(steps[0].id).not.toBe(steps[2].id);
    expect(ids(steps[1].steps)).toEqual(['wait-box', 'reach', 'grip', 'reach', 'release']);
    expect(steps[1].steps[1].target).toEqual({ kind: 'box', at: from });
    expect(steps[1].steps[3].target).toEqual({ kind: 'grid' });
    expect(steps[1]).toMatchObject({ on: onto, columns: 3, rows: 3, layers: 2 });
  });
});
