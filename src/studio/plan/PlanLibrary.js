import { decodeDxf, guessUnit, isAnnotationLayer, isWallLayer, parseDxf, unitKeyFor } from './dxf.js';
import { DEFAULT_WALL_HEIGHT, DEFAULT_WALL_OPACITY } from './FloorPlan.js';

// Floor plan files are read once each (by file id) and shared by every copy, undo step and
// reopening of the scene.
const cache = new Map();

export function isPlanFile(name) {
  return /\.dxf$/i.test(name || '');
}

export function readPlan(id, file) {
  if (!cache.has(id)) {
    const reading = file.arrayBuffer().then((buffer) => parseDxf(decodeDxf(buffer)));
    reading.catch(() => cache.delete(id));
    cache.set(id, reading);
  }
  return cache.get(id);
}

// The settings a newly imported plan starts with: the file's units (or a guess from its size),
// notes and dimension layers hidden, walls flat.
export function defaultPlanSettings(data) {
  const { main } = data;
  const extent = Math.max(main.maxX - main.minX, main.maxY - main.minY);
  const fromFile = data.metresPerUnit && unitKeyFor(data.metresPerUnit);
  return {
    unit: fromFile || guessUnit(extent),
    ...(fromFile ? {} : { unitGuessed: true }),
    hiddenLayers: data.layers.filter((layer) => layer.hiddenInFile || isAnnotationLayer(layer.name)).map((layer) => layer.name),
    walls: { layers: [], height: DEFAULT_WALL_HEIGHT, opacity: DEFAULT_WALL_OPACITY },
  };
}

// Layers worth offering first for raising into walls.
export function suggestedWallLayers(data) {
  return data.layers.filter((layer) => layer.count && isWallLayer(layer.name)).map((layer) => layer.name);
}
