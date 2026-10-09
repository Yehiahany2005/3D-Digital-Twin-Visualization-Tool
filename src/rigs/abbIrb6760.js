// Rig for the ABB IRB 6760 in src/assets/robot.glb (see abbRobotStudio.js for how these rigs work).
//
// Limits and the balancer linkage come from the kinematics ABB embedded in the file
// (extras.ABB_ro_int_kinematics). The file was exported with axis 5 at 30°, so the rest pose
// reads 30°.
import { abbRobotStudioRig, pose } from './abbRobotStudio.js';

export const ABB_IRB6760_RIG = abbRobotStudioRig({
  limits: [[-170, 170], [-65, 85], [-180, 70], [-300, 300], [-130, 130], [-360, 360]],
  speeds: [35, 60, 90, 120, 160, 220],
  rest: [0, 0, 0, 0, 30, 0],
  balancer: {
    rodPinFromCylinder: [-0.47491, -0.06929, 0],
    cylinderPivotFromRod: [0.479938, 0, 0],
    rodDirection: [-1, 0, 0],
  },
  // extras.ABB_ro_int_mountOffset: 0.2 m along Link6's own Z.
  flange: 0.2,
  poses: [
    pose('home', 'Home', [0, 0, 0, 0, 30, 0]),
    pose('ready', 'Ready', [0, 10, 10, 0, 50, 0]),
    pose('reach_forward', 'Reach Forward', [15, 45, -10, 0, 45, 0]),
    pose('scan_left', 'Scan Left', [35, 20, 5, 0, 60, 0]),
    pose('scan_right', 'Scan Right', [-35, 20, 5, 0, 60, 0]),
  ],
});
