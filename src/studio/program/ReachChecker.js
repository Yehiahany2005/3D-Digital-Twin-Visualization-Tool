import * as THREE from 'three';
import { resolveTool, solveReach } from '../../motion/InverseKinematics.js';
import { reachFor } from './reachFor.js';

const DOWN = new THREE.Vector3(0, -1, 0);
// Time spent solving per frame, so checking a big grid never stalls the view.
const BUDGET_MS = 10;

// Answers "can this robot get its tool tip there?" for the spots a program uses, while editing.
// Each answer is worked out once (a few at a time, between frames) and remembered for that robot
// placement, tool and point: check() says 'ok', 'fail', or 'pending' until it is known.
export class ReachChecker {
  constructor() {
    this.results = new Map();
    this.queue = new Map();
  }

  key(runtime, point, orient) {
    runtime.root.updateMatrixWorld(true);
    const placement = runtime.root.matrixWorld.elements.map((value) => value.toFixed(3)).join(',');
    const tool = JSON.stringify(runtime.asset?.rig?.tools[0] || null);
    return `${runtime.id}|${placement}|${tool}|${point.toArray().map((value) => value.toFixed(3)).join(',')}|${orient}`;
  }

  check(runtime, point, orient = 'down') {
    if (!runtime?.asset?.rig) return 'fail';
    const key = this.key(runtime, point, orient);
    if (this.results.has(key)) return this.results.get(key);
    if (!this.queue.has(key)) this.queue.set(key, { runtime, point: point.clone(), orient });
    return 'pending';
  }

  // The combined answer for several points: fail if any fails, pending while any is unknown.
  checkAll(runtime, points, orient) {
    const states = points.map((point) => this.check(runtime, point, orient));
    if (states.includes('fail')) return 'fail';
    if (states.includes('pending')) return 'pending';
    return 'ok';
  }

  get busy() {
    return this.queue.size > 0;
  }

  // Works through waiting checks for a few milliseconds. Returns true if any answer arrived.
  work() {
    if (!this.queue.size) return false;
    const start = performance.now();
    let answered = false;
    for (const [key, job] of this.queue) {
      this.queue.delete(key);
      this.results.set(key, this.solve(job));
      answered = true;
      if (performance.now() - start > BUDGET_MS) break;
    }
    return answered;
  }

  solve({ runtime, point, orient }) {
    const rig = runtime.asset?.rig;
    const tool = rig?.tools[0] ? resolveTool(rig, rig.tools[0]) : null;
    if (!tool) return 'fail';
    const direction = orient === 'any' ? null : DOWN;
    if (solveReach(rig, tool, point, { orient: direction, quick: true }).reached) return 'ok';
    return reachFor(rig, tool, point, direction).reached ? 'ok' : 'fail';
  }

  // Forget what was asked but not yet answered (e.g. another robot was selected).
  cancel() {
    this.queue.clear();
  }
}
