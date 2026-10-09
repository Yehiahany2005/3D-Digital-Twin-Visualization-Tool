// Rig for the ABB IRB 6730S-150/4.0 (shelf-mounted), from RobotStudio's IRB6730S_150_400_OC_01.glb.
// See abbRobotStudio.js for how these rigs work. The model file is imported by the user, not
// shipped with the app; AssetRegistry gives an imported file of this name this rig.
//
// Limits, the balancer linkage and the flange come from the kinematics ABB embedded in the file
// (extras.ABB_ro_int_kinematics). It is a shelf robot: axis 2 tips forward up to 160° so the arm
// reaches down in front of the shelf it stands on; raise it with the Height base control (or put
// it on a platform in a scene) to use that range.
//
// Not modelled: ABB also limits axis 3 by axis 2 when the arm leans back (axis 3 may go no
// lower than about −145° at axis 2 = −40°, easing to −180° by axis 2 = −17°).
import { abbRobotStudioRig, pose } from './abbRobotStudio.js';

export const ABB_IRB6730S_RIG = abbRobotStudioRig({
  limits: [[-170, 170], [-40, 160], [-180, 70], [-300, 300], [-130, 130], [-360, 360]],
  speeds: [35, 60, 90, 120, 160, 220],
  // The file was exported with axis 5 at 30°, so the rest pose reads 30°.
  rest: [0, 0, 0, 0, 30, 0],
  // Measured from the LinkD1 / LinkD2 nodes at the exported pose. Unlike the IRB 6760's, this
  // rod's own X axis is about 5° off the cylinder line, so the slide direction is not [-1, 0, 0].
  balancer: {
    rodPinFromCylinder: [-0.63939, 0.16666, 0],
    cylinderPivotFromRod: [0.657832, 0.062062, 0],
    rodDirection: [-0.995579, -0.093926, 0],
  },
  // extras.ABB_ro_int_mountOffset: 0.18 m along Link6's own Z.
  flange: 0.18,
  poses: [
    pose('home', 'Home', [0, 0, 0, 0, 30, 0]),
    pose('ready', 'Ready', [0, 20, 0, 0, 50, 0]),
    pose('reach_forward', 'Reach Forward', [15, 60, -20, 0, 50, 0]),
    pose('reach_down', 'Reach Down', [0, 100, -30, 0, 20, 0]),
    pose('scan_left', 'Scan Left', [35, 30, 0, 0, 60, 0]),
    pose('scan_right', 'Scan Right', [-35, 30, 0, 0, 60, 0]),
  ],
});
