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

/** Rectangular perimeter path (XZ) matching the stack footprint + clearance. */
function rectPerimeterPoints(halfX, halfZ, segmentsPerSide = 8) {
  const corners = [
    [halfX, -halfZ],
    [halfX, halfZ],
    [-halfX, halfZ],
    [-halfX, -halfZ],
  ];
  const points = [];
  for (let side = 0; side < 4; side += 1) {
    const [x0, z0] = corners[side];
    const [x1, z1] = corners[(side + 1) % 4];
    for (let i = 0; i < segmentsPerSide; i += 1) {
      const t = i / segmentsPerSide;
      points.push(new THREE.Vector3(
        THREE.MathUtils.lerp(x0, x1, t),
        0,
        THREE.MathUtils.lerp(z0, z1, t),
      ));
    }
  }
  return points;
}

/**
 * Open rectangular tube from y=0 to y=height, sized to the stack outer perimeter.
 * Built as a continuous wall strip — not a cylinder/ellipse.
 */
function createRectTubeGeometry(halfX, halfZ, height, segmentsPerSide = 8) {
  const ring = rectPerimeterPoints(halfX, halfZ, segmentsPerSide);
  const ringCount = ring.length;
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];

  for (let i = 0; i < ringCount; i += 1) {
    const p = ring[i];
    const next = ring[(i + 1) % ringCount];
    const tangent = new THREE.Vector3().subVectors(next, p);
    // Outward normal in XZ (perpendicular to edge, pointing away from origin).
    let nx = tangent.z;
    let nz = -tangent.x;
    const len = Math.hypot(nx, nz) || 1;
    nx /= len;
    nz /= len;
    if (nx * p.x + nz * p.z < 0) {
      nx = -nx;
      nz = -nz;
    }

    const u = i / ringCount;
    positions.push(p.x, 0, p.z, p.x, height, p.z);
    normals.push(nx, 0, nz, nx, 0, nz);
    uvs.push(u, 0, u, 1);
  }

  for (let i = 0; i < ringCount; i += 1) {
    const a = i * 2;
    const b = a + 1;
    const c = ((i + 1) % ringCount) * 2;
    const d = c + 1;
    indices.push(a, c, b, b, c, d);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  return geometry;
}

/** Thin rectangular band (leading edge of the wrap) in the XZ plane. */
function createRectBandGeometry(halfX, halfZ, thickness = 0.03, segmentsPerSide = 8) {
  const ring = rectPerimeterPoints(halfX, halfZ, segmentsPerSide);
  const positions = [];
  const indices = [];
  const ringCount = ring.length;
  for (let i = 0; i < ringCount; i += 1) {
    const p = ring[i];
    positions.push(p.x, -thickness / 2, p.z, p.x, thickness / 2, p.z);
  }
  for (let i = 0; i < ringCount; i += 1) {
    const a = i * 2;
    const b = a + 1;
    const c = ((i + 1) % ringCount) * 2;
    const d = c + 1;
    indices.push(a, c, b, b, c, d);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
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

  // Growing covered shell: scales up from the stack bottom.
  const cover = mesh(
    createRectTubeGeometry(halfX, halfZ, stackHeight, 10),
    filmMat.clone(),
    'Film cover',
    filmRoot,
  );
  cover.scale.y = 0.001;
  cover.material.opacity = 0;
  cover.material.depthWrite = false;

  // Thin overlapping shells for stretch-wrap layering (tiny outward offset).
  const filmLayers = [];
  const layerCount = 3;
  for (let index = 0; index < layerCount; index += 1) {
    const inset = (index + 1) * 0.004;
    const layer = mesh(
      createRectTubeGeometry(halfX + inset, halfZ + inset, stackHeight, 10),
      filmMat.clone(),
      `Film layer ${index + 1}`,
      filmRoot,
    );
    layer.scale.y = 0.001;
    layer.material.opacity = 0;
    layer.material.depthWrite = false;
    filmLayers.push(layer);
  }

  // Leading wrap band rides the stack perimeter from bottom → top.
  const band = mesh(
    createRectBandGeometry(halfX + 0.006, halfZ + 0.006, 0.04, 10),
    filmMat.clone(),
    'Film leading edge',
    filmRoot,
  );
  band.position.y = 0;
  band.material.opacity = 0;
  band.material.depthWrite = false;

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
      filmRoot.visible = wrapProgress > 0.001;

      // Turntable: several revolutions over the cycle.
      const turns = wrapProgress * Math.PI * 8;
      rotorPivot.rotation.y = turns;

      // Film carriage rides the mast (up during wrap).
      carriage.position.y = carriageRestY + wrapProgress * carriageTravel;

      // Film roll cores spin as film pays out.
      filmRollPivots.forEach((pivot, index) => {
        pivot.rotation.y = turns * (1.8 + index * 0.15);
      });

      // Covered height grows from stack bottom → top (tight rectangular shell).
      const coverScale = Math.max(0.001, wrapProgress);
      cover.scale.y = coverScale;
      cover.material.opacity = Math.min(0.22 + wrapProgress * 0.28, 0.48);

      filmLayers.forEach((layer, index) => {
        const threshold = index / (layerCount + 1);
        const local = THREE.MathUtils.clamp((wrapProgress - threshold) / (1 - threshold), 0, 1);
        layer.scale.y = Math.max(0.001, local);
        layer.material.opacity = local * (0.12 + index * 0.04);
      });

      band.visible = wrapProgress > 0.001 && wrapProgress < 0.995;
      band.position.y = wrapProgress * stackHeight;
      band.material.opacity = wrapProgress > 0.001 ? 0.55 : 0;
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
      cover.scale.y = 0.001;
      filmLayers.forEach((layer) => { layer.scale.y = 0.001; });
      band.position.y = 0;
    },
  };
}
