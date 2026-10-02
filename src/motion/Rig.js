import * as THREE from 'three';

// A rig makes parts of a model movable. It is built from a plain JSON definition:
//
//   joints: [{
//     id, name,
//     type: 'revolute' (rotates, degrees) | 'prismatic' (slides, millimetres),
//     parent: id of the joint this one is mounted on, or null for the fixed base,
//     parts: [{ name, path }]            the objects that move with this joint,
//     frame: 'model' | 'part'            coordinates below are in the model frame
//                                        or in the first part's own frame,
//     axis: [x, y, z], pivot: [x, y, z],
//     min, max, speed, zero              limits, speed per second, value at the pose the file was exported in,
//     aim:     { joint, target }         optional: rotate automatically so the pivot keeps pointing at a
//                                        point carried by another joint (cylinders, linkages),
//     stretch: { joint, target, anchor } optional: slide automatically to keep target at the same distance,
//   }]
//
// Every joint gets a pivot group placed at its pivot. Parts are re-parented under that
// group and child joints are nested inside their parent joint's group, so moving one
// joint carries everything mounted on it.

const DEFAULT_REVOLUTE = { min: -180, max: 180, speed: 60 };
const DEFAULT_PRISMATIC = { min: -1000, max: 1000, speed: 250 };

function toVector(values, fallback) {
  return Array.isArray(values) && values.length === 3 ? new THREE.Vector3(...values) : fallback.clone();
}

function sanitizeName(id) {
  return String(id).replace(/[^A-Za-z0-9_-]/g, '_');
}

function sortByDependencies(definitions, dependenciesOf) {
  const byId = new Map(definitions.map((definition) => [definition.id, definition]));
  const sorted = [];
  const state = new Map();
  const visit = (definition) => {
    if (state.get(definition.id) === 'done') return;
    if (state.get(definition.id) === 'visiting') throw new Error(`Joint "${definition.name || definition.id}" is part of a loop of parents.`);
    state.set(definition.id, 'visiting');
    dependenciesOf(definition).forEach((id) => {
      const dependency = byId.get(id);
      if (dependency) visit(dependency);
    });
    state.set(definition.id, 'done');
    sorted.push(definition);
  };
  definitions.forEach(visit);
  return sorted;
}

// The object's parent in the file's original hierarchy, even after a rig re-parented it.
export function originalParent(object) {
  return object.userData.rigOriginalParent || object.parent;
}

export function partReference(object) {
  return { path: object.userData.partPath, name: object.name || '' };
}

export function emptyRigDefinition() {
  return { version: 1, joints: [], poses: [], sequences: [] };
}

export class Rig {
  constructor({ root, content, definition }) {
    this.root = root;
    this.content = content;
    this.joints = [];
    this.jointsById = new Map();
    this.warnings = [];
    this.listeners = new Set();

    this.assignPartPaths();
    this.createBaseJoints();
    this.setDefinition(definition || emptyRigDefinition());
  }

  // Records each object's position in the file's original hierarchy, e.g. "0/3/1".
  // Joint definitions refer to parts by this path, which survives re-parenting.
  assignPartPaths() {
    const visit = (object, path) => {
      if (object.userData.partPath === undefined) object.userData.partPath = path;
      object.children.forEach((child, index) => visit(child, path ? `${path}/${index}` : String(index)));
    };
    visit(this.content, '');
  }

  findPart(reference, claimed) {
    let byPath = null;
    let byName = null;
    this.content.traverse((object) => {
      if (object.userData.rigJointId !== undefined || claimed.has(object)) return;
      if (reference.path !== undefined && object.userData.partPath === reference.path) byPath ??= object;
      if (reference.name && object.name === reference.name) byName ??= object;
    });
    if (byPath && (!reference.name || byPath.name === reference.name)) return byPath;
    return byName || byPath;
  }

  get metresPerUnit() {
    return this.content.getWorldScale(new THREE.Vector3()).x;
  }

  createBaseJoints() {
    const size = new THREE.Box3().setFromObject(this.root).getSize(new THREE.Vector3());
    const range = Math.ceil(Math.max(10, Math.max(size.x, size.y, size.z) * 5)) * 1000;
    const base = (id, name, type, min, max, speed) => ({
      id, name, type, kind: 'base', driven: false, min, max, speed, zero: 0, value: 0,
    });
    this.baseJoints = [
      base('base.x', 'Move X', 'prismatic', -range, range, 500),
      base('base.z', 'Move Z', 'prismatic', -range, range, 500),
      base('base.y', 'Height', 'prismatic', -range, range, 250),
      base('base.yaw', 'Rotate', 'revolute', -180, 180, 45),
    ];
    this.baseJoints.forEach((joint) => this.jointsById.set(joint.id, joint));
  }

  get allJoints() {
    return [...this.baseJoints, ...this.joints];
  }

  get controllableJoints() {
    return this.joints.filter((joint) => !joint.driven);
  }

  get poses() {
    return this.definition.poses;
  }

  get sequences() {
    return this.definition.sequences;
  }

  onChange(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emitChange() {
    this.listeners.forEach((listener) => listener(this));
  }

  setDefinition(definition) {
    const previousValues = this.getPose();
    this.teardown();
    this.definition = {
      version: 1,
      ...definition,
      joints: definition.joints || [],
      poses: definition.poses || [],
      sequences: definition.sequences || [],
    };
    this.build();
    this.setValues(previousValues);
    this.emitChange();
  }

  build() {
    this.warnings = [];
    this.root.updateMatrixWorld(true);
    const contentInverse = this.content.matrixWorld.clone().invert();
    const ordered = sortByDependencies(this.definition.joints, (definition) => [definition.parent].filter(Boolean));
    const claimed = new Set();

    ordered.forEach((definition) => {
      const parts = (definition.parts || []).map((reference) => {
        const part = this.findPart(reference, claimed);
        if (!part) this.warnings.push(`Joint "${definition.name}": part "${reference.name || reference.path}" was not found.`);
        else claimed.add(part);
        return part;
      }).filter(Boolean);

      // Matrix from the definition's coordinate frame into the model (content) frame.
      const frame = definition.frame === 'part' && parts[0]
        ? contentInverse.clone().multiply(parts[0].matrixWorld)
        : new THREE.Matrix4();
      const pivot = toVector(definition.pivot, new THREE.Vector3()).applyMatrix4(frame);
      const axis = toVector(definition.axis, new THREE.Vector3(0, 1, 0)).transformDirection(frame);

      const group = new THREE.Group();
      group.name = `joint_${sanitizeName(definition.id)}`;
      group.userData.rigJointId = definition.id;
      group.position.copy(pivot);
      this.content.add(group);
      group.updateMatrixWorld(true);
      const parentJoint = definition.parent ? this.jointsById.get(definition.parent) : null;
      if (definition.parent && !parentJoint) this.warnings.push(`Joint "${definition.name}": parent "${definition.parent}" does not exist.`);
      (parentJoint?.group || this.content).attach(group);

      parts.forEach((part) => {
        part.userData.rigOriginalParent ??= part.parent;
        group.attach(part);
      });

      const defaults = definition.type === 'prismatic' ? DEFAULT_PRISMATIC : DEFAULT_REVOLUTE;
      const joint = {
        id: definition.id,
        name: definition.name || definition.id,
        type: definition.type === 'prismatic' ? 'prismatic' : 'revolute',
        kind: 'joint',
        definition,
        driven: Boolean(definition.aim || definition.stretch),
        min: Number.isFinite(definition.min) ? definition.min : defaults.min,
        max: Number.isFinite(definition.max) ? definition.max : defaults.max,
        speed: Number.isFinite(definition.speed) && definition.speed > 0 ? definition.speed : defaults.speed,
        zero: Number.isFinite(definition.zero) ? definition.zero : 0,
        value: Number.isFinite(definition.zero) ? definition.zero : 0,
        group,
        parts,
        frameMatrix: frame,
        pivotInModel: pivot.clone(),
        axis: axis.normalize(),
        restPosition: group.position.clone(),
        restQuaternion: group.quaternion.clone(),
        pointInFrame: (values) => toVector(values, new THREE.Vector3()).applyMatrix4(frame),
      };
      this.joints.push(joint);
      this.jointsById.set(joint.id, joint);
    });

    this.joints.filter((joint) => joint.driven).forEach((joint) => this.prepareDriven(joint));
    this.drivenOrder = sortByDependencies(
      this.joints.filter((joint) => joint.driven).map((joint) => joint.definition),
      (definition) => [definition.parent, definition.aim?.joint, definition.stretch?.joint].filter(Boolean),
    ).map((definition) => this.jointsById.get(definition.id));
    this.root.updateMatrixWorld(true);
  }

  // Captures, in the rest pose, where a driven joint's target sits relative to the joint that carries it.
  prepareDriven(joint) {
    const link = joint.definition.aim || joint.definition.stretch;
    const carrier = this.jointsById.get(link.joint)?.group || this.content;
    const toWorld = (values) => this.content.localToWorld(joint.pointInFrame(values));
    const parent = joint.group.parent;

    const targetWorld = toWorld(link.target);
    joint.linkCarrier = carrier;
    joint.linkTargetLocal = carrier.worldToLocal(targetWorld.clone());
    const targetInParent = parent.worldToLocal(targetWorld.clone());

    if (joint.type === 'revolute') {
      joint.restDirection = targetInParent.sub(joint.restPosition).projectOnPlane(joint.axis).normalize();
    } else {
      joint.anchorInParent = parent.worldToLocal(link.anchor ? toWorld(link.anchor) : joint.group.getWorldPosition(new THREE.Vector3()));
      joint.restDistance = targetInParent.distanceTo(joint.anchorInParent);
    }
  }

  teardown() {
    if (!this.joints.length) return;
    this.joints.forEach((joint) => {
      joint.group.position.copy(joint.restPosition);
      joint.group.quaternion.copy(joint.restQuaternion);
    });
    this.root.updateMatrixWorld(true);
    [...this.joints].reverse().forEach((joint) => {
      joint.parts.forEach((part) => {
        const original = part.userData.rigOriginalParent;
        if (original) original.attach(part);
        delete part.userData.rigOriginalParent;
      });
      joint.group.removeFromParent();
      this.jointsById.delete(joint.id);
    });
    this.joints = [];
    this.drivenOrder = [];
  }

  dispose() {
    this.teardown();
    this.listeners.clear();
  }

  // Runs fn with every joint at its rest pose (the pose the file was exported in),
  // which is the pose joint pivots and axes are defined in. Restores the pose after.
  withRestPose(fn) {
    const pose = this.getPose();
    const rest = {};
    this.joints.forEach((joint) => {
      if (!joint.driven) rest[joint.id] = joint.zero;
    });
    this.setValues(rest);
    this.root.updateMatrixWorld(true);
    try {
      return fn();
    } finally {
      this.setValues(pose);
      this.root.updateMatrixWorld(true);
    }
  }

  // Converts a pivot/axis given in model coordinates (rest pose) into world space for
  // the current pose, as if mounted on `parentId`. Used to draw the joint being edited.
  modelToWorld(point, direction, parentId) {
    const parent = parentId ? this.jointsById.get(parentId) : null;
    if (!parent?.group) {
      return {
        point: this.content.localToWorld(point.clone()),
        direction: direction.clone().transformDirection(this.content.matrixWorld),
      };
    }
    // At rest a joint group sits at its pivot with no rotation relative to the model.
    return {
      point: parent.group.localToWorld(point.clone().sub(parent.pivotInModel)),
      direction: direction.clone().transformDirection(parent.group.matrixWorld),
    };
  }

  getValue(id) {
    return this.jointsById.get(id)?.value ?? null;
  }

  // Values of everything a user can control: base motion plus non-driven joints.
  getPose() {
    const pose = {};
    this.allJoints.forEach((joint) => {
      if (!joint.driven) pose[joint.id] = joint.value;
    });
    return pose;
  }

  clamp(joint, value) {
    return THREE.MathUtils.clamp(value, joint.min, joint.max);
  }

  setValue(id, value) {
    this.setValues({ [id]: value });
  }

  setValues(values) {
    Object.entries(values || {}).forEach(([id, value]) => {
      const joint = this.jointsById.get(id);
      if (!joint || joint.driven || !Number.isFinite(value)) return;
      joint.value = this.clamp(joint, value);
    });
    this.apply();
  }

  apply() {
    this.baseJoints.forEach((joint) => this.applyBase(joint));
    this.joints.forEach((joint) => {
      if (!joint.driven) this.applyJoint(joint);
    });
    if (!this.drivenOrder?.length) return;
    this.root.updateMatrixWorld(true);
    this.drivenOrder.forEach((joint) => {
      joint.value = this.solveDriven(joint);
      this.applyJoint(joint);
      joint.group.updateMatrixWorld(true);
    });
  }

  applyBase(joint) {
    if (joint.id === 'base.yaw') this.root.rotation.y = THREE.MathUtils.degToRad(joint.value);
    else this.root.position[joint.id.slice(5)] = joint.value / 1000;
  }

  applyJoint(joint) {
    const offset = joint.value - joint.zero;
    if (joint.type === 'revolute') {
      joint.group.quaternion.copy(joint.restQuaternion)
        .multiply(new THREE.Quaternion().setFromAxisAngle(joint.axis, THREE.MathUtils.degToRad(offset)));
    } else {
      const distance = offset / 1000 / this.metresPerUnit;
      joint.group.position.copy(joint.restPosition)
        .addScaledVector(joint.axis.clone().applyQuaternion(joint.restQuaternion), distance);
    }
  }

  solveDriven(joint) {
    const parent = joint.group.parent;
    const targetWorld = joint.linkCarrier.localToWorld(joint.linkTargetLocal.clone());
    const targetInParent = parent.worldToLocal(targetWorld);

    if (joint.type === 'revolute') {
      const direction = targetInParent.sub(joint.restPosition).projectOnPlane(joint.axis).normalize();
      const angle = Math.atan2(
        new THREE.Vector3().crossVectors(joint.restDirection, direction).dot(joint.axis),
        joint.restDirection.dot(direction),
      );
      return joint.zero + THREE.MathUtils.radToDeg(angle);
    }
    const stretch = targetInParent.distanceTo(joint.anchorInParent) - joint.restDistance;
    return joint.zero + stretch * this.metresPerUnit * 1000;
  }
}
