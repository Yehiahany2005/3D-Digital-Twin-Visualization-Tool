import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { analyzeSurface } from './surfaceAnalysis.js';
import { niceNumber } from '../ui/JointControls.js';

// The first triangle of a mesh whose normal points along `direction`.
function triangleFacing(geometry, direction) {
  const position = geometry.attributes.position;
  const index = geometry.index;
  const count = (index ? index.count : position.count) / 3;
  for (let triangle = 0; triangle < count; triangle += 1) {
    const [a, b, c] = [0, 1, 2].map((corner) => new THREE.Vector3().fromBufferAttribute(position, index ? index.getX(triangle * 3 + corner) : triangle * 3 + corner));
    const normal = new THREE.Vector3().subVectors(c, b).cross(new THREE.Vector3().subVectors(a, b)).normalize();
    if (normal.dot(direction) > 0.99) return triangle;
  }
  throw new Error('no such face');
}

describe('slide direction from a flat face', () => {
  it('follows the long side of a rail face made of two triangles, not its diagonal', () => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 0.1, 0.3));
    const result = analyzeSurface(mesh, triangleFacing(mesh.geometry, new THREE.Vector3(0, 1, 0)));
    expect(result.kind).toBe('flat');
    expect(Math.abs(result.along.x)).toBeCloseTo(1, 6);
    expect(result.elongation).toBeGreaterThan(3);
  });

  it('works for a rail at an angle', () => {
    const geometry = new THREE.BoxGeometry(2, 0.1, 0.3).rotateY(THREE.MathUtils.degToRad(30));
    const mesh = new THREE.Mesh(geometry);
    const result = analyzeSurface(mesh, triangleFacing(geometry, new THREE.Vector3(0, 1, 0)));
    const expected = new THREE.Vector3(1, 0, 0).applyAxisAngle(new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad(30));
    expect(Math.abs(result.along.dot(expected))).toBeCloseTo(1, 6);
  });

  it('reports no clear direction on a square face', () => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 0.1, 1));
    const result = analyzeSurface(mesh, triangleFacing(mesh.geometry, new THREE.Vector3(0, 1, 0)));
    expect(result.elongation).toBeLessThan(1.3);
  });

  it('gives a rod its centre line', () => {
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1, 32, 1, true));
    const result = analyzeSurface(mesh, 0);
    expect(result.kind).toBe('round');
    expect(Math.abs(result.axis.y)).toBeCloseTo(1, 4);
  });
});

describe('niceNumber', () => {
  it('rounds to 1, 2 or 5 times a power of ten', () => {
    expect(niceNumber(23)).toBe(20);
    expect(niceNumber(480)).toBe(500);
    expect(niceNumber(0.12)).toBeCloseTo(0.1);
    expect(niceNumber(7000)).toBe(5000);
    expect(niceNumber(0)).toBe(1);
  });
});
