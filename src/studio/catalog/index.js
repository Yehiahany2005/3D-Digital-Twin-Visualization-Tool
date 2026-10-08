// Built-in components that can be placed in a scene (conveyors, pallets, people…).
//
// A component is plain data plus a builder:
//   {
//     id, name, category, description, icon,
//     params: { key: { label, type: 'number' | 'select' | 'boolean', default, min, max, step, unit, options } },
//     build(params) → { root, anchors, colliders, body, update?(dt, editor), dispose?() }  (may be async)
//   }
// The root's origin is where the item stands (usually the middle of its footprint, on the floor).
// anchors: named points other items snap to; colliders + body: how it takes part in physics.

import { beltConveyor, boxRemover, boxSource } from './flow.js';
import { cardboardBox, pallet } from './loads.js';
import { person, worker } from './people.js';
import { stretchWrapper, vacuumGripper } from './machines.js';
import { fence, floorMarking, table } from './fixtures.js';

export const CATALOG = [
  beltConveyor,
  boxSource,
  boxRemover,
  pallet,
  cardboardBox,
  person,
  worker,
  stretchWrapper,
  vacuumGripper,
  table,
  fence,
  floorMarking,
];

export function getComponent(id) {
  return CATALOG.find((component) => component.id === id) || null;
}

// A component's parameters with defaults filled in and numbers kept inside their limits.
export function resolveParams(definition, params = {}) {
  const resolved = {};
  Object.entries(definition.params || {}).forEach(([key, spec]) => {
    let value = params?.[key] ?? spec.default;
    if (spec.type === 'number') {
      value = Number(value);
      if (!Number.isFinite(value)) value = spec.default;
      if (Number.isFinite(spec.min)) value = Math.max(spec.min, value);
      if (Number.isFinite(spec.max)) value = Math.min(spec.max, value);
    } else if (spec.type === 'select') {
      if (!spec.options.some((option) => option.value === value)) value = spec.default;
    } else if (spec.type === 'boolean') {
      value = Boolean(value);
    }
    resolved[key] = value;
  });
  return resolved;
}
