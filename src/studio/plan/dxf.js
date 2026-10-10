// Reads a DXF floor plan (AutoCAD's text exchange format) into flat line segments per layer,
// plus text labels. No three.js here: plain numbers, so it is fast and easy to test.
//
//   parseDxf(text) → {
//     layers: [{ name, segments: Float64Array [x1, y1, x2, y2, …], count, hiddenInFile }],
//     texts:  [{ layer, text, x, y, height, rotation, align }]   rotation in radians, align 0–8,
//     bounds: { minX, minY, maxX, maxY },
//     main:   the building's bounds (no note layers, no stray far-away bits),
//     insunits, metresPerUnit (null when the file doesn't say), counts: { LINE: n, … },
//     skipped: { HATCH: n, … },
//   }
//
// Coordinates stay in drawing units; units are converted when the plan is drawn. Arcs, circles,
// ellipses, splines and polyline bulges become short straight pieces.

// $INSUNITS codes → metres. 0 (unitless) and the astronomical ones mean "not said".
export const INSUNITS_METRES = {
  1: 0.0254, 2: 0.3048, 3: 1609.344, 4: 0.001, 5: 0.01, 6: 1, 7: 1000, 8: 2.54e-8, 9: 2.54e-5,
  10: 0.9144, 11: 1e-10, 12: 1e-9, 13: 1e-6, 14: 0.1, 15: 10, 16: 100, 21: 1200 / 3937,
};

// Units offered for correcting a plan, by key.
export const PLAN_UNITS = {
  mm: { label: 'Millimetres', metres: 0.001 },
  cm: { label: 'Centimetres', metres: 0.01 },
  dm: { label: 'Decimetres', metres: 0.1 },
  m: { label: 'Metres', metres: 1 },
  km: { label: 'Kilometres', metres: 1000 },
  in: { label: 'Inches', metres: 0.0254 },
  ft: { label: 'Feet', metres: 0.3048 },
  yd: { label: 'Yards', metres: 0.9144 },
};

export function unitKeyFor(metres) {
  const found = Object.entries(PLAN_UNITS).find(([, unit]) => Math.abs(unit.metres - metres) / unit.metres < 1e-6);
  return found ? found[0] : null;
}

// A factory hall is roughly 10–300 m across. The first unit that makes the drawing that size wins,
// in the order units are most often used for plans; otherwise the one that comes closest to 50 m.
export function guessUnit(extent) {
  if (!(extent > 0)) return 'm';
  const order = ['mm', 'm', 'cm', 'ft', 'in'];
  const fits = order.find((key) => {
    const size = extent * PLAN_UNITS[key].metres;
    return size >= 10 && size <= 300;
  });
  if (fits) return fits;
  return order.reduce((best, key) => {
    const off = Math.abs(Math.log(extent * PLAN_UNITS[key].metres / 50));
    return off < best.off ? { key, off } : best;
  }, { key: 'm', off: Infinity }).key;
}

export class DxfError extends Error {}

const MAX_INSERT_DEPTH = 16;
const MAX_TEXTS = 20000;

// ---- Reading group code / value pairs ---------------------------------------------------------

function readPairs(text) {
  const lines = text.split(/\r\n|\n|\r/);
  const codes = [];
  const values = [];
  for (let index = 0; index + 1 < lines.length; index += 2) {
    const code = Number.parseInt(lines[index], 10);
    if (Number.isNaN(code)) {
      // Some writers leave blank lines at the end; anything else means the file is broken.
      if (lines[index].trim() === '' && index >= lines.length - 3) break;
      if (index === 0) throw new DxfError("This doesn't look like a DXF file: it doesn't start like one. Save the drawing from AutoCAD as AutoCAD DXF (*.dxf).");
      throw new DxfError(`The file is damaged near line ${index + 1} (expected a group code, found "${lines[index].slice(0, 30)}").`);
    }
    codes.push(code);
    values.push(lines[index + 1]);
  }
  return { codes, values };
}

// Turns the file into sections of entities: { header: { $NAME: { code: value } }, tables: [...], blocks, entities }
function readStructure(text) {
  const { codes, values } = readPairs(text);
  const header = {};
  const layers = new Map();
  const blocks = new Map();
  const entities = [];
  let index = 0;
  const count = codes.length;

  // Reads one entity starting at a 0 code: { type, data: [[code, value], …] }.
  const readEntity = () => {
    const type = values[index].trim();
    const data = [];
    index += 1;
    while (index < count && codes[index] !== 0) {
      data.push([codes[index], values[index]]);
      index += 1;
    }
    return { type, data };
  };

  let foundSection = false;
  while (index < count) {
    if (codes[index] !== 0) {
      index += 1;
      continue;
    }
    const marker = values[index].trim();
    if (marker === 'EOF') break;
    if (marker !== 'SECTION') {
      index += 1;
      continue;
    }
    foundSection = true;
    index += 1;
    const name = codes[index] === 2 ? values[index].trim() : '';
    index += 1;
    if (name === 'HEADER') {
      let variable = null;
      while (index < count && !(codes[index] === 0 && values[index].trim() === 'ENDSEC')) {
        if (codes[index] === 9) {
          variable = values[index].trim();
          header[variable] = {};
        } else if (variable) {
          header[variable][codes[index]] = values[index];
        }
        index += 1;
      }
    } else if (name === 'TABLES') {
      while (index < count && !(codes[index] === 0 && values[index].trim() === 'ENDSEC')) {
        if (codes[index] === 0 && values[index].trim() === 'LAYER') {
          const entry = readEntity();
          const layerName = field(entry.data, 2);
          if (layerName?.trim()) {
            const color = Number(field(entry.data, 62) ?? 7);
            const flags = Number(field(entry.data, 70) ?? 0);
            layers.set(layerName.trim(), { off: color < 0, frozen: Boolean(flags & 1) });
          }
        } else {
          index += 1;
        }
      }
    } else if (name === 'BLOCKS' || name === 'ENTITIES') {
      let block = null;
      while (index < count && !(codes[index] === 0 && values[index].trim() === 'ENDSEC')) {
        if (codes[index] !== 0) {
          index += 1;
          continue;
        }
        const entity = readEntity();
        if (entity.type === 'BLOCK') {
          block = {
            name: (field(entity.data, 2) || '').trim(),
            base: [num(entity.data, 10), num(entity.data, 20)],
            entities: [],
          };
        } else if (entity.type === 'ENDBLK') {
          if (block?.name) blocks.set(block.name, block);
          block = null;
        } else if (block) {
          block.entities.push(entity);
        } else {
          entities.push(entity);
        }
      }
    }
    // Skip to the end of the section (also for sections we don't read, like OBJECTS).
    while (index < count && !(codes[index] === 0 && values[index].trim() === 'ENDSEC')) index += 1;
    index += 1;
  }
  if (!foundSection) throw new DxfError("This doesn't look like a DXF file (it has no sections).");
  return { header, layers, blocks, entities };
}

function field(data, code) {
  for (let i = 0; i < data.length; i += 1) if (data[i][0] === code) return data[i][1];
  return undefined;
}

function num(data, code, fallback = 0) {
  const value = Number.parseFloat(field(data, code));
  return Number.isFinite(value) ? value : fallback;
}

// ---- Text ----------------------------------------------------------------------------------------

// Plain text from a TEXT or MTEXT value: formatting codes removed, special characters decoded.
export function cleanText(raw, mtext = false) {
  let text = String(raw ?? '');
  text = text.replace(/\\U\+([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
  text = text.replace(/%%[cC]/g, 'Ø').replace(/%%[dD]/g, '°').replace(/%%[pP]/g, '±').replace(/%%%/g, '%').replace(/%%[uUoOkK]/g, '');
  if (mtext) {
    text = text
      .replace(/\\P/g, '\n')
      .replace(/\\~/g, ' ')
      .replace(/\\[ACcFfHhQTWp][^;]*;/g, '')
      .replace(/\\S([^;]*);/g, (_, stack) => stack.replace(/[#^]/, '/'))
      .replace(/\\[LlOoKkN]/g, '')
      .replace(/\\\\/g, '\\')
      .replace(/\\([{}])/g, '$1')
      .replace(/[{}]/g, '');
  }
  return text.trim();
}

// ---- Geometry ------------------------------------------------------------------------------------

// Growable list of segments for one layer.
class SegmentList {
  constructor() {
    this.data = new Float64Array(1024);
    this.length = 0;
  }

  push(x1, y1, x2, y2) {
    if (this.length + 4 > this.data.length) {
      const grown = new Float64Array(this.data.length * 2);
      grown.set(this.data);
      this.data = grown;
    }
    const { data } = this;
    data[this.length] = x1;
    data[this.length + 1] = y1;
    data[this.length + 2] = x2;
    data[this.length + 3] = y2;
    this.length += 4;
  }

  trimmed() {
    return this.data.slice(0, this.length);
  }
}

// 2D affine transform [a, b, c, d, e, f]: x' = a x + c y + e, y' = b x + d y + f.
const IDENTITY = [1, 0, 0, 1, 0, 0];

function multiply(m, n) {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

// Entities whose extrusion points down (mirrored in AutoCAD) have their x mirrored (OCS).
function ocsMirror(data) {
  return num(data, 230, 1) < 0;
}

export function parseDxf(text) {
  if (typeof text !== 'string' || !text.trim()) throw new DxfError('The file is empty.');
  if (text.startsWith('AutoCAD Binary DXF')) {
    throw new DxfError('This is a binary DXF file. In AutoCAD, save it again as an ASCII DXF (Save As → AutoCAD DXF, with the "Binary" option off).');
  }
  if (/^AC10\d\d/.test(text)) throw new DxfError('This is a DWG file renamed to .dxf. In AutoCAD, use Save As → AutoCAD DXF (*.dxf).');

  const { header, layers: layerTable, blocks, entities } = readStructure(text);
  const insunits = Number(header.$INSUNITS?.[70] ?? 0);
  const metresPerUnit = INSUNITS_METRES[insunits] ?? null;

  // How finely curves are cut: about 1/20000 of the drawing's size (2 mm on a 40 m hall).
  const extMin = header.$EXTMIN;
  const extMax = header.$EXTMAX;
  let extent = extMin && extMax ? Math.max(Number(extMax[10]) - Number(extMin[10]), Number(extMax[20]) - Number(extMin[20])) : NaN;
  if (!(extent > 0 && extent < 1e12)) extent = 0;
  let tolerance = extent > 0 ? extent / 20000 : 0;

  const lists = new Map();
  const counts = {};
  const skipped = {};
  const texts = [];
  let textsDropped = 0;
  const listFor = (layer) => {
    let list = lists.get(layer);
    if (!list) {
      list = new SegmentList();
      lists.set(layer, list);
    }
    return list;
  };
  const count = (type) => { counts[type] = (counts[type] || 0) + 1; };
  const skip = (type) => { skipped[type] = (skipped[type] || 0) + 1; };

  // Pieces needed for a curve of this radius and sweep, so it is off by at most `tolerance`.
  const piecesFor = (radius, sweep, scale) => {
    const r = Math.abs(radius * scale);
    let perCircle = 64;
    if (tolerance > 0 && r > 0) {
      const ratio = Math.min(1, tolerance / r);
      perCircle = Math.ceil((2 * Math.PI) / (2 * Math.acos(1 - ratio)));
    }
    perCircle = Math.min(128, Math.max(12, perCircle));
    return Math.max(2, Math.ceil((Math.abs(sweep) / (2 * Math.PI)) * perCircle));
  };

  // Draws entities with transform m; layer "0" inside a block takes the insert's layer.
  const drawEntities = (list, m, parentLayer, depth, seenBlocks) => {
    const scale = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;
    const line = (layer, x1, y1, x2, y2) => {
      listFor(layer).push(
        m[0] * x1 + m[2] * y1 + m[4], m[1] * x1 + m[3] * y1 + m[5],
        m[0] * x2 + m[2] * y2 + m[4], m[1] * x2 + m[3] * y2 + m[5],
      );
    };
    // A polyline through points (with optional bulges after each point).
    const polyline = (layer, points, bulges, closed) => {
      const n = points.length;
      if (n < 2) return;
      const last = closed ? n : n - 1;
      for (let i = 0; i < last; i += 1) {
        const [x1, y1] = points[i];
        const [x2, y2] = points[(i + 1) % n];
        const bulge = bulges?.[i] || 0;
        if (Math.abs(bulge) < 1e-9) {
          line(layer, x1, y1, x2, y2);
          continue;
        }
        // A bulge is tan(sweep / 4); the arc goes left of the chord for a positive bulge.
        const sweep = 4 * Math.atan(bulge);
        const chord = Math.hypot(x2 - x1, y2 - y1);
        if (chord < 1e-12) continue;
        const radius = chord / (2 * Math.sin(Math.abs(sweep) / 2));
        const mx = (x1 + x2) / 2;
        const my = (y1 + y2) / 2;
        // Distance from the chord's middle to the centre, towards the arc's centre side.
        const sagitta = radius * Math.cos(sweep / 2);
        const nx = -(y2 - y1) / chord;
        const ny = (x2 - x1) / chord;
        const cx = mx + nx * sagitta * Math.sign(bulge);
        const cy = my + ny * sagitta * Math.sign(bulge);
        const start = Math.atan2(y1 - cy, x1 - cx);
        arc(layer, cx, cy, radius, start, sweep);
      }
    };
    const arc = (layer, cx, cy, radius, start, sweep) => {
      const pieces = piecesFor(radius, sweep, scale);
      let px = cx + radius * Math.cos(start);
      let py = cy + radius * Math.sin(start);
      for (let i = 1; i <= pieces; i += 1) {
        const angle = start + (sweep * i) / pieces;
        const x = cx + radius * Math.cos(angle);
        const y = cy + radius * Math.sin(angle);
        line(layer, px, py, x, y);
        px = x;
        py = y;
      }
    };
    const addText = (layer, value, x, y, height, rotation, align) => {
      if (!value) return;
      if (texts.length >= MAX_TEXTS) {
        textsDropped += 1;
        return;
      }
      const tx = m[0] * x + m[2] * y + m[4];
      const ty = m[1] * x + m[3] * y + m[5];
      const dir = [m[0] * Math.cos(rotation) + m[2] * Math.sin(rotation), m[1] * Math.cos(rotation) + m[3] * Math.sin(rotation)];
      texts.push({ layer, text: value, x: tx, y: ty, height: height * scale, rotation: Math.atan2(dir[1], dir[0]), align });
    };

    for (let index = 0; index < list.length; index += 1) {
      const { type, data } = list[index];
      // Paper space (title blocks, sheet layouts) isn't part of the floor.
      if (field(data, 67)?.trim() === '1') continue;
      let layer = (field(data, 8) ?? '0').trim() || '0';
      if (layer === '0' && parentLayer) layer = parentLayer;
      const mirror = ocsMirror(data) ? -1 : 1;
      switch (type) {
        case 'LINE':
          count(type);
          line(layer, num(data, 10), num(data, 20), num(data, 11), num(data, 21));
          break;
        case 'LWPOLYLINE': {
          count(type);
          const points = [];
          const bulges = [];
          data.forEach(([code, value]) => {
            if (code === 10) {
              points.push([Number.parseFloat(value) * mirror, 0]);
              bulges.push(0);
            } else if (code === 20 && points.length) points[points.length - 1][1] = Number.parseFloat(value);
            else if (code === 42 && points.length) bulges[bulges.length - 1] = Number.parseFloat(value) * mirror;
          });
          polyline(layer, points, bulges, (num(data, 70) & 1) === 1);
          break;
        }
        case 'POLYLINE': {
          const flags = num(data, 70);
          const points = [];
          const bulges = [];
          // Its VERTEX entities follow, up to SEQEND.
          while (index + 1 < list.length && list[index + 1].type === 'VERTEX') {
            index += 1;
            const vertex = list[index].data;
            const vertexFlags = num(vertex, 70);
            // Spline frame points and polyface mesh faces aren't the outline.
            if (vertexFlags & 16 || (vertexFlags & 128 && !(vertexFlags & 64))) continue;
            points.push([num(vertex, 10) * mirror, num(vertex, 20)]);
            bulges.push(num(vertex, 42) * mirror);
          }
          if (list[index + 1]?.type === 'SEQEND') index += 1;
          if (flags & 16 || flags & 64) {
            skip('POLYLINE (3D mesh)');
            break;
          }
          count(type);
          polyline(layer, points, bulges, (flags & 1) === 1);
          break;
        }
        case 'ARC': {
          count(type);
          let start = num(data, 50) * (Math.PI / 180);
          let end = num(data, 51) * (Math.PI / 180);
          let sweep = end - start;
          while (sweep <= 0) sweep += 2 * Math.PI;
          if (mirror < 0) {
            // Mirrored: the arc runs the other way round about the mirrored centre.
            start = Math.PI - start;
            end = start - sweep;
            sweep = -sweep;
          }
          arc(layer, num(data, 10) * mirror, num(data, 20), num(data, 40), start, sweep);
          break;
        }
        case 'CIRCLE':
          count(type);
          arc(layer, num(data, 10) * mirror, num(data, 20), num(data, 40), 0, 2 * Math.PI);
          break;
        case 'ELLIPSE': {
          count(type);
          const cx = num(data, 10);
          const cy = num(data, 20);
          const ax = num(data, 11);
          const ay = num(data, 21);
          const ratio = num(data, 40, 1);
          const start = num(data, 41, 0);
          let end = num(data, 42, 2 * Math.PI);
          if (end <= start) end += 2 * Math.PI;
          const major = Math.hypot(ax, ay);
          // Minor axis is the major turned 90° (the other way if the extrusion points down).
          const bx = -ay * ratio * mirror;
          const by = ax * ratio * mirror;
          const pieces = piecesFor(major, end - start, scale);
          let px = cx + ax * Math.cos(start) + bx * Math.sin(start);
          let py = cy + ay * Math.cos(start) + by * Math.sin(start);
          for (let i = 1; i <= pieces; i += 1) {
            const t = start + ((end - start) * i) / pieces;
            const x = cx + ax * Math.cos(t) + bx * Math.sin(t);
            const y = cy + ay * Math.cos(t) + by * Math.sin(t);
            line(layer, px, py, x, y);
            px = x;
            py = y;
          }
          break;
        }
        case 'SPLINE': {
          const points = splinePoints(data);
          if (points.length < 2) {
            skip(type);
            break;
          }
          count(type);
          polyline(layer, points, null, false);
          break;
        }
        case 'SOLID':
        case 'TRACE':
        case '3DFACE': {
          count(type);
          // SOLID corners are stored in the order 1, 2, 4, 3.
          const corners = [[num(data, 10), num(data, 20)], [num(data, 11), num(data, 21)], [num(data, 13, num(data, 12)), num(data, 23, num(data, 22))], [num(data, 12), num(data, 22)]];
          if (type === '3DFACE') [corners[2], corners[3]] = [corners[3], corners[2]];
          polyline(layer, corners.map(([x, y]) => [x * mirror, y]), null, true);
          break;
        }
        case 'LEADER': {
          count(type);
          const points = [];
          data.forEach(([code, value]) => {
            if (code === 10) points.push([Number.parseFloat(value), 0]);
            else if (code === 20 && points.length) points[points.length - 1][1] = Number.parseFloat(value);
          });
          polyline(layer, points, null, false);
          break;
        }
        case 'TEXT':
        case 'ATTRIB': {
          count(type === 'ATTRIB' ? 'TEXT' : type);
          // Flag 1 on an attribute: invisible.
          if (type === 'ATTRIB' && num(data, 70) & 1) break;
          const h = num(data, 72);
          const v = num(data, 73, num(data, 74));
          // Aligned text is placed by its second point.
          const aligned = h !== 0 || v !== 0;
          const x = aligned ? num(data, 11, num(data, 10)) : num(data, 10);
          const y = aligned ? num(data, 21, num(data, 20)) : num(data, 20);
          // align: 0–8 as columns left/centre/right, rows bottom/middle/top.
          const column = h === 1 || h === 4 ? 1 : h === 2 ? 2 : 0;
          const row = v === 3 ? 2 : v === 2 || h === 4 ? 1 : 0;
          addText(layer, cleanText(field(data, 1)), x * mirror, y, num(data, 40, 1), num(data, 50) * (Math.PI / 180) * mirror, row * 3 + column);
          break;
        }
        case 'MTEXT': {
          count(type);
          const raw = data.filter(([code]) => code === 3).map(([, value]) => value).join('') + (field(data, 1) || '');
          let rotation = num(data, 50) * (Math.PI / 180);
          if (field(data, 11) !== undefined) rotation = Math.atan2(num(data, 21), num(data, 11));
          // Attachment 1–9: top-left … bottom-right; rows here count from the bottom.
          const attachment = Math.min(9, Math.max(1, num(data, 71, 1)));
          const column = (attachment - 1) % 3;
          const row = 2 - Math.floor((attachment - 1) / 3);
          addText(layer, cleanText(raw, true), num(data, 10) * mirror, num(data, 20), num(data, 40, 1), rotation * mirror, row * 3 + column);
          break;
        }
        case 'INSERT':
        case 'DIMENSION': {
          const name = (field(data, 2) || '').trim();
          const block = blocks.get(name);
          if (!block) {
            skip(type === 'DIMENSION' ? 'DIMENSION (no drawing)' : 'INSERT (missing block)');
            // An insert's attributes follow it.
            while (list[index + 1]?.type === 'ATTRIB' || list[index + 1]?.type === 'SEQEND') index += 1;
            break;
          }
          if (depth >= MAX_INSERT_DEPTH || seenBlocks.has(name)) {
            skip('INSERT (too deeply nested)');
            break;
          }
          count(type);
          const nested = new Set(seenBlocks).add(name);
          if (type === 'DIMENSION') {
            // A dimension's drawing is a ready-made block in drawing coordinates.
            drawEntities(block.entities, m, layer, depth + 1, nested);
            break;
          }
          const sx = num(data, 41, 1);
          const sy = num(data, 42, 1);
          const rotation = num(data, 50) * (Math.PI / 180);
          const columns = Math.max(1, num(data, 70, 1));
          const rows = Math.max(1, num(data, 71, 1));
          const dx = num(data, 44);
          const dy = num(data, 45);
          const cos = Math.cos(rotation);
          const sin = Math.sin(rotation);
          for (let r = 0; r < rows; r += 1) {
            for (let c = 0; c < columns; c += 1) {
              // Array copies step along the insert's own (turned) axes.
              const ox = c * dx * cos - r * dy * sin;
              const oy = c * dx * sin + r * dy * cos;
              // place (mirror for OCS) ∘ turn ∘ scale ∘ move the block's base point to the origin
              let local = [cos * sx, sin * sx, -sin * sy, cos * sy, 0, 0];
              local = multiply(local, [1, 0, 0, 1, -block.base[0], -block.base[1]]);
              local = multiply([1, 0, 0, 1, num(data, 10) + ox, num(data, 20) + oy], local);
              if (mirror < 0) local = multiply([-1, 0, 0, 1, 0, 0], local);
              drawEntities(block.entities, multiply(m, local), layer, depth + 1, nested);
            }
          }
          // Attributes (texts filled in per insert) follow in world coordinates.
          while (list[index + 1]?.type === 'ATTRIB' || list[index + 1]?.type === 'SEQEND') {
            index += 1;
            if (list[index].type === 'ATTRIB') drawEntities([list[index]], m, layer, depth + 1, nested);
          }
          break;
        }
        case 'ATTDEF':
        case 'VIEWPORT':
        case 'SEQEND':
        case 'VERTEX':
          break;
        default:
          skip(type);
      }
    }
  };

  // Without usable extents in the header, a quick first pass over plain coordinates sizes the
  // curve tolerance.
  if (!tolerance) {
    let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
    entities.forEach(({ data }) => data.forEach(([code, value]) => {
      const v = Number.parseFloat(value);
      if (!Number.isFinite(v)) return;
      if (code === 10 || code === 11) { minX = Math.min(minX, v); maxX = Math.max(maxX, v); }
      if (code === 20 || code === 21) { minY = Math.min(minY, v); maxY = Math.max(maxY, v); }
    }));
    extent = Math.max(maxX - minX, maxY - minY);
    tolerance = extent > 0 && Number.isFinite(extent) ? extent / 20000 : 0;
  }

  drawEntities(entities, IDENTITY, null, 0, new Set());
  if (textsDropped) skipped['TEXT (over 20,000)'] = textsDropped;

  const layers = [...lists.entries()]
    .map(([name, list]) => ({
      name,
      segments: list.trimmed(),
      count: list.length / 4,
      hiddenInFile: Boolean(layerTable.get(name)?.off || layerTable.get(name)?.frozen),
    }));
  // Layers with only text still need a row (to switch their labels).
  texts.forEach((label) => {
    if (!layers.some((layer) => layer.name === label.layer)) {
      layers.push({ name: label.layer, segments: new Float64Array(0), count: 0, hiddenInFile: Boolean(layerTable.get(label.layer)?.off || layerTable.get(label.layer)?.frozen) });
    }
  });
  layers.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  layers.forEach((layer) => { layer.texts = texts.filter((label) => label.layer === layer.name).length; });

  if (!layers.some((layer) => layer.count) && !texts.length) {
    const what = Object.keys(skipped).length ? ` It only has ${Object.keys(skipped).join(', ').toLowerCase()}.` : '';
    throw new DxfError(`Nothing in this DXF file can be drawn as a floor plan (no lines, arcs, circles, polylines or text in model space).${what}`);
  }

  // The middle and size of the plan come from the building, not from its notes and dimensions.
  const building = layers.filter((layer) => layer.count && !layer.hiddenInFile && !isAnnotationLayer(layer.name));
  const { bounds } = measure(layers, texts);
  const { main } = building.length ? measure(building, []) : measure(layers, texts);
  return { layers, texts, bounds, main, insunits, metresPerUnit, counts, skipped };
}

// Full bounds, and "main" bounds that leave out the outer 0.5 % of points on each side, so one
// stray line far away doesn't decide the plan's size or middle.
function measure(layers, texts) {
  let total = 0;
  layers.forEach((layer) => { total += layer.segments.length / 2; });
  const stride = Math.max(1, Math.floor(total / 40000));
  const xs = [];
  const ys = [];
  const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  let counter = 0;
  const add = (x, y) => {
    if (x < bounds.minX) bounds.minX = x;
    if (x > bounds.maxX) bounds.maxX = x;
    if (y < bounds.minY) bounds.minY = y;
    if (y > bounds.maxY) bounds.maxY = y;
    if (counter % stride === 0) {
      xs.push(x);
      ys.push(y);
    }
    counter += 1;
  };
  layers.forEach(({ segments }) => {
    for (let i = 0; i < segments.length; i += 2) add(segments[i], segments[i + 1]);
  });
  texts.forEach((label) => add(label.x, label.y));
  const cut = (values) => {
    values.sort((a, b) => a - b);
    const drop = Math.floor(values.length * 0.005);
    return [values[drop], values[values.length - 1 - drop]];
  };
  const [minX, maxX] = cut(xs);
  const [minY, maxY] = cut(ys);
  return { bounds, main: { minX, minY, maxX, maxY } };
}

// Points along a spline: the curve from its control points (NURBS, any degree), else a line
// through its fit points.
function splinePoints(data) {
  const degree = num(data, 71, 3);
  const knots = [];
  const control = [];
  const weights = [];
  const fit = [];
  data.forEach(([code, value]) => {
    const v = Number.parseFloat(value);
    if (code === 40) knots.push(v);
    else if (code === 41) weights.push(v);
    else if (code === 10) control.push([v, 0]);
    else if (code === 20 && control.length) control[control.length - 1][1] = v;
    else if (code === 11) fit.push([v, 0]);
    else if (code === 21 && fit.length) fit[fit.length - 1][1] = v;
  });
  if (control.length > degree && knots.length === control.length + degree + 1) {
    const start = knots[degree];
    const end = knots[control.length];
    const samples = Math.min(2000, Math.max(16, control.length * 8));
    const result = [];
    for (let i = 0; i <= samples; i += 1) {
      const t = start + ((end - start) * i) / samples;
      result.push(deBoor(degree, knots, control, weights, Math.min(t, end - 1e-12 * Math.max(1, Math.abs(end)))));
    }
    // The last point exactly at the curve's end.
    result[result.length - 1] = deBoor(degree, knots, control, weights, end, true);
    return result;
  }
  return fit.length >= 2 ? fit : control;
}

function deBoor(degree, knots, control, weights, t, atEnd = false) {
  const n = control.length;
  if (atEnd) {
    // Clamped splines end on their last control point.
    return control[n - 1];
  }
  let span = degree;
  while (span < n - 1 && t >= knots[span + 1]) span += 1;
  const w = (i) => (weights.length === n ? weights[i] : 1);
  const d = [];
  for (let j = 0; j <= degree; j += 1) {
    const i = span - degree + j;
    const weight = w(i);
    d.push([control[i][0] * weight, control[i][1] * weight, weight]);
  }
  for (let r = 1; r <= degree; r += 1) {
    for (let j = degree; j >= r; j -= 1) {
      const i = span - degree + j;
      const denominator = knots[i + degree - r + 1] - knots[i];
      const alpha = denominator === 0 ? 0 : (t - knots[i]) / denominator;
      d[j] = [0, 1, 2].map((k) => (1 - alpha) * d[j - 1][k] + alpha * d[j][k]);
    }
  }
  const [x, y, weight] = d[degree];
  return [x / weight, y / weight];
}

// Layers that are notes rather than the building: hidden when a plan is first imported.
export function isAnnotationLayer(name) {
  return /dim|anno|text|txt|note|hatch|defpoints|title|border|leader|cota|bemass|vport|viewport/i.test(name);
}

// Layers that are walls: offered first when raising walls.
export function isWallLayer(name) {
  return /wall|mauer|wand|muro|\bmur\b/i.test(name);
}

// Bytes → text. Newer DXF files are UTF-8; older ones use the Windows code page.
export function decodeDxf(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes.length >= 6 && String.fromCharCode(...bytes.slice(0, 4)) === 'AC10') {
    throw new DxfError('This is a DWG file renamed to .dxf. In AutoCAD, use Save As → AutoCAD DXF (*.dxf).');
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}
