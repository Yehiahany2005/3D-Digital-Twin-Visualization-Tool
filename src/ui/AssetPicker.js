import { ASSET_REGISTRY, getAssetConfig, registerImportedAsset, unregisterAsset } from '../assets/AssetRegistry.js';
import { removeStoredImport, storeImport } from '../assets/ImportStore.js';
import { forgetSavedRig } from '../motion/RigStore.js';
import { IMPORT_ACCEPT, fileExtension, unsupportedFormatMessage } from '../loaders/ModelLoader.js';
import { PickerMenu } from './PickerMenu.js';

// Machine mode's header picker: built-in models and models imported on this device, importing
// a new file, and removing an imported one. onSelect(id) loads the chosen model.
export class AssetPicker {
  constructor({ root, assetManager, status, onSelect, defaultAssetId }) {
    this.assetManager = assetManager;
    this.status = status;
    this.onSelect = onSelect;
    this.defaultAssetId = defaultAssetId;
    this.loading = false;
    this.menu = new PickerMenu({ root, noun: 'model', groups: () => this.groups(), onChoose: (item) => this.choose(item.id) });

    this.importInput = root.querySelector('[data-asset-import]');
    this.importInput.accept = IMPORT_ACCEPT;
    root.querySelector('[data-asset-import-button]').addEventListener('click', () => this.importInput.click());
    this.importInput.addEventListener('change', () => {
      const [file] = this.importInput.files;
      this.importInput.value = '';
      this.menu.close();
      if (file) this.importFile(file);
    });
  }

  groups() {
    return [
      { title: 'Built-in models', items: ASSET_REGISTRY.filter((asset) => !asset.imported).map((config) => this.toItem(config)) },
      {
        title: 'Imported on this device',
        items: ASSET_REGISTRY.filter((asset) => asset.imported).map((config) => this.toItem(config)),
        empty: 'Nothing imported yet. Imported files stay on this device only.',
      },
    ];
  }

  toItem(config) {
    const item = { id: config.id, name: config.name, type: config.type };
    if (config.file) {
      item.badge = {
        text: fileExtension(config.file.name).toUpperCase(),
        title: config.stored ? 'Saved on this device' : 'Not saved; it will be gone after a refresh',
        muted: !config.stored,
      };
    }
    if (config.imported) item.remove = { title: `Remove ${config.name} from this device`, run: () => this.removeImported(config.id) };
    return item;
  }

  async choose(id) {
    if (this.loading) return;
    this.status.show(null);
    this.setLoading(true);
    await this.onSelect(id);
    this.setLoading(false);
  }

  setCurrent(id) {
    this.menu.setCurrent(getAssetConfig(id) || null);
  }

  setLoading(loading) {
    if (loading === this.loading) return;
    this.loading = loading;
    this.menu.setBusy(loading);
    this.status.setBusy(loading);
  }

  // ---- Imported models -------------------------------------------------------------------

  async removeImported(id) {
    const config = getAssetConfig(id);
    if (!config || !window.confirm(`Remove "${config.name}" from this device? Its joints, poses and sequences are deleted too.`)) return;
    try {
      if (config.stored) await removeStoredImport(id);
    } catch (error) {
      this.status.error(`Couldn't remove "${config.name}": ${error.message || 'unknown error'}`);
      return;
    }
    forgetSavedRig(config);
    if (this.menu.currentId === id) {
      this.menu.close();
      await this.choose(this.defaultAssetId);
    }
    this.assetManager.forget(id);
    unregisterAsset(id);
    if (this.menu.isOpen) this.menu.render();
    this.status.show(`"${config.name}" was removed from this device.`);
  }

  async importFile(file) {
    const formatError = unsupportedFormatMessage(file.name);
    if (formatError) {
      this.status.error(formatError);
      return;
    }

    this.status.show(null);
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
      await this.onSelect(existing.id);
      this.setLoading(false);
      return;
    }

    const config = registerImportedAsset(file, storedId ? { id: storedId, stored: true } : {});
    await this.onSelect(config.id);
    this.setLoading(false);

    if (this.assetManager.currentAsset?.config.id !== config.id) {
      unregisterAsset(config.id);
      if (storedId) removeStoredImport(storedId).catch(() => {});
      return;
    }
    if (storeError) {
      console.warn('Imported model could not be saved in this browser.', storeError);
      this.status.error("This model couldn't be saved on this device (the browser may be out of space), so it will be gone after a refresh. Export its rig file from Joint Setup to keep your work.");
    }
  }
}
