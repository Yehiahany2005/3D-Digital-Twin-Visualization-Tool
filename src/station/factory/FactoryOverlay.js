import * as THREE from 'three';
import { ArrowLeft, ArrowUpRight, Eye, EyeOff, Package, createElement } from 'lucide';
import './factoryOverlay.css';

/*
 * KPI values below are mock / sample data for the demo. They are kept mutually
 * consistent (e.g. 4,128 cans = 1,032 cases = 38 pallets of 27) and every KPI group
 * is labelled "Sample data" in the UI. Live process state comes from the factory.
 */
const FACTORY_KPIS = [
  { label: 'Production output', value: '4,128', unit: 'cans', meta: 'This shift, target 4,300' },
  { label: 'Efficiency', value: '96.0', unit: '%', meta: 'Output against shift plan' },
  { label: 'OEE', value: '81.7', unit: '%', meta: 'Avail. 93.1  Perf. 90.6  Qual. 96.9' },
  { label: 'Completed boxes', value: '1,032', unit: 'cases', meta: '<strong>38</strong> pallets wrapped' },
];

const STATIONS = [
  {
    name: 'Filling & Capping',
    summary: '4-head volumetric filler with servo capper',
    liveKey: 'station1',
    kpis: [
      { label: 'Throughput', value: '8.6', unit: 'cans/min', meta: 'Rated 11.4, paced by packing' },
      { label: 'Fill accuracy', value: '99.6', unit: '%', meta: 'Spec 99.5 % or better' },
      { label: 'Cap torque', value: '2.6', unit: 'Nm', meta: 'Window 2.4 to 2.8 Nm' },
      { label: 'Availability', value: '94.2', unit: '%', meta: '<strong>+1.3 pts</strong> vs last shift' },
    ],
  },
  {
    name: 'Case Packing',
    summary: 'Gantry robot packs 4 cans per case',
    liveKey: 'station2',
    kpis: [
      { label: 'Cases per hour', value: '129', unit: 'cases/h', meta: 'Line bottleneck, target 132' },
      { label: 'Pick success', value: '99.8', unit: '%', meta: '2 misses in 1,032 picks' },
      { label: 'Cycle time', value: '27.6', unit: 's', meta: 'Per case of 4 cans' },
      { label: 'Carton waste', value: '0.4', unit: '%', meta: '<strong>-0.2 pts</strong> vs last shift' },
    ],
  },
  {
    name: 'Palletizing & Wrapping',
    summary: 'ABB robot stacks 3 × 3 × 3, then stretch wrap',
    liveKey: 'station3',
    kpis: [
      { label: 'Cases palletized', value: '129', unit: 'cases/h', meta: 'Robot capacity 252/h' },
      { label: 'Pallet cycle', value: '12.6', unit: 'min', meta: 'Stack, transfer and wrap' },
      { label: 'Robot utilization', value: '51.2', unit: '%', meta: 'Paced by case packing' },
      { label: 'Film per pallet', value: '0.42', unit: 'kg', meta: '<strong>-6 %</strong> vs last week' },
    ],
  },
];

const VIEWPORT_PADDING = 12;
const LABEL_LIFT = 0.6;
const FLY_SECONDS = 1.15;
const INSPECT_MIN_DISTANCE = 0.25;
const CLICK_TOLERANCE_PX = 5;
const ACCENT = 0x69c7d3;

function el(tag, className, html) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (html !== undefined) node.innerHTML = html;
  return node;
}

function icon(node) {
  return createElement(node, { width: 16, height: 16, 'stroke-width': 1.75, 'aria-hidden': 'true' });
}

function kpiCard({ label, value, unit, meta }) {
  const card = el('div', 'fx-kpi');
  card.append(
    el('span', 'fx-kpi-label', label),
    el('span', 'fx-kpi-value', `${value}<span class="fx-kpi-unit">${unit}</span>`),
    el('span', 'fx-kpi-meta', meta),
  );
  return card;
}

const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/**
 * Interactive information layer for the Factory scene: factory title + KPIs, a
 * floating label per station, click-to-inspect camera flights with station KPI
 * panels, and a single Hide UI / Show UI switch. It never touches station
 * geometry or production state; its only 3D content is the floor brackets.
 */
export class FactoryOverlay {
  constructor({ container, camera, controls, domElement, factory }) {
    this.container = container;
    this.camera = camera;
    this.controls = controls;
    this.domElement = domElement;
    this.factory = factory;
    this.active = false;
    this.uiVisible = true;
    this.focused = null;
    this.meshHover = null;
    this.labelHover = null;
    this.boxes = [];
    this.tween = null;
    this.overview = null;
    this.highlights = null;
    this.raycaster = new THREE.Raycaster();
    this.projected = new THREE.Vector3();
    this.buildDom();
    this.bindEvents();
  }

  // ---- DOM -----------------------------------------------------------------------------

  buildDom() {
    const root = el('div', 'fx-overlay');
    root.hidden = true;
    this.root = root;

    // Factory title + KPI block.
    this.titleAnchor = el('div', 'fx-anchor');
    this.titleBlock = el('div', 'fx-title-block fx-info');
    const title = el('button', 'fx-title');
    title.type = 'button';
    title.title = 'Show the whole line';
    title.append(el('span', 'fx-title-text', 'Lubricant Line 01'), el('span', 'fx-title-sub', 'Raw materials to finished pallet'));
    title.addEventListener('click', () => this.showOverview());
    const head = el('div', 'fx-kpi-head');
    head.append(el('span', '', 'Shift performance'), el('span', 'fx-chip', ''));
    const grid = el('div', 'fx-kpi-grid');
    FACTORY_KPIS.forEach((kpi) => grid.append(kpiCard(kpi)));
    this.titleBlock.append(title, head, grid);
    this.titleAnchor.append(this.titleBlock);
    root.append(this.titleAnchor);

    // Station labels + focus panels.
    this.stations = STATIONS.map((station, index) => {
      const anchor = el('div', 'fx-anchor fx-station-anchor');
      const label = el('button', 'fx-station fx-info');
      label.type = 'button';
      label.setAttribute('aria-label', `Inspect station ${index + 1}, ${station.name}`);
      const body = el('span', 'fx-station-body');
      const reveal = el('span', 'fx-station-reveal');
      const revealInner = el('span');
      const cta = el('span', 'fx-station-cta', 'Inspect station');
      cta.append(icon(ArrowUpRight));
      revealInner.append(el('span', 'fx-station-summary', station.summary), cta);
      reveal.append(revealInner);
      body.append(el('span', 'fx-station-kicker', `Station ${index + 1}`), el('span', 'fx-station-name', station.name), reveal);
      label.append(el('span', 'fx-station-index', String(index + 1)), body);
      label.addEventListener('click', () => this.focusStation(index));
      label.addEventListener('pointerenter', () => { this.labelHover = index; });
      label.addEventListener('pointerleave', () => { if (this.labelHover === index) this.labelHover = null; });
      label.addEventListener('focus', () => { this.labelHover = index; });
      label.addEventListener('blur', () => { if (this.labelHover === index) this.labelHover = null; });
      const stem = el('span', 'fx-stem');
      anchor.append(label, stem);

      const focusAnchor = el('div', 'fx-anchor');
      const focus = el('section', 'fx-focus fx-info is-off');
      focus.setAttribute('aria-label', `Station ${index + 1} details`);
      const focusHead = el('header', 'fx-focus-head');
      const titleBox = el('div');
      titleBox.append(el('h3', '', station.name), el('p', '', `Station ${index + 1}. ${station.summary}`));
      focusHead.append(el('span', 'fx-station-index', String(index + 1)), titleBox, el('span', 'fx-chip', 'Sample data'));
      const live = el('div', 'fx-focus-live');
      const liveText = el('span');
      live.append(el('span', '', 'Live'), liveText);
      const focusGrid = el('div', 'fx-kpi-grid fx-kpi-grid--2');
      station.kpis.forEach((kpi) => focusGrid.append(kpiCard(kpi)));
      focus.append(focusHead, live, focusGrid);
      focusAnchor.append(focus);

      root.append(anchor, focusAnchor);
      return { ...station, anchor, label, stem, focusAnchor, focus, liveText, liveValue: '' };
    });

    // Viewport controls.
    this.backButton = el('button', 'fx-btn fx-back is-off');
    this.backButton.type = 'button';
    this.backButton.append(icon(ArrowLeft), el('span', '', 'Factory overview'), el('kbd', '', 'Esc'));
    this.backButton.addEventListener('click', () => this.showOverview());

    this.toggleButton = el('button', 'fx-btn fx-toggle');
    this.toggleButton.type = 'button';
    this.toggleButton.addEventListener('click', () => this.setUiVisible(!this.uiVisible));
    this.renderToggle();

    // Switches the jerry cans between the station's own can and the yellow retail can.
    this.canButton = el('button', 'fx-btn fx-can');
    this.canButton.type = 'button';
    this.canButton.title = 'Switch the jerry can design';
    this.canButton.addEventListener('click', () => this.toggleCanLook());
    this.renderCanButton();

    root.append(this.backButton, this.canButton, this.toggleButton);
    this.container.append(root);
  }

  renderToggle() {
    this.toggleButton.replaceChildren(
      icon(this.uiVisible ? EyeOff : Eye),
      el('span', '', this.uiVisible ? 'Hide UI' : 'Show UI'),
      el('kbd', '', 'H'),
    );
    this.toggleButton.setAttribute('aria-pressed', String(!this.uiVisible));
  }

  toggleCanLook() {
    this.factory.setCanLook(this.factory.canLook === 'branded' ? 'classic' : 'branded');
    this.renderCanButton();
  }

  renderCanButton() {
    const branded = this.factory.canLook === 'branded';
    this.canButton.replaceChildren(
      icon(Package),
      el('span', '', branded ? 'Can: Shell' : 'Can: Classic'),
      el('kbd', '', 'C'),
    );
    this.canButton.setAttribute('aria-pressed', String(branded));
  }

  // ---- Events ----------------------------------------------------------------------------

  bindEvents() {
    let down = null;
    let pendingMove = null;
    this.domElement.addEventListener('pointermove', (event) => {
      if (!this.active || event.buttons) return;
      const queued = pendingMove;
      pendingMove = event;
      if (queued) return;
      requestAnimationFrame(() => {
        const latest = pendingMove;
        pendingMove = null;
        if (latest && this.active) this.meshHover = this.pick(latest);
      });
    });
    this.domElement.addEventListener('pointerleave', () => { this.meshHover = null; });
    this.domElement.addEventListener('pointerdown', (event) => {
      if (this.active && event.button === 0) down = { x: event.clientX, y: event.clientY };
    });
    this.domElement.addEventListener('pointerup', (event) => {
      const start = down;
      down = null;
      if (!this.active || !start || this.tween) return;
      if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > CLICK_TOLERANCE_PX) return;
      const index = this.pick(event);
      if (index !== null) this.focusStation(index);
    });
    window.addEventListener('keydown', (event) => {
      if (!this.active || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.target.closest?.('input, textarea, select, [contenteditable="true"]')) return;
      if (event.key === 'Escape' && this.focused !== null) this.showOverview();
      if (event.key === 'h' || event.key === 'H') this.setUiVisible(!this.uiVisible);
      if (event.key === 'c' || event.key === 'C') this.toggleCanLook();
    });
  }

  /** Index of the nearest station whose bounds the pointer ray hits, or null. */
  pick(event) {
    const rect = this.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    let best = null;
    let bestDistance = Infinity;
    const hit = new THREE.Vector3();
    this.boxes.forEach((box, index) => {
      if (!this.raycaster.ray.intersectBox(box, hit)) return;
      const distance = hit.distanceTo(this.raycaster.ray.origin);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = index;
      }
    });
    return best;
  }

  // ---- Lifecycle -------------------------------------------------------------------------

  /** Call after the factory is shown and the camera framed on it. */
  activate() {
    this.active = true;
    this.root.hidden = false;
    this.focused = null;
    this.meshHover = null;
    this.labelHover = null;
    this.factory.root.updateMatrixWorld(true);
    this.boxes = this.factory.stationRoots.map((root) => new THREE.Box3().setFromObject(root));
    this.lineBounds = this.boxes.reduce((all, box) => all.union(box), new THREE.Box3());
    this.overview = { position: this.camera.position.clone(), target: this.controls.target.clone() };
    // The whole-line framing sets a ~3.6 m zoom floor; allow close inspection of station details.
    this.savedMinDistance = this.controls.minDistance;
    this.controls.minDistance = INSPECT_MIN_DISTANCE;
    this.buildHighlights();
  }

  deactivate() {
    this.active = false;
    this.root.hidden = true;
    this.tween = null;
    this.controls.enabled = true;
    if (this.savedMinDistance !== undefined) this.controls.minDistance = this.savedMinDistance;
    this.domElement.style.cursor = '';
    this.highlights?.group.removeFromParent();
    this.highlights = null;
  }

  setUiVisible(visible) {
    this.uiVisible = visible;
    this.renderToggle();
  }

  // ---- Camera ----------------------------------------------------------------------------

  focusStation(index) {
    this.focused = index;
    this.labelHover = null;
    this.flyTo(this.stationPose(this.boxes[index]));
  }

  showOverview() {
    this.focused = null;
    if (this.overview) this.flyTo(this.overview);
  }

  stationPose(box) {
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const radius = size.length() / 2;
    const halfVertical = THREE.MathUtils.degToRad(this.camera.fov / 2);
    const halfHorizontal = Math.atan(Math.tan(halfVertical) * this.camera.aspect);
    const distance = (radius / Math.sin(Math.min(halfVertical, halfHorizontal))) * 0.78;
    const target = new THREE.Vector3(center.x, box.min.y + size.y * 0.35, center.z);
    const direction = new THREE.Vector3(0.38, 0.58, 1).normalize();
    return { position: target.clone().addScaledVector(direction, distance), target };
  }

  flyTo({ position, target }) {
    if (reducedMotion()) {
      this.camera.position.copy(position);
      this.controls.target.copy(target);
      this.tween = null;
      this.controls.enabled = true;
      return;
    }
    this.tween = {
      fromPosition: this.camera.position.clone(),
      fromTarget: this.controls.target.clone(),
      toPosition: position.clone(),
      toTarget: target.clone(),
      progress: 0,
    };
    this.controls.enabled = false;
  }

  // ---- Floor brackets (hover / selection feedback) -----------------------------------------

  buildHighlights() {
    this.highlights?.group.removeFromParent();
    const group = new THREE.Group();
    group.name = 'FactoryOverlayHighlights';
    const items = this.boxes.map((box, index) => {
      const material = new THREE.MeshBasicMaterial({ color: ACCENT, transparent: true, opacity: 0, depthWrite: false, toneMapped: false });
      const fillMaterial = material.clone();
      const station = new THREE.Group();
      station.name = `Station ${index + 1} brackets`;
      const margin = 0.35;
      const minX = box.min.x - margin;
      const maxX = box.max.x + margin;
      const minZ = box.min.z - margin;
      const maxZ = box.max.z + margin;
      const arm = Math.min(1.4, (maxX - minX) * 0.16, (maxZ - minZ) * 0.3);
      const width = 0.08;
      const strip = (w, d, x, z) => {
        const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, d), material);
        mesh.rotation.x = -Math.PI / 2;
        mesh.position.set(x, 0.03, z);
        mesh.renderOrder = 5;
        station.add(mesh);
      };
      [[minX, 1], [maxX, -1]].forEach(([x, sx]) => {
        [[minZ, 1], [maxZ, -1]].forEach(([z, sz]) => {
          strip(arm, width, x + sx * arm / 2, z + sz * width / 2);
          strip(width, arm, x + sx * width / 2, z + sz * arm / 2);
        });
      });
      const fill = new THREE.Mesh(new THREE.PlaneGeometry(maxX - minX, maxZ - minZ), fillMaterial);
      fill.rotation.x = -Math.PI / 2;
      fill.position.set((minX + maxX) / 2, 0.025, (minZ + maxZ) / 2);
      fill.renderOrder = 4;
      station.add(fill);
      group.add(station);
      return { material, fillMaterial, level: 0 };
    });
    // Hover/focus outlines are UI: they keep their own look in Digital Twin View.
    group.userData.helper = true;
    this.factory.root.add(group);
    this.highlights = { group, items };
  }

  // ---- Frame update ------------------------------------------------------------------------

  update(delta) {
    if (!this.active) return;
    this.updateTween(delta);
    const hot = this.uiVisible && this.focused === null ? (this.labelHover ?? this.meshHover) : null;
    this.domElement.style.cursor = this.meshHover !== null && !this.tween ? 'pointer' : '';
    this.updateHighlights(delta, hot);
    this.updateDom(hot);
  }

  updateTween(delta) {
    const tween = this.tween;
    if (!tween) return;
    tween.progress = Math.min(tween.progress + delta / FLY_SECONDS, 1);
    const eased = easeInOutCubic(tween.progress);
    this.camera.position.lerpVectors(tween.fromPosition, tween.toPosition, eased);
    this.controls.target.lerpVectors(tween.fromTarget, tween.toTarget, eased);
    if (tween.progress >= 1) {
      this.tween = null;
      this.controls.enabled = true;
    }
  }

  updateHighlights(delta, hot) {
    if (!this.highlights) return;
    this.highlights.group.visible = this.uiVisible;
    const rate = reducedMotion() ? 1 : Math.min(delta * 8, 1);
    this.highlights.items.forEach((item, index) => {
      const target = hot === index ? 1 : this.focused === index ? 0.55 : 0;
      item.level += (target - item.level) * rate;
      item.material.opacity = 0.9 * item.level;
      item.fillMaterial.opacity = 0.07 * item.level;
    });
  }

  /** Projects a world point to viewport pixels; null when behind the camera. */
  toScreen(point, width, height) {
    this.projected.copy(point).project(this.camera);
    if (this.projected.z > 1) return null;
    return { x: (this.projected.x + 1) / 2 * width, y: (1 - this.projected.y) / 2 * height };
  }

  /** Places an element centred above `screen`, kept inside the viewport. Returns its top edge. */
  place(anchor, screen, width, height, maxBottom = Infinity) {
    const w = anchor.offsetWidth;
    const h = anchor.offsetHeight;
    const x = THREE.MathUtils.clamp(screen.x, VIEWPORT_PADDING + w / 2, Math.max(VIEWPORT_PADDING + w / 2, width - VIEWPORT_PADDING - w / 2));
    const bottom = Math.max(Math.min(screen.y, maxBottom, height - VIEWPORT_PADDING), VIEWPORT_PADDING + h);
    anchor.style.transform = `translate3d(${Math.round(x - w / 2)}px, ${Math.round(bottom - h)}px, 0)`;
    return bottom - h;
  }

  updateDom(hot) {
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    const overviewMode = this.focused === null;
    const status = this.factory.status;
    let labelsTop = Infinity;

    this.stations.forEach((station, index) => {
      const box = this.boxes[index];
      const top = new THREE.Vector3((box.min.x + box.max.x) / 2, box.max.y + LABEL_LIFT, (box.min.z + box.max.z) / 2);
      const screen = this.toScreen(top, width, height);
      const showLabel = this.uiVisible && overviewMode && screen;
      station.label.classList.toggle('is-off', !showLabel);
      station.stem.classList.toggle('is-off', !showLabel);
      station.label.classList.toggle('is-hot', hot === index);
      if (screen) {
        const labelTop = this.place(station.anchor, screen, width, height);
        if (showLabel) labelsTop = Math.min(labelsTop, labelTop);
      }

      const showFocus = this.uiVisible && this.focused === index && (!this.tween || this.tween.progress > 0.55);
      station.focus.classList.toggle('is-off', !showFocus);
      if (this.focused === index && screen) this.place(station.focusAnchor, screen, width, height);
      if (showFocus) {
        const live = status[station.liveKey] + (index === 2 ? `  ${status.palletBoxes}/${status.palletTotal} cases on pallet` : '');
        if (live !== station.liveValue) {
          station.liveValue = live;
          station.liveText.textContent = live;
        }
      }
    });

    // Title sits above the line, and above the station labels if they would collide.
    const lineTop = new THREE.Vector3(
      (this.lineBounds.min.x + this.lineBounds.max.x) / 2,
      this.lineBounds.max.y + 3,
      (this.lineBounds.min.z + this.lineBounds.max.z) / 2,
    );
    const titleScreen = this.toScreen(lineTop, width, height);
    const showTitle = this.uiVisible && overviewMode && titleScreen;
    this.titleBlock.classList.toggle('is-off', !showTitle);
    if (titleScreen) this.place(this.titleAnchor, titleScreen, width, height, labelsTop - 16);

    this.backButton.classList.toggle('is-off', overviewMode);
  }
}
