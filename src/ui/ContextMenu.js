import { icon } from '../studio/ui/icons.js';

// A right-click menu. open({ x, y, title, items }) shows it at a screen point (kept on screen);
// an item is { label, icon, shortcut, run, disabled, danger } or 'separator'. Arrow keys move,
// Enter picks, Escape or a click elsewhere closes it.
export class ContextMenu {
  constructor() {
    this.element = document.createElement('div');
    this.element.className = 'context-menu';
    this.element.setAttribute('role', 'menu');
    this.element.hidden = true;
    document.body.append(this.element);
    document.addEventListener('pointerdown', (event) => {
      if (!this.element.hidden && !this.element.contains(event.target)) this.close();
    }, true);
    this.element.addEventListener('keydown', (event) => this.handleKey(event));
    window.addEventListener('resize', () => this.close());
    window.addEventListener('wheel', () => this.close(), { passive: true });
    window.addEventListener('blur', () => this.close());
  }

  get isOpen() {
    return !this.element.hidden;
  }

  open({ x, y, title, items }) {
    const nodes = [];
    if (title) {
      const heading = document.createElement('p');
      heading.className = 'context-menu-title';
      heading.textContent = title;
      nodes.push(heading);
    }
    items.forEach((item) => {
      if (item === 'separator') {
        nodes.push(Object.assign(document.createElement('hr'), { className: 'context-menu-separator' }));
        return;
      }
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `context-menu-item${item.danger ? ' is-danger' : ''}`;
      button.setAttribute('role', 'menuitem');
      button.disabled = Boolean(item.disabled);
      if (item.icon) button.append(icon(item.icon, 14));
      button.append(Object.assign(document.createElement('span'), { textContent: item.label }));
      if (item.shortcut) button.append(Object.assign(document.createElement('kbd'), { textContent: item.shortcut }));
      button.addEventListener('click', () => {
        this.close();
        item.run();
      });
      nodes.push(button);
    });
    this.element.replaceChildren(...nodes);
    this.element.hidden = false;
    // Keep it on screen.
    const { width, height } = this.element.getBoundingClientRect();
    this.element.style.left = `${Math.max(4, Math.min(x, window.innerWidth - width - 4))}px`;
    this.element.style.top = `${Math.max(4, Math.min(y, window.innerHeight - height - 4))}px`;
    this.element.querySelector('.context-menu-item:not(:disabled)')?.focus({ preventScroll: true });
  }

  close() {
    if (this.element.hidden) return;
    this.element.hidden = true;
  }

  handleKey(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      this.close();
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const items = [...this.element.querySelectorAll('.context-menu-item:not(:disabled)')];
    const index = items.indexOf(document.activeElement);
    const next = event.key === 'ArrowDown' ? items[(index + 1) % items.length] : items[(index - 1 + items.length) % items.length];
    next?.focus();
  }
}
