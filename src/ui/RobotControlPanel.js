const ACTIONS = {
  Home: 'Home',
  ReachForward: 'ReachForward',
  InspectionScan: 'InspectionScan',
  Calibration: 'Calibration',
};

export class RobotControlPanel {
  constructor(controller, panelElement) {
    this.controller = controller;
    this.panelElement = panelElement;
    this.statusElement = panelElement.querySelector('[data-robot-status]');
    this.statusValueElement = document.querySelector('[data-status-value]');
    this.taskValueElement = document.querySelector('[data-task-value]');
    this.buttons = [...panelElement.querySelectorAll('[data-robot-action]')];
    this.isBusy = false;

    this.buttons.forEach((button) => {
      button.addEventListener('click', () => this.handleAction(button.dataset.robotAction));
    });
  }

  async handleAction(action) {
    if (this.isBusy || this.controller.isMoving) return;

    this.isBusy = true;
    this.setButtonsDisabled(true);
    const task = action === ACTIONS.Home ? 'Returning Home...' : `Executing ${action}...`;
    this.setStatus(task);
    this.setTask(task);

    try {
      switch (action) {
        case ACTIONS.Home:
          await this.controller.home();
          break;
        case ACTIONS.ReachForward:
          await this.controller.reachForward();
          break;
        case ACTIONS.InspectionScan:
          await this.controller.inspectionScan();
          break;
        case ACTIONS.Calibration:
          await this.controller.calibration();
          break;
        default:
          throw new Error(`Unknown robot action: ${action}`);
      }
    } catch (error) {
      console.error(`Robot action failed: ${action}`, error);
      this.setStatus('Action unavailable');
    } finally {
      this.isBusy = false;
      this.setButtonsDisabled(false);
      if (this.statusElement.textContent !== 'Action unavailable') {
        this.setStatus('Idle');
        this.setTask('None');
      }
    }
  }

  setButtonsDisabled(disabled) {
    this.buttons.forEach((button) => {
      button.disabled = disabled;
    });
  }

  setStatus(status) {
    this.statusElement.textContent = status;
    if (this.statusValueElement) this.statusValueElement.textContent = status;
  }

  setTask(task) {
    if (this.taskValueElement) this.taskValueElement.textContent = task;
  }

  destroy() {
    this.buttons.forEach((button) => {
      button.replaceWith(button.cloneNode(true));
    });
  }
}
