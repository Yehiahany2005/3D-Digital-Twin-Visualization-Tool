import * as THREE from 'three';

const COLORS = { ok: 0x4cd38a, fail: 0xf06464, pending: 0x9aa3aa, hover: 0xf2c46d };

// Shows, in the 3D view, where the step being edited goes: a dot for a spot (with a dashed line
// up to where it comes from above), and a ghost box on every spot of a grid. Each is green when
// the robot can reach it, red when it can't, and grey while that is being worked out.
export class ProgramMarkers {
  constructor(scene) {
    this.group = new THREE.Group();
    this.group.name = 'Program markers';
    this.group.userData.helper = true;
    scene.add(this.group);
    this.materials = Object.fromEntries(Object.entries(COLORS).map(([state, color]) => [state, {
      solid: new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.9 }),
      ghost: new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.16, depthWrite: false }),
      edge: new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9 }),
      dash: new THREE.LineDashedMaterial({ color, dashSize: 0.05, gapSize: 0.04, depthTest: false, transparent: true }),
    }]));
    this.dot = new THREE.SphereGeometry(0.065, 16, 12);
    this.unitBox = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
    this.unitEdges = new THREE.EdgesGeometry(this.unitBox);
    this.signature = '';
  }

  clear() {
    this.group.children.slice().forEach((child) => {
      child.removeFromParent();
      if (child.isLine && child.geometry !== this.unitEdges) child.geometry.dispose();
    });
    this.signature = '';
  }

  // points: [{ position, above?, state }]; boxes: [{ position, quaternion, size, state }].
  show({ points = [], boxes = [] }) {
    const signature = JSON.stringify([points.map((point) => [point.position.toArray(), point.above?.toArray(), point.state]),
      boxes.map((box) => [box.position.toArray(), box.size, box.state])]);
    if (signature === this.signature) return;
    this.clear();
    this.signature = signature;
    points.forEach(({ position, above, state }) => {
      const materials = this.materials[state] || this.materials.pending;
      const dot = new THREE.Mesh(this.dot, materials.solid);
      dot.position.copy(position);
      dot.renderOrder = 1002;
      this.group.add(dot);
      if (above) {
        const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([position, above]), materials.dash);
        line.computeLineDistances();
        line.renderOrder = 1002;
        this.group.add(line);
      }
    });
    boxes.forEach(({ position, quaternion, size, state }) => {
      const materials = this.materials[state] || this.materials.pending;
      const ghost = new THREE.Mesh(this.unitBox, materials.ghost);
      const edges = new THREE.LineSegments(this.unitEdges, materials.edge);
      [ghost, edges].forEach((object) => {
        object.position.copy(position);
        object.quaternion.copy(quaternion);
        object.scale.set(...size);
        this.group.add(object);
      });
    });
    this.group.traverse((object) => { object.raycast = () => {}; });
  }

  // The spot a click would choose, while picking one in the view.
  showHover(position) {
    if (!position) {
      this.clear();
      return;
    }
    this.show({ points: [{ position, state: 'hover' }] });
  }
}
