import { parentOf } from '../SceneDocument.js';
import { icon } from './icons.js';

// Above this many objects, a search box helps find one.
const FILTER_FROM = 7;

// The scene's objects (like Roblox Studio's Explorer), with mounted and attached ones nested
// under what they hang off. Click selects, double-click frames it in the view, right-click opens
// its menu, and hovering a row lights the object up in the view. The eye and padlock show on
// hover, or stay visible while an object is hidden or locked. Robots with a program get a badge.
export class ExplorerPanel {
  constructor({ list, count, filter, editor, onFrame, iconFor, onContextMenu, onHover }) {
    this.list = list;
    this.count = count;
    this.filter = filter;
    this.editor = editor;
    this.onFrame = onFrame;
    this.iconFor = iconFor;
    this.onContextMenu = onContextMenu;
    this.onHover = onHover;
    editor.onChange((type) => {
      if (type === 'document' || type === 'item-ready') this.render();
      else if (type === 'selection') this.updateSelection();
    });
    filter?.addEventListener('input', () => this.render());
    filter?.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && filter.value) {
        event.stopPropagation();
        filter.value = '';
        this.render();
      }
    });
    list.addEventListener('pointerleave', () => this.onHover?.(null));
  }

  render() {
    const { items } = this.editor;
    this.count.textContent = items.length ? String(items.length) : '';
    if (this.filter) {
      this.filter.hidden = items.length < FILTER_FROM;
      if (this.filter.hidden) this.filter.value = '';
    }
    const query = this.filter?.value.trim().toLowerCase();
    if (query) {
      const matches = items.filter((item) => item.name.toLowerCase().includes(query));
      this.list.replaceChildren(...(matches.length ? matches.map((item) => this.row(item, 0)) : [Object.assign(document.createElement('li'), { className: 'empty-state', textContent: `No object called "${this.filter.value.trim()}".` })]));
      this.updateSelection();
      return;
    }
    if (!items.length) {
      const empty = document.createElement('li');
      empty.className = 'empty-state';
      empty.textContent = 'Nothing here yet. Objects you add are listed here.';
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
    const steps = item.program?.steps?.length;
    if (steps) {
      const badge = document.createElement('span');
      badge.className = 'explorer-badge';
      badge.title = 'Has a program: it works when the scene plays';
      badge.append(icon('ListVideo', 12));
      name.append(badge);
    }
    if (item.mount || item.attach) {
      name.title = `${item.name}: ${item.mount ? 'mounted on' : 'follows'} ${this.editor.item(parentOf(item))?.name || 'another item'}`;
    } else {
      name.title = item.name;
    }
    name.addEventListener('click', () => this.editor.select(item.id));
    name.addEventListener('dblclick', () => this.onFrame?.(item.id));
    row.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      this.editor.select(item.id);
      this.onContextMenu?.(item.id, event);
    });
    row.addEventListener('pointerenter', () => this.onHover?.(item.id));

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
