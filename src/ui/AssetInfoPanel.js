const NO_ANIMATIONS_MESSAGE = 'No embedded animations detected.';

// The Asset Information card and, for models that carry their own animation clips, the
// Asset Animations card (pick a clip, play, pause, restart).
export class AssetInfoPanel {
  constructor({ nameElement, typeElement, animationCountElement, animationCard, animationSelect, playButton, pauseButton, restartButton, messageElement }) {
    this.nameElement = nameElement;
    this.typeElement = typeElement;
    this.animationCountElement = animationCountElement;
    this.animationCard = animationCard;
    this.animationSelect = animationSelect;
    this.messageElement = messageElement;
    this.asset = null;

    const controller = () => this.asset?.animationController;
    animationSelect.addEventListener('change', () => controller()?.select(animationSelect.value));
    playButton.addEventListener('click', () => controller()?.play(animationSelect.value));
    pauseButton.addEventListener('click', () => controller()?.pause());
    restartButton.addEventListener('click', () => controller()?.restart(animationSelect.value));
  }

  setAsset(asset) {
    this.asset = asset;
    const { config, animations } = asset;
    this.nameElement.textContent = config.name;
    this.typeElement.textContent = config.type;
    this.animationCountElement.textContent = String(animations.length);
    this.messageElement.textContent = NO_ANIMATIONS_MESSAGE;
    this.messageElement.hidden = animations.length > 0;
    this.animationCard.hidden = animations.length === 0;

    this.animationSelect.replaceChildren(...animations.map((clip, index) => {
      const clipName = clip.name || `Animation ${index + 1}`;
      return new Option(clipName, clipName);
    }));
  }
}
