// A robot's (or a worker's) program in a scene: what it does when the scene plays. It is saved with the
// scene, on the robot's item (item.program), because its steps refer to things in that scene
// ("the box at the end of this conveyor", "the next spot on that pallet"). The robot's own poses
// and sequences (Machine tab → Animation Setup) can be used as steps too.
//
//   program: { loop: false, steps: [step, …] }
//   step: { id, type, …settings }; block steps (grid, repeat) hold their own `steps`.
//
// Targets (where a Reach goes, where a box is waited for):
//   { kind: 'spot', item, anchor }        a named spot on an object (a conveyor's end, a pallet's top)
//   { kind: 'point', item, offset }       a point clicked on an object, in the object's own frame;
//                                         item null: a point on the floor, in world coordinates
//   { kind: 'box', at: spot | point }     the box waiting at that spot (found when the step runs)
//   { kind: 'grid' }                      the current spot of the grid this step repeats across
//
// A worker with a pallet jack has its own steps (WORKER_STEP_ORDER). Where it goes ("Go to"):
//   { kind: 'item', item }                an object: the pallet's middle ends up on the object's
//                                         middle, square with it (a wrapper's turntable, a marked bay)
//   { kind: 'point', item: null, offset } a point on the floor
//   { kind: 'start' }                     where the worker stood when the scene started

import { newId } from '../SceneDocument.js';

export const STEP_TYPES = {
  pose: { label: 'Go to pose', icon: 'House', help: 'Move to one of the robot\'s saved poses.' },
  sequence: { label: 'Play sequence', icon: 'ListVideo', help: 'Play one of the robot\'s saved sequences.' },
  reach: { label: 'Reach', icon: 'Crosshair', help: 'Move the tool tip to a spot, a box, or the next spot on a grid.' },
  grip: { label: 'Grip', icon: 'Grab', help: 'Pick up the box the tool tip is touching.' },
  release: { label: 'Release', icon: 'Hand', help: 'Let go of the box being held.' },
  wait: { label: 'Wait', icon: 'Timer', help: 'Pause for a number of seconds.' },
  'wait-box': { label: 'Wait for a box', icon: 'PackageSearch', help: 'Pause until a box has arrived at a spot.' },
  grid: { label: 'Repeat across a grid', icon: 'Grid3x3', block: true, help: 'Run the steps inside once for every spot of a grid (e.g. layers of boxes on a pallet).' },
  repeat: { label: 'Repeat', icon: 'Repeat', block: true, help: 'Run the steps inside a number of times.' },
  conveyor: { label: 'Conveyor on / off', icon: 'Power', help: 'Start or stop a conveyor.' },
  // A worker with a pallet jack.
  'pick-pallet': { label: 'Pick up pallet', icon: 'ArrowUpFromLine', help: 'Walk to a pallet, slide the forks under it and lift it (with the boxes on it).' },
  'go-to': { label: 'Go to', icon: 'MapPin', help: 'Walk somewhere, carrying the pallet if it has one. At an object, the pallet ends up on its middle.' },
  'put-down': { label: 'Put pallet down', icon: 'ArrowDownToLine', help: 'Lower the pallet where it is (onto a low surface like a turntable, or the floor) and back away.' },
  'wait-load': { label: 'Wait for boxes', icon: 'PackageCheck', help: 'Pause until a pallet has this many boxes on it (e.g. a robot has finished stacking it).' },
};

// Order in the "Add step" menu.
export const STEP_ORDER = ['reach', 'grip', 'release', 'wait-box', 'grid', 'pose', 'sequence', 'wait', 'repeat', 'conveyor'];
export const WORKER_STEP_ORDER = ['pick-pallet', 'go-to', 'put-down', 'wait-load', 'wait', 'repeat'];

// The box most scenes use (the catalog box's default size), for planning before anything plays.
export const DEFAULT_BOX = { length: 0.62, width: 0.42, height: 0.42 };
export const DEFAULT_APPROACH = 0.3;

export function newStep(type, settings = {}) {
  const base = { id: newId('step'), type };
  switch (type) {
    case 'pose': return { ...base, pose: null, ...settings };
    case 'sequence': return { ...base, sequence: null, ...settings };
    case 'reach': return { ...base, target: null, approach: DEFAULT_APPROACH, orient: 'down', ...settings };
    case 'wait': return { ...base, seconds: 1, ...settings };
    case 'wait-box': return { ...base, at: null, ...settings };
    case 'grid': return {
      ...base,
      on: null,
      columns: 3,
      rows: 3,
      layers: 1,
      spacing: [round(DEFAULT_BOX.length + 0.02), round(DEFAULT_BOX.width + 0.02)],
      layerHeight: DEFAULT_BOX.height,
      steps: [],
      ...settings,
    };
    case 'repeat': return { ...base, times: 3, steps: [], ...settings };
    case 'conveyor': return { ...base, item: null, running: false, ...settings };
    case 'pick-pallet': return { ...base, pallet: null, ...settings };
    case 'go-to': return { ...base, target: null, ...settings };
    case 'wait-load': return { ...base, pallet: null, count: 1, ...settings };
    default: return { ...base, ...settings };
  }
}

function round(value, digits = 3) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function emptyProgram() {
  return { loop: false, steps: [] };
}

// A program read from a scene file: unknown step types are kept (a newer app may know them).
export function normalizeProgram(program) {
  if (!program || typeof program !== 'object') return emptyProgram();
  const clean = (steps) => (Array.isArray(steps) ? steps : [])
    .filter((step) => step && typeof step === 'object' && typeof step.type === 'string')
    .map((step) => ({ ...step, id: String(step.id || newId('step')), ...(Array.isArray(step.steps) ? { steps: clean(step.steps) } : {}) }));
  return { ...program, loop: Boolean(program.loop), steps: clean(program.steps) };
}

export function stepCount(steps) {
  return steps.reduce((total, step) => total + 1 + (step.steps ? stepCount(step.steps) : 0), 0);
}

// ---- Editing a program (all return a new program; the old one is left as it was) ------------

function mapSteps(steps, visit) {
  return steps.flatMap((step) => {
    const result = visit(step);
    if (result === null) return [];
    const next = result || step;
    return [next.steps ? { ...next, steps: mapSteps(next.steps, visit) } : next];
  });
}

// The step with `id` and the list it is in.
export function findStep(steps, id, parent = null) {
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    if (step.id === id) return { step, list: steps, index, parent };
    if (step.steps) {
      const found = findStep(step.steps, id, step);
      if (found) return found;
    }
  }
  return null;
}

export function updateStep(program, id, patch) {
  return { ...program, steps: mapSteps(program.steps, (step) => (step.id === id ? { ...step, ...patch } : undefined)) };
}

export function removeStep(program, id) {
  return { ...program, steps: mapSteps(program.steps, (step) => (step.id === id ? null : undefined)) };
}

// Adds steps at the end of a block (parentId) or of the program (parentId null), or right after
// the step `afterId` (in whatever list that step is in).
export function insertSteps(program, steps, { parentId = null, afterId = null } = {}) {
  const added = structuredClone(steps);
  let containerId = parentId;
  if (afterId) {
    const found = findStep(program.steps, afterId);
    if (found) containerId = found.parent?.id ?? null;
  }
  const place = (list) => {
    const index = afterId ? list.findIndex((step) => step.id === afterId) : -1;
    return index === -1 ? [...list, ...added] : [...list.slice(0, index + 1), ...added, ...list.slice(index + 1)];
  };
  if (!containerId) return { ...program, steps: place(program.steps) };
  return { ...program, steps: mapSteps(program.steps, (step) => (step.id === containerId ? { ...step, steps: place(step.steps) } : undefined)) };
}

// Moves a step one place up or down within its list.
export function moveStep(program, id, direction) {
  const reorder = (list) => {
    const index = list.findIndex((step) => step.id === id);
    if (index === -1) return list;
    const target = index + direction;
    if (target < 0 || target >= list.length) return list;
    const next = [...list];
    [next[index], next[target]] = [next[target], next[index]];
    return next;
  };
  const found = findStep(program.steps, id);
  if (!found) return program;
  if (!found.parent) return { ...program, steps: reorder(program.steps) };
  return { ...program, steps: mapSteps(program.steps, (step) => (step.id === found.parent.id ? { ...step, steps: reorder(step.steps) } : undefined)) };
}

// A copy of a step (and of the steps inside it) with new ids, placed right after it.
export function duplicateStep(program, id) {
  const found = findStep(program.steps, id);
  if (!found) return program;
  const renew = (step) => ({ ...step, id: newId('step'), ...(step.steps ? { steps: step.steps.map(renew) } : {}) });
  return insertSteps(program, [renew(structuredClone(found.step))], { afterId: id });
}

// The grid block a step is inside (the nearest one), or null.
export function enclosingGrid(steps, id, grid = null) {
  for (const step of steps) {
    if (step.id === id) return grid;
    if (step.steps) {
      const found = enclosingGrid(step.steps, id, step.type === 'grid' ? step : grid);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

// ---- Grids ----------------------------------------------------------------------------------

// The spots of a grid, in the order they are filled: layer by layer, row by row. Each is the
// middle of a box's bottom face, in the frame of the grid's surface (x along the object's
// length, z across it, y up), centred on the surface.
export function gridSpots(grid) {
  const columns = Math.max(1, Math.round(grid.columns || 1));
  const rows = Math.max(1, Math.round(grid.rows || 1));
  const layers = Math.max(1, Math.round(grid.layers || 1));
  const [dx, dz] = grid.spacing || [DEFAULT_BOX.length, DEFAULT_BOX.width];
  const dy = grid.layerHeight ?? DEFAULT_BOX.height;
  const spots = [];
  for (let layer = 0; layer < layers; layer += 1) {
    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        spots.push({
          index: spots.length,
          column,
          row,
          layer,
          position: [(column - (columns - 1) / 2) * dx, layer * dy, (row - (rows - 1) / 2) * dz],
        });
      }
    }
  }
  return spots;
}

// ---- The "Pick & place" shortcut ---------------------------------------------------------------

// The usual cycle, as plain steps the user can then change:
//   [Go to pose (home)] → Repeat across a grid { Wait for a box → Reach the box → Grip →
//   Reach the next grid spot → Release } → [Go to pose (home)]
export function pickAndPlaceSteps({ from, onto, grid = null, box = DEFAULT_BOX, homePose = null }) {
  const cycle = [
    newStep('wait-box', { at: from }),
    newStep('reach', { target: { kind: 'box', at: from } }),
    newStep('grip'),
    newStep('reach', { target: grid ? { kind: 'grid' } : onto }),
    newStep('release'),
  ];
  const home = homePose ? [newStep('pose', { pose: homePose })] : [];
  const body = grid
    ? [newStep('grid', {
      on: onto,
      columns: grid.columns,
      rows: grid.rows,
      layers: grid.layers,
      spacing: [round(box.length + 0.02), round(box.width + 0.02)],
      layerHeight: box.height,
      steps: cycle,
    })]
    : cycle;
  return [...home, ...body, ...home.map((step) => ({ ...step, id: newId('step') }))];
}

// ---- The "Move a pallet" shortcut ------------------------------------------------------------

// A worker's usual trip, as plain steps the user can then change:
//   [Wait for boxes] → Pick up pallet → Go to (destination) → Put pallet down → Go to (where it started)
export function movePalletSteps({ pallet = null, to = null, waitFor = 0 } = {}) {
  return [
    ...(waitFor > 0 ? [newStep('wait-load', { pallet, count: waitFor })] : []),
    newStep('pick-pallet', { pallet }),
    newStep('go-to', { target: to }),
    newStep('put-down'),
    newStep('go-to', { target: { kind: 'start' } }),
  ];
}
