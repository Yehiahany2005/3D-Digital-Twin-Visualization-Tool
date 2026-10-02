import { ASSET_REGISTRY, registerImportedAsset, unregisterAsset } from '../assets/AssetRegistry.js';
import { IMPORT_ACCEPT, unsupportedFormatMessage } from '../loaders/ModelLoader.js';

const NO_ANIMATIONS_MESSAGE = 'No embedded animations detected.';

export class AssetSelectionPanel {
  constructor({ assetManager, selectElement, infoTitle, nameElement, typeElement, animationCountElement, animationCard, animationSelect, playButton, pauseButton, restartButton, messageElement }) {
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
    this.importInput = document.querySelector('[data-asset-import]');
    this.importButton = document.querySelector('[data-asset-import-button]');
    this.statusElement = document.querySelector('[data-asset-status]');
    this.importInput.accept = IMPORT_ACCEPT;

    ASSET_REGISTRY.forEach((asset) => this.addOption(asset));

    this.importButton.addEventListener('click', () => this.importInput.click());
    this.importInput.addEventListener('change', () => {
      const [file] = this.importInput.files;
      this.importInput.value = '';
      if (file) this.importFile(file);
    });

    this.selectElement.addEventListener('change', async () => {
      this.setStatus(null);
      this.setLoading(true);
      await this.assetManager.select(this.selectElement.value);
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
    this.infoTitle.textContent = config.robotController ? 'Robot Information' : 'Asset Information';
    this.assetLabel.textContent = config.robotController ? 'Robot Model' : 'Asset Name';
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

  addOption(config) {
    const option = document.createElement('option');
    option.value = config.id;
    option.textContent = config.name;
    this.selectElement.appendChild(option);
    return option;
  }

  async importFile(file) {
    const formatError = unsupportedFormatMessage(file.name);
    if (formatError) {
      this.showError(formatError);
      return;
    }

    this.setStatus(null);
    const config = registerImportedAsset(file);
    const option = this.addOption(config);
    this.setLoading(true);
    await this.assetManager.select(config.id);
    this.setLoading(false);

    if (this.assetManager.currentAsset?.config.id !== config.id) {
      option.remove();
      unregisterAsset(config.id);
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
