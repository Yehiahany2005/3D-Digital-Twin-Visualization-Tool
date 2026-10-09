import * as THREE from 'three';
import { solveReach } from '../../motion/InverseKinematics.js';

// Close enough to pick up or put down a box.
const HANDLING_TOLERANCE = 0.012;
const HANDLING_TILT_DEG = 1;
// Nearby points to come at a target from, a few centimetres away.
const NUDGES = [[0.05, 0, 0], [-0.05, 0, 0], [0, 0, 0.05], [0, 0, -0.05], [0, 0.05, 0]].map((offset) => new THREE.Vector3(...offset));

// Inverse kinematics for robot programs: solveReach, made dependable for handling boxes.
//
// With the tool pointing straight down, an arm's wrist can line up with its forearm (a wrist
// singularity) right over some spots, and the solver then stalls a few millimetres short. A miss
// within about a centimetre is accepted (a box doesn't mind); a slightly bigger one is retried
// starting from the answer for a point a few centimetres away, which comes at it from a better angle.
export function reachFor(rig, tool, point, orient) {
  const first = solveReach(rig, tool, point, { orient });
  if (first.reached || first.error > HANDLING_TOLERANCE * 2) return first;
  const closeEnough = (result) => result.error <= HANDLING_TOLERANCE && (!orient || result.tilt <= HANDLING_TILT_DEG);
  if (closeEnough(first)) return { ...first, reached: true };
  const saved = rig.getPose();
  try {
    for (const nudge of NUDGES) {
      const near = solveReach(rig, tool, point.clone().add(nudge), { orient, quick: true });
      if (!near.reached) continue;
      rig.setValues(near.values);
      const again = solveReach(rig, tool, point, { orient, quick: true });
      if (again.reached) return again;
    }
  } finally {
    rig.setValues(saved);
  }
  return first;
}
