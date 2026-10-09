import { Rig, emptyRigDefinition } from '../motion/Rig.js';
import { MotionPlayer } from '../motion/MotionPlayer.js';
import { loadSavedRig } from '../motion/RigStore.js';
import { AssetManager } from '../scene/AssetManager.js';
import { JointGizmo, LinePickPreview, PartHighlight, SelectionOutline, SurfacePreview } from '../scene/RigHelpers.js';
import { JointControls } from '../ui/JointControls.js';
import { CommandsPanel } from '../ui/CommandsPanel.js';
import { RigEditorPanel } from '../ui/RigEditorPanel.js';
import { AnimationEditorPanel } from '../ui/AnimationEditorPanel.js';
import { AssetPicker } from '../ui/AssetPicker.js';
import { AssetInfoPanel } from '../ui/AssetInfoPanel.js';
import { getAssetConfig } from '../assets/AssetRegistry.js';
import { lastAsset, rememberLastAsset } from '../assets/ImportStore.js';

export const DEFAULT_ASSET_ID = 'abb_irb6760';

// Machine tab: one model at a time, with its joints, poses and sequences, Joint Setup,
// Animation Setup, Reach and the model's own animation clips.
//
// enter() shows the model (loading the last one used the first time); exit() hides it and lets
// go of everything Machine-only: Reach, part picking in Joint Setup, motion in progress.
export class MachineTab {
  constructor({ view, ui }) {
    this.view = view;
    this.active = false;
    this.asset = null;
    const { scene } = view;

    this.jointControls = new JointControls({
      container: ui.jointsList,
      filter: (joint) => joint.kind === 'joint',
      emptyMessage: 'This model has no movable joints yet.',
      emptyAction: { label: 'Set up joints', onClick: () => this.rigEditor.open() },
    });
    this.commandsPanel = new CommandsPanel(ui.commands);
    this.rigEditor = new RigEditorPanel({
      card: ui.rigEditorCard,
      picker: view.picker,
      surfacePreview: new SurfacePreview(scene),
      linePreview: new LinePickPreview(scene),
      outline: new SelectionOutline(scene),
      highlight: new PartHighlight(scene),
      gizmo: new JointGizmo(scene),
    });
    this.animationEditor = new AnimationEditorPanel({
      card: ui.animationEditorCard,
      // The exported file should carry the model's own materials, not the Digital Twin View tint.
      beforeExport: () => view.viewManager.useOriginalMaterials(),
    });
    this.assetInfo = new AssetInfoPanel(ui.assetInfo);

    this.assetManager = new AssetManager({
      scene,
      cameraManager: view.cameraManager,
      controls: view.controls,
      onAssetLoaded: (asset) => this.handleAssetLoaded(asset),
      onAssetError: (config, error) => view.status.error(`Unable to load ${config.name}: ${error.message || 'unknown error'}`),
      onStatus: (message) => view.status.show(message),
    });
    this.picker = new AssetPicker({
      root: ui.pickerRoot,
      assetManager: this.assetManager,
      status: view.status,
      onSelect: (id) => this.assetManager.select(id),
      defaultAssetId: DEFAULT_ASSET_ID,
    });
  }

  // Opens a model by id; used by "Joints & animations" on a scene item too.
  async select(id) {
    if (!getAssetConfig(id)) return;
    this.picker.setLoading(true);
    await this.assetManager.select(id);
    this.picker.setLoading(false);
  }

  // Each model keeps its own rig and player, so switching models keeps its pose.
  ensureRig(asset) {
    if (asset.rig) return;
    const fallback = asset.config.rig ? structuredClone(asset.config.rig) : emptyRigDefinition();
    const saved = loadSavedRig(asset.config);
    asset.rig = new Rig({ root: asset.model, content: asset.content, definition: emptyRigDefinition() });
    try {
      asset.rig.setDefinition(saved || fallback);
    } catch (error) {
      console.warn('Rig could not be built; using the default rig instead.', error);
      asset.rig.setDefinition(saved ? fallback : emptyRigDefinition());
    }
    asset.rig.warnings.forEach((warning) => console.warn(warning));
    asset.player = new MotionPlayer(asset.rig);
  }

  handleAssetLoaded(asset) {
    this.asset?.player?.stop();
    this.asset = asset;
    rememberLastAsset(asset.config.id);
    this.ensureRig(asset);
    asset.model.visible = this.active;

    this.jointControls.setRig(asset.rig, asset.player);
    this.commandsPanel.setRig(asset.rig, asset.player);
    this.rigEditor.setAsset(asset);
    this.animationEditor.setAsset(asset);
    this.assetInfo.setAsset(asset);
    this.picker.setCurrent(asset.config.id);
    if (this.active) this.showAsset();
  }

  // The model, the Digital Twin View, floor and lights, Reach and the camera, all on this model.
  showAsset() {
    const { asset, view } = this;
    asset.model.visible = true;
    view.viewManager.replaceRobot(asset.model, { force: true });
    view.fitTo(asset.model);
    view.reach.setAsset(asset);
  }

  // assetId: open this model (default: the one already open, else the last one used).
  async enter({ assetId = null } = {}) {
    this.active = true;
    this.picker.menu.root.hidden = false;
    this.view.reach.setHidden(false);
    if (assetId && assetId !== this.asset?.config.id) {
      await this.select(assetId);
      // Loaded and shown; if it failed, carry on with the model that was open.
      if (this.asset?.config.id === assetId) return;
    }
    if (this.asset) {
      this.showAsset();
      this.view.cameraManager.frameObject(this.asset.model, this.view.controls);
      return;
    }
    const last = lastAsset();
    await this.select(last && getAssetConfig(last) ? last : DEFAULT_ASSET_ID);
    if (!this.assetManager.currentAsset) await this.select(DEFAULT_ASSET_ID);
  }

  exit() {
    this.active = false;
    this.picker.menu.close();
    this.picker.menu.root.hidden = true;
    this.view.reach.setHidden(true);
    // Joint Setup picks on the model; nothing of this tab may keep the viewport's clicks.
    this.rigEditor.card.open = false;
    this.asset?.player.stop();
    if (this.asset) this.asset.model.visible = false;
  }

  update(deltaTime) {
    this.asset?.player.update(deltaTime);
    this.assetManager.update(deltaTime);
    if (!this.active) return;
    this.jointControls.update();
    this.rigEditor.update();
  }
}
