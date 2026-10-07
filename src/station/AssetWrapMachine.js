import * as THREE from 'three';
import { ModelLoader } from '../loaders/ModelLoader.js';
import wrappingUrl from '../assets/Wrapping.STEP?url';

/** Names from the Wrapping.STEP assembly (SolidWorks Assem1). */
const FRAME_NAMES = new Set(['wraping machine', 'Part1']);
const CARRIAGE_NAMES = new Set(['cone holder', 'cones', 'cone2']);
const ROTOR_NAME = 'rotor';
const FILM_ROLL_NAMES = new Set(['cones', 'cone2']);

const loader = new ModelLoader();
let cachedContent = null;

function findDirectChildren(parent, predicate) {
  return parent.children.filter((child) => predicate(child));
}

function computeBox(objects) {
  const box = new THREE.Box3();
  objects.forEach((object) => box.expandByObject(object));
  return box;
}

async function loadWrappingContent(onStatus) {
  if (cachedContent) return cachedContent.clone(true);
  onStatus?.('Loading wrapping station…');
  const response = await fetch(wrappingUrl);
  if (!response.ok) throw new Error(`Could not download wrapping station (HTTP ${response.status}).`);
  const buffer = await response.arrayBuffer();
  const parsed = await loader.parse(buffer, 'Wrapping.STEP', { onStatus });
  parsed.scene.traverse((object) => {
    if (!object.isMesh) return;
    object.castShadow = true;
    object.receiveShadow = true;
  });
  cachedContent = parsed.scene;
  return cachedContent.clone(true);
}

function mesh(geometry, material, name, parent) {
  const object = new THREE.Mesh(geometry, material);
  object.name = name;
  object.castShadow = true;
  object.receiveShadow = true;
  parent.add(object);
  return object;
}

/**
 * One closed loop around the rectangular stack perimeter (XZ), corners included
 * exactly so the film never rounds off into an oval. Each sample carries its
 * arc-length position and the outward offset direction (corners push out on
 * both axes so the offset loop stays a true rectangle).
 */
function rectPerimeterLoop(halfX, halfZ, maxSpacing = 0.05) {
  const sides = [
    { from: [halfX, -halfZ], to: [halfX, halfZ], normal: [1, 0] },
    { from: [halfX, halfZ], to: [-halfX, halfZ], normal: [0, 1] },
    { from: [-halfX, halfZ], to: [-halfX, -halfZ], normal: [-1, 0] },
    { from: [-halfX, -halfZ], to: [halfX, -halfZ], normal: [0, -1] },
  ];
  const samples = [];
  let s = 0;
  sides.forEach((side, index) => {
    const previous = sides[(index + 3) % 4];
    const length = Math.hypot(side.to[0] - side.from[0], side.to[1] - side.from[1]);
    const steps = Math.max(1, Math.ceil(length / maxSpacing));
    for (let i = 0; i < steps; i += 1) {
      const t = i / steps;
      const corner = i === 0;
      samples.push({
        x: THREE.MathUtils.lerp(side.from[0], side.to[0], t),
        z: THREE.MathUtils.lerp(side.from[1], side.to[1], t),
        s: s + t * length,
        ox: corner ? side.normal[0] + previous.normal[0] : side.normal[0],
        oz: corner ? side.normal[1] + previous.normal[1] : side.normal[1],
        nx: side.normal[0],
        nz: side.normal[1],
      });
    }
    s += length;
  });
  return { samples, perimeter: s };
}

/**
 * Stretch-film ribbon spiralling around the stack: a few base turns at the
 * stack bottom, a constant-pitch rise (pitch < band height so passes overlap
 * with no gaps), then top turns flush with the stack top. Vertices are ordered
 * along the path so the wrap can be revealed with a draw range.
 */
function createSpiralFilm(halfX, halfZ, stackHeight, {
  bandHeight,
  pitch,
  baseTurns = 1.5,
  topTurns = 1.5,
  layerGrowth = 0.001,
} = {}) {
  const { samples, perimeter } = rectPerimeterLoop(halfX, halfZ);
  const riseHeight = Math.max(0, stackHeight - bandHeight);
  const riseTurns = riseHeight / pitch;
  const totalTurns = baseTurns + riseTurns + topTurns;
  const totalLength = totalTurns * perimeter;

  const bandBottomAt = (s) => {
    const turn = s / perimeter;
    if (turn <= baseTurns) return 0;
    return Math.min(riseHeight, (turn - baseTurns) * pitch);
  };

  const path = [];
  for (let loop = 0; loop * perimeter < totalLength; loop += 1) {
    for (const sample of samples) {
      const s = loop * perimeter + sample.s;
      if (s >= totalLength) break;
      path.push({ ...sample, s });
    }
  }
  // Close the path exactly at the end point.
  const endLocal = totalLength - Math.floor(totalLength / perimeter) * perimeter;
  const endIndex = samples.findIndex((sample, index) => {
    const next = samples[index + 1];
    return !next || next.s > endLocal;
  });
  const a = samples[endIndex];
  const b = samples[(endIndex + 1) % samples.length];
  const bS = endIndex + 1 < samples.length ? b.s : perimeter;
  const endT = (endLocal - a.s) / Math.max(bS - a.s, 1e-6);
  path.push({
    x: THREE.MathUtils.lerp(a.x, b.x, endT),
    z: THREE.MathUtils.lerp(a.z, b.z, endT),
    ox: endT > 0 ? a.nx : a.ox,
    oz: endT > 0 ? a.nz : a.oz,
    s: totalLength,
  });

  const positions = new Float32Array(path.length * 6);
  const normals = new Float32Array(path.length * 6);
  const indices = [];
  path.forEach((point, index) => {
    const offset = (point.s / perimeter) * layerGrowth;
    const x = point.x + point.ox * offset;
    const z = point.z + point.oz * offset;
    const bottom = bandBottomAt(point.s);
    const length = Math.hypot(point.ox, point.oz) || 1;
    positions.set([x, bottom, z, x, bottom + bandHeight, z], index * 6);
    normals.set([point.ox / length, 0, point.oz / length, point.ox / length, 0, point.oz / length], index * 6);
    if (index > 0) {
      const p = (index - 1) * 2;
      const c = index * 2;
      indices.push(p, c, p + 1, p + 1, c, c + 1);
    }
  });

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geometry.setIndex(indices);
  geometry.setDrawRange(0, 0);

  return {
    geometry,
    path,
    perimeter,
    totalLength,
    riseHeight,
    bandHeight,
    bandBottomAt,
  };
}

/**
 * Wrapping station built from src/assets/Wrapping.STEP.
 *
 * Inspected hierarchy (Assem1):
 * - wraping machine / Part1 — fixed frame and inbound ramp (−X)
 * - rotor — turntable ring centered on the origin (inner ≈0.48 m, top ≈0.44 m)
 * - cone holder, cones, cone2 — film carriage / roll assembly (+X mast)
 *
 * Local origin is the turntable center on the floor. +X faces the film mast;
 * −X is the inbound ramp (worker approach).
 */
export async function createAssetWrapMachine({
  stackLength = 1.9,
  stackWidth = 1.3,
  stackHeight = 1.26,
  palletHeight = 0.144,
  filmClearance = 0.012,
  onStatus,
} = {}) {
  const root = new THREE.Group();
  root.name = 'AssetWrapMachine';

  const content = await loadWrappingContent(onStatus);
  content.name = content.name || 'WrappingContent';
  root.add(content);

  const assembly = content.getObjectByName('Assem1') || content;
  // Prefer direct assembly children — mesh descendants reuse the same CAD names.
  const rotorNode = findDirectChildren(assembly, (object) => object.name === ROTOR_NAME)[0];
  if (!rotorNode) throw new Error('Wrapping.STEP is missing the "rotor" turntable node.');

  const carriageNodes = findDirectChildren(assembly, (object) => CARRIAGE_NAMES.has(object.name));
  if (!carriageNodes.length) throw new Error('Wrapping.STEP is missing film-carriage nodes.');

  // Rotor pivot at the turntable's geometric center so rotation stays coaxial.
  assembly.updateMatrixWorld(true);
  const rotorBounds = new THREE.Box3().setFromObject(rotorNode);
  const rotorCenter = rotorBounds.getCenter(new THREE.Vector3());
  const deckHeight = rotorBounds.max.y;

  const rotorPivot = new THREE.Group();
  rotorPivot.name = 'TurntablePivot';
  rotorPivot.position.set(rotorCenter.x, rotorCenter.y, rotorCenter.z);
  assembly.add(rotorPivot);
  rotorPivot.attach(rotorNode);

  // Carriage group keeps native relative placement; translate in Y during wrap.
  const carriage = new THREE.Group();
  carriage.name = 'FilmCarriage';
  assembly.add(carriage);
  carriageNodes.forEach((node) => carriage.attach(node));
  carriage.updateMatrixWorld(true);

  const carriageRestY = 0;
  const carriageBounds = new THREE.Box3().setFromObject(carriage);
  const frameNodes = findDirectChildren(assembly, (object) => FRAME_NAMES.has(object.name));
  const mastTop = frameNodes.length
    ? computeBox(frameNodes).max.y
    : carriageBounds.max.y + 1.2;
  const wrapRise = stackHeight;
  const carriageTravel = Math.max(0.55, Math.min(mastTop - carriageBounds.max.y - 0.08, wrapRise * 0.95));

  // Film-roll / cone spin pivots (vertical cores on the carriage).
  const filmRollNodes = findDirectChildren(carriage, (object) => FILM_ROLL_NAMES.has(object.name));
  const filmRollPivots = filmRollNodes.map((node, index) => {
    const bounds = new THREE.Box3().setFromObject(node);
    const center = bounds.getCenter(new THREE.Vector3());
    const pivot = new THREE.Group();
    pivot.name = `FilmRollPivot_${index + 1}`;
    carriage.worldToLocal(center);
    pivot.position.copy(center);
    carriage.add(pivot);
    pivot.attach(node);
    return pivot;
  });

  // Stack bounding box → film shell (tight rectangular perimeter, not a cylinder).
  const halfX = stackLength * 0.5 + filmClearance;
  const halfZ = stackWidth * 0.5 + filmClearance;
  const filmBottomY = deckHeight + palletHeight;

  const filmMat = new THREE.MeshStandardMaterial({
    color: 0xd8eef8,
    metalness: 0.02,
    roughness: 0.28,
    transparent: true,
    opacity: 0,
    side: THREE.DoubleSide,
    depthWrite: false,
  });

  const filmRoot = new THREE.Group();
  filmRoot.name = 'WrapFilm';
  filmRoot.visible = false;
  filmRoot.position.y = filmBottomY;
  root.add(filmRoot);

  // Spiral stretch film hugging the stack's outer rectangle, bottom → top.
  const bandHeight = Math.min(0.32, stackHeight / 3);
  const spiral = createSpiralFilm(halfX, halfZ, stackHeight, {
    bandHeight,
    pitch: bandHeight * 0.55,
  });
  const film = mesh(spiral.geometry, filmMat, 'Film spiral', filmRoot);
  film.material.opacity = 0.34;
  film.castShadow = false;
  film.frustumCulled = false;
  film.renderOrder = 2;
  const filmPositions = spiral.geometry.getAttribute('position');

  // Leading edge where film is currently laid onto the stack.
  const leadingEdge = mesh(
    new THREE.BoxGeometry(0.014, bandHeight, 0.014),
    new THREE.MeshStandardMaterial({ color: 0xf2fbff, roughness: 0.2, transparent: true, opacity: 0.85 }),
    'Film leading edge',
    filmRoot,
  );
  leadingEdge.castShadow = false;
  leadingEdge.visible = false;

  // Index of the path vertex pair temporarily moved to the exact wrap head.
  let headIndex = -1;
  const restingPositions = filmPositions.array.slice();
  const restoreHead = () => {
    if (headIndex < 0) return;
    filmPositions.array.set(restingPositions.subarray(headIndex * 6, headIndex * 6 + 6), headIndex * 6);
    filmPositions.needsUpdate = true;
    headIndex = -1;
  };

  const placeFilmHead = (length) => {
    restoreHead();
    const path = spiral.path;
    if (length <= 0) {
      spiral.geometry.setDrawRange(0, 0);
      return null;
    }
    if (length >= spiral.totalLength) {
      spiral.geometry.setDrawRange(0, (path.length - 1) * 6);
      return null;
    }
    // Last path sample at or before the head.
    let low = 0;
    let high = path.length - 1;
    while (high - low > 1) {
      const middle = (low + high) >> 1;
      if (path[middle].s <= length) low = middle;
      else high = middle;
    }
    const from = path[low];
    const to = path[low + 1];
    const t = (length - from.s) / Math.max(to.s - from.s, 1e-6);
    const fromX = filmPositions.getX(low * 2);
    const fromZ = filmPositions.getZ(low * 2);
    const x = THREE.MathUtils.lerp(fromX, filmPositions.getX((low + 1) * 2), t);
    const z = THREE.MathUtils.lerp(fromZ, filmPositions.getZ((low + 1) * 2), t);
    const bottom = spiral.bandBottomAt(length);
    headIndex = low + 1;
    filmPositions.setXYZ(headIndex * 2, x, bottom, z);
    filmPositions.setXYZ(headIndex * 2 + 1, x, bottom + bandHeight, z);
    filmPositions.needsUpdate = true;
    spiral.geometry.setDrawRange(0, headIndex * 6);
    return { x, z, bottom };
  };

  const modelBounds = new THREE.Box3().setFromObject(content);
  const size = modelBounds.getSize(new THREE.Vector3());

  let wrapProgress = 0;

  return {
    root,
    carriage,
    rotorPivot,
    filmRoot,
    deckHeight,
    bayLength: size.x,
    bayWidth: size.z,
    height: size.y,
    references: {
      bayCenter: new THREE.Vector3(0, 0, 0),
      inbound: new THREE.Vector3(modelBounds.min.x - 0.2, 0, 0),
      deck: new THREE.Vector3(0, deckHeight, 0),
    },
    setWrapProgress(progress) {
      wrapProgress = THREE.MathUtils.clamp(progress, 0, 1);
      filmRoot.visible = wrapProgress > 0;

      const length = wrapProgress * spiral.totalLength;
      const turns = (length / spiral.perimeter) * Math.PI * 2;
      rotorPivot.rotation.y = turns;

      // Film carriage follows the band height up the mast.
      const rise = spiral.riseHeight > 0 ? spiral.bandBottomAt(length) / spiral.riseHeight : wrapProgress;
      carriage.position.y = carriageRestY + rise * carriageTravel;

      // Film roll cores spin as film pays out.
      filmRollPivots.forEach((pivot, index) => {
        pivot.rotation.y = turns * (1.8 + index * 0.15);
      });

      const head = placeFilmHead(length);
      leadingEdge.visible = Boolean(head);
      if (head) leadingEdge.position.set(head.x, head.bottom + bandHeight / 2, head.z);
    },
    getWrapProgress() {
      return wrapProgress;
    },
    resetWrap() {
      this.setWrapProgress(0);
      filmRoot.visible = false;
      carriage.position.y = carriageRestY;
      rotorPivot.rotation.y = 0;
      filmRollPivots.forEach((pivot) => { pivot.rotation.y = 0; });
    },
  };
}
