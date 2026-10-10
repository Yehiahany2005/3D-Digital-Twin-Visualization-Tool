import { describe, expect, it } from 'vitest';
import { cleanText, DxfError, guessUnit, isAnnotationLayer, parseDxf } from './dxf.js';
import { arc, circle, insert, line, lwpolyline, sampleHall, text, writeDxf } from './sampleDxf.js';

const layer = (plan, name) => plan.layers.find((candidate) => candidate.name === name);

// Every end point of a layer's segments, as [x, y].
function points(plan, name) {
  const segments = layer(plan, name).segments;
  const result = [];
  for (let i = 0; i < segments.length; i += 2) result.push([segments[i], segments[i + 1]]);
  return result;
}

const near = (a, b, digits = 6) => expect(a).toBeCloseTo(b, digits);

describe('parseDxf', () => {
  it('reads every entity type into segments per layer', () => {
    const plan = parseDxf(writeDxf({
      insunits: 6,
      entities: [
        line('L', 0, 0, 10, 0),
        lwpolyline('P', [[0, 0], [1, 0], [1, 1]], { closed: true }),
        circle('C', 0, 0, 2),
        arc('A', 0, 0, 1, 0, 90),
        ['ELLIPSE', [[8, 'E'], [10, 0], [20, 0], [11, 4], [21, 0], [40, 0.5], [41, 0], [42, Math.PI * 2]]],
        ['SPLINE', [[8, 'S'], [71, 1], [72, 4], [73, 2], [40, 0], [40, 0], [40, 1], [40, 1], [10, 0], [20, 0], [10, 3], [20, 4]]],
        ['POLYLINE', [[8, 'PL'], [66, 1], [70, 0]]],
        ['VERTEX', [[8, 'PL'], [10, 0], [20, 0]]],
        ['VERTEX', [[8, 'PL'], [10, 5], [20, 0]]],
        ['VERTEX', [[8, 'PL'], [10, 5], [20, 5]]],
        ['SEQEND', [[8, 'PL']]],
        text('T', 1, 2, 0.5, 'Hello'),
        ['MTEXT', [[8, 'T'], [10, 3], [20, 4], [40, 0.3], [71, 1], [1, '{\\fArial|b1;Cell}\\P2']]],
      ],
    }));
    expect(plan.metresPerUnit).toBe(1);
    expect(layer(plan, 'L').count).toBe(1);
    expect(layer(plan, 'P').count).toBe(3);
    expect(layer(plan, 'PL').count).toBe(2);
    // Every circle point is on the circle; the arc ends where it should.
    points(plan, 'C').forEach(([x, y]) => near(Math.hypot(x, y), 2));
    const arcPoints = points(plan, 'A');
    near(arcPoints[0][0], 1);
    near(arcPoints[arcPoints.length - 1][1], 1);
    // Ellipse 4 wide and 2 tall.
    const ellipse = points(plan, 'E');
    near(Math.max(...ellipse.map(([x]) => x)), 4);
    near(Math.max(...ellipse.map(([, y]) => y)), 2, 2);
    // A degree-1 spline is the straight line between its two control points.
    const spline = points(plan, 'S');
    near(spline[spline.length - 1][0], 3);
    near(spline[spline.length - 1][1], 4);
    expect(plan.texts.map((label) => label.text)).toEqual(['Hello', 'Cell\n2']);
    expect(plan.counts).toMatchObject({ LINE: 1, LWPOLYLINE: 1, CIRCLE: 1, ARC: 1, ELLIPSE: 1, SPLINE: 1, POLYLINE: 1, TEXT: 1, MTEXT: 1 });
  });

  it('turns a polyline bulge into an arc', () => {
    // Bulge 1 = a half circle from (0,0) to (2,0), going right of the chord (clockwise below it
    // for a negative bulge, above for positive: positive turns left of the direction of travel).
    const plan = parseDxf(writeDxf({ entities: [lwpolyline('B', [[0, 0], [2, 0]], { bulges: [1] })] }));
    const pts = points(plan, 'B');
    pts.forEach(([x, y]) => near(Math.hypot(x - 1, y), 1));
    // Travelling +x with a positive bulge, the arc swings to the right (y < 0): counter-clockwise
    // about the centre (1, 0) from angle 180° to 360°.
    expect(Math.min(...pts.map(([, y]) => y))).toBeCloseTo(-1, 3);
    expect(Math.max(...pts.map(([, y]) => y))).toBeLessThan(1e-9);
  });

  it('applies block inserts with base point, scale, rotation and nesting; layer 0 takes the insert\'s layer', () => {
    const plan = parseDxf(writeDxf({
      blocks: [
        { name: 'INNER', base: [1, 0], entities: [line('0', 1, 0, 2, 0)] },
        { name: 'OUTER', entities: [insert('0', 'INNER', 10, 0), line('OWN', 0, 0, 0, 1)] },
      ],
      entities: [insert('M', 'OUTER', 100, 100, { scale: 2, rotation: 90 })],
    }));
    // INNER's line (1..2 → 0..1 from its base) sits at 10..11 in OUTER, then ×2, turned 90° and moved.
    const [[x1, y1], [x2, y2]] = points(plan, 'M');
    near(x1, 100);
    near(y1, 120);
    near(x2, 100);
    near(y2, 122);
    // Entities on their own layer keep it.
    const [[ox, oy], [px, py]] = points(plan, 'OWN');
    near(ox, 100);
    near(oy, 100);
    near(px, 98);
    near(py, 100);
  });

  it('draws dimensions from their block and lists what it skipped', () => {
    const plan = parseDxf(sampleHall());
    expect(layer(plan, 'DIMENSIONS').count).toBe(3);
    expect(plan.skipped).toEqual({ HATCH: 1 });
    expect(plan.texts.find((label) => label.text === '40000').layer).toBe('DIMENSIONS');
  });

  it('reads units from $INSUNITS, and measures the plan', () => {
    const plan = parseDxf(sampleHall());
    expect(plan.insunits).toBe(4);
    expect(plan.metresPerUnit).toBe(0.001);
    expect(plan.bounds.maxX - plan.bounds.minX).toBe(40000);
    // The dimension line sits 2 m below the hall.
    expect(plan.bounds.minY).toBe(-2300);
  });

  it('guesses units from the size when the file does not say', () => {
    const plan = parseDxf(writeDxf({ entities: [line('W', 0, 0, 40000, 0), line('W', 0, 0, 0, 25000)] }));
    expect(plan.metresPerUnit).toBeNull();
    expect(guessUnit(40000)).toBe('mm');
    expect(guessUnit(40)).toBe('m');
    expect(guessUnit(4000)).toBe('cm');
    expect(guessUnit(130)).toBe('m');
    expect(guessUnit(1500)).toBe('cm');
  });

  it('mirrors entities whose extrusion points down', () => {
    const plan = parseDxf(writeDxf({ entities: [['CIRCLE', [[8, 'C'], [10, 5], [20, 0], [40, 1], [230, -1]]]] }));
    const xs = points(plan, 'C').map(([x]) => x);
    near(Math.min(...xs), -6);
  });

  it('gives clear errors for broken or empty files', () => {
    expect(() => parseDxf('')).toThrow(DxfError);
    expect(() => parseDxf('hello\nworld\n')).toThrow(/damaged|DXF/);
    expect(() => parseDxf('AC1032 binary')).toThrow(/DWG/);
    expect(() => parseDxf(writeDxf({ entities: [['HATCH', [[8, 'H']]]] }))).toThrow(/Nothing in this DXF/);
  });

  it('cleans MTEXT formatting and recognises annotation layers', () => {
    expect(cleanText('\\A1;{\\C1;Line}\\Ptwo %%c50', true)).toBe('Line\ntwo Ø50');
    expect(isAnnotationLayer('A-ANNO-DIMS')).toBe(true);
    expect(isAnnotationLayer('DIMENSIONS')).toBe(true);
    expect(isAnnotationLayer('WALLS')).toBe(false);
  });

  it('handles a plan with 100k segments quickly', () => {
    const entities = [];
    for (let i = 0; i < 100000; i += 1) entities.push(line('BIG', i % 300, Math.floor(i / 300), (i % 300) + 0.5, Math.floor(i / 300)));
    const source = writeDxf({ insunits: 6, entities });
    const start = performance.now();
    const plan = parseDxf(source);
    const took = performance.now() - start;
    expect(layer(plan, 'BIG').count).toBe(100000);
    expect(took).toBeLessThan(3000);
  });
});
