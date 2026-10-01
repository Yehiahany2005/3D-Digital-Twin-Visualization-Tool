import * as THREE from 'three';

export class AnimationController {
  constructor(root, clips) {
    this.root = root;
    this.clips = clips;
    this.mixer = clips.length > 0 ? new THREE.AnimationMixer(root) : null;
    this.actions = new Map();
    this.activeClipName = null;

    clips.forEach((clip, index) => {
      const name = clip.name || `Animation ${index + 1}`;
      this.actions.set(name, this.mixer.clipAction(clip));
    });
  }

  get hasAnimations() {
    return this.clips.length > 0;
  }

  play(clipName = this.activeClipName || this.clipName(0)) {
    if (!this.mixer || !clipName) return;
    const action = this.actions.get(clipName);
    if (!action) return;

    this.actions.forEach((otherAction) => {
      if (otherAction !== action) otherAction.stop();
    });
    action.paused = false;
    action.play();
    this.activeClipName = clipName;
  }

  pause() {
    if (this.activeClipName) this.actions.get(this.activeClipName).paused = true;
  }

  restart(clipName = this.activeClipName || this.clipName(0)) {
    if (!this.mixer || !clipName) return;
    const action = this.actions.get(clipName);
    if (!action) return;

    action.reset();
    action.play();
    action.paused = false;
    this.activeClipName = clipName;
  }

  select(clipName) {
    if (!this.actions.has(clipName)) return;
    this.actions.forEach((action) => action.stop());
    this.activeClipName = clipName;
  }

  update(deltaTime) {
    this.mixer?.update(deltaTime);
  }

  stop() {
    this.actions.forEach((action) => action.stop());
    this.mixer?.stopAllAction();
  }

  dispose() {
    this.stop();
    this.actions.clear();
    this.mixer = null;
  }

  clipName(index) {
    const clip = this.clips[index];
    return clip ? clip.name || `Animation ${index + 1}` : null;
  }
}
