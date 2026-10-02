import * as THREE from 'three';

const CLICK_TOLERANCE_PX = 5;
const ACCENT = 0x69c7d3;
const TARGET_COLOR = 0xf2b84b;

// Turns clicks on the viewport into raycast hits, ignoring drags (which orbit the camera).
export class ViewportPicker {
  constructor({ domElement, camera }) {
    this.domElement = domElement;
    this.camera = camera;
    this.raycaster = new THREE.Raycaster();
    this.handler = null;
    this.target = null;
    this.down = null;

    domElement.addEventListener('pointerdown', (event) => {
      if (event.button === 0) this.down = { x: event.clientX, y: event.clientY };
    });
    domElement.addEventListener('pointerup', (event) => {
      const down = this.down;
      this.down = null;
      if (!down || !this.handler || !this.target) return;
      if (Math.hypot(event.clientX - down.x, event.clientY - down.y) > CLICK_TOLERANCE_PX) return;
      this.handler(this.pick(event), event);
    });
  }

  // handler(hit | null, event) is called for each click; pass null to stop picking.
  setHandler(handler, target) {
    this.handler = handler;
    this.target = target;
    this.domElement.style.cursor = handler ? 'crosshair' : '';
  }

  pick(event) {
    const rect = this.domElement.getBoundingClientRect();
    const pointer = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(pointer, this.camera);
    const hits = this.raycaster.intersectObject(this.target, true);
    return hits.find((hit) => hit.object.isMesh && hit.object.visible && hit.faceIndex !== undefined) || null;
  }
}

// Outline boxes around the currently selected parts.
export class SelectionOutline {
  constructor(scene) {
    this.scene = scene;
    this.helpers = [];
  }

  set(objects) {
    this.clear();
    objects.forEach((object) => {
      const helper = new THREE.BoxHelper(object, ACCENT);
      helper.material.depthTest = false;
      helper.material.transparent = true;
      helper.renderOrder = 999;
      this.scene.add(helper);
      this.helpers.push({ helper, object });
    });
  }

  clear() {
    this.helpers.forEach(({ helper }) => {
      helper.removeFromParent();
      helper.geometry.dispose();
      helper.material.dispose();
    });
    this.helpers = [];
  }

  update() {
    this.helpers.forEach(({ helper }) => helper.update());
  }
}

function overlayMaterial(color) {
  return new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.95 });
}

// Arrow along the joint axis, a dot at the pivot, a ring for rotation, and an
// optional marker for a linked joint's target point. Drawn on top of the model.
export class JointGizmo {
  constructor(scene) {
    this.group = new THREE.Group();
    this.group.name = 'JointGizmo';
    this.group.visible = false;

    this.arrow = new THREE.ArrowHelper(new THREE.Vector3(0, 1, 0), new THREE.Vector3(), 1, ACCENT, 0.2, 0.08);
    [this.arrow.line.material, this.arrow.cone.material].forEach((material) => {
      material.depthTest = false;
      material.transparent = true;
    });
    this.pivot = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), overlayMaterial(ACCENT));
    this.ring = new THREE.Mesh(new THREE.TorusGeometry(1, 0.03, 8, 48), overlayMaterial(ACCENT));
    this.target = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), overlayMaterial(TARGET_COLOR));
    this.group.add(this.arrow, this.pivot, this.ring, this.target);
    this.group.traverse((object) => { object.renderOrder = 1000; });
    scene.add(this.group);
  }

  // point/direction/target are in world space; size is the model's largest dimension.
  show({ point, direction, type, target, size }) {
    const length = size * 0.3;
    const direction3 = direction.clone().normalize();
    this.arrow.position.copy(point).addScaledVector(direction3, type === 'prismatic' ? -length / 2 : 0);
    this.arrow.setDirection(direction3);
    this.arrow.setLength(length, length * 0.18, length * 0.07);
    this.pivot.position.copy(point);
    this.pivot.scale.setScalar(size * 0.012);
    this.ring.visible = type === 'revolute';
    this.ring.position.copy(point);
    this.ring.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), direction3);
    this.ring.scale.setScalar(size * 0.08);
    this.target.visible = Boolean(target);
    if (target) {
      this.target.position.copy(target);
      this.target.scale.setScalar(size * 0.015);
    }
    this.group.visible = true;
  }

  hide() {
    this.group.visible = false;
  }
}
