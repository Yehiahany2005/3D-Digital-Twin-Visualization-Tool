import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';

const FORMATS = {
  glb: { kind: 'gltf', label: 'GLB' },
  gltf: { kind: 'gltf', label: 'glTF' },
  step: { kind: 'step', label: 'STEP' },
  stp: { kind: 'step', label: 'STEP' },
  iges: { kind: 'iges', label: 'IGES' },
  igs: { kind: 'iges', label: 'IGES' },
  stl: { kind: 'stl', label: 'STL' },
  obj: { kind: 'obj', label: 'OBJ' },
  fbx: { kind: 'fbx', label: 'FBX' },
  '3mf': { kind: '3mf', label: '3MF' },
};

// Native formats of CAD programs. They are closed formats that no browser
// library can read, so the user is asked to export a STEP file instead.
const PROPRIETARY_FORMATS = {
  sldprt: 'SolidWorks',
  sldasm: 'SolidWorks',
  slddrw: 'SolidWorks',
  ipt: 'Autodesk Inventor',
  iam: 'Autodesk Inventor',
  idw: 'Autodesk Inventor',
  f3d: 'Autodesk Fusion',
  f3z: 'Autodesk Fusion',
  dwg: 'AutoCAD',
  catpart: 'CATIA',
  catproduct: 'CATIA',
  prt: 'Creo or Siemens NX',
  asm: 'Creo',
  x_t: 'Parasolid',
  x_b: 'Parasolid',
  skp: 'SketchUp',
};

export const UNIT_SCALES = {
  m: 1,
  cm: 0.01,
  mm: 0.001,
  in: 0.0254,
  ft: 0.3048,
};

export const IMPORT_ACCEPT = Object.keys(FORMATS).map((extension) => `.${extension}`).join(',');
export const SUPPORTED_LABEL = 'GLB, glTF, STEP, IGES, STL, OBJ, FBX or 3MF';

// Double-sided because CAD and STL surfaces are not always consistently oriented.
const DEFAULT_MATERIAL = { color: 0xb8bcc2, metalness: 0.25, roughness: 0.55, side: THREE.DoubleSide };
const LARGEST_PLAUSIBLE_METRES = 50;

export function fileExtension(fileName) {
  const match = /\.([^./\\]+)$/.exec(fileName);
  return match ? match[1].toLowerCase() : '';
}

export function formatLabel(fileName) {
  return FORMATS[fileExtension(fileName)]?.label || fileExtension(fileName).toUpperCase();
}

// Returns a user-facing message when the file cannot be imported, otherwise null.
export function unsupportedFormatMessage(fileName) {
  const extension = fileExtension(fileName);
  if (FORMATS[extension]) return null;
  const application = PROPRIETARY_FORMATS[extension];
  if (application) {
    return `.${extension} files come from ${application} and can only be opened there. `
      + `In ${application}, use File → Save As / Export → STEP (.step), then import that file.`;
  }
  return `${extension ? `.${extension} files aren't` : "This file isn't"} supported. Use ${SUPPORTED_LABEL}.`;
}

function largestDimension(object) {
  const size = new THREE.Box3().setFromObject(object).getSize(new THREE.Vector3());
  return Math.max(size.x, size.y, size.z);
}

// STL, OBJ and FBX do not record units. CAD exports are usually millimetres, so
// anything implausibly large to be metres is assumed to be millimetres.
function guessUnits(object) {
  return largestDimension(object) > LARGEST_PLAUSIBLE_METRES ? 'mm' : 'm';
}

function cadColor(rgb) {
  return new THREE.Color().setRGB(rgb[0], rgb[1], rgb[2], THREE.SRGBColorSpace);
}

function buildCadScene(result) {
  const materials = new Map();
  const materialFor = (rgb) => {
    const key = rgb ? rgb.map((value) => value.toFixed(3)).join(',') : 'default';
    if (!materials.has(key)) {
      materials.set(key, new THREE.MeshStandardMaterial({
        ...DEFAULT_MATERIAL,
        ...(rgb ? { color: cadColor(rgb) } : {}),
      }));
    }
    return materials.get(key);
  };

  const geometries = result.meshes.map((mesh) => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(mesh.attributes.position.array, 3));
    if (mesh.attributes.normal) geometry.setAttribute('normal', new THREE.BufferAttribute(mesh.attributes.normal.array, 3));
    if (mesh.index) geometry.setIndex(new THREE.BufferAttribute(mesh.index.array, 1));
    if (!mesh.attributes.normal) geometry.computeVertexNormals();
    // Keep the original CAD face boundaries; joint setup uses them to find round features.
    geometry.userData.brepFaces = (mesh.brep_faces || []).map((face) => [face.first, face.last]);

    const faceMaterials = [];
    const faceColors = (mesh.brep_faces || []).map((face) => face.color || mesh.color || null);
    const distinct = new Set(faceColors.map((color) => (color ? color.join(',') : 'default')));
    if (distinct.size > 1) {
      (mesh.brep_faces || []).forEach((face, index) => {
        const material = materialFor(faceColors[index]);
        let materialIndex = faceMaterials.indexOf(material);
        if (materialIndex === -1) materialIndex = faceMaterials.push(material) - 1;
        geometry.addGroup(face.first * 3, (face.last - face.first + 1) * 3, materialIndex);
      });
    }
    return { geometry, material: faceMaterials.length > 1 ? faceMaterials : materialFor(faceColors[0] || mesh.color), name: mesh.name };
  });

  const buildNode = (node) => {
    const group = new THREE.Group();
    group.name = node.name || '';
    (node.meshes || []).forEach((meshIndex) => {
      const { geometry, material, name } = geometries[meshIndex];
      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = name || node.name || '';
      group.add(mesh);
    });
    (node.children || []).forEach((child) => group.add(buildNode(child)));
    return group;
  };

  return buildNode(result.root);
}

export class ModelLoader {
  constructor() {
    this.gltfLoader = new GLTFLoader();
    this.gltfLoader.setMeshoptDecoder(MeshoptDecoder);
    this.dracoLoader = null;
  }

  // Parses a model from an ArrayBuffer. Returns { scene, animations, units, unitsGuessed, upAxis }.
  async parse(buffer, fileName, { onStatus } = {}) {
    const extension = fileExtension(fileName);
    const format = FORMATS[extension];
    if (!format) throw new Error(unsupportedFormatMessage(fileName));

    switch (format.kind) {
      case 'gltf':
        return this.parseGltf(buffer);
      case 'step':
      case 'iges':
        return this.parseCad(buffer, format.kind, onStatus);
      case 'stl':
        return this.parseStl(buffer, fileName);
      case 'obj':
        return this.parseObj(buffer);
      case 'fbx':
        return this.parseFbx(buffer);
      case '3mf':
        return this.parse3mf(buffer);
      default:
        throw new Error(unsupportedFormatMessage(fileName));
    }
  }

  async parseGltf(buffer) {
    if (!this.dracoLoader) {
      this.dracoLoader = new DRACOLoader();
      this.dracoLoader.setDecoderPath(`${import.meta.env.BASE_URL}draco/`);
      this.gltfLoader.setDRACOLoader(this.dracoLoader);
    }
    try {
      const gltf = await this.gltfLoader.parseAsync(buffer, '');
      return { scene: gltf.scene, animations: gltf.animations, units: 'm', unitsGuessed: false, upAxis: 'y' };
    } catch (error) {
      if (/load|fetch|uri/i.test(error?.message || '')) {
        throw new Error('This .gltf file refers to separate texture or .bin files. Export it as a single .glb file instead.');
      }
      throw error;
    }
  }

  async parseCad(buffer, kind, onStatus) {
    onStatus?.('Loading CAD engine…');
    const { readCadFile } = await import('./occtClient.js');
    onStatus?.(`Converting ${kind.toUpperCase()} geometry…`);
    const result = await readCadFile(buffer, kind);
    if (!result.meshes?.length) throw new Error(`The ${kind.toUpperCase()} file contains no solid geometry.`);
    return { scene: buildCadScene(result), animations: [], units: 'm', unitsGuessed: false, upAxis: 'y' };
  }

  async parseStl(buffer, fileName) {
    const { STLLoader } = await import('three/examples/jsm/loaders/STLLoader.js');
    const geometry = new STLLoader().parse(buffer);
    if (!geometry.hasAttribute('normal')) geometry.computeVertexNormals();
    const material = new THREE.MeshStandardMaterial({ ...DEFAULT_MATERIAL, vertexColors: Boolean(geometry.hasColors) });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = fileName.replace(/\.[^.]+$/, '');
    const scene = new THREE.Group();
    scene.add(mesh);
    return { scene, animations: [], units: guessUnits(scene), unitsGuessed: true, upAxis: 'z' };
  }

  async parseObj(buffer) {
    const { OBJLoader } = await import('three/examples/jsm/loaders/OBJLoader.js');
    const scene = new OBJLoader().parse(new TextDecoder().decode(buffer));
    return { scene, animations: [], units: guessUnits(scene), unitsGuessed: true, upAxis: 'y' };
  }

  async parseFbx(buffer) {
    const { FBXLoader } = await import('three/examples/jsm/loaders/FBXLoader.js');
    const scene = new FBXLoader().parse(buffer, '');
    return { scene, animations: scene.animations || [], units: guessUnits(scene), unitsGuessed: true, upAxis: 'y' };
  }

  async parse3mf(buffer) {
    const { ThreeMFLoader } = await import('three/examples/jsm/loaders/3MFLoader.js');
    const scene = new ThreeMFLoader().parse(buffer);
    // The 3MF specification defaults to millimetres with Z pointing up.
    return { scene, animations: [], units: 'mm', unitsGuessed: false, upAxis: 'z' };
  }
}
