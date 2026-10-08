// Built-in components that can be placed in a scene (conveyors, pallets, people…).
//
// A component is plain data plus a builder:
//   {
//     id, name, category, description, icon,
//     params: { key: { label, type: 'number' | 'select' | 'boolean', default, min, max, step, unit, options } },
//     build(params) → { root, anchors?, colliders?, body?, update?(dt, editor), dispose?() }  (may be async)
//   }

export const CATALOG = [];

export function getComponent(id) {
  return CATALOG.find((component) => component.id === id) || null;
}
