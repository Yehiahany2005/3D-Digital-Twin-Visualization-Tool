import { ASSET_REGISTRY } from '../assets/AssetRegistry.js';

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

    ASSET_REGISTRY.forEach((asset) => {
      const option = document.createElement('option');
      option.value = asset.id;
      option.textContent = asset.name;
      this.selectElement.appendChild(option);
    });

    this.selectElement.addEventListener('change', async () => {
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

  setLoading(isLoading) {
    this.selectElement.disabled = isLoading;
  }

  showError(message) {
    if (this.assetManager.currentAsset) this.selectElement.value = this.assetManager.currentAsset.config.id;
    this.messageElement.hidden = false;
    this.messageElement.textContent = message;
    this.animationCard.hidden = true;
  }
}
