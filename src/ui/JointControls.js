// Slider + jog-button rows for a set of rig joints.

function signed(value, digits) {
  const text = value.toFixed(digits);
  // Rounding leftovers like -0.00001 would otherwise display as "-0.0".
  return Number(text) === 0 ? `+${Math.abs(0).toFixed(digits)}` : `${value > 0 ? '+' : ''}${text}`;
}

export function formatJointValue(joint, value = joint.value) {
  if (joint.type === 'revolute') return `${signed(value, 1)}°`;
  if (Math.abs(value) >= 1000) return `${signed(value / 1000, 3)} m`;
  return `${signed(value, 1)} mm`;
}

// A round 1 / 2 / 5 × 10ⁿ number close to value.
export function niceNumber(value) {
  if (!(value > 0)) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  const leading = value / power;
  return (leading < 1.5 ? 1 : leading < 3.5 ? 2 : leading < 7.5 ? 5 : 10) * power;
}

// Slides jog by about a twentieth of their travel, so a small gripper and a long gantry
// both move a useful amount per click. Base motion keeps a fixed 10 mm.
function jogStep(joint) {
  if (joint.type === 'revolute') return 5;
  if (joint.kind === 'base') return 10;
  return niceNumber((joint.max - joint.min) / 20);
}

function sliderStep(joint) {
  if (joint.type === 'revolute') return 0.1;
  return joint.kind !== 'base' && joint.max - joint.min < 100 ? 0.1 : 1;
}

export class JointControls {
  constructor({ container, filter, emptyMessage, emptyAction }) {
    this.container = container;
    this.filter = filter;
    this.emptyMessage = emptyMessage;
    this.emptyAction = emptyAction;
    this.rows = [];
    this.rig = null;
    this.player = null;
  }

  setRig(rig, player) {
    this.unsubscribe?.();
    this.rig = rig;
    this.player = player;
    this.unsubscribe = rig?.onChange(() => this.render());
    this.render();
  }

  render() {
    this.container.replaceChildren();
    this.rows = [];
    const joints = this.rig ? this.rig.allJoints.filter(this.filter) : [];

    if (!joints.length) {
      const empty = document.createElement('p');
      empty.className = 'empty-state';
      empty.textContent = this.emptyMessage;
      this.container.appendChild(empty);
      if (this.emptyAction) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'secondary-button';
        button.textContent = this.emptyAction.label;
        button.addEventListener('click', this.emptyAction.onClick);
        this.container.appendChild(button);
      }
      return;
    }

    joints.forEach((joint) => this.container.appendChild(this.createRow(joint)));
    this.update(true);
  }

  createRow(joint) {
    const row = document.createElement('div');
    row.className = 'joint-row';

    const head = document.createElement('div');
    head.className = 'joint-row-head';
    const name = document.createElement('span');
    name.textContent = joint.name;
    const value = document.createElement('strong');
    head.append(name, value);
    row.appendChild(head);

    const entry = { joint, value, slider: null, lastValue: null, dragging: false };

    if (joint.driven) {
      // Followers have no slider: say which joint to move instead.
      const leader = this.rig.jointsById.get((joint.definition.aim || joint.definition.stretch).joint);
      const note = document.createElement('small');
      note.className = 'joint-follow-note';
      note.textContent = leader
        ? `Moves by itself when you move "${leader.name}".`
        : 'Moves by itself when the joint it follows moves.';
      row.appendChild(note);
    } else {
      const controls = document.createElement('div');
      controls.className = 'joint-row-controls';
      const step = jogStep(joint);
      const minus = this.createJogButton('−', `Decrease ${joint.name}`, () => this.jog(joint, -step));
      const plus = this.createJogButton('+', `Increase ${joint.name}`, () => this.jog(joint, step));

      const slider = document.createElement('input');
      slider.type = 'range';
      slider.min = String(joint.min);
      slider.max = String(joint.max);
      slider.step = String(sliderStep(joint));
      slider.setAttribute('aria-label', joint.name);
      slider.title = `${formatJointValue(joint, joint.min)} to ${formatJointValue(joint, joint.max)}`;
      slider.addEventListener('pointerdown', () => { entry.dragging = true; });
      slider.addEventListener('pointerup', () => { entry.dragging = false; });
      slider.addEventListener('blur', () => { entry.dragging = false; });
      slider.addEventListener('input', () => {
        this.player?.stop();
        this.rig.setValue(joint.id, Number(slider.value));
      });

      controls.append(minus, slider, plus);
      row.appendChild(controls);
      entry.slider = slider;
    }

    this.rows.push(entry);
    return row;
  }

  createJogButton(text, label, onClick) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = text;
    button.setAttribute('aria-label', label);
    button.addEventListener('click', onClick);
    return button;
  }

  jog(joint, delta) {
    if (!this.player) return;
    this.player.moveTo({ [joint.id]: joint.value + delta }, { label: `Jogging ${joint.name}` });
  }

  update(force = false) {
    this.rows.forEach((entry) => {
      const current = entry.joint.value;
      if (!force && entry.lastValue !== null && Math.abs(current - entry.lastValue) < 1e-4) return;
      entry.lastValue = current;
      entry.value.textContent = formatJointValue(entry.joint);
      if (entry.slider && !entry.dragging) entry.slider.value = String(current);
    });
  }

  destroy() {
    this.unsubscribe?.();
    this.container.replaceChildren();
    this.rows = [];
  }
}
