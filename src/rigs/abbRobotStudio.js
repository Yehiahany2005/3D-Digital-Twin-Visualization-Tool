// The common shape of rigs for six-axis ABB robots exported from RobotStudio as GLB.
//
// RobotStudio places every link node (Link1 … Link6) on its joint with the rotation axis as its
// local Z (the DH convention), so each joint uses frame 'part' with the pivot at the part's
// origin and axis [0, 0, 1]. Limits come from the kinematics ABB embeds in the file
// (extras.ABB_ro_int_kinematics) and the rest pose from extras.ABB_ro_int_jointvalues.
//
// Robots with a balancer cylinder have two more links: the cylinder (LinkD1) pivots on the
// turret and its rod (LinkD2) is pinned to the upper arm. Both follow axis 2 automatically.
// The balancer points are in the LinkD1 / LinkD2 frames: the rod pin, the cylinder pivot, and
// the direction from pivot to pin.

const joint = (number, [min, max], speed, zero) => ({
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
  ...(zero ? { zero } : {}),
});

const balancerJoints = ({ rodPinFromCylinder, cylinderPivotFromRod, rodDirection }) => [
  {
    id: 'balancer',
    name: 'Balancer cylinder',
    type: 'revolute',
    parent: 'axis1',
    parts: [{ name: 'LinkD1' }],
    frame: 'part',
    axis: [0, 0, 1],
    pivot: [0, 0, 0],
    aim: { joint: 'axis2', target: rodPinFromCylinder },
  },
  {
    id: 'balancer_rod',
    name: 'Balancer rod',
    type: 'prismatic',
    parent: 'balancer',
    parts: [{ name: 'LinkD2' }],
    frame: 'part',
    axis: rodDirection,
    pivot: [0, 0, 0],
    stretch: { joint: 'axis2', target: [0, 0, 0], anchor: cylinderPivotFromRod },
  },
];

export const pose = (id, name, [a1, a2, a3, a4, a5, a6]) => ({
  id,
  name,
  values: { axis1: a1, axis2: a2, axis3: a3, axis4: a4, axis5: a5, axis6: a6 },
});

// Steps refer to poses by id, so editing a pose in Animation Setup updates every sequence using it.
const move = (poseId, duration) => ({ type: 'move', pose: poseId, ...(duration ? { duration } : {}) });
const wait = (duration) => ({ type: 'wait', duration });

// limits: six [min, max] in degrees; speeds: six °/s; rest: the six values the file was exported
// at; flange: the tool flange's distance along Link6's Z (extras.ABB_ro_int_mountOffset);
// poses: must include 'home', 'reach_forward', 'ready', 'scan_left' and 'scan_right'.
export function abbRobotStudioRig({ limits, speeds, rest, balancer, flange, poses }) {
  const home = poses.find((candidate) => candidate.id === 'home');
  const homeValues = Object.values(home.values);
  // Calibration: from Home, nudge each axis +5° and −5° in turn, then return.
  const calibrationSteps = [1, 2, 3, 4, 5, 6].flatMap((number, index) => {
    const id = `axis${number}`;
    const homeValue = homeValues[index];
    return [
      { type: 'move', label: `Axis ${number} +5°`, values: { [id]: homeValue + 5 } },
      { type: 'move', label: `Axis ${number} −5°`, values: { [id]: homeValue - 5 } },
      { type: 'move', label: `Axis ${number} home`, values: { [id]: homeValue } },
    ];
  });
  return {
    version: 1,
    joints: [
      ...limits.map((range, index) => joint(index + 1, range, speeds[index], rest[index])),
      ...(balancer ? balancerJoints(balancer) : []),
    ],
    // Tool point for Reach: the tool flange. Move it with Reach → Tool tip once a gripper is fitted.
    tools: [{ id: 'flange', name: 'Tool flange', joint: 'axis6', frame: 'part', point: [0, 0, flange], direction: [0, 0, 1] }],
    poses,
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
}
