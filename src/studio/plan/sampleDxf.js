// Writes small DXF files for the tests and the sample floor plan (docs/samples/sample-hall.dxf).
// Entities are given as [type, [[code, value], …]].

export function writeDxf({ insunits = null, layers = [], blocks = [], entities = [] }) {
  const out = [];
  const pair = (code, value) => out.push(String(code), String(value));
  const entity = ([type, data]) => {
    pair(0, type);
    data.forEach(([code, value]) => pair(code, value));
  };
  pair(0, 'SECTION');
  pair(2, 'HEADER');
  if (insunits !== null) {
    pair(9, '$INSUNITS');
    pair(70, insunits);
  }
  pair(0, 'ENDSEC');
  pair(0, 'SECTION');
  pair(2, 'TABLES');
  pair(0, 'TABLE');
  pair(2, 'LAYER');
  layers.forEach(({ name, color = 7, frozen = false }) => entity(['LAYER', [[2, name], [70, frozen ? 1 : 0], [62, color]]]));
  pair(0, 'ENDTAB');
  pair(0, 'ENDSEC');
  pair(0, 'SECTION');
  pair(2, 'BLOCKS');
  blocks.forEach(({ name, base = [0, 0], entities: inside }) => {
    entity(['BLOCK', [[8, '0'], [2, name], [70, 0], [10, base[0]], [20, base[1]], [30, 0]]]);
    inside.forEach(entity);
    entity(['ENDBLK', [[8, '0']]]);
  });
  pair(0, 'ENDSEC');
  pair(0, 'SECTION');
  pair(2, 'ENTITIES');
  entities.forEach(entity);
  pair(0, 'ENDSEC');
  pair(0, 'EOF');
  return `${out.join('\n')}\n`;
}

export const line = (layer, x1, y1, x2, y2) => ['LINE', [[8, layer], [10, x1], [20, y1], [30, 0], [11, x2], [21, y2], [31, 0]]];

export function lwpolyline(layer, points, { closed = false, bulges = [] } = {}) {
  const data = [[8, layer], [90, points.length], [70, closed ? 1 : 0]];
  points.forEach(([x, y], index) => {
    data.push([10, x], [20, y]);
    if (bulges[index]) data.push([42, bulges[index]]);
  });
  return ['LWPOLYLINE', data];
}

export const circle = (layer, x, y, r) => ['CIRCLE', [[8, layer], [10, x], [20, y], [30, 0], [40, r]]];
export const arc = (layer, x, y, r, start, end) => ['ARC', [[8, layer], [10, x], [20, y], [30, 0], [40, r], [50, start], [51, end]]];
export const text = (layer, x, y, height, value, rotation = 0) => ['TEXT', [[8, layer], [10, x], [20, y], [30, 0], [40, height], [1, value], [50, rotation]]];
export const insert = (layer, name, x, y, { scale = 1, rotation = 0 } = {}) => ['INSERT', [[8, layer], [2, name], [10, x], [20, y], [30, 0], [41, scale], [42, scale], [50, rotation]]];

// A 40 m × 25 m hall drawn in millimetres: outer walls (with a door gap and a door swing), a row
// of columns, a machine block placed twice, labels, a dimension and a hatch (which is skipped).
export function sampleHall() {
  const W = 40000;
  const D = 25000;
  const walls = [
    line('WALLS', 0, 0, 17000, 0),
    line('WALLS', 21000, 0, W, 0),
    line('WALLS', W, 0, W, D),
    line('WALLS', W, D, 0, D),
    line('WALLS', 0, D, 0, 0),
    // Inner face of the walls, 250 mm in.
    lwpolyline('WALLS', [[250, 250], [16750, 250]]),
    lwpolyline('WALLS', [[21250, 250], [W - 250, 250], [W - 250, D - 250], [250, D - 250], [250, 250]]),
  ];
  const columns = [];
  for (let x = 5000; x < W; x += 10000) {
    for (const y of [5000, 20000]) columns.push(lwpolyline('COLUMNS', [[x - 200, y - 200], [x + 200, y - 200], [x + 200, y + 200], [x - 200, y + 200]], { closed: true }));
  }
  const door = [
    // Door leaf and its swing (a quarter circle, as a bulge and as an ARC).
    line('DOORS', 17000, 0, 17000, 2000),
    lwpolyline('DOORS', [[17000, 2000], [19000, 0]], { bulges: [-Math.tan(Math.PI / 8)] }),
    arc('DOORS', 21000, 0, 2000, 90, 180),
  ];
  const machine = {
    name: 'MACHINE',
    base: [0, 0],
    entities: [
      lwpolyline('0', [[-1500, -1000], [1500, -1000], [1500, 1000], [-1500, 1000]], { closed: true }),
      circle('0', 0, 0, 400),
    ],
  };
  const dimensionBlock = {
    name: '*D1',
    entities: [line('0', 0, -2000, W, -2000), line('0', 0, -2300, 0, -1700), line('0', W, -2300, W, -1700), text('0', W / 2 - 1500, -1800, 500, '40000')],
  };
  return writeDxf({
    insunits: 4,
    layers: [{ name: 'WALLS' }, { name: 'COLUMNS' }, { name: 'DOORS' }, { name: 'MACHINES' }, { name: 'LABELS' }, { name: 'DIMENSIONS' }, { name: 'CONVEYOR' }],
    blocks: [machine, dimensionBlock],
    entities: [
      ...walls,
      ...columns,
      ...door,
      insert('MACHINES', 'MACHINE', 8000, 12500),
      insert('MACHINES', 'MACHINE', 30000, 12500, { rotation: 90 }),
      lwpolyline('CONVEYOR', [[12000, 13500], [26000, 13500], [26000, 11500], [12000, 11500]], { closed: true }),
      text('LABELS', 6500, 14500, 600, 'CELL 1'),
      text('LABELS', 28000, 15500, 600, 'PALLETS'),
      text('LABELS', 17500, 1000, 500, 'DOOR'),
      ['DIMENSION', [[8, 'DIMENSIONS'], [2, '*D1'], [10, 0], [20, -2000], [70, 0]]],
      ['HATCH', [[8, 'WALLS'], [2, 'SOLID']]],
    ],
  });
}
