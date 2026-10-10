import * as THREE from 'three';

const TRANSITION_DURATION = 0.4;
const DIGITAL_BACKGROUND = new THREE.Color(0x111a22);
const DIGITAL_FLOOR = new THREE.Color(0x1d2a31);
const DIGITAL_ROBOT = new THREE.Color(0x3d9caf);
const DIGITAL_EMISSIVE = new THREE.Color(0x0b5362);
const DIGITAL_GRID = new THREE.Color(0x3b8190);

function cloneMaterials(material) {
  return Array.isArray(material) ? material.map((item) => item.clone()) : material.clone();
}

function eachMaterial(material, callback) {
  if (Array.isArray(material)) material.forEach(callback);
  else callback(material);
}

function blendMaterial(working, from, to, progress) {
  working.color.lerpColors(from.color, to.color, progress);
  if (working.emissive && from.emissive && to.emissive) {
    working.emissive.lerpColors(from.emissive, to.emissive, progress);
    working.emissiveIntensity = THREE.MathUtils.lerp(from.emissiveIntensity ?? 0, to.emissiveIntensity ?? 0, progress);
  }
  if ('metalness' in working) working.metalness = THREE.MathUtils.lerp(from.metalness, to.metalness, progress);
  if ('roughness' in working) working.roughness = THREE.MathUtils.lerp(from.roughness, to.roughness, progress);
  working.opacity = THREE.MathUtils.lerp(from.opacity, to.opacity, progress);
  working.transparent = progress > 0.01 || to.transparent;
  working.depthWrite = progress < 0.98 || to.depthWrite;
}

export class DigitalTwinViewManager {
  constructor({ scene, robot, floor, lightingGroup, toggleButton, modeElement }) {
    this.scene = scene;
    this.robot = robot;
    this.floor = floor;
    this.lightingGroup = lightingGroup;
    this.toggleButton = toggleButton;
    this.modeElement = modeElement;
    this.isDigitalTwin = false;
    this.transition = null;
    this.materialSlots = [];
    this.lightSlots = [];
    this.originalBackground = scene.background.clone();
    this.originalFog = scene.fog ? {
      color: scene.fog.color.clone(),
      near: scene.fog.near,
      far: scene.fog.far,
    } : null;
    this.digitalBackground = DIGITAL_BACKGROUND.clone();
    this.grid = this.createGrid();
    this.digitalLights = this.createDigitalLights();

    this.captureMaterials();
    this.captureLights();
    this.toggleButton?.addEventListener('click', () => this.toggle());
    this.updateUi();
  }

  // robot: what gets the Digital Twin tint (a model, a whole scene, or null for nothing but the floor).
  captureMaterials() {
    this.robot?.traverse((object) => {
      // Helpers (like the selection tint) and floor plans keep their own look.
      if (!object.isMesh || !object.material || object.userData.helper || object.userData.ownLook) return;
      const original = object.material;
      const digital = cloneMaterials(original);
      const working = cloneMaterials(original);

      eachMaterial(digital, (material) => {
        material.color.lerp(DIGITAL_ROBOT, 0.72);
        if (material.emissive) {
          material.emissive.copy(DIGITAL_EMISSIVE);
          material.emissiveIntensity = 0.18;
        }
        if ('metalness' in material) material.metalness = Math.max(material.metalness, 0.48);
        if ('roughness' in material) material.roughness = Math.min(material.roughness, 0.42);
        material.transparent = true;
        material.opacity = 0.86;
        material.depthWrite = true;
      });

      this.materialSlots.push({ object, original, digital, working });
    });

    if (this.floor?.material) {
      const original = this.floor.material;
      const digital = original.clone();
      const working = original.clone();
      digital.color.copy(DIGITAL_FLOOR);
      digital.roughness = 0.94;
      this.materialSlots.push({ object: this.floor, original, digital, working });
    }
  }

  captureLights() {
    this.lightingGroup?.traverse((light) => {
      if (!light.isLight) return;
      this.lightSlots.push({ light, intensity: light.intensity, color: light.color.clone() });
    });
  }

  createGrid() {
    const grid = new THREE.GridHelper(80, 40, DIGITAL_GRID, new THREE.Color(0x24404b));
    grid.position.y = this.floor?.position.y ?? 0;
    grid.material.transparent = true;
    grid.material.opacity = 0;
    grid.visible = false;
    this.scene.add(grid);
    return grid;
  }

  createDigitalLights() {
    const lights = new THREE.Group();
    lights.name = 'DigitalTwinLights';

    const key = new THREE.DirectionalLight(0xd9f5ff, 2.2);
    key.position.set(4, 8, 5);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.near = 0.1;
    key.shadow.camera.far = 50;
    key.shadow.camera.left = -15;
    key.shadow.camera.right = 15;
    key.shadow.camera.top = 15;
    key.shadow.camera.bottom = -15;

    const fill = new THREE.DirectionalLight(0x6ebbd0, 1.1);
    fill.position.set(-5, 4, -4);
    const rim = new THREE.DirectionalLight(0x53d2e5, 1.5);
    rim.position.set(-2, 6, -8);
    const ambient = new THREE.AmbientLight(0x9bd5df, 0.35);
    lights.add(ambient, key, fill, rim);
    lights.traverse((light) => {
      if (light.isLight) light.userData.digitalTargetIntensity = light.intensity;
    });
    lights.visible = false;
    this.scene.add(lights);
    return lights;
  }

  toggle() {
    if (this.transition) return;
    this.isDigitalTwin = !this.isDigitalTwin;
    this.startTransition(this.isDigitalTwin);
  }

  // force: capture again even if it is the same object (a scene whose items changed).
  replaceRobot(robot, { force = false } = {}) {
    if (this.robot === robot && !force) return;
    if (this.transition) this.finishTransition(this.isDigitalTwin);

    this.materialSlots.forEach((slot) => {
      slot.object.material = slot.original;
      eachMaterial(slot.digital, (material) => material.dispose());
      eachMaterial(slot.working, (material) => material.dispose());
    });

    this.robot = robot;
    this.materialSlots = [];
    this.captureMaterials();
    if (this.isDigitalTwin) {
      this.materialSlots.forEach((slot) => {
        slot.object.material = slot.digital;
      });
    }
  }

  // Puts the model's own materials back (e.g. while exporting it) and returns a function that
  // restores whatever was showing.
  useOriginalMaterials() {
    const shown = this.materialSlots.map((slot) => [slot, slot.object.material]);
    this.materialSlots.forEach((slot) => { slot.object.material = slot.original; });
    return () => shown.forEach(([slot, material]) => { slot.object.material = material; });
  }

  startTransition(toDigitalTwin) {
    const startProgress = toDigitalTwin ? 0 : 1;
    this.materialSlots.forEach((slot) => {
      const from = toDigitalTwin ? slot.original : slot.digital;
      Object.assign(slot, { from, to: toDigitalTwin ? slot.digital : slot.original });
      eachMaterial(slot.working, (material, index) => {
        const source = Array.isArray(from) ? from[index] : from;
        material.copy(source);
      });
      slot.object.material = slot.working;
    });

    this.grid.visible = true;
    this.digitalLights.visible = true;
    this.transition = { elapsed: 0, toDigitalTwin, startProgress };
    this.updateUi();
  }

  update(deltaTime) {
    if (!this.transition) return;
    const transition = this.transition;
    transition.elapsed = Math.min(transition.elapsed + deltaTime, TRANSITION_DURATION);
    const linearProgress = transition.elapsed / TRANSITION_DURATION;
    const easedProgress = linearProgress * linearProgress * (3 - 2 * linearProgress);
    const progress = THREE.MathUtils.lerp(transition.startProgress, transition.toDigitalTwin ? 1 : 0, easedProgress);

    this.materialSlots.forEach((slot) => {
      eachMaterial(slot.working, (material, index) => {
        const from = Array.isArray(slot.from) ? slot.from[index] : slot.from;
        const to = Array.isArray(slot.to) ? slot.to[index] : slot.to;
        blendMaterial(material, from, to, transition.toDigitalTwin ? easedProgress : 1 - easedProgress);
      });
    });

    this.scene.background.lerpColors(this.originalBackground, this.digitalBackground, progress);
    if (this.scene.fog && this.originalFog) {
      this.scene.fog.color.lerpColors(this.originalFog.color, this.digitalBackground, progress);
    }
    this.lightSlots.forEach(({ light, intensity, color }) => {
      light.intensity = THREE.MathUtils.lerp(intensity, 0, progress);
      light.color.lerpColors(color, new THREE.Color(0x25414a), progress);
    });
    this.digitalLights.traverse((light) => {
      if (light.isLight) light.intensity = (light.userData.digitalTargetIntensity ?? 0) * progress;
    });
    this.grid.material.opacity = progress * 0.22;

    if (transition.elapsed >= TRANSITION_DURATION) {
      this.finishTransition(transition.toDigitalTwin);
    }
  }

  finishTransition(digitalTwin) {
    this.materialSlots.forEach((slot) => {
      slot.object.material = digitalTwin ? slot.digital : slot.original;
    });
    this.digitalLights.visible = digitalTwin;
    this.grid.visible = digitalTwin;
    this.grid.material.opacity = digitalTwin ? 0.22 : 0;
    this.scene.background.copy(digitalTwin ? this.digitalBackground : this.originalBackground);
    if (this.scene.fog && this.originalFog) this.scene.fog.color.copy(digitalTwin ? this.digitalBackground : this.originalFog.color);
    this.lightSlots.forEach(({ light, intensity, color }) => {
      light.intensity = digitalTwin ? 0 : intensity;
      light.color.copy(color);
    });
    this.transition = null;
    this.updateUi();
  }

  updateUi() {
    if (this.toggleButton) this.toggleButton.textContent = 'Switch View';
    if (this.modeElement) this.modeElement.textContent = this.isDigitalTwin ? 'Digital Twin View' : 'CAD View';
  }
}
