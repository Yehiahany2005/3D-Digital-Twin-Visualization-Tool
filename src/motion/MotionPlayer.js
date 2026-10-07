import * as THREE from 'three';

const MIN_MOVE_DURATION = 0.35;
const MAX_MOVE_DURATION = 60;

// Trapezoidal velocity profile: accelerate for 20% of the move, cruise, decelerate for the last 20%.
export function trapezoidProgress(progress) {
  const acceleration = 0.2;
  const cruise = 0.6;
  const peakVelocity = 1 / (acceleration + cruise);

  if (progress <= acceleration) return 0.5 * (peakVelocity / acceleration) * progress ** 2;
  if (progress <= acceleration + cruise) return 0.125 + peakVelocity * (progress - acceleration);

  const decelerationProgress = progress - acceleration - cruise;
  return 0.875 + peakVelocity * decelerationProgress
    - 0.5 * (peakVelocity / acceleration) * decelerationProgress ** 2;
}

// Works out which joints change and how long the move takes when every joint
// respects its own speed limit and all of them arrive together.
export function planMove(rig, from, targetValues, duration) {
  const tracks = [];
  Object.entries(targetValues || {}).forEach(([id, target]) => {
    const joint = rig.jointsById.get(id);
    if (!joint || joint.driven || !Number.isFinite(target)) return;
    const start = from[id] ?? joint.value;
    const end = rig.clamp(joint, target);
    if (Math.abs(end - start) > 1e-6) tracks.push({ id, start, end, minimumTime: Math.abs(end - start) / joint.speed });
  });
  const naturalDuration = Math.max(MIN_MOVE_DURATION, ...tracks.map((track) => track.minimumTime));
  const finalDuration = Number.isFinite(duration) && duration > 0 ? duration : Math.min(naturalDuration, MAX_MOVE_DURATION);
  return { tracks, duration: tracks.length ? finalDuration : 0 };
}

export function sampleMove(plan, elapsed) {
  const progress = plan.duration > 0 ? trapezoidProgress(Math.min(elapsed / plan.duration, 1)) : 1;
  const values = {};
  plan.tracks.forEach((track) => {
    values[track.id] = THREE.MathUtils.lerp(track.start, track.end, progress);
  });
  return values;
}

// A move step either names a saved pose ({ pose: id }) or carries its own values.
export function stepValues(rig, step) {
  if (step.pose !== undefined) return rig.poses.find((pose) => pose.id === step.pose)?.values || {};
  return step.values || {};
}

export function stepLabel(rig, step) {
  if (step.type === 'wait') return 'waiting';
  if (step.label) return step.label;
  return rig.poses.find((pose) => pose.id === step.pose)?.name || 'moving';
}

// The timeline a sequence follows from `startPose`, without moving the rig:
// one segment per step, each with its start time, plan and the full pose it starts from.
export function planSequence(rig, sequence, startPose) {
  let pose = { ...startPose };
  let time = 0;
  const segments = (sequence.steps || []).map((step) => {
    const plan = step.type === 'wait'
      ? { tracks: [], duration: Math.max(0, step.duration || 0) }
      : planMove(rig, pose, stepValues(rig, step), step.duration);
    const segment = { step, start: time, plan, from: pose };
    pose = { ...pose, ...sampleMove(plan, plan.duration) };
    time += plan.duration;
    return segment;
  });
  return { segments, duration: time, endPose: pose };
}

export class MotionPlayer {
  constructor(rig) {
    this.rig = rig;
    this.active = null;
    this.runId = 0;
    this.status = 'Idle';
    this.listeners = new Set();
  }

  get isPlaying() {
    return this.status !== 'Idle';
  }

  onChange(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setStatus(status) {
    this.status = status;
    this.listeners.forEach((listener) => listener(status));
  }

  // A single timed step. Resolves true when finished, false when interrupted.
  runStep(step) {
    return new Promise((resolve) => {
      const plan = step.type === 'wait'
        ? { tracks: [], duration: Math.max(0, step.duration || 0) }
        : planMove(this.rig, this.rig.getPose(), stepValues(this.rig, step), step.duration);
      this.lastStepDuration = plan.duration;
      this.active = { plan, elapsed: 0, resolve };
      if (plan.duration === 0) this.finishActive(true);
    });
  }

  finishActive(completed) {
    const active = this.active;
    if (!active) return;
    this.active = null;
    if (completed && active.plan.tracks.length) this.rig.setValues(sampleMove(active.plan, active.plan.duration));
    active.resolve(completed);
  }

  async moveTo(values, { duration, label = 'Moving' } = {}) {
    this.stop();
    const runId = ++this.runId;
    this.setStatus(label);
    const completed = await this.runStep({ type: 'move', values, duration });
    if (runId === this.runId) this.setStatus('Idle');
    return completed;
  }

  async playSequence(sequence, { loop = sequence.loop } = {}) {
    this.stop();
    const runId = ++this.runId;
    let loopTime;
    do {
      loopTime = 0;
      for (const step of sequence.steps || []) {
        if (runId !== this.runId) return false;
        this.setStatus(`${sequence.name}: ${stepLabel(this.rig, step)}`);
        const completed = await this.runStep(step);
        if (!completed) return false;
        loopTime += this.lastStepDuration;
      }
      // A loop whose steps take no time would spin forever without rendering a frame.
    } while (loop && loopTime > 0 && runId === this.runId);
    if (runId === this.runId) this.setStatus('Idle');
    return true;
  }

  stop() {
    this.runId += 1;
    this.finishActive(false);
    if (this.status !== 'Idle') this.setStatus('Idle');
  }

  update(deltaTime) {
    const active = this.active;
    if (!active) return;
    active.elapsed = Math.min(active.elapsed + deltaTime, active.plan.duration);
    if (active.plan.tracks.length) this.rig.setValues(sampleMove(active.plan, active.elapsed));
    if (active.elapsed >= active.plan.duration) this.finishActive(true);
  }
}
