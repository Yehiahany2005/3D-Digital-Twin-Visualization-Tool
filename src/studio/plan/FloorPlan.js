import * as THREE from 'three';
import { PLAN_UNITS } from './dxf.js';

// A DXF floor plan in a scene: its lines drawn flat on the floor, one LineSegments per layer (a
// few draw calls even for 100k+ lines), text as flat labels, and optionally the lines of chosen
// layers raised into thin see-through walls.
//
// The drawing is centred on the item: coordinates are stored relative to the plan's middle, so
// a plan drawn far from its origin (common in CAD) keeps full precision. Drawing x → world x,
// drawing y → world −z, so it reads the right way round from above.
//
// Settings live on the scene item (item.plan) and are applied by setVisualState(), so undo,
// saving and copies treat them like any other change:
//   { unit: 'mm', unitGuessed, hiddenLayers: [...], walls: { layers: [...], height, opacity } }

const LIFT = 0.002;
const CAD_LINE = 0x2b3136;
const CAD_TEXT = 0x23292d;
const CAD_WALL = 0xc9d3d8;
const TWIN_LINE = 0x7fe6f2;
const TWIN_TEXT = 0x9ff0f8;
const TWIN_WALL = 0x3d9caf;
const WALL_THICKNESS = 0.1;
// Raised walls collide only up to this many pieces (a plan with more is still drawn).
export const MAX_WALL_COLLIDERS = 20000;
const TEXT_PIXELS = 64;
const ATLAS_WIDTH = 2048;
const ATLAS_MAX_HEIGHT = 4096;

export const DEFAULT_WALL_HEIGHT = 3;
export const DEFAULT_WALL_OPACITY = 0.35;

export function metresPerUnit(settings) {
  return PLAN_UNITS[settings?.unit]?.metres ?? 1;
}

export class FloorPlan {
  constructor(data) {
    this.data = data;
    this.digital = false;
    // Middle of the drawing (main area), in drawing units.
    const { main } = data;
    this.center = [(main.minX + main.maxX) / 2, (main.minY + main.maxY) / 2];

    this.root = new THREE.Group();
    this.root.name = 'Floor plan';
    // Lifted a couple of millimetres so the lines never flicker against the floor.
    this.lift = new THREE.Group();
    this.lift.position.y = LIFT;
    // Drawing plane (x, y) onto the floor (x, −z); scaled to metres by the unit.
    this.drawing = new THREE.Group();
    this.drawing.rotation.x = -Math.PI / 2;
    this.lift.add(this.drawing);
    this.root.add(this.lift);
    this.walls = new THREE.Group();
    this.root.add(this.walls);

    this.lineMaterial = new THREE.LineBasicMaterial({ color: CAD_LINE });
    this.textMaterials = [];
    this.layerObjects = new Map();
    data.layers.forEach((layer) => {
      const objects = [];
      if (layer.count) {
        const positions = new Float32Array(layer.count * 6);
        const [cx, cy] = this.center;
        const { segments } = layer;
        for (let i = 0, j = 0; i < segments.length; i += 2, j += 3) {
          positions[j] = segments[i] - cx;
          positions[j + 1] = segments[i + 1] - cy;
        }
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geometry.computeBoundingBox();
        geometry.computeBoundingSphere();
        const lines = new THREE.LineSegments(geometry, this.lineMaterial);
        lines.name = `Layer ${layer.name}`;
        lines.userData.planLayer = layer.name;
        lines.castShadow = false;
        lines.receiveShadow = false;
        objects.push(lines);
        this.drawing.add(lines);
      }
      this.layerObjects.set(layer.name, objects);
    });
    this.buildTexts();
    this.applied = null;
  }

  // ---- Text labels: every label of a layer in one mesh, its letters in a shared picture ----------

  buildTexts() {
    const byLayer = new Map();
    this.data.texts.forEach((label) => {
      if (!label.text.trim() || !(label.height > 0)) return;
      if (!byLayer.has(label.layer)) byLayer.set(label.layer, []);
      byLayer.get(label.layer).push(label);
    });
    if (!byLayer.size || typeof document === 'undefined') return;
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) return;
    const font = `${TEXT_PIXELS * 0.8}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    byLayer.forEach((labels, layerName) => {
      // Lay every line of text out on rows of a canvas, wrapping to a new canvas when full.
      const pages = [];
      let page = null;
      context.font = font;
      labels.forEach((label) => {
        const lines = label.text.split('\n');
        lines.forEach((text, lineIndex) => {
          const width = Math.min(ATLAS_WIDTH - 4, Math.ceil(context.measureText(text).width) + 4);
          if (!page || page.x + width > ATLAS_WIDTH) {
            if (page && page.y + TEXT_PIXELS * 2 <= ATLAS_MAX_HEIGHT) {
              page.x = 0;
              page.y += TEXT_PIXELS;
            } else {
              page = { x: 0, y: 0, glyphs: [] };
              pages.push(page);
            }
          }
          page.glyphs.push({ label, text, lineIndex, lines: lines.length, x: page.x, y: page.y, width });
          page.x += width;
        });
      });
      const objects = this.layerObjects.get(layerName) || [];
      pages.forEach((current) => {
        const height = THREE.MathUtils.ceilPowerOfTwo(current.y + TEXT_PIXELS);
        const pageCanvas = document.createElement('canvas');
        pageCanvas.width = ATLAS_WIDTH;
        pageCanvas.height = height;
        const pen = pageCanvas.getContext('2d');
        pen.font = font;
        pen.fillStyle = '#ffffff';
        pen.textBaseline = 'middle';
        current.glyphs.forEach((glyph) => pen.fillText(glyph.text, glyph.x + 2, glyph.y + TEXT_PIXELS / 2));
        const texture = new THREE.CanvasTexture(pageCanvas);
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.anisotropy = 4;
        const material = new THREE.MeshBasicMaterial({
          map: texture,
          color: CAD_TEXT,
          transparent: true,
          depthWrite: false,
          polygonOffset: true,
          polygonOffsetFactor: -2,
          polygonOffsetUnits: -2,
        });
        material.userData.texture = texture;
        this.textMaterials.push(material);
        const mesh = new THREE.Mesh(this.textGeometry(current.glyphs, ATLAS_WIDTH, height), material);
        mesh.name = `Labels ${layerName}`;
        mesh.userData.planLayer = layerName;
        mesh.userData.ownLook = true;
        mesh.userData.planBackdrop = true;
        // Not tinted when the plan is selected (it would cover the letters with boxes).
        mesh.userData.helper = true;
        mesh.renderOrder = 1;
        objects.push(mesh);
        this.drawing.add(mesh);
      });
      this.layerObjects.set(layerName, objects);
    });
  }

  // Quads for each line of text, in drawing units relative to the plan's middle.
  textGeometry(glyphs, atlasWidth, atlasHeight) {
    const positions = new Float32Array(glyphs.length * 12);
    const uvs = new Float32Array(glyphs.length * 8);
    const indices = new Uint32Array(glyphs.length * 6);
    const [cx, cy] = this.center;
    glyphs.forEach((glyph, n) => {
      const { label } = glyph;
      // The canvas row is one text height tall; the letters fill about 70 % of it.
      const rowHeight = label.height / 0.7;
      const width = (glyph.width / TEXT_PIXELS) * rowHeight;
      const column = label.align % 3;
      const row = Math.floor(label.align / 3);
      const blockHeight = rowHeight * glyph.lines;
      // Bottom-left of the whole text block relative to its insertion point.
      const left = -width * (column / 2);
      const bottom = -blockHeight * (row / 2) - label.height * 0.15;
      const lineBottom = bottom + rowHeight * (glyph.lines - 1 - glyph.lineIndex);
      const cos = Math.cos(label.rotation);
      const sin = Math.sin(label.rotation);
      const corner = (u, v) => [label.x - cx + u * cos - v * sin, label.y - cy + u * sin + v * cos];
      const quad = [corner(left, lineBottom), corner(left + width, lineBottom), corner(left + width, lineBottom + rowHeight), corner(left, lineBottom + rowHeight)];
      quad.forEach(([x, y], k) => positions.set([x, y, 0], n * 12 + k * 3));
      const u0 = glyph.x / atlasWidth;
      const u1 = (glyph.x + glyph.width) / atlasWidth;
      const v0 = 1 - (glyph.y + TEXT_PIXELS) / atlasHeight;
      const v1 = 1 - glyph.y / atlasHeight;
      uvs.set([u0, v0, u1, v0, u1, v1, u0, v1], n * 8);
      indices.set([n * 4, n * 4 + 1, n * 4 + 2, n * 4, n * 4 + 2, n * 4 + 3], n * 6);
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    return geometry;
  }

  // ---- Settings ------------------------------------------------------------------------------------

  get scale() {
    return this.drawing.scale.x;
  }

  // Applies the item's plan settings (units, hidden layers, walls). Cheap when nothing changed.
  setVisualState(item) {
    const settings = item.plan || {};
    const scale = metresPerUnit(settings);
    this.drawing.scale.setScalar(scale);
    const hidden = new Set(settings.hiddenLayers || []);
    this.layerObjects.forEach((objects, name) => objects.forEach((object) => { object.visible = !hidden.has(name); }));
    const walls = settings.walls?.layers?.length ? settings.walls : null;
    const wallKey = walls ? JSON.stringify([scale, walls.layers, walls.height, walls.opacity]) : null;
    if (wallKey !== this.wallKey) {
      this.wallKey = wallKey;
      this.buildWalls(walls, scale);
    }
    this.hiddenLayers = hidden;
  }

  // Thin vertical panels along every line of the chosen layers.
  buildWalls(walls, scale) {
    this.walls.children.forEach((child) => child.geometry.dispose());
    this.walls.clear();
    this.wallMaterial?.dispose();
    this.wallMaterial = null;
    this.wallSegments = [];
    if (!walls) return;
    const height = Math.max(0.05, Number(walls.height) || DEFAULT_WALL_HEIGHT);
    const [cx, cy] = this.center;
    const chosen = this.data.layers.filter((layer) => walls.layers.includes(layer.name) && layer.count);
    let total = 0;
    chosen.forEach((layer) => { total += layer.count; });
    if (!total) return;
    const positions = new Float32Array(total * 12);
    const indices = new Uint32Array(total * 6);
    let n = 0;
    chosen.forEach((layer) => {
      const { segments } = layer;
      for (let i = 0; i < segments.length; i += 4) {
        // Drawing (x, y) → floor (x, −y), in metres from the plan's middle.
        const x1 = (segments[i] - cx) * scale;
        const z1 = -(segments[i + 1] - cy) * scale;
        const x2 = (segments[i + 2] - cx) * scale;
        const z2 = -(segments[i + 3] - cy) * scale;
        if (Math.hypot(x2 - x1, z2 - z1) < 1e-4) continue;
        positions.set([x1, 0, z1, x2, 0, z2, x2, height, z2, x1, height, z1], n * 12);
        indices.set([n * 4, n * 4 + 1, n * 4 + 2, n * 4, n * 4 + 2, n * 4 + 3], n * 6);
        this.wallSegments.push([x1, z1, x2, z2, layer.name]);
        n += 1;
      }
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions.subarray(0, n * 12), 3));
    geometry.setIndex(new THREE.BufferAttribute(indices.subarray(0, n * 6), 1));
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    this.wallMaterial = new THREE.MeshStandardMaterial({
      color: this.digital ? TWIN_WALL : CAD_WALL,
      emissive: this.digital ? TWIN_WALL : 0x000000,
      emissiveIntensity: this.digital ? 0.35 : 0,
      roughness: 0.8,
      metalness: 0,
      transparent: true,
      opacity: THREE.MathUtils.clamp(Number(walls.opacity ?? DEFAULT_WALL_OPACITY), 0.05, 1),
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(geometry, this.wallMaterial);
    mesh.name = 'Walls';
    mesh.userData.ownLook = true;
    mesh.userData.planBackdrop = true;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    this.walls.add(mesh);
    // Their top edges, so the walls read clearly even when very see-through.
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geometry, 30), this.lineMaterial);
    edges.name = 'Wall edges';
    this.walls.add(edges);
  }

  // CAD View: dark lines on the grey floor. Digital Twin View: glowing accent lines.
  setDigital(digital) {
    if (digital === this.digital) return;
    this.digital = digital;
    this.lineMaterial.color.setHex(digital ? TWIN_LINE : CAD_LINE);
    this.lineMaterial.blending = digital ? THREE.AdditiveBlending : THREE.NormalBlending;
    this.lineMaterial.transparent = digital;
    this.lineMaterial.toneMapped = !digital;
    this.lineMaterial.needsUpdate = true;
    this.textMaterials.forEach((material) => {
      material.color.setHex(digital ? TWIN_TEXT : CAD_TEXT);
      material.toneMapped = !digital;
      material.needsUpdate = true;
    });
    if (this.wallMaterial) {
      this.wallMaterial.color.setHex(digital ? TWIN_WALL : CAD_WALL);
      this.wallMaterial.emissive.setHex(digital ? TWIN_WALL : 0x000000);
      this.wallMaterial.emissiveIntensity = digital ? 0.35 : 0;
    }
  }

  // ---- Physics: raised walls are solid, the flat drawing never is ---------------------------------

  get body() {
    return this.wallSegments?.length ? 'static' : 'none';
  }

  // Boxes along the walls, in the item's own frame (Simulation turns them with `rotation`).
  get colliders() {
    if (!this.wallSegments?.length) return [];
    const height = this.walls.children[0]?.geometry.boundingBox.max.y || DEFAULT_WALL_HEIGHT;
    return this.wallSegments.slice(0, MAX_WALL_COLLIDERS).map(([x1, z1, x2, z2]) => {
      const length = Math.hypot(x2 - x1, z2 - z1);
      return {
        size: [length, height, WALL_THICKNESS],
        position: [(x1 + x2) / 2, height / 2, (z1 + z2) / 2],
        rotation: [0, -Math.atan2(z2 - z1, x2 - x1), 0],
      };
    });
  }

  // ---- Picking: "is the pointer on a line of the plan?" ----------------------------------------------

  // True when a world point on the floor is within `tolerance` metres of a visible line.
  isNear(worldPoint, tolerance) {
    if (!this.root.visible) return false;
    this.drawing.updateMatrixWorld(true);
    const local = this.drawing.worldToLocal(worldPoint.clone());
    const reach = tolerance / this.scale;
    const index = this.lineIndex();
    const { cell, minX, minY, columns, rows, cells } = index;
    const c0 = Math.max(0, Math.floor((local.x - reach - minX) / cell));
    const c1 = Math.min(columns - 1, Math.floor((local.x + reach - minX) / cell));
    const r0 = Math.max(0, Math.floor((local.y - reach - minY) / cell));
    const r1 = Math.min(rows - 1, Math.floor((local.y + reach - minY) / cell));
    for (let r = r0; r <= r1; r += 1) {
      for (let c = c0; c <= c1; c += 1) {
        const list = cells.get(r * columns + c);
        if (!list) continue;
        for (let k = 0; k < list.length; k += 1) {
          const [positions, offset] = list[k];
          if (distanceToSegment(local.x, local.y, positions[offset], positions[offset + 1], positions[offset + 3], positions[offset + 4]) <= reach) return true;
        }
      }
    }
    return false;
  }

  // A grid of buckets over the visible lines (built once per set of visible layers).
  lineIndex() {
    const key = JSON.stringify([...(this.hiddenLayers || [])]);
    if (this.index && this.indexKey === key) return this.index;
    const visible = [];
    this.layerObjects.forEach((objects) => objects.forEach((object) => {
      if (object.isLineSegments && object.visible) visible.push(object.geometry.attributes.position.array);
    }));
    const box = new THREE.Box2();
    visible.forEach((positions) => {
      for (let i = 0; i < positions.length; i += 3) box.expandByPoint(new THREE.Vector2(positions[i], positions[i + 1]));
    });
    const size = box.isEmpty() ? new THREE.Vector2(1, 1) : box.getSize(new THREE.Vector2());
    const cell = Math.max(size.x, size.y, 1e-6) / 256;
    const columns = Math.max(1, Math.ceil(size.x / cell) + 1);
    const rows = Math.max(1, Math.ceil(size.y / cell) + 1);
    const minX = box.isEmpty() ? 0 : box.min.x;
    const minY = box.isEmpty() ? 0 : box.min.y;
    const cells = new Map();
    visible.forEach((positions) => {
      for (let i = 0; i < positions.length; i += 6) {
        const ca = Math.floor((Math.min(positions[i], positions[i + 3]) - minX) / cell);
        const cb = Math.floor((Math.max(positions[i], positions[i + 3]) - minX) / cell);
        const ra = Math.floor((Math.min(positions[i + 1], positions[i + 4]) - minY) / cell);
        const rb = Math.floor((Math.max(positions[i + 1], positions[i + 4]) - minY) / cell);
        // Long lines go in every bucket of their box (few lines are long).
        for (let r = ra; r <= rb; r += 1) {
          for (let c = ca; c <= cb; c += 1) {
            const id = r * columns + c;
            let list = cells.get(id);
            if (!list) {
              list = [];
              cells.set(id, list);
            }
            list.push([positions, i]);
          }
        }
      }
    });
    this.index = { cell, minX, minY, columns, rows, cells };
    this.indexKey = key;
    return this.index;
  }

  // How big the shown layers are on the floor, in metres (for Properties).
  get size() {
    const box = new THREE.Box3();
    this.layerObjects.forEach((objects) => objects.forEach((object) => {
      if (object.visible && object.isLineSegments) box.union(object.geometry.boundingBox);
    }));
    if (box.isEmpty()) return [0, 0];
    return [(box.max.x - box.min.x) * this.scale, (box.max.y - box.min.y) * this.scale];
  }

  dispose() {
    this.root.traverse((object) => object.geometry?.dispose());
    this.lineMaterial.dispose();
    this.textMaterials.forEach((material) => {
      material.userData.texture?.dispose();
      material.dispose();
    });
    this.wallMaterial?.dispose();
  }
}

function distanceToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  let t = lengthSquared ? ((px - ax) * dx + (py - ay) * dy) / lengthSquared : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}
