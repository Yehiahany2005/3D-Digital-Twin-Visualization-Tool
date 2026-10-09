// Short messages over the 3D view: loading progress, notes that fade on their own, and errors.
export class StatusMessage {
  constructor(element) {
    this.element = element;
    this.busy = 0;
    this.timer = null;
  }

  // While something loads, progress messages stay until replaced instead of fading.
  setBusy(busy) {
    this.busy = Math.max(0, this.busy + (busy ? 1 : -1));
    // A note shown while loading fades once loading is over.
    if (!this.busy && !this.element.hidden && !this.element.classList.contains('is-error')) this.show(this.element.textContent);
  }

  show(message) {
    // Loading clears its progress note when it ends; that must not wipe an error shown meanwhile.
    if (!message && this.element.classList.contains('is-error')) return;
    clearTimeout(this.timer);
    this.element.classList.remove('is-error');
    this.element.hidden = !message;
    this.element.textContent = message || '';
    if (message && !this.busy) this.timer = setTimeout(() => this.show(null), 4000);
  }

  error(message) {
    clearTimeout(this.timer);
    this.element.hidden = false;
    this.element.textContent = message;
    this.element.classList.add('is-error');
    this.timer = setTimeout(() => {
      this.element.classList.remove('is-error');
      this.show(null);
    }, 9000);
  }
}
