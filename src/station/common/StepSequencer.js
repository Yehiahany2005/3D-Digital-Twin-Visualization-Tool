/**
 * Timed step queue for station process animations.
 *
 * A step is { state, label, duration, status?, onStart?, onUpdate?(progress, previous), onEnd? }.
 * `advance(time)` consumes scaled time across as many steps as it covers, so a
 * 10× speed frame completes several steps without skipping their callbacks.
 * When the queue runs dry, `plan()` is asked to queue the next phase.
 */
export class StepSequencer {
  constructor({ plan, onStepStart } = {}) {
    this.plan = plan;
    this.onStepStart = onStepStart;
    this.steps = [];
    this.active = null;
  }

  clear() {
    this.steps = [];
    this.active = null;
  }

  queue(state, label, duration, status = {}, callbacks = {}) {
    this.steps.push({ state, label, duration, status, elapsed: 0, ...callbacks });
  }

  advance(time) {
    let remaining = time;
    for (let guard = 0; remaining > 1e-9 && guard < 128; guard += 1) {
      if (!this.active && !this.begin()) return;
      const step = this.active;
      const previous = step.duration > 0 ? step.elapsed / step.duration : 0;
      const used = Math.min(remaining, step.duration - step.elapsed);
      step.elapsed += used;
      remaining -= used;
      const progress = step.duration > 0 ? step.elapsed / step.duration : 1;
      step.onUpdate?.(progress, previous, step);
      if (step.elapsed >= step.duration - 1e-9) {
        step.onEnd?.();
        this.active = null;
      }
    }
  }

  begin() {
    if (!this.steps.length) this.plan?.();
    if (!this.steps.length) return false;
    this.active = this.steps.shift();
    this.active.elapsed = 0;
    this.onStepStart?.(this.active);
    this.active.onStart?.();
    return true;
  }
}
