import * as THREE from 'three';
import { drawnMeshes } from './Simulation.js';

const ACCENT = 0x69c7d3;

// Shows what is selected by tinting its own parts, so the highlight has the object's real shape
// (a box around a robot covers lots of empty space). Each tint is a child of the part it covers,
// so it follows joints and animations by itself.
//
// Same interface as RigHelpers' SelectionOutline: set(objects), clear(), update().
export class SelectionHighlight {
  constructor({ color = ACCENT, opacity = 0.3 } = {}) {
    this.material = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });
    this.tints = [];
    this.color = color;
    this.lineOpacity = Math.min(1, opacity * 3);
  }

  set(objects) {
    this.clear();
    objects.forEach((object) => {
      drawnMeshes(object).forEach((mesh) => this.cover(mesh));
      // A floor plan is lines: they are redrawn in the highlight colour.
      object.traverse((child) => { if (child.isLineSegments && child.userData.planLayer) this.coverLines(child); });
    });
  }

  coverLines(lines) {
    this.lineMaterial ??= new THREE.LineBasicMaterial({ color: this.color, transparent: true, opacity: this.lineOpacity, depthWrite: false });
    const tint = new THREE.LineSegments(lines.geometry, this.lineMaterial);
    tint.name = 'Selection tint';
    tint.userData.helper = true;
    tint.raycast = () => {};
    tint.renderOrder = 2;
    lines.add(tint);
    this.tints.push(tint);
  }

  cover(mesh) {
    let tint;
    if (mesh.isSkinnedMesh) {
      // A skinned part bends with its bones; the tint must use the same skeleton.
      tint = new THREE.SkinnedMesh(mesh.geometry, this.material);
      tint.bind(mesh.skeleton, mesh.bindMatrix);
      tint.bindMode = mesh.bindMode;
    } else {
      tint = new THREE.Mesh(mesh.geometry, this.material);
    }
    tint.name = 'Selection tint';
    tint.userData.helper = true;
    tint.raycast = () => {};
    tint.castShadow = false;
    tint.receiveShadow = false;
    tint.renderOrder = 1;
    mesh.add(tint);
    this.tints.push(tint);
  }

  clear() {
    this.tints.forEach((tint) => tint.removeFromParent());
    this.tints = [];
  }

  // Nothing to do per frame: the tints move with their parts.
  update() {}
}
