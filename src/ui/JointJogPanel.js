const AXES = [
  { axis: 1, linkName: 'Link1' },
  { axis: 2, linkName: 'Link2' },
  { axis: 3, linkName: 'Link3' },
  { axis: 4, linkName: 'Link4' },
  { axis: 5, linkName: 'Link5' },
  { axis: 6, linkName: 'Link6' },
];
const JOG_INCREMENT = 5;

export class JointJogPanel {
  constructor(controller, panelElement) {
    this.controller = controller;
    this.panelElement = panelElement;
    this.angleElements = new Map();
    this.summaryElements = new Map();
    this.buttons = [...panelElement.querySelectorAll('[data-jog-link]')];
    this.isBusy = false;

    AXES.forEach(({ axis, linkName }) => {
      this.angleElements.set(axis, panelElement.querySelector(`[data-jog-angle="${axis}"]`));
      this.summaryElements.set(axis, panelElement.querySelector(`[data-jog-summary="${axis}"]`));
      panelElement.querySelectorAll(`[data-jog-link="${linkName}"]`).forEach((button) => {
        button.addEventListener('click', () => this.jog(linkName, Number(button.dataset.jogDelta)));
      });
    });
  }

  async jog(linkName, delta) {
    if (this.isBusy || this.controller.isMoving) return;

    this.isBusy = true;
    this.setButtonsDisabled(true);
    try {
      await this.controller.moveJointRelative(linkName, delta * JOG_INCREMENT);
    } catch (error) {
      console.warn(`Jog blocked for ${linkName}:`, error.message);
    } finally {
      this.isBusy = false;
      this.setButtonsDisabled(this.controller.isMoving);
      this.updateAngles();
    }
  }

  update() {
    this.updateAngles();
    this.setButtonsDisabled(this.isBusy || this.controller.isMoving);
  }

  updateAngles() {
    this.controller.getJointAngles().forEach(({ linkName, angle }) => {
      const axis = Number(linkName.replace('Link', ''));
      const element = this.angleElements.get(axis);
      if (angle === null) return;
      const formattedAngle = `${angle >= 0 ? '+' : ''}${angle.toFixed(1)}°`;
      if (element) element.textContent = formattedAngle;
      const summaryElement = this.summaryElements.get(axis);
      if (summaryElement) summaryElement.textContent = formattedAngle;
    });
  }

  setButtonsDisabled(disabled) {
    this.buttons.forEach((button) => {
      button.disabled = disabled;
    });
  }

  destroy() {
    this.buttons.forEach((button) => {
      button.replaceWith(button.cloneNode(true));
    });
  }
}
