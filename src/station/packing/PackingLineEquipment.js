import { box, cylinder, group, roundedBox } from '../oil/OilGeometry.js';
import { createBeltConveyor, createConveyorTunnel } from '../oil/OilConveyor.js';

/**
 * Two-lane can input conveyor: belt, centre lane divider hung from overhead
 * bridges, a fixed end stop the cans accumulate against, and an infeed tunnel.
 * Root sits on the line centre (z = `z`).
 */
export function createInputConveyor({ materials, definition }) {
  const { line, input } = definition;
  const root = group(null, 'InputConveyor', [0, 0, input.z]);
  const belt = createBeltConveyor({
    name: 'InputBelt',
    start: input.start,
    end: input.end,
    beltHeight: line.beltHeight,
    beltWidth: line.beltWidth,
    guideHalfGap: input.guideHalfGap,
    materials,
  });
  root.add(belt.root);

  const stopFaceX = Math.max(...input.stopX) + definition.can.length / 2;
  const dividerStart = input.tunnel.end + 0.02;
  const dividerEnd = stopFaceX;
  const divider = group(root, 'LaneDivider');
  roundedBox(divider, [dividerEnd - dividerStart, 0.17, 0.012], [(dividerStart + dividerEnd) / 2, line.beltHeight + 0.11, 0], materials.stainless, 'Divider blade', 0.004);
  const frameZ = line.beltWidth / 2 + 0.065;
  const bridgeTop = line.beltHeight + 0.5;
  [-1.6, -0.55].forEach((x, index) => {
    const bridge = group(divider, `Divider bridge ${index + 1}`, [x, 0, 0]);
    [-1, 1].forEach((side) => {
      roundedBox(bridge, [0.04, bridgeTop - line.beltHeight + 0.02, 0.04], [0, (line.beltHeight + bridgeTop) / 2, side * frameZ], materials.stainless, 'Bridge post', 0.006);
    });
    roundedBox(bridge, [0.04, 0.04, frameZ * 2 + 0.04], [0, bridgeTop, 0], materials.stainless, 'Bridge beam', 0.006);
    roundedBox(bridge, [0.02, bridgeTop - line.beltHeight - 0.19, 0.012], [0, (bridgeTop + line.beltHeight + 0.19) / 2, 0], materials.stainless, 'Divider hanger', 0.003);
  });

  const endStop = group(root, 'EndStop', [stopFaceX + 0.008, 0, 0]);
  roundedBox(endStop, [0.016, 0.1, line.beltWidth - 0.02], [0, line.beltHeight + 0.08, 0], materials.safetyYellow, 'Stop bar', 0.004);
  box(endStop, [0.004, 0.08, line.beltWidth - 0.04], [-0.009, line.beltHeight + 0.08, 0], materials.rubber, 'Stop bumper');
  [-1, 1].forEach((side) => {
    roundedBox(endStop, [0.04, 0.22, 0.04], [0.01, line.beltHeight + 0.05, side * frameZ], materials.stainless, 'Stop post', 0.006);
  });

  const tunnel = createConveyorTunnel({ name: 'InfeedTunnel', ...input.tunnel, beltHeight: line.beltHeight, beltWidth: line.beltWidth, materials, openSide: 1 });
  root.add(tunnel.root);
  return { root, belt };
}

/**
 * Carton line: infeed section (case erector tunnel → packing position with a
 * swing-arm box stop) and output section (case taper → output tunnel).
 */
export function createBoxConveyors({ materials, definition, tapeMaterial }) {
  const { line, boxLine, box: boxDef } = definition;
  const guideHalfGap = boxDef.width / 2 + 0.012;
  const frameZ = line.beltWidth / 2 + 0.06;

  const boxRoot = group(null, 'BoxConveyor', [0, 0, boxLine.z]);
  const infeed = createBeltConveyor({ name: 'BoxInfeedBelt', ...boxLine.infeed, beltHeight: line.beltHeight, beltWidth: line.beltWidth, guideHalfGap, materials });
  boxRoot.add(infeed.root);
  const erector = createConveyorTunnel({ name: 'CaseErectorTunnel', ...boxLine.erectorTunnel, beltHeight: line.beltHeight, beltWidth: line.beltWidth, materials, openSide: 1 });
  boxRoot.add(erector.root);

  // Swing-arm stop: closed across the belt in front of the packing position.
  const stop = group(boxRoot, 'BoxStop', [boxLine.packX + boxDef.length / 2 + 0.008, 0, -frameZ]);
  roundedBox(stop, [0.08, 0.3, 0.08], [0, line.beltHeight - 0.05, -0.02], materials.frame, 'Stop bracket', 0.01);
  cylinder(stop, 0.03, 0.16, [0, line.beltHeight + 0.12, -0.02], materials.aluminium, 'Swing actuator', { segments: 20 });
  const arm = group(stop, 'StopArm', [0, line.beltHeight + 0.105, 0]);
  roundedBox(arm, [0.012, 0.045, frameZ], [0, 0, frameZ / 2], materials.safetyYellow, 'Stop blade', 0.004);
  box(arm, [0.004, 0.035, frameZ - 0.04], [-0.008, 0, frameZ / 2 + 0.02], materials.rubber, 'Blade bumper');

  const outputRoot = group(null, 'OutputConveyor', [0, 0, boxLine.z]);
  const output = createBeltConveyor({ name: 'OutputBelt', ...boxLine.output, beltHeight: line.beltHeight, beltWidth: line.beltWidth, guideHalfGap, materials });
  outputRoot.add(output.root);
  const outputTunnel = createConveyorTunnel({ name: 'OutputTunnel', ...boxLine.outputTunnel, beltHeight: line.beltHeight, beltWidth: line.beltWidth, materials, openSide: -1 });
  outputRoot.add(outputTunnel.root);

  // Top case taper bridging the output belt.
  const taper = group(outputRoot, 'CaseTaper', [boxLine.taperX, 0, 0]);
  const boxTop = line.beltHeight + boxDef.height;
  const bridgeTop = boxTop + 0.42;
  [-1, 1].forEach((side) => {
    roundedBox(taper, [0.08, bridgeTop, 0.08], [0, bridgeTop / 2, side * (frameZ + 0.08)], materials.frame, 'Taper column', 0.012);
    roundedBox(taper, [0.22, 0.02, 0.22], [0, 0.01, side * (frameZ + 0.08)], materials.brushed, 'Taper foot', 0.004);
  });
  roundedBox(taper, [0.12, 0.1, (frameZ + 0.08) * 2 + 0.1], [0, bridgeTop, 0], materials.frame, 'Taper beam', 0.012);
  roundedBox(taper, [0.04, bridgeTop - boxTop - 0.2, 0.04], [0, (bridgeTop + boxTop + 0.2) / 2, 0], materials.stainless, 'Head hanger', 0.006);
  const head = group(taper, 'TapingHead', [0, boxTop, 0]);
  roundedBox(head, [0.34, 0.12, 0.08], [-0.03, 0.14, 0.07], materials.safetyYellow, 'Head cover', 0.015);
  roundedBox(head, [0.34, 0.12, 0.012], [-0.03, 0.14, -0.04], materials.brushed, 'Side plate', 0.004);
  const rollers = [-0.15, 0.1].map((x, index) => cylinder(head, 0.028, 0.07, [x, 0.03, 0], materials.rubber, `Wipe roller ${index + 1}`, { axis: 'z', segments: 20 }));
  const tapeRoll = group(head, 'TapeRoll', [-0.05, 0.2, 0]);
  cylinder(tapeRoll, 0.09, 0.05, [0, 0, 0], tapeMaterial, 'Tape roll', { axis: 'z', segments: 32 });
  cylinder(tapeRoll, 0.04, 0.052, [0, 0, 0], materials.guide, 'Tape core', { axis: 'z', segments: 24 });
  box(tapeRoll, [0.03, 0.012, 0.054], [0.06, 0, 0], materials.frameDark, 'Roll index mark');
  box(head, [0.004, 0.17, 0.05], [0.11, 0.1, 0], tapeMaterial, 'Tape web');

  return {
    boxRoot,
    outputRoot,
    infeed,
    output,
    /** 0 = blade across the belt, 1 = swung clear. */
    setStopOpen(open) {
      arm.rotation.y = (Math.PI / 2) * open;
    },
    /** Spins the taper rollers and tape roll by belt travel. */
    spinTaper(distance) {
      rollers.forEach((roller) => { roller.rotation.z -= distance / 0.028; });
      tapeRoll.rotation.z -= distance / 0.09;
    },
  };
}
