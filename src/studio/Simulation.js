import * as THREE from 'three';
import { createBoxMesh } from './catalog/loads.js';

const STEP = 1 / 60;
const MAX_STEPS_PER_FRAME = 4;
const MAX_SPAWNED = 300;
const FRICTION = 0.7;
// How far above a belt a box may be and still be carried (it settles onto the belt in between).
const BELT_CONTACT = 0.04;

let rapierLoading = null;
// The physics engine (Rapier, compiled to WebAssembly) is only downloaded when a scene first plays.
function loadRapier() {
  rapierLoading ??= import('@dimforge/rapier3d-compat').then(async (module) => {
    const RAPIER = module.default || module;
    await RAPIER.init();
    return RAPIER;
  });
  return rapierLoading;
}

const v = (vector) => ({ x: vector.x, y: vector.y, z: vector.z });
const q = (quaternion) => ({ x: quaternion.x, y: quaternion.y, z: quaternion.z, w: quaternion.w });

// The parts of an item that are drawn: its own meshes, not those of items mounted on it, nor
// helpers like the selection tint.
export function drawnMeshes(root) {
  const meshes = [];
  const walk = (object) => {
    if (!object.visible || object.userData.helper || object.userData.simulated) return;
    if (object !== root && object.userData.sceneItemId) return;
    if (object.isMesh) meshes.push(object);
    object.children.forEach(walk);
  };
  walk(root);
  return meshes;
}

// A part's shape for the physics, in its own frame and at its size in the scene (its body carries
// its position and rotation): the exact triangles, so boxes touch the part itself and pass
// through the gaps between parts. Skinned parts (animated people) bend, so they use a box.
function partShape(RAPIER, mesh, scale) {
  const geometry = mesh.geometry;
  const positions = geometry?.attributes.position;
  if (!positions || positions.count < 3) return null;
  if (mesh.isSkinnedMesh) {
    geometry.computeBoundingBox();
    const size = geometry.boundingBox.getSize(new THREE.Vector3()).multiply(scale);
    const center = geometry.boundingBox.getCenter(new THREE.Vector3()).multiply(scale);
    return RAPIER.ColliderDesc.cuboid(size.x / 2, size.y / 2, size.z / 2).setTranslation(center.x, center.y, center.z);
  }
  const vertices = new Float32Array(positions.count * 3);
  for (let index = 0; index < positions.count; index += 1) {
    vertices[index * 3] = positions.getX(index) * scale.x;
    vertices[index * 3 + 1] = positions.getY(index) * scale.y;
    vertices[index * 3 + 2] = positions.getZ(index) * scale.z;
  }
  const indices = geometry.index
    ? Uint32Array.from(geometry.index.array)
    : Uint32Array.from({ length: positions.count - (positions.count % 3) }, (_, index) => index);
  if (indices.length < 3) return null;
  return RAPIER.ColliderDesc.trimesh(vertices, indices);
}

// The simulation while a scene plays (like Roblox's Play): gravity, boxes that fall, stack and
// ride conveyors, box sources that send boxes out, ends of line that take them away. Nothing it
// does is saved: stopping puts every item back where the scene document says it is.
export class Simulation {
  constructor(editor) {
    this.editor = editor;
    this.running = false;
  }

  async start() {
    const RAPIER = await loadRapier();
    this.RAPIER = RAPIER;
    const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    world.timestep = STEP;
    this.world = world;
    this.bodies = [];
    this.belts = [];
    this.sources = [];
    this.sinks = [];
    this.spawned = [];
    this.removed = [];
    this.accumulator = 0;
    this.spawnedCount = 0;

    // The floor.
    const floor = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, -0.05, 0));
    world.createCollider(RAPIER.ColliderDesc.cuboid(500, 0.05, 500).setFriction(FRICTION), floor);

    this.editor.root.updateMatrixWorld(true);
    this.editor.items.forEach((item) => {
      const runtime = this.editor.runtimes.get(item.id);
      if (!runtime || runtime.destroyed || item.hidden || !runtime.root.visible) return;
      this.addItem(item, runtime);
    });
    this.running = true;
  }

  // A model marked solid: every drawn part is a collider of its exact shape. Parts that can move
  // (on a joint, in an animation, or on something that moves) follow their part every step.
  addSolidModel(item, runtime) {
    const { RAPIER, world } = this;
    const asset = runtime.asset;
    const moving = Boolean(item.mount || item.attach || asset?.rig?.joints.length || asset?.animations?.length);
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    runtime.root.updateMatrixWorld(true);
    drawnMeshes(runtime.root).forEach((mesh) => {
      mesh.matrixWorld.decompose(position, quaternion, scale);
      const shape = partShape(RAPIER, mesh, scale);
      if (!shape) return;
      const desc = moving ? RAPIER.RigidBodyDesc.kinematicPositionBased() : RAPIER.RigidBodyDesc.fixed();
      const body = world.createRigidBody(desc.setTranslation(position.x, position.y, position.z).setRotation(q(quaternion)));
      world.createCollider(shape.setFriction(FRICTION), body);
      this.bodies.push({ item, runtime, body, type: moving ? 'kinematic' : 'static', object: mesh });
    });
  }

  addItem(item, runtime) {
    if (runtime.kind === 'model') {
      if (item.solid) this.addSolidModel(item, runtime);
      return;
    }
    const { RAPIER, world } = this;
    const root = runtime.root;
    const component = runtime.component;
    const linked = Boolean(item.mount || item.attach);
    let type = component?.body || 'none';
    const colliders = runtime.kind === 'component' ? component.colliders || [] : [];
    // Linked items (a box on a gripper, a fixture on a robot) follow what they hang off.
    if (linked && type !== 'none') type = 'kinematic';

    const position = root.getWorldPosition(new THREE.Vector3());
    const quaternion = root.getWorldQuaternion(new THREE.Quaternion());
    if (type !== 'none' && colliders.length) {
      const desc = type === 'dynamic' ? RAPIER.RigidBodyDesc.dynamic()
        : type === 'kinematic' ? RAPIER.RigidBodyDesc.kinematicPositionBased()
          : RAPIER.RigidBodyDesc.fixed();
      desc.setTranslation(position.x, position.y, position.z).setRotation(q(quaternion));
      if (type === 'dynamic') desc.setCanSleep(true).setCcdEnabled(true);
      const body = world.createRigidBody(desc);
      colliders.forEach((shape) => {
        const [x, y, z] = shape.size;
        const colliderDesc = RAPIER.ColliderDesc.cuboid(x / 2, y / 2, z / 2)
          .setTranslation(...shape.position)
          .setFriction(FRICTION);
        if (type === 'dynamic') colliderDesc.setMass((component?.mass || 8) / colliders.length);
        world.createCollider(colliderDesc, body);
      });
      // Where the bottom of the shape is, relative to the body's origin (for "standing on a belt").
      const bottomOffset = Math.min(...colliders.map((shape) => shape.position[1] - shape.size[1] / 2));
      this.bodies.push({ item, runtime, body, type, bottomOffset });
    }

    if (component?.belt) {
      const matrix = root.matrixWorld.clone();
      this.belts.push({
        ...component.belt,
        inverse: matrix.clone().invert(),
        direction: new THREE.Vector3(1, 0, 0).transformDirection(matrix),
      });
    }
    if (component?.source) {
      const spawn = new THREE.Vector3(...component.source.spawn).applyMatrix4(root.matrixWorld);
      this.sources.push({ ...component.source, item, spawn, quaternion, timer: component.source.interval * 0.8, sent: 0 });
    }
    if (component?.sink) {
      this.sinks.push({ ...component.sink, inverse: root.matrixWorld.clone().invert() });
    }
  }

  // A new box from a source, if there is room for it.
  spawnBox(source) {
    const { RAPIER, world } = this;
    const { length, width, height } = source.box;
    const clear = Math.max(length, width, height) * 0.75;
    const blocked = this.bodies.some(({ body, type }) => type === 'dynamic' && new THREE.Vector3().copy(body.translation()).distanceTo(source.spawn) < clear);
    if (blocked || this.spawnedCount >= MAX_SPAWNED) return false;
    const mesh = createBoxMesh({ length, width, height });
    mesh.name = `${source.item.name}: box ${source.sent + 1}`;
    mesh.userData.simulated = true;
    mesh.position.copy(source.spawn);
    mesh.quaternion.copy(source.quaternion);
    this.editor.root.add(mesh);
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(source.spawn.x, source.spawn.y, source.spawn.z)
      .setRotation(q(source.quaternion))
      .setCcdEnabled(true));
    world.createCollider(RAPIER.ColliderDesc.cuboid(length / 2, height / 2, width / 2).setFriction(FRICTION).setMass(8), body);
    const entry = { mesh, body, type: 'dynamic', spawned: true, bottomOffset: -height / 2 };
    this.bodies.push(entry);
    this.spawned.push(entry);
    this.spawnedCount += 1;
    return true;
  }

  // Bodies standing on a running belt move with it: along it at its speed, kept to its middle.
  driveBelts() {
    const point = new THREE.Vector3();
    this.bodies.forEach((entry) => {
      if (entry.type !== 'dynamic') return;
      const { body } = entry;
      point.copy(body.translation());
      for (const belt of this.belts) {
        const local = point.clone().applyMatrix4(belt.inverse);
        const bottom = local.y + entry.bottomOffset;
        if (Math.abs(local.x) > belt.length / 2 || Math.abs(local.z) > belt.width / 2 + 0.02) continue;
        if (bottom < belt.top - BELT_CONTACT || bottom > belt.top + BELT_CONTACT) continue;
        if (belt.speed <= 0) break;
        const velocity = body.linvel();
        const along = belt.direction.clone().multiplyScalar(belt.speed);
        body.setLinvel({ x: along.x, y: Math.min(velocity.y, 0), z: along.z }, true);
        break;
      }
    });
  }

  // Bodies that reach an end of line disappear.
  drainSinks() {
    if (!this.sinks.length) return;
    const point = new THREE.Vector3();
    this.bodies = this.bodies.filter((entry) => {
      if (entry.type !== 'dynamic') return true;
      point.copy(entry.body.translation());
      const inside = this.sinks.some((sink) => {
        const local = point.clone().applyMatrix4(sink.inverse);
        return [0, 1, 2].every((axis) => Math.abs(local.getComponent(axis) - sink.center[axis]) <= sink.size[axis] / 2);
      });
      if (!inside) return true;
      this.world.removeRigidBody(entry.body);
      if (entry.spawned) {
        entry.mesh.removeFromParent();
        entry.mesh.traverse((child) => child.geometry?.dispose());
        this.spawned = this.spawned.filter((other) => other !== entry);
      } else {
        // A scene item: hidden until the simulation stops.
        entry.runtime.root.visible = false;
        this.removed.push(entry);
      }
      return false;
    });
  }

  step(deltaTime) {
    if (!this.running) return;
    this.accumulator = Math.min(this.accumulator + deltaTime, STEP * MAX_STEPS_PER_FRAME);
    while (this.accumulator >= STEP) {
      this.accumulator -= STEP;
      this.sources.forEach((source) => {
        if (source.sent >= source.maxBoxes) return;
        source.timer += STEP;
        if (source.timer >= source.interval && this.spawnBox(source)) {
          source.timer = 0;
          source.sent += 1;
        }
      });
      // Moving parts and linked items follow where they are drawn (a robot arm pushes boxes).
      const position = new THREE.Vector3();
      const quaternion = new THREE.Quaternion();
      const scale = new THREE.Vector3();
      this.bodies.forEach(({ type, body, runtime, object }) => {
        if (type !== 'kinematic') return;
        const target = object || runtime.root;
        target.updateWorldMatrix(true, false);
        target.matrixWorld.decompose(position, quaternion, scale);
        body.setNextKinematicTranslation(v(position));
        body.setNextKinematicRotation(q(quaternion));
      });
      this.driveBelts();
      this.world.step();
      this.drainSinks();
    }
    // Show where the moving bodies are now.
    this.bodies.forEach((entry) => {
      if (entry.type !== 'dynamic') return;
      const target = entry.mesh || entry.runtime.root;
      target.position.copy(entry.body.translation());
      target.quaternion.copy(entry.body.rotation());
    });
  }

  get boxCount() {
    return this.bodies.filter((entry) => entry.type === 'dynamic').length;
  }

  stop() {
    this.running = false;
    this.spawned.forEach(({ mesh }) => {
      mesh.removeFromParent();
      mesh.traverse((child) => child.geometry?.dispose());
    });
    this.spawned = [];
    this.world?.free();
    this.world = null;
    this.bodies = [];
  }
}

// Whether an item takes part in the simulation (for the Properties hint).
export function describeBody(item, runtime) {
  if (runtime?.kind === 'component') {
    const body = runtime.component.body;
    if (runtime.component.belt) return 'Carries boxes along when playing.';
    if (runtime.component.source) return 'Sends out boxes when playing.';
    if (runtime.component.sink) return 'Takes away boxes that reach it when playing.';
    if (body === 'dynamic') return 'Falls, slides and rides conveyors when playing.';
    if (body === 'static') return 'Boxes rest on it and bump into it when playing.';
    return null;
  }
  return item.solid ? 'Solid when playing: boxes bump into its actual shape.' : null;
}

