// Buttons for a rig's saved poses ("go to") and sequences ("play"), plus a stop button.

export class CommandsPanel {
  constructor({ card, list, statusElement, stopButton }) {
    this.card = card;
    this.list = list;
    this.statusElement = statusElement;
    this.stopButton = stopButton;
    this.rig = null;
    this.player = null;
    this.stopButton.addEventListener('click', () => this.player?.stop());
  }

  setRig(rig, player) {
    this.unsubscribeRig?.();
    this.unsubscribePlayer?.();
    this.rig = rig;
    this.player = player;
    this.unsubscribeRig = rig?.onChange(() => this.render());
    this.unsubscribePlayer = player?.onChange((status) => this.showStatus(status));
    this.render();
    this.showStatus(player?.status || 'Idle');
  }

  render() {
    this.list.replaceChildren();
    const poses = this.rig?.poses || [];
    const sequences = this.rig?.sequences || [];
    this.card.hidden = !poses.length && !sequences.length;

    if (sequences.length) this.list.appendChild(this.createGroup('Sequences', sequences, (sequence) => ({
      text: `▶ ${sequence.name}`,
      run: () => this.player.playSequence(sequence),
    })));
    if (poses.length) this.list.appendChild(this.createGroup('Go to pose', poses, (pose) => ({
      text: pose.name,
      run: () => this.player.moveTo(pose.values, { label: `Moving to ${pose.name}` }),
    })));
  }

  createGroup(title, items, describe) {
    const group = document.createElement('div');
    group.className = 'command-group';
    const heading = document.createElement('p');
    heading.className = 'command-group-title';
    heading.textContent = title;
    const buttons = document.createElement('div');
    buttons.className = 'control-actions';
    items.forEach((item) => {
      const { text, run } = describe(item);
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = text;
      button.addEventListener('click', run);
      buttons.appendChild(button);
    });
    group.append(heading, buttons);
    return group;
  }

  showStatus(status) {
    this.statusElement.textContent = status;
    this.stopButton.disabled = status === 'Idle';
  }
}
