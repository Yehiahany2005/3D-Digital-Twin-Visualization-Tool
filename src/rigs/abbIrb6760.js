// Rig for the ABB IRB 6760 in src/assets/robot.glb.
//
// Limits and the balancer linkage come from the kinematics ABB embedded in the
// file (extras.ABB_ro_int_kinematics). Every link node is placed on its joint
// with the rotation axis as its local Z (the DH convention), so each joint uses
// frame 'part' with the pivot at the part's origin and axis [0, 0, 1].
//
// The balancer cylinder (LinkD1) pivots on the turret and its rod (LinkD2) is
// pinned to the upper arm. Both follow axis 2 automatically. The points below are
// in the LinkD1 / LinkD2 frames: the rod pin, the cylinder pivot, and the
// cylinder direction (pivot → pin).
const ROD_PIN_FROM_CYLINDER = [-0.47491, -0.06929, 0];
const CYLINDER_PIVOT_FROM_ROD = [0.479938, 0, 0];
const ROD_DIRECTION = [-1, 0, 0];

const joint = (number, min, max, speed, extra = {}) => ({
  id: `axis${number}`,
  name: `Axis ${number}`,
  type: 'revolute',
  parent: number > 1 ? `axis${number - 1}` : null,
  parts: [{ name: `Link${number}` }],
  frame: 'part',
  axis: [0, 0, 1],
  pivot: [0, 0, 0],
  min,
  max,
  speed,
  ...extra,
});

const pose = (id, name, [a1, a2, a3, a4, a5, a6]) => ({
  id,
  name,
  values: { axis1: a1, axis2: a2, axis3: a3, axis4: a4, axis5: a5, axis6: a6 },
});

const HOME = [0, 0, 0, 0, 30, 0];
const POSES = [
  pose('home', 'Home', HOME),
  pose('ready', 'Ready', [0, 10, 10, 0, 50, 0]),
  pose('reach_forward', 'Reach Forward', [15, 45, -10, 0, 45, 0]),
  pose('scan_left', 'Scan Left', [35, 20, 5, 0, 60, 0]),
  pose('scan_right', 'Scan Right', [-35, 20, 5, 0, 60, 0]),
];

const move = (poseId, duration) => {
  const { name, values } = POSES.find((item) => item.id === poseId);
  return { type: 'move', label: name, values, ...(duration ? { duration } : {}) };
};
const wait = (duration) => ({ type: 'wait', duration });

// Calibration: from Home, nudge each axis +5° and −5° in turn, then return.
const calibrationSteps = ['axis1', 'axis2', 'axis3', 'axis4', 'axis5', 'axis6'].flatMap((id, index) => {
  const homeValue = HOME[index];
  return [
    { type: 'move', label: `Axis ${index + 1} +5°`, values: { [id]: homeValue + 5 } },
    { type: 'move', label: `Axis ${index + 1} −5°`, values: { [id]: homeValue - 5 } },
    { type: 'move', label: `Axis ${index + 1} home`, values: { [id]: homeValue } },
  ];
});

export const ABB_IRB6760_RIG = {
  version: 1,
  joints: [
    joint(1, -170, 170, 35),
    joint(2, -65, 85, 60),
    joint(3, -180, 70, 90),
    joint(4, -300, 300, 120),
    // The file was exported with axis 5 at 30°, so the rest pose reads 30°.
    joint(5, -130, 130, 160, { zero: 30 }),
    joint(6, -360, 360, 220),
    {
      id: 'balancer',
      name: 'Balancer cylinder',
      type: 'revolute',
      parent: 'axis1',
      parts: [{ name: 'LinkD1' }],
      frame: 'part',
      axis: [0, 0, 1],
      pivot: [0, 0, 0],
      aim: { joint: 'axis2', target: ROD_PIN_FROM_CYLINDER },
    },
    {
      id: 'balancer_rod',
      name: 'Balancer rod',
      type: 'prismatic',
      parent: 'balancer',
      parts: [{ name: 'LinkD2' }],
      frame: 'part',
      axis: ROD_DIRECTION,
      pivot: [0, 0, 0],
      stretch: { joint: 'axis2', target: [0, 0, 0], anchor: CYLINDER_PIVOT_FROM_ROD },
    },
  ],
  poses: POSES,
  sequences: [
    {
      id: 'reach_forward',
      name: 'Reach Forward',
      steps: [move('reach_forward'), wait(0.75), move('home')],
    },
    {
      id: 'inspection_scan',
      name: 'Inspection Scan',
      steps: [move('ready'), move('scan_left'), wait(0.75), move('scan_right'), wait(0.75), move('home')],
    },
    {
      id: 'calibration',
      name: 'Calibration',
      steps: [move('home'), ...calibrationSteps],
    },
  ],
};
