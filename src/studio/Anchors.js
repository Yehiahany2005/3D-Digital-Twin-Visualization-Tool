import * as THREE from 'three';
import { resolveTool } from '../motion/InverseKinematics.js';

// Anchors: named points on items that other items snap or mount to (like Visual Components'
// interfaces or Process Simulate's mount frames).
//
//   flow-out ↔ flow-in      conveyor ends: dropping one near another lines them up (placement only)
//   tool-mount → tool-flange   a tool's mounting face onto a robot's tool point: mounted (follows it)
//
// Each anchor resolves to { object, position, direction }: a point and an outward direction in
// the local frame of the 3D object it moves with (an item root, or a robot joint).

const COMPATIBLE = {
  'flow-in': ['flow-out'],
  'flow-out': ['flow-in'],
  'tool-mount': ['tool-flange'],
};

export function canConnect(ownType, targetType) {
  return COMPATIBLE[ownType]?.includes(targetType) || false;
}

// The joint and point where tools mount on a machine: its tool tip as set up in Machine mode
// (for the ABB, the flange), not a tool mounted on it since.
function flangeAnchor(runtime) {
  const asset = runtime.asset;
  const tool = asset?.flangeTool || asset?.rig?.tools[0];
  if (!tool) return null;
  const resolved = resolveTool(asset.rig, tool);
  if (!resolved) return null;
  const group = resolved.joint.group;
  group.updateMatrixWorld(true);
  const inverse = group.matrixWorld.clone().invert();
  return {
    name: 'tool',
    type: 'tool-flange',
    label: 'Tool flange',
    object: group,
    jointId: resolved.joint.id,
    position: resolved.position().applyMatrix4(inverse),
    direction: resolved.direction().transformDirection(inverse),
  };
}

// All anchors of an item: [{ name, type, label, object, position, direction, jointId? }].
export function anchorsOf(runtime) {
  if (!runtime || runtime.destroyed) return [];
  if (runtime.kind === 'component') {
    return Object.entries(runtime.component.anchors || {}).map(([name, anchor]) => ({
      name,
      type: anchor.type,
      label: name,
      object: runtime.root,
      position: new THREE.Vector3(...anchor.position),
      direction: new THREE.Vector3(...anchor.direction).normalize(),
    }));
  }
  if (runtime.kind === 'model') {
    const flange = flangeAnchor(runtime);
    return flange ? [flange] : [];
  }
  return [];
}

export function anchorNamed(runtime, name) {
  return anchorsOf(runtime).find((anchor) => anchor.name === name) || null;
}

export function worldOf(anchor) {
  anchor.object.updateMatrixWorld(true);
  return {
    position: anchor.position.clone().applyMatrix4(anchor.object.matrixWorld),
    direction: anchor.direction.clone().transformDirection(anchor.object.matrixWorld),
  };
}

// Where an item has to be (in the frame of `target.object`) so that its own anchor sits on the
// target anchor, facing it. `upright` keeps the item level and only turns it about the vertical
// (conveyors); otherwise it turns freely (a tool facing a flange).
//   own: anchor in the item's own frame { position, direction }
//   target: { position, direction } in the frame the item will sit in
export function alignment(own, target, { upright = false } = {}) {
  const wanted = target.direction.clone().negate();
  let quaternion;
  if (upright) {
    const from = Math.atan2(own.direction.x, own.direction.z);
    const to = Math.atan2(wanted.x, wanted.z);
    quaternion = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), to - from);
  } else {
    quaternion = new THREE.Quaternion().setFromUnitVectors(own.direction.clone().normalize(), wanted.normalize());
  }
  const position = target.position.clone().sub(own.position.clone().applyQuaternion(quaternion));
  return { position, quaternion };
}

// The best snap for an item being dragged: its anchor closest to a compatible anchor on another
// item, within `tolerance` metres. Returns { own, target, targetId, distance } or null.
export function findSnap(runtime, runtimes, { tolerance = 0.35, exclude = new Set() } = {}) {
  const ownAnchors = anchorsOf(runtime).filter((anchor) => COMPATIBLE[anchor.type]);
  if (!ownAnchors.length) return null;
  let best = null;
  runtimes.forEach((other) => {
    if (other === runtime || exclude.has(other.id)) return;
    const targets = anchorsOf(other);
    ownAnchors.forEach((own) => {
      const ownWorld = worldOf(own);
      targets.forEach((target) => {
        if (!canConnect(own.type, target.type)) return;
        const targetWorld = worldOf(target);
        const distance = ownWorld.position.distanceTo(targetWorld.position);
        if (distance <= tolerance && (!best || distance < best.distance)) best = { own, target, targetId: other.id, distance, targetWorld };
      });
    });
  });
  return best;
}
