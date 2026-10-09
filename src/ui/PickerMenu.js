// A header picker: a button showing what is open, and a searchable menu of grouped choices.
// Machine mode uses it for models, Scene mode for scenes.
//
// groups() returns [{ title, items, empty }]; an item is
//   { id, name, type, badge?: { text, title, muted }, remove?: { title, run } }.
// `empty` is shown when a group has nothing in it (without one, the empty group is left out).
export class PickerMenu {
  constructor({ root, groups, onChoose, noun = 'item' }) {
    this.root = root;
    this.groups = groups;
    this.onChoose = onChoose;
    this.noun = noun;
    this.currentId = null;

    this.button = root.querySelector('[data-picker-button]');
    this.currentName = root.querySelector('[data-picker-name]');
    this.currentType = root.querySelector('[data-picker-type]');
    this.menu = root.querySelector('[data-picker-menu]');
    this.search = root.querySelector('[data-picker-search]');
    this.list = root.querySelector('[data-picker-list]');

    this.button.addEventListener('click', () => (this.menu.hidden ? this.open() : this.close()));
    this.search.addEventListener('input', () => this.render());
    this.menu.addEventListener('keydown', (event) => this.handleKey(event));
    document.addEventListener('pointerdown', (event) => {
      if (!this.menu.hidden && !root.contains(event.target)) this.close();
    });
  }

  open() {
    this.menu.hidden = false;
    this.button.setAttribute('aria-expanded', 'true');
    this.search.value = '';
    this.render();
    this.search.focus();
  }

  close({ focusButton = false } = {}) {
    if (this.menu.hidden) return;
    this.menu.hidden = true;
    this.button.setAttribute('aria-expanded', 'false');
    if (focusButton) this.button.focus();
  }

  get isOpen() {
    return !this.menu.hidden;
  }

  // What the button shows. item: { id, name, type } or null while nothing is open yet.
  setCurrent(item) {
    this.currentId = item?.id ?? null;
    this.currentName.textContent = item?.name || 'Loading…';
    this.currentType.textContent = item?.type || '';
    this.button.title = item ? `${item.name}: choose another ${this.noun}` : `Choose a ${this.noun}`;
    if (this.isOpen) this.render();
  }

  setBusy(busy) {
    this.button.disabled = busy;
    this.root.classList.toggle('is-loading', busy);
  }

  render() {
    const query = this.search.value.trim().toLowerCase();
    const matches = (item) => !query || `${item.name} ${item.type || ''}`.toLowerCase().includes(query);
    this.list.replaceChildren();
    let shown = 0;
    this.groups().forEach(({ title, items, empty }) => {
      const visible = items.filter(matches);
      if (!visible.length && (query || !empty)) return;
      const heading = document.createElement('p');
      heading.className = 'picker-group';
      heading.textContent = title;
      this.list.appendChild(heading);
      if (!visible.length) {
        this.list.appendChild(this.note(empty));
        return;
      }
      visible.forEach((item) => this.list.appendChild(this.createItem(item)));
      shown += visible.length;
    });
    if (!shown && query) this.list.appendChild(this.note(`Nothing matches "${this.search.value.trim()}".`));
  }

  note(text) {
    const note = document.createElement('p');
    note.className = 'picker-empty';
    note.textContent = text;
    return note;
  }

  createItem(item) {
    const row = document.createElement('div');
    row.className = 'picker-item';
    const current = item.id === this.currentId;
    row.classList.toggle('is-current', current);

    const choose = document.createElement('button');
    choose.type = 'button';
    choose.className = 'picker-item-choose';
    choose.setAttribute('aria-current', String(current));
    const name = document.createElement('strong');
    name.textContent = item.name;
    const type = document.createElement('small');
    type.textContent = item.type || '';
    const text = document.createElement('span');
    text.className = 'picker-item-text';
    text.append(name, type);
    choose.appendChild(text);
    if (item.badge) {
      const badge = document.createElement('span');
      badge.className = 'picker-item-badge';
      badge.textContent = item.badge.text;
      badge.title = item.badge.title || '';
      badge.classList.toggle('is-unsaved', Boolean(item.badge.muted));
      choose.appendChild(badge);
    }
    choose.addEventListener('click', () => {
      this.close({ focusButton: true });
      if (item.id !== this.currentId) this.onChoose(item);
    });
    row.appendChild(choose);

    if (item.remove) {
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'picker-item-remove';
      remove.textContent = '✕';
      remove.title = item.remove.title;
      remove.setAttribute('aria-label', item.remove.title);
      remove.addEventListener('click', () => item.remove.run());
      row.appendChild(remove);
    }
    return row;
  }

  // Arrow keys move between items, Escape closes.
  handleKey(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      this.close({ focusButton: true });
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const items = [...this.list.querySelectorAll('.picker-item-choose')];
    if (!items.length) return;
    const index = items.indexOf(document.activeElement);
    const next = event.key === 'ArrowDown'
      ? items[(index + 1) % items.length]
      : items[index <= 0 ? items.length - 1 : index - 1];
    next.focus();
  }
}
