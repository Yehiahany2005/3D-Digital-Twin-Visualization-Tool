import { box, cylinder, group, roundedBox } from '../station-1/OilGeometry.js';

/** Radius of the tucker and side-folder bars (m); contact clearance = flap thickness + this. */
export const CLOSER_BAR_RADIUS = 0.012;

const PLATE_HALF = { x: 0.29, z: 0.18 };

/**
 * Compact top-flap closer bridging the output belt at `boxLine.closerX`.
 * The case stops under it; then
 * - two tucker bars (on X slides with vertical cylinders) drop in behind the
 *   end flaps and push them inward,
 * - the compression plate tamps the end flaps flat,
 * - two side folder bars (horizontal cylinders on the columns) push the side
 *   flaps inward,
 * - the compression plate presses the closed top.
 * Every tool parks above or beside the open-flap envelope so the next case
 * passes underneath freely. Root sits at the case stop position (output conveyor space).
 */
export function createCaseCloser({ materials, definition }) {
  const { line, boxLine, box: boxDef, closer } = definition;
  const { length, width, height, flap } = boxDef;
  const top = line.beltHeight + height;
  const minorHingeY = top - flap * 2;
  const majorHingeY = top - flap;
  const r = CLOSER_BAR_RADIUS;
  const columnZ = 0.6;
  const beamY = top + 0.62;
  const railY = top + 0.5;
  const railZ = 0.235;

  const root = group(null, 'CaseCloser', [boxLine.closerX, 0, 0]);

  // ---- Frame -------------------------------------------------------------------------------
  const frame = group(root, 'CloserFrame');
  [-1, 1].forEach((side) => {
    roundedBox(frame, [0.08, beamY + 0.05, 0.08], [0, (beamY + 0.05) / 2, side * columnZ], materials.frame, 'Closer column', 0.012);
    roundedBox(frame, [0.22, 0.02, 0.22], [0, 0.01, side * columnZ], materials.brushed, 'Closer foot', 0.004);
    roundedBox(frame, [1.04, 0.06, 0.06], [0, railY, side * railZ], materials.frame, 'Tucker beam', 0.008);
    box(frame, [1.0, 0.012, 0.02], [0, railY - 0.036, side * railZ], materials.chrome, 'Tucker rail');
    roundedBox(frame, [0.1, 0.06, 0.06], [0, (railY + beamY) / 2, side * railZ], materials.frameDark, 'Beam hanger', 0.006);
  });
  roundedBox(frame, [0.12, 0.1, columnZ * 2 + 0.12], [0, beamY, 0], materials.frame, 'Closer beam', 0.012);
  cylinder(frame, 0.045, 0.47, [0, top + 0.615, 0], materials.aluminium, 'Press cylinder', { segments: 24 });
  cylinder(frame, 0.05, 0.03, [0, top + 0.865, 0], materials.safetyYellow, 'Press cylinder cap', { segments: 24 });

  // ---- Compression plate -------------------------------------------------------------------
  const plate = group(root, 'CompressionPlate');
  box(plate, [PLATE_HALF.x * 2 - 0.02, 0.008, PLATE_HALF.z * 2 - 0.02], [0, 0.004, 0], materials.rubber, 'Press pad');
  roundedBox(plate, [PLATE_HALF.x * 2, 0.02, PLATE_HALF.z * 2], [0, 0.018, 0], materials.stainless, 'Press plate', 0.004);
  roundedBox(plate, [0.16, 0.03, 0.16], [0, 0.043, 0], materials.brushed, 'Plate flange', 0.006);
  cylinder(plate, 0.025, 0.4, [0, 0.258, 0], materials.chrome, 'Press rod', { segments: 16 });

  // ---- End-flap tuckers (trailing −X, leading +X) -------------------------------------------
  const tuckers = [-1, 1].map((side) => {
    const carriage = group(root, side > 0 ? 'Tucker leading' : 'Tucker trailing');
    const bar = group(carriage, 'TuckerBar');
    cylinder(bar, r, railZ * 2 + 0.02, [0, 0, 0], materials.rubber, 'Tucker roller', { axis: 'z', segments: 16 });
    [-1, 1].forEach((z) => {
      roundedBox(carriage, [0.1, 0.04, 0.08], [0, railY - 0.05, z * railZ], materials.frameDark, 'Slide block', 0.006);
      cylinder(carriage, 0.02, 0.12, [0, railY - 0.13, z * railZ], materials.aluminium, 'Tucker cylinder', { segments: 16 });
      cylinder(bar, 0.009, 0.26, [0, 0.13, z * railZ], materials.chrome, 'Tucker rod', { segments: 12 });
    });
    return { side, carriage, bar };
  });

  // ---- Side-flap folders (rear −Z, front +Z) -------------------------------------------------
  const folderY = majorHingeY + closer.foldUp;
  const folders = [-1, 1].map((side) => {
    cylinder(frame, 0.028, 0.22, [0, folderY, side * 0.47], materials.aluminium, 'Folder cylinder', { axis: 'z', segments: 20 });
    roundedBox(frame, [0.1, 0.1, 0.03], [0, folderY, side * (columnZ - 0.055)], materials.frameDark, 'Folder bracket', 0.006);
    const slide = group(root, side > 0 ? 'Side folder front' : 'Side folder rear', [0, folderY, 0]);
    cylinder(slide, r, PLATE_HALF.x * 2, [0, 0, 0], materials.rubber, 'Folder roller', { axis: 'x', segments: 16 });
    roundedBox(slide, [0.06, 0.04, 0.03], [0, 0, side * 0.02], materials.safetyYellow, 'Folder clevis', 0.006);
    cylinder(slide, 0.012, 0.26, [0, 0, side * 0.15], materials.chrome, 'Folder rod', { axis: 'z', segments: 12 });
    return { side, slide };
  });

  const closerParts = {
    root,
    plateHalf: PLATE_HALF,
    /** Tucker bars `out` beyond the end walls (negative = over the case), `up` above the end-flap hinge. */
    setTuckers(out, up) {
      tuckers.forEach(({ side, carriage, bar }) => {
        carriage.position.x = side * (length / 2 + out);
        bar.position.y = minorHingeY + up;
      });
    },
    /** Side folder bars `out` beyond the side walls (negative = over the case). */
    setFolders(out) {
      folders.forEach(({ side, slide }) => { slide.position.z = side * (width / 2 + out); });
    },
    /** Compression plate underside `up` above the side-flap hinge (0 = pressing the closed top). */
    setPlate(up) {
      plate.position.y = majorHingeY + up;
    },
    reset() {
      closerParts.setTuckers(closer.parkOut, closer.parkUp);
      closerParts.setFolders(closer.parkOut);
      closerParts.setPlate(closer.plateParkUp);
    },
  };
  closerParts.reset();
  return closerParts;
}
