import { parentOf } from '../SceneDocument.js';
import { icon } from './icons.js';

// The scene tree (like Roblox Studio's Explorer): every item, with mounted and attached items
// nested under what they hang off. Click selects, double-click frames it in the view; the eye
// hides an item and the lock keeps it from being moved by accident.
export class ExplorerPanel {
  constructor({ list, count, editor, onFrame, iconFor }) {
    this.list = list;
    this.count = count;
    this.editor = editor;
    this.onFrame = onFrame;
    this.iconFor = iconFor;
    editor.onChange((type) => {
      if (type === 'document' || type === 'item-ready') this.render();
      else if (type === 'selection') this.updateSelection();
    });
  }

  render() {
    const { items } = this.editor;
    this.count.textContent = items.length ? String(items.length) : '';
    if (!items.length) {
      const empty = document.createElement('li');
      empty.className = 'empty-state';
      empty.textContent = 'The scene is empty. Use "Add" above the 3D view to place models and parts.';
      this.list.replaceChildren(empty);
      return;
    }
    const ids = new Set(items.map((item) => item.id));
    const children = new Map();
    items.forEach((item) => {
      const parent = ids.has(parentOf(item)) ? parentOf(item) : null;
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent).push(item);
    });
    const build = (parent, depth) => (children.get(parent) || []).flatMap((item) => [this.row(item, depth), ...build(item.id, depth + 1)]);
    this.list.replaceChildren(...build(null, 0));
    this.updateSelection();
  }

  row(item, depth) {
    const runtime = this.editor.runtimes.get(item.id);
    const row = document.createElement('li');
    row.className = 'explorer-row';
    row.dataset.itemId = item.id;
    row.setAttribute('role', 'treeitem');
    row.style.setProperty('--depth', String(Math.min(depth, 8)));
    row.classList.toggle('is-hidden', Boolean(item.hidden));
    row.classList.toggle('is-missing', runtime?.kind === 'missing');

    const name = document.createElement('button');
    name.type = 'button';
    name.className = 'explorer-name';
    name.append(icon(runtime?.kind === 'missing' ? 'AlertTriangle' : this.iconFor(item, runtime)));
    const label = document.createElement('span');
    label.textContent = item.name;
    name.append(label);
    if (runtime?.kind === 'loading') {
      const loading = document.createElement('small');
      loading.textContent = 'loading…';
      name.append(loading);
    }
    if (item.mount || item.attach) {
      name.title = `${item.name}: ${item.mount ? 'mounted on' : 'follows'} ${this.editor.item(parentOf(item))?.name || 'another item'}`;
    } else {
      name.title = item.name;
    }
    name.addEventListener('click', () => this.editor.select(item.id));
    name.addEventListener('dblclick', () => this.onFrame?.(item.id));

    const toggles = document.createElement('span');
    toggles.className = 'explorer-toggles';
    toggles.append(
      this.toggle(item.hidden ? 'EyeOff' : 'Eye', item.hidden ? `Show ${item.name}` : `Hide ${item.name}`, item.hidden, () => {
        this.editor.updateItem(item.id, { hidden: item.hidden ? undefined : true }, item.hidden ? `Show ${item.name}` : `Hide ${item.name}`);
      }),
      this.toggle(item.locked ? 'Lock' : 'LockOpen', item.locked ? `Unlock ${item.name}` : `Lock ${item.name} so it can't be moved`, item.locked, () => {
        this.editor.updateItem(item.id, { locked: item.locked ? undefined : true }, item.locked ? `Unlock ${item.name}` : `Lock ${item.name}`);
      }),
    );
    row.append(name, toggles);
    return row;
  }

  toggle(iconName, label, on, run) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'explorer-toggle';
    button.classList.toggle('is-on', Boolean(on));
    button.title = label;
    button.setAttribute('aria-label', label);
    button.append(icon(iconName, 13));
    button.addEventListener('click', run);
    return button;
  }

  updateSelection() {
    this.list.querySelectorAll('.explorer-row').forEach((row) => {
      const selected = row.dataset.itemId === this.editor.selectedId;
      row.classList.toggle('is-selected', selected);
      row.setAttribute('aria-selected', String(selected));
      if (selected) row.scrollIntoView({ block: 'nearest' });
    });
  }
}
