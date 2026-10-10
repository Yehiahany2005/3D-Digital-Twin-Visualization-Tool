import { PickerMenu } from '../ui/PickerMenu.js';
import { BUILT_IN_SCENES, BuiltInScenes, getBuiltInScene } from '../station/BuiltInScenes.js';
import { lastSceneId, listScenes, rememberLastScene } from '../studio/SceneStore.js';
import { isFileScene, SCENE_FILES } from '../scenes/index.js';

const BUILT_IN_PREFIX = 'builtin:';
const DEFAULT_SCENE = `${BUILT_IN_PREFIX}factory`;

const itemCount = (count) => `${count} item${count === 1 ? '' : 's'}`;

// Scene tab: whole scenes, from two sources that share the header picker and the sidebar.
//   Built-in scenes: production lines made in code (src/station), which run but can't be edited,
//     and scene files (src/scenes), which open in the scene editor like any scene of yours.
//   My scenes: scenes built by drag and drop in the scene editor (src/studio), saved in this browser.
// One of the two is active at a time; the other is fully put away (its 3D content, sidebar cards,
// viewport toolbar, Reach and viewport clicks).
export class SceneTab {
  constructor({ view, templates, editor, ui }) {
    this.view = view;
    this.editor = editor;
    this.ui = ui;
    this.active = false;
    this.source = null; // 'builtin' | 'editor'
    this.saved = [];

    this.builtIn = new BuiltInScenes({
      context: {
        scene: view.scene,
        renderer: view.renderer,
        cameraManager: view.cameraManager,
        controls: view.controls,
        container: view.container,
        floor: view.floor,
      },
      templates,
      ui: ui.builtInCard,
      onShown: (root) => {
        // The tint follows the running scene: new products and swapped lamp materials included.
        view.viewManager.replaceRobot(root, { force: true });
        view.fitTo(root, { tightShadows: true });
      },
      onError: (message) => view.status.error(message),
    });

    this.picker = new PickerMenu({ root: ui.pickerRoot, noun: 'scene', groups: () => this.groups(), onChoose: (item) => this.open(item.id) });
    ui.newScene.addEventListener('click', () => {
      this.picker.close();
      this.withEditor(() => editor.newScene());
    });
    ui.openFile.addEventListener('click', () => {
      this.picker.close();
      ui.fileInput.click();
    });
    ui.fileInput.addEventListener('change', () => {
      const [file] = ui.fileInput.files;
      ui.fileInput.value = '';
      if (file) this.withEditor(() => editor.openFile(file));
    });
  }

  groups() {
    const opened = this.editor.opened ? this.editor.editor.document : null;
    const current = opened && !isFileScene(opened.id) ? opened : null;
    const saved = this.saved.filter((scene) => !isFileScene(scene.id)).map((scene) => (scene.id === current?.id ? { ...scene, name: current.name, itemCount: current.items.length } : scene));
    if (current && !saved.some((scene) => scene.id === current.id)) saved.unshift({ id: current.id, name: current.name, itemCount: current.items.length });
    return [
      {
        title: 'Built-in scenes',
        items: [
          ...BUILT_IN_SCENES.map((entry) => ({ id: `${BUILT_IN_PREFIX}${entry.id}`, name: entry.name, type: entry.type })),
          ...SCENE_FILES.map((entry) => ({ id: entry.id, name: entry.name, type: entry.description || 'Scene file · open it to play or change it' })),
        ],
      },
      {
        title: 'My scenes',
        items: saved.map((scene) => ({ id: scene.id, name: scene.name, type: `Drag and drop · ${itemCount(scene.itemCount)}` })),
        empty: 'Nothing yet. Choose New scene below to build one by drag and drop.',
      },
    ];
  }

  async refreshSaved() {
    this.saved = await listScenes();
    if (this.picker.isOpen) this.picker.render();
  }

  // The header shows the open scene, whichever kind it is.
  showCurrent() {
    if (this.source === 'builtin') {
      const entry = getBuiltInScene(this.builtIn.activeId);
      if (entry) this.picker.setCurrent({ id: `${BUILT_IN_PREFIX}${entry.id}`, name: entry.name, type: 'Built-in scene · runs in code' });
    } else if (this.source === 'editor' && this.editor.opened) {
      const scene = this.editor.editor.document;
      const kind = isFileScene(scene.id) ? 'Built-in scene' : 'My scene';
      this.picker.setCurrent({ id: scene.id, name: scene.name, type: `${kind} · ${itemCount(scene.items.length)}` });
    }
  }

  setSource(source) {
    this.source = source;
    this.ui.builtInPane.hidden = source !== 'builtin';
    this.ui.editorPane.hidden = source !== 'editor';
  }

  // One thing at a time: opening a scene while another one loads would show both.
  async run(task) {
    if (this.busy) return;
    this.busy = true;
    this.picker.setBusy(true);
    this.view.status.setBusy(true);
    try {
      await task();
    } finally {
      this.view.status.setBusy(false);
      this.picker.setBusy(false);
      this.busy = false;
    }
  }

  // Opens a built-in scene ("builtin:<id>") or a saved scene (its id).
  open(id) {
    return this.run(() => (id.startsWith(BUILT_IN_PREFIX) ? this.openBuiltIn(id.slice(BUILT_IN_PREFIX.length)) : this.openEditor(id)));
  }

  async openBuiltIn(id) {
    this.editor.exit();
    this.setSource('builtin');
    rememberLastScene(`${BUILT_IN_PREFIX}${id}`);
    const opened = await this.builtIn.open(id);
    if (opened) this.showCurrent();
    // It couldn't be built (the error is shown): don't leave an empty tab behind.
    else if (this.active) await this.openEditor();
  }

  async openEditor(sceneId = null) {
    this.builtIn.close();
    this.setSource('editor');
    await this.editor.enter(sceneId);
    this.showCurrent();
  }

  // New scene / Open file act on the editor, so it comes forward first.
  withEditor(action) {
    return this.run(async () => {
      if (this.source !== 'editor') await this.openEditor();
      await action();
    });
  }

  // The editor reports changes to the open scene and to the saved list.
  sceneChanged() {
    if (this.source === 'editor') this.showCurrent();
  }

  async enter() {
    this.active = true;
    this.picker.root.hidden = false;
    this.refreshSaved();
    const last = lastSceneId() || DEFAULT_SCENE;
    const gone = (last.startsWith(BUILT_IN_PREFIX) && !getBuiltInScene(last.slice(BUILT_IN_PREFIX.length)))
      || (isFileScene(last) && !SCENE_FILES.some((entry) => entry.id === last));
    await this.open(gone ? DEFAULT_SCENE : last);
  }

  exit() {
    this.active = false;
    this.picker.close();
    this.picker.root.hidden = true;
    this.builtIn.close();
    this.editor.exit();
    this.setSource(null);
  }

  update(deltaTime) {
    this.builtIn.update(deltaTime);
    this.editor.update(deltaTime);
  }
}
