import * as THREE from 'three';

// Works out a joint axis and pivot from the surface a user clicked.
//
// 1. Collect the surface patch around the clicked triangle: the exact CAD face for
//    STEP/IGES imports, otherwise the smoothly connected triangles around it.
// 2. Look at how the patch's normals are spread out:
//    - all parallel                → flat face: axis = its normal, pivot = its centre
//    - all perpendicular to a line → round (cylinder/cone): axis = that line,
//                                    pivot = the point all normals pass through
//    - spread in every direction   → curved (sphere-like): pivot = its centre
//
// All results are in the mesh's local (geometry) coordinates.

const SMOOTH_ANGLE_COS = Math.cos(THREE.MathUtils.degToRad(20));
const MAX_REGION_TRIANGLES = 200000;
const FLAT_THRESHOLD = 0.02;
const ROUND_THRESHOLD = 0.06;

// Eigen-decomposition of a symmetric 3x3 matrix (Jacobi rotations).
// Returns eigenvalues in descending order with matching unit eigenvectors.
function symmetricEigen(matrix) {
  const a = matrix.map((row) => [...row]);
  const v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 50; sweep += 1) {
    let off = 0;
    for (let p = 0; p < 3; p += 1) for (let q = p + 1; q < 3; q += 1) off += a[p][q] ** 2;
    if (off < 1e-20) break;
    for (let p = 0; p < 3; p += 1) {
      for (let q = p + 1; q < 3; q += 1) {
        if (Math.abs(a[p][q]) < 1e-30) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < 3; k += 1) {
          const akp = a[k][p];
          const akq = a[k][q];
          a[k][p] = c * akp - s * akq;
          a[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < 3; k += 1) {
          const apk = a[p][k];
          const aqk = a[q][k];
          a[p][k] = c * apk - s * aqk;
          a[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < 3; k += 1) {
          const vkp = v[k][p];
          const vkq = v[k][q];
          v[k][p] = c * vkp - s * vkq;
          v[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }
  return [0, 1, 2]
    .map((i) => ({ value: a[i][i], vector: new THREE.Vector3(v[0][i], v[1][i], v[2][i]).normalize() }))
    .sort((left, right) => right.value - left.value);
}

function triangleVertexIndices(geometry, triangle) {
  const index = geometry.index;
  const base = triangle * 3;
  return index ? [index.getX(base), index.getX(base + 1), index.getX(base + 2)] : [base, base + 1, base + 2];
}

function triangleCount(geometry) {
  return (geometry.index ? geometry.index.count : geometry.attributes.position.count) / 3;
}

function readTriangle(geometry, triangle) {
  const position = geometry.attributes.position;
  const [ia, ib, ic] = triangleVertexIndices(geometry, triangle);
  const a = new THREE.Vector3().fromBufferAttribute(position, ia);
  const b = new THREE.Vector3().fromBufferAttribute(position, ib);
  const c = new THREE.Vector3().fromBufferAttribute(position, ic);
  const cross = new THREE.Vector3().subVectors(c, b).cross(new THREE.Vector3().subVectors(a, b));
  const doubleArea = cross.length();
  return {
    normal: doubleArea > 0 ? cross.divideScalar(doubleArea) : cross,
    area: doubleArea / 2,
    centroid: a.add(b).add(c).divideScalar(3),
  };
}

// Triangles of the CAD face containing the clicked triangle (STEP/IGES imports).
function cadFaceTriangles(geometry, seed) {
  const face = geometry.userData.brepFaces?.find(([first, last]) => seed >= first && seed <= last);
  if (!face) return null;
  const triangles = [];
  for (let triangle = face[0]; triangle <= face[1]; triangle += 1) triangles.push(triangle);
  return triangles;
}

// Which triangles share each vertex position. Built once per geometry: hover previews ask
// for many regions of the same mesh.
const adjacencyCache = new WeakMap();
function adjacency(geometry) {
  if (adjacencyCache.has(geometry)) return adjacencyCache.get(geometry);
  const position = geometry.attributes.position;
  geometry.computeBoundingBox();
  const size = geometry.boundingBox.getSize(new THREE.Vector3()).length() || 1;
  const precision = size * 1e-6;
  const keyOf = (vertex) => `${Math.round(position.getX(vertex) / precision)},${Math.round(position.getY(vertex) / precision)},${Math.round(position.getZ(vertex) / precision)}`;

  const total = triangleCount(geometry);
  const vertexKeys = new Array(position.count);
  const trianglesByKey = new Map();
  for (let triangle = 0; triangle < total; triangle += 1) {
    triangleVertexIndices(geometry, triangle).forEach((vertex) => {
      vertexKeys[vertex] ??= keyOf(vertex);
      const key = vertexKeys[vertex];
      if (!trianglesByKey.has(key)) trianglesByKey.set(key, []);
      trianglesByKey.get(key).push(triangle);
    });
  }
  const result = { vertexKeys, trianglesByKey };
  adjacencyCache.set(geometry, result);
  return result;
}

// Triangles reachable from the seed without crossing a sharp edge. Neighbours are
// found through shared vertex positions, so this also works for unindexed meshes.
function smoothRegionTriangles(geometry, seed) {
  const { vertexKeys, trianglesByKey } = adjacency(geometry);

  const normals = new Map();
  const normalOf = (triangle) => {
    if (!normals.has(triangle)) normals.set(triangle, readTriangle(geometry, triangle).normal);
    return normals.get(triangle);
  };

  const visited = new Set([seed]);
  const queue = [seed];
  while (queue.length && visited.size < MAX_REGION_TRIANGLES) {
    const triangle = queue.shift();
    const normal = normalOf(triangle);
    triangleVertexIndices(geometry, triangle).forEach((vertex) => {
      trianglesByKey.get(vertexKeys[vertex]).forEach((neighbour) => {
        if (visited.has(neighbour)) return;
        if (normalOf(neighbour).dot(normal) < SMOOTH_ANGLE_COS) return;
        visited.add(neighbour);
        queue.push(neighbour);
      });
    });
  }
  return [...visited];
}

// Least-squares point closest to all lines (centroid + t·normal).
// `axis`, when given, pins the solution's position along that direction to `anchor`.
function closestPointToNormalLines(samples, axis, anchor) {
  const matrix = new THREE.Matrix3().set(0, 0, 0, 0, 0, 0, 0, 0, 0);
  const elements = matrix.elements;
  const rhs = new THREE.Vector3();
  const add = (direction, point, weight, project) => {
    // project = true adds weight·(I − d dᵀ), otherwise weight·(d dᵀ)
    const d = [direction.x, direction.y, direction.z];
    const p = [point.x, point.y, point.z];
    for (let row = 0; row < 3; row += 1) {
      let sum = 0;
      for (let col = 0; col < 3; col += 1) {
        const value = weight * ((project ? (row === col ? 1 : 0) : 0) + (project ? -1 : 1) * d[row] * d[col]);
        elements[col * 3 + row] += value;
        sum += value * p[col];
      }
      rhs.setComponent(row, rhs.getComponent(row) + sum);
    }
  };
  let totalArea = 0;
  samples.forEach(({ normal, area, centroid }) => {
    add(normal, centroid, area, true);
    totalArea += area;
  });
  if (axis) add(axis, anchor, totalArea, false);
  if (Math.abs(matrix.determinant()) < 1e-18 * Math.max(totalArea, 1e-12) ** 3) return null;
  return rhs.applyMatrix3(matrix.invert());
}

// Results per geometry, keyed by every triangle of the analysed surface, so hovering anywhere
// on a surface that was already analysed is instant.
const resultCache = new WeakMap();

// Returns { kind: 'round' | 'flat' | 'curved' | 'point', axis, pivot, radius?, triangles }.
export function analyzeSurface(mesh, seedTriangle) {
  const geometry = mesh.geometry;
  if (!resultCache.has(geometry)) resultCache.set(geometry, new Map());
  const cache = resultCache.get(geometry);
  if (cache.has(seedTriangle)) return cache.get(seedTriangle);
  const result = analyzeRegion(geometry, seedTriangle);
  result.triangles.forEach((triangle) => cache.set(triangle, result));
  cache.set(seedTriangle, result);
  return result;
}

function analyzeRegion(geometry, seedTriangle) {
  const triangles = cadFaceTriangles(geometry, seedTriangle) || smoothRegionTriangles(geometry, seedTriangle);
  const withTriangles = (result) => ({ ...result, triangles });
  const samples = triangles.map((triangle) => readTriangle(geometry, triangle)).filter((sample) => sample.area > 0);
  const seed = readTriangle(geometry, seedTriangle);
  if (!samples.length) return withTriangles({ kind: 'point', axis: seed.normal, pivot: seed.centroid, triangleCount: 0 });

  let totalArea = 0;
  const centre = new THREE.Vector3();
  const meanNormal = new THREE.Vector3();
  const covariance = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  samples.forEach(({ normal, area, centroid }) => {
    totalArea += area;
    centre.addScaledVector(centroid, area);
    meanNormal.addScaledVector(normal, area);
    const n = [normal.x, normal.y, normal.z];
    for (let row = 0; row < 3; row += 1) for (let col = 0; col < 3; col += 1) covariance[row][col] += area * n[row] * n[col];
  });
  centre.divideScalar(totalArea);
  for (let row = 0; row < 3; row += 1) for (let col = 0; col < 3; col += 1) covariance[row][col] /= totalArea;
  const [, second, third] = symmetricEigen(covariance);

  if (second.value < FLAT_THRESHOLD) {
    const axis = meanNormal.lengthSq() > 0 ? meanNormal.normalize() : seed.normal;
    return withTriangles({ kind: 'flat', axis, pivot: centre, triangleCount: samples.length });
  }

  if (third.value < ROUND_THRESHOLD) {
    const axis = third.vector;
    const pivot = closestPointToNormalLines(samples, axis, centre);
    if (pivot) {
      const radius = samples.reduce((sum, { centroid, area }) => {
        const offset = centroid.clone().sub(pivot);
        return sum + area * offset.sub(axis.clone().multiplyScalar(offset.dot(axis))).length();
      }, 0) / totalArea;
      return withTriangles({ kind: 'round', axis, pivot, radius, triangleCount: samples.length });
    }
  }

  const pivot = closestPointToNormalLines(samples) || centre;
  return withTriangles({ kind: 'curved', axis: seed.normal, pivot, triangleCount: samples.length });
}
