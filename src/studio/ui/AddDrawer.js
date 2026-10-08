import * as THREE from 'three';
import { icon } from './icons.js';

const UP = new THREE.Vector3(0, 1, 0);
const FLOOR = new THREE.Plane(UP, 0);

function makeGhostMaterial(material) {
  const ghost = material.clone();
  ghost.transparent = true;
  ghost.opacity = 0.45;
  ghost.depthWrite = false;
  return ghost;
}

// See-through copy of a preview object, so it is clear it isn't placed yet.
function ghostify(object) {
  object.traverse((child) => {
    if (!child.isMesh) return;
    child.material = Array.isArray(child.material) ? child.material.map(makeGhostMaterial) : makeGhostMaterial(child.material);
    child.castShadow = false;
    child.raycast = () => {};
  });
  return object;
}

// A wire box of a given size standing on the floor: the stand-in for a model while placing it.
function boxGhost(size) {
  const geometry = new THREE.BoxGeometry(size.x, size.y, size.z).translate(0, size.y / 2, 0);
  const group = new THREE.Group();
  const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geometry), new THREE.LineBasicMaterial({ color: 0x69c7d3 }));
  const fill = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color: 0x69c7d3, transparent: true, opacity: 0.12, depthWrite: false }));
  fill.raycast = () => {};
  edges.raycast = () => {};
  group.add(fill, edges);
  return group;
}

// The "Add" drawer at the bottom of the 3D view (like Roblox Studio's Toolbox): searchable
// models and parts, placed by clicking then clicking on the floor, or by dragging onto it.
//
// entries(): [{ key, name, subtitle, category, icon, thumbnail?, source, params? }]
// preview(entry): Promise<{ object, size }> – what follows the pointer while placing
// place(entry, { position, rotation }) – adds the item
export class AddDrawer {
  constructor({ drawer, toggleButton, editor, picker, camera, domElement, scene, entries, preview, place, onImport, onOpenChange }) {
    this.drawer = drawer;
    this.toggleButton = toggleButton;
    this.editor = editor;
    this.picker = picker;
    this.camera = camera;
    this.domElement = domElement;
    this.scene = scene;
    this.entries = entries;
    this.preview = preview;
    this.place = place;
    this.onOpenChange = onOpenChange;
    this.search = drawer.querySelector('[data-add-search]');
    this.categoriesElement = drawer.querySelector('[data-add-categories]');
    this.grid = drawer.querySelector('[data-add-grid]');
    this.hint = drawer.querySelector('[data-add-hint]');
    this.category = 'All';
    this.placing = null;
    this.raycaster = new THREE.Raycaster();

    toggleButton.addEventListener('click', () => this.setOpen(this.drawer.hidden));
    drawer.querySelector('[data-add-close]').addEventListener('click', () => this.setOpen(false));
    this.search.addEventListener('input', () => this.renderGrid());
    const importInput = drawer.querySelector('[data-add-import-input]');
    drawer.querySelector('[data-add-import]').addEventListener('click', () => importInput.click());
    importInput.addEventListener('change', () => {
      const [file] = importInput.files;
      importInput.value = '';
      if (file) onImport(file);
    });

    // Dragging a card onto the 3D view places it where it is dropped.
    domElement.addEventListener('dragover', (event) => {
      if (!this.dragEntry) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
      this.moveGhostTo(event);
    });
    domElement.addEventListener('dragleave', () => this.ghost && (this.ghost.visible = false));
    domElement.addEventListener('drop', (event) => {
      if (!this.dragEntry) return;
      event.preventDefault();
      this.moveGhostTo(event);
      if (this.ghost?.visible) this.commitPlacement(false);
      this.endPlacing();
    });
    document.addEventListener('keydown', (event) => {
      if (!this.placing || event.target.closest?.('input, select, textarea')) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        this.endPlacing();
        this.editor.emit('status', 'Placing cancelled.');
      } else if (event.key === 'r' || event.key === 'R') {
        event.preventDefault();
        this.turnGhost(event.shiftKey ? -90 : 90);
      }
    });
  }

  setOpen(open) {
    this.drawer.hidden = !open;
    this.toggleButton.setAttribute('aria-expanded', String(open));
    this.toggleButton.classList.toggle('is-active', open);
    if (open) {
      this.render();
      this.search.focus();
    } else {
      this.endPlacing();
    }
    this.onOpenChange?.(open);
  }

  get isOpen() {
    return !this.drawer.hidden;
  }

  render() {
    const entries = this.entries();
    const categories = ['All', ...new Set(entries.map((entry) => entry.category))];
    if (!categories.includes(this.category)) this.category = 'All';
    this.categoriesElement.replaceChildren(...categories.map((category) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'add-chip';
      chip.textContent = category;
      chip.classList.toggle('is-active', category === this.category);
      chip.setAttribute('aria-pressed', String(category === this.category));
      chip.addEventListener('click', () => {
        this.category = category;
        this.render();
      });
      return chip;
    }));
    this.renderGrid(entries);
  }

  renderGrid(entries = this.entries()) {
    const query = this.search.value.trim().toLowerCase();
    const shown = entries.filter((entry) => (this.category === 'All' || entry.category === this.category)
      && (!query || `${entry.name} ${entry.subtitle} ${entry.category}`.toLowerCase().includes(query)));
    if (!shown.length) {
      const empty = document.createElement('p');
      empty.className = 'empty-state';
      empty.textContent = query ? `Nothing matches "${this.search.value.trim()}".` : 'Nothing here yet.';
      this.grid.replaceChildren(empty);
      return;
    }
    this.grid.replaceChildren(...shown.map((entry) => this.card(entry)));
  }

  card(entry) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'add-card';
    card.draggable = true;
    card.title = `${entry.name}${entry.subtitle ? ` · ${entry.subtitle}` : ''}\nClick, then click on the floor to place. Or drag it onto the floor.`;
    card.classList.toggle('is-active', this.placing?.entry.key === entry.key);
    const picture = document.createElement('span');
    picture.className = 'add-card-picture';
    if (entry.thumbnail) {
      const image = document.createElement('img');
      image.src = entry.thumbnail;
      image.alt = '';
      picture.append(image);
    } else {
      picture.append(icon(entry.icon || 'Box', 26));
    }
    const name = document.createElement('strong');
    name.textContent = entry.name;
    const subtitle = document.createElement('small');
    subtitle.textContent = entry.subtitle || entry.category;
    card.append(picture, name, subtitle);
    card.addEventListener('click', () => this.startPlacing(entry));
    card.addEventListener('dragstart', (event) => {
      event.dataTransfer.setData('text/plain', entry.name);
      event.dataTransfer.effectAllowed = 'copy';
      this.startPlacing(entry, { dragging: true });
    });
    card.addEventListener('dragend', () => {
      if (this.dragEntry) this.endPlacing();
    });
    return card;
  }

  // ---- Placing ---------------------------------------------------------------------------

  async startPlacing(entry, { dragging = false } = {}) {
    this.endPlacing();
    const token = {};
    this.placing = { entry, token, yaw: 0 };
    this.dragEntry = dragging ? entry : null;
    // While placing, the drawer shrinks to its hint so the floor behind it can be clicked.
    if (!dragging) this.drawer.classList.add('is-placing');
    this.renderGrid();
    this.hint.textContent = `Placing ${entry.name}: click on the floor or on top of something. R turns it 90°, Shift-click keeps placing, Esc cancels.`;
    if (!dragging) {
      this.picker.setHandler((hit, event) => this.handlePlaceClick(event), () => this.editor.root, {
        owner: 'scene-place',
        hover: (hit, event) => this.moveGhostTo(event),
        onRelease: () => this.endPlacing(),
      });
    }
    let previewed;
    try {
      previewed = await this.preview(entry);
    } catch (error) {
      if (this.placing?.token === token) this.endPlacing();
      this.editor.emit('status', `Can't place ${entry.name}: ${error.message}`);
      return;
    }
    if (this.placing?.token !== token) {
      previewed?.dispose?.();
      return;
    }
    this.ghost = previewed.ghost ? ghostify(previewed.object) : boxGhost(previewed.size);
    this.ghost.visible = false;
    this.ghost.rotation.y = THREE.MathUtils.degToRad(this.placing.yaw);
    this.scene.add(this.ghost);
    if (this.lastPointer) this.moveGhostTo(this.lastPointer);
  }

  endPlacing() {
    const wasPicking = this.placing && !this.dragEntry && this.picker.owner === 'scene-place';
    if (this.ghost) {
      this.ghost.removeFromParent();
      this.ghost.traverse((child) => {
        if (!child.isMesh && !child.isLineSegments) return;
        child.geometry?.dispose();
        [child.material].flat().forEach((material) => material?.dispose());
      });
    }
    this.ghost = null;
    this.placing = null;
    this.dragEntry = null;
    this.drawer.classList.remove('is-placing');
    if (wasPicking) this.picker.setHandler(null);
    this.hint.textContent = 'Click an item, then click on the floor to place it (R turns it, Esc cancels, Shift keeps placing). You can also drag it onto the floor.';
    if (this.isOpen) this.renderGrid();
  }

  turnGhost(degrees) {
    if (!this.placing) return;
    this.placing.yaw = (((this.placing.yaw + degrees) % 360) + 360) % 360;
    if (this.ghost) this.ghost.rotation.y = THREE.MathUtils.degToRad(this.placing.yaw);
  }

  // Where the pointer points: the top of an item if it is pointing at one (to put a box on a
  // table), otherwise the floor. Snapped to the grid.
  pointAt(event) {
    const rect = this.domElement.getBoundingClientRect();
    const pointer = new THREE.Vector2(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(pointer, this.camera);
    let point = null;
    const hit = this.raycaster.intersectObject(this.editor.root, true).find((candidate) => candidate.object.visible && candidate.face);
    if (hit) {
      const normal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
      if (normal.y > 0.7) point = hit.point.clone();
    }
    point ??= this.raycaster.ray.intersectPlane(FLOOR, new THREE.Vector3());
    if (!point) return null;
    const snap = this.editor.snap;
    if (snap > 0) {
      point.x = Math.round(point.x / snap) * snap;
      point.z = Math.round(point.z / snap) * snap;
    }
    return point;
  }

  moveGhostTo(event) {
    if (!event) return;
    this.lastPointer = { clientX: event.clientX, clientY: event.clientY, shiftKey: event.shiftKey };
    if (!this.ghost) return;
    const point = this.pointAt(event);
    this.ghost.visible = Boolean(point);
    if (point) this.ghost.position.copy(point);
  }

  handlePlaceClick(event) {
    this.moveGhostTo(event);
    if (!this.ghost?.visible) return;
    this.commitPlacement(event.shiftKey);
  }

  commitPlacement(keepPlacing) {
    const { entry, yaw } = this.placing;
    const position = this.ghost.position.toArray();
    this.place(entry, { position, rotation: [0, yaw > 180 ? yaw - 360 : yaw, 0] });
    if (!keepPlacing) {
      this.endPlacing();
      this.setOpen(false);
    }
  }
}
