import { ASSET_REGISTRY, getAssetConfig, registerImportedAsset, unregisterAsset } from '../assets/AssetRegistry.js';
import { removeStoredImport, storeImport } from '../assets/ImportStore.js';
import { forgetSavedRig } from '../motion/RigStore.js';
import { IMPORT_ACCEPT, fileExtension, unsupportedFormatMessage } from '../loaders/ModelLoader.js';

const NO_ANIMATIONS_MESSAGE = 'No embedded animations detected.';
const STATION = { id: 'station', name: 'Station 3', type: 'Robot cell: conveyor, robot and wrapping machine' };
// Procedural stations are opened through onProceduralStationSelect(id).
const PROCEDURAL_STATIONS = [
  { id: 'oil-station', name: 'Station 1 · Oil Filling & Capping', type: 'Procedural lubricant filling and capping line' },
  { id: 'packing-station', name: 'Station 2 · Jerry Can Case Packing', type: 'Gantry robot packs 4 jerry cans per case' },
];
const FACTORY = { id: 'factory', name: 'Factory · Lubricant Line', type: 'Station 1 → 2 → 3 as one continuous production line' };
const SCENES = [FACTORY, ...PROCEDURAL_STATIONS, STATION];

// The asset picker in the header: a button showing the current asset that opens a searchable
// menu grouped into scenes, built-in models and models imported on this device. It also fills
// the Asset Information and Asset Animations cards for the loaded asset.
export class AssetSelectionPanel {
  constructor({ assetManager, nameElement, typeElement, animationCountElement, animationCard, animationSelect, playButton, pauseButton, restartButton, messageElement, onStationSelect, onProceduralStationSelect, onFactorySelect, onAssetSelect, defaultAssetId }) {
    this.assetManager = assetManager;
    this.nameElement = nameElement;
    this.typeElement = typeElement;
    this.animationCountElement = animationCountElement;
    this.animationCard = animationCard;
    this.animationSelect = animationSelect;
    this.playButton = playButton;
    this.pauseButton = pauseButton;
    this.restartButton = restartButton;
    this.messageElement = messageElement;
    this.onStationSelect = onStationSelect;
    this.onProceduralStationSelect = onProceduralStationSelect;
    this.onFactorySelect = onFactorySelect;
    this.onAssetSelect = onAssetSelect;
    this.defaultAssetId = defaultAssetId;
    this.currentId = null;
    this.loading = false;

    this.root = document.querySelector('[data-asset-switcher]');
    this.button = this.root.querySelector('[data-asset-switcher-button]');
    this.currentName = this.root.querySelector('[data-asset-current-name]');
    this.currentType = this.root.querySelector('[data-asset-current-type]');
    this.menu = this.root.querySelector('[data-asset-menu]');
    this.search = this.root.querySelector('[data-asset-search]');
    this.list = this.root.querySelector('[data-asset-list]');
    this.importInput = this.root.querySelector('[data-asset-import]');
    this.importButton = this.root.querySelector('[data-asset-import-button]');
    this.statusElement = document.querySelector('[data-asset-status]');
    this.importInput.accept = IMPORT_ACCEPT;

    this.button.addEventListener('click', () => (this.menu.hidden ? this.open() : this.close()));
    this.search.addEventListener('input', () => this.renderList());
    this.menu.addEventListener('keydown', (event) => this.handleKey(event));
    document.addEventListener('pointerdown', (event) => {
      if (!this.menu.hidden && !this.root.contains(event.target)) this.close();
    });
    this.importButton.addEventListener('click', () => this.importInput.click());
    this.importInput.addEventListener('change', () => {
      const [file] = this.importInput.files;
      this.importInput.value = '';
      this.close();
      if (file) this.importFile(file);
    });

    this.animationSelect.addEventListener('change', () => this.assetManager.currentAsset?.animationController.select(this.animationSelect.value));
    this.playButton.addEventListener('click', () => this.assetManager.currentAsset?.animationController.play(this.animationSelect.value));
    this.pauseButton.addEventListener('click', () => this.assetManager.currentAsset?.animationController.pause());
    this.restartButton.addEventListener('click', () => this.assetManager.currentAsset?.animationController.restart(this.animationSelect.value));
    this.showCurrent();
  }

  // ---- Menu -------------------------------------------------------------------------

  open() {
    this.menu.hidden = false;
    this.button.setAttribute('aria-expanded', 'true');
    this.search.value = '';
    this.renderList();
    this.search.focus();
  }

  close({ focusButton = false } = {}) {
    if (this.menu.hidden) return;
    this.menu.hidden = true;
    this.button.setAttribute('aria-expanded', 'false');
    if (focusButton) this.button.focus();
  }

  groups() {
    return [
      { title: 'Scenes', items: SCENES },
      { title: 'Built-in models', items: ASSET_REGISTRY.filter((asset) => !asset.imported) },
      {
        title: 'Imported on this device',
        items: ASSET_REGISTRY.filter((asset) => asset.imported),
        empty: 'Nothing imported yet. Imported files stay on this device only.',
      },
    ];
  }

  renderList() {
    const query = this.search.value.trim().toLowerCase();
    const matches = (item) => !query || `${item.name} ${item.type || ''}`.toLowerCase().includes(query);
    this.list.replaceChildren();
    let shown = 0;
    this.groups().forEach(({ title, items, empty }) => {
      const visible = items.filter(matches);
      if (!visible.length && (query || !empty)) return;
      const heading = document.createElement('p');
      heading.className = 'asset-menu-group';
      heading.textContent = title;
      this.list.appendChild(heading);
      if (!visible.length) {
        this.list.appendChild(this.note(empty));
        return;
      }
      visible.forEach((item) => this.list.appendChild(this.createItem(item)));
      shown += visible.length;
    });
    if (!shown && query) this.list.appendChild(this.note(`No asset matches "${this.search.value.trim()}".`));
  }

  note(text) {
    const note = document.createElement('p');
    note.className = 'asset-menu-empty';
    note.textContent = text;
    return note;
  }

  createItem(item) {
    const row = document.createElement('div');
    row.className = 'asset-item';
    const current = item.id === this.currentId;
    row.classList.toggle('is-current', current);

    const choose = document.createElement('button');
    choose.type = 'button';
    choose.className = 'asset-item-choose';
    choose.setAttribute('aria-current', String(current));
    const name = document.createElement('strong');
    name.textContent = item.name;
    const type = document.createElement('small');
    type.textContent = item.type || '';
    const text = document.createElement('span');
    text.className = 'asset-item-text';
    text.append(name, type);
    choose.appendChild(text);
    if (item.file) {
      const badge = document.createElement('span');
      badge.className = 'asset-item-badge';
      badge.textContent = fileExtension(item.file.name).toUpperCase();
      badge.title = item.stored ? 'Saved on this device' : 'Not saved; it will be gone after a refresh';
      badge.classList.toggle('is-unsaved', !item.stored);
      choose.appendChild(badge);
    }
    choose.addEventListener('click', () => this.choose(item.id));
    row.appendChild(choose);

    if (item.imported) {
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'asset-item-remove';
      remove.textContent = '✕';
      remove.title = `Remove ${item.name} from this device`;
      remove.setAttribute('aria-label', remove.title);
      remove.addEventListener('click', () => this.removeImported(item.id));
      row.appendChild(remove);
    }
    return row;
  }

  // Arrow keys move between assets, Enter picks, Escape closes.
  handleKey(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      this.close({ focusButton: true });
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const items = [...this.list.querySelectorAll('.asset-item-choose')];
    if (!items.length) return;
    const index = items.indexOf(document.activeElement);
    const next = event.key === 'ArrowDown'
      ? items[(index + 1) % items.length]
      : items[index <= 0 ? items.length - 1 : index - 1];
    next.focus();
  }

  async choose(id) {
    this.close({ focusButton: true });
    if (id === this.currentId || this.loading) return;
    this.setStatus(null);
    this.setLoading(true);
    if (id === STATION.id) await this.onStationSelect?.();
    else if (id === FACTORY.id) await this.onFactorySelect?.();
    else if (PROCEDURAL_STATIONS.some((scene) => scene.id === id)) await this.onProceduralStationSelect?.(id);
    else await this.selectAsset(id);
    this.setLoading(false);
  }

  selectAsset(id) {
    return this.onAssetSelect ? this.onAssetSelect(id) : this.assetManager.select(id);
  }

  // ---- Current asset -------------------------------------------------------------------

  setCurrent(id) {
    this.currentId = id;
    this.showCurrent();
    if (!this.menu.hidden) this.renderList();
  }

  showCurrent() {
    const item = SCENES.find((scene) => scene.id === this.currentId) || getAssetConfig(this.currentId);
    this.currentName.textContent = item?.name || 'Loading…';
    this.currentType.textContent = item?.type || '';
    this.button.title = item ? `${item.name}: choose another asset or import a file` : 'Choose an asset';
  }

  update(asset) {
    const { config, animations } = asset;
    this.setCurrent(config.id);
    this.nameElement.textContent = config.name;
    this.typeElement.textContent = config.type;
    this.animationCountElement.textContent = String(animations.length);
    this.messageElement.textContent = NO_ANIMATIONS_MESSAGE;
    this.messageElement.hidden = animations.length > 0;
    this.animationCard.hidden = animations.length === 0;

    this.animationSelect.replaceChildren();
    animations.forEach((clip, index) => {
      const option = document.createElement('option');
      const clipName = clip.name || `Animation ${index + 1}`;
      option.value = clipName;
      option.textContent = clipName;
      this.animationSelect.appendChild(option);
    });
  }

  // ---- Imported models -------------------------------------------------------------------

  // Lists a model saved on this device without loading it yet.
  addStoredModel(id, file) {
    if (!getAssetConfig(id)) registerImportedAsset(file, { id, stored: true });
  }

  async removeImported(id) {
    const config = getAssetConfig(id);
    if (!config || !window.confirm(`Remove "${config.name}" from this device? Its joints, poses and sequences are deleted too.`)) return;
    try {
      if (config.stored) await removeStoredImport(id);
    } catch (error) {
      this.showError(`Couldn't remove "${config.name}": ${error.message || 'unknown error'}`);
      return;
    }
    forgetSavedRig(config);
    if (this.currentId === id) {
      this.close();
      this.setLoading(true);
      await this.selectAsset(this.defaultAssetId);
      this.setLoading(false);
    }
    this.assetManager.forget(id);
    unregisterAsset(id);
    this.renderList();
    this.setStatus(`"${config.name}" was removed from this device.`);
  }

  async importFile(file) {
    const formatError = unsupportedFormatMessage(file.name);
    if (formatError) {
      this.showError(formatError);
      return;
    }

    this.setStatus(null);
    this.setLoading(true);
    // Keep a copy in this browser so the model survives a page refresh.
    let storedId = null;
    let storeError = null;
    try {
      storedId = await storeImport(file);
    } catch (error) {
      storeError = error;
    }

    // Importing a file that is already saved just opens it.
    const existing = storedId && getAssetConfig(storedId);
    if (existing) {
      await this.selectAsset(existing.id);
      this.setLoading(false);
      return;
    }

    const config = registerImportedAsset(file, storedId ? { id: storedId, stored: true } : {});
    await this.selectAsset(config.id);
    this.setLoading(false);

    if (this.assetManager.currentAsset?.config.id !== config.id) {
      unregisterAsset(config.id);
      if (storedId) removeStoredImport(storedId).catch(() => {});
      return;
    }
    if (storeError) {
      console.warn('Imported model could not be saved in this browser.', storeError);
      this.showError("This model couldn't be saved on this device (the browser may be out of space), so it will be gone after a refresh. Export its rig file from Joint Setup to keep your work.");
    }
  }

  // ---- Status (shown over the 3D view) -----------------------------------------------------

  setLoading(isLoading) {
    this.loading = isLoading;
    this.button.disabled = isLoading;
    this.root.classList.toggle('is-loading', isLoading);
  }

  setStatus(message) {
    // Loading clears its progress note when it ends; that must not wipe an error shown meanwhile.
    if (!message && this.statusElement.classList.contains('is-error')) return;
    clearTimeout(this.statusTimer);
    this.statusElement.classList.remove('is-error');
    this.statusElement.hidden = !message;
    this.statusElement.textContent = message || '';
    // Progress messages are replaced as loading goes on; a final note fades on its own.
    if (message && !this.loading) this.statusTimer = setTimeout(() => this.setStatus(null), 4000);
  }

  showError(message) {
    clearTimeout(this.statusTimer);
    this.showCurrent();
    this.statusElement.hidden = false;
    this.statusElement.textContent = message;
    this.statusElement.classList.add('is-error');
    this.statusTimer = setTimeout(() => {
      this.statusElement.classList.remove('is-error');
      this.setStatus(null);
    }, 9000);
  }
}
