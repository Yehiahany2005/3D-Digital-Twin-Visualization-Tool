import { ASSET_REGISTRY, getAssetConfig, registerImportedAsset, unregisterAsset } from '../assets/AssetRegistry.js';
import { removeStoredImport, storeImport } from '../assets/ImportStore.js';
import { forgetSavedRig } from '../motion/RigStore.js';
import { IMPORT_ACCEPT, unsupportedFormatMessage } from '../loaders/ModelLoader.js';

const NO_ANIMATIONS_MESSAGE = 'No embedded animations detected.';

export class AssetSelectionPanel {
  constructor({ assetManager, selectElement, infoTitle, nameElement, typeElement, animationCountElement, animationCard, animationSelect, playButton, pauseButton, restartButton, messageElement, onStationSelect, defaultAssetId }) {
    this.assetManager = assetManager;
    this.selectElement = selectElement;
    this.infoTitle = infoTitle;
    this.assetLabel = document.querySelector('[data-asset-label]');
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
    this.importInput = document.querySelector('[data-asset-import]');
    this.importButton = document.querySelector('[data-asset-import-button]');
    this.statusElement = document.querySelector('[data-asset-status]');
    this.savedModelRow = document.querySelector('[data-saved-model]');
    this.defaultAssetId = defaultAssetId;
    this.importInput.accept = IMPORT_ACCEPT;

    ASSET_REGISTRY.forEach((asset) => this.addOption(asset));
    this.stationOption = this.addOption({ id: 'station', name: 'Station' });
    document.querySelector('[data-forget-model]').addEventListener('click', () => this.forgetCurrentModel());

    this.importButton.addEventListener('click', () => this.importInput.click());
    this.importInput.addEventListener('change', () => {
      const [file] = this.importInput.files;
      this.importInput.value = '';
      if (file) this.importFile(file);
    });

    this.selectElement.addEventListener('change', async () => {
      this.setStatus(null);
      this.setLoading(true);
      if (this.selectElement.value === 'station') {
        await this.onStationSelect?.();
      } else {
        await this.assetManager.select(this.selectElement.value);
      }
      this.setLoading(false);
    });
    this.animationSelect.addEventListener('change', () => this.assetManager.currentAsset?.animationController.select(this.animationSelect.value));
    this.playButton.addEventListener('click', () => this.assetManager.currentAsset?.animationController.play(this.animationSelect.value));
    this.pauseButton.addEventListener('click', () => this.assetManager.currentAsset?.animationController.pause());
    this.restartButton.addEventListener('click', () => this.assetManager.currentAsset?.animationController.restart(this.animationSelect.value));
  }

  update(asset) {
    const { config, animations } = asset;
    this.selectElement.value = config.id;
    this.nameElement.textContent = config.name;
    this.typeElement.textContent = config.type;
    this.animationCountElement.textContent = String(animations.length);
    this.savedModelRow.hidden = !config.stored;
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

  // Imported models are listed above "Station", which stays last.
  addOption(config) {
    const option = document.createElement('option');
    option.value = config.id;
    option.textContent = config.name;
    this.selectElement.insertBefore(option, this.stationOption?.parentNode === this.selectElement ? this.stationOption : null);
    return option;
  }

  // Adds a model saved on this device to the list without loading it yet.
  addStoredModel(id, file) {
    if (getAssetConfig(id)) return;
    this.addOption(registerImportedAsset(file, { id, stored: true }));
  }

  async forgetCurrentModel() {
    const asset = this.assetManager.currentAsset;
    if (!asset?.config.stored) return;
    const { config } = asset;
    if (!window.confirm(`Remove "${config.name}" from this device? Its joints, poses and sequences are deleted too.`)) return;
    try {
      await removeStoredImport(config.id);
    } catch (error) {
      this.showError(`Couldn't remove "${config.name}": ${error.message || 'unknown error'}`);
      return;
    }
    forgetSavedRig(config);
    this.setLoading(true);
    await this.assetManager.select(this.defaultAssetId);
    this.setLoading(false);
    this.assetManager.forget(config.id);
    [...this.selectElement.options].find((option) => option.value === config.id)?.remove();
    unregisterAsset(config.id);
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
      await this.assetManager.select(existing.id);
      this.setLoading(false);
      return;
    }

    const config = registerImportedAsset(file, storedId ? { id: storedId, stored: true } : {});
    const option = this.addOption(config);
    await this.assetManager.select(config.id);
    this.setLoading(false);

    if (this.assetManager.currentAsset?.config.id !== config.id) {
      option.remove();
      unregisterAsset(config.id);
      if (storedId) removeStoredImport(storedId).catch(() => {});
      return;
    }
    if (storeError) {
      console.warn('Imported model could not be saved in this browser.', storeError);
      this.showError("This model couldn't be saved on this device (the browser may be out of space), so it will be gone after a refresh. Export its rig file from Joint Setup to keep your work.");
    }
  }

  setLoading(isLoading) {
    this.selectElement.disabled = isLoading;
    this.importButton.disabled = isLoading;
  }

  setStatus(message) {
    this.statusElement.classList.remove('is-error');
    this.statusElement.hidden = !message;
    this.statusElement.textContent = message || '';
  }

  showError(message) {
    if (this.assetManager.currentAsset) this.selectElement.value = this.assetManager.currentAsset.config.id;
    this.statusElement.hidden = false;
    this.statusElement.textContent = message;
    this.statusElement.classList.add('is-error');
  }
}
