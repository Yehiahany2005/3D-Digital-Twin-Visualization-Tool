// Full-view cover with the scene's name, shown while a built-in scene is being built and its
// models load, so a half-built line never shows. Fades out once the scene has drawn a frame.

const FADE_MS = 320;

const nextFrame = () => new Promise((resolve) => { requestAnimationFrame(() => resolve()); });

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

export class LoadingScreen {
  constructor(container) {
    this.root = el('div', 'scene-loading');
    this.root.hidden = true;
    this.root.setAttribute('role', 'status');
    this.root.setAttribute('aria-live', 'polite');
    const card = el('div', 'scene-loading-card');
    this.kicker = el('span', 'scene-loading-kicker', 'Loading scene');
    this.title = el('h2', 'scene-loading-title');
    this.subtitle = el('p', 'scene-loading-subtitle');
    const bar = el('div', 'scene-loading-bar');
    bar.append(el('span'));
    card.append(this.kicker, this.title, this.subtitle, bar);
    this.root.append(card);
    container.append(this.root);
    this.hideTimer = null;
  }

  /** Covers the view at once and resolves after it has been painted (before heavy work starts). */
  async show({ title, subtitle = '' }) {
    clearTimeout(this.hideTimer);
    this.title.textContent = title;
    this.subtitle.textContent = subtitle;
    this.subtitle.hidden = !subtitle;
    this.root.hidden = false;
    this.root.classList.remove('is-leaving');
    await nextFrame();
    await nextFrame();
  }

  /** Fades out after the next frame, so the finished scene is what appears underneath. */
  async hide() {
    if (this.root.hidden) return;
    await nextFrame();
    this.root.classList.add('is-leaving');
    clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => {
      this.root.hidden = true;
      this.root.classList.remove('is-leaving');
    }, FADE_MS);
  }

  /** Removes it straight away (leaving the tab, an error). */
  hideNow() {
    clearTimeout(this.hideTimer);
    this.root.hidden = true;
    this.root.classList.remove('is-leaving');
  }
}
