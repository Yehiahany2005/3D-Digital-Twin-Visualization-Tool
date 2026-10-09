import * as THREE from 'three';
import { addMesh, cylinder, flange, group, pipeRun } from './OilGeometry.js';

/**
 * Hoses and product piping. Rigid runs are built once; flexible hoses are
 * spline tubes between two anchor objects and are rebuilt whenever a moving
 * anchor (the filling head) changes position.
 */
export function createHoses({ materials }) {
  const root = group(null, 'Hoses');
  const flexible = [];
  const worldA = new THREE.Vector3();
  const worldB = new THREE.Vector3();

  function rebuild(hose) {
    hose.from.getWorldPosition(worldA);
    hose.to.getWorldPosition(worldB);
    root.worldToLocal(worldA);
    root.worldToLocal(worldB);
    const middle = worldA.clone().lerp(worldB, 0.5).add(hose.sag);
    const curve = new THREE.CatmullRomCurve3([
      worldA.clone(),
      worldA.clone().add(hose.startTangent),
      middle,
      worldB.clone().add(hose.endTangent),
      worldB.clone(),
    ], false, 'centripetal');
    hose.mesh.geometry.dispose();
    hose.mesh.geometry = new THREE.TubeGeometry(curve, 48, hose.radius, 10, false);
    hose.lastKey = worldB.toArray().map((value) => value.toFixed(4)).join();
  }

  return {
    root,
    addRigid(name, points, radius, material = materials.stainless, { flanges = [] } = {}) {
      const run = pipeRun(root, points, radius, material, name);
      flanges.forEach((point, index) => flange(run, radius * 1.9, point, materials.brushed, `${name} flange ${index + 1}`, point[3] || 'y'));
      return run;
    },
    addValve(name, position, axis = 'y', radius = 0.035) {
      const valve = group(root, name, position);
      addMesh(valve, new THREE.SphereGeometry(radius * 1.3, 20, 14), materials.stainless, 'Ball valve body');
      const lever = group(valve, 'Valve lever', [0, radius * 1.3, 0]);
      cylinder(lever, 0.008, 0.04, [0, 0.02, 0], materials.stainless, 'Stem', { segments: 10 });
      addMesh(lever, new THREE.BoxGeometry(0.16, 0.012, 0.025), materials.emergency, 'Lever handle', [axis === 'y' ? 0.07 : 0, 0.04, axis === 'y' ? 0 : 0.07]);
      return valve;
    },
    addGauge(name, position, facing = 'z') {
      const gauge = group(root, name, position);
      cylinder(gauge, 0.01, 0.06, [0, 0.03, 0], materials.brushed, 'Gauge stem', { segments: 10 });
      cylinder(gauge, 0.045, 0.03, [0, 0.1, 0], materials.stainless, 'Gauge case', { axis: facing, segments: 28 });
      const face = new THREE.MeshStandardMaterial({ color: 0xf5f5f0, roughness: 0.4 });
      const dial = cylinder(gauge, 0.038, 0.002, [0, 0.1, 0.016], face, 'Gauge dial', { axis: facing, segments: 28 });
      dial.castShadow = false;
      addMesh(gauge, new THREE.BoxGeometry(0.003, 0.03, 0.002), materials.emergency, 'Gauge needle', [0.006, 0.108, 0.018]).rotation.z = -0.6;
      return gauge;
    },
    addFlexible(name, from, to, { radius = 0.018, material = materials.hose, sag = [0, -0.1, 0], startTangent = [0, -0.12, 0], endTangent = [-0.1, 0.1, 0] } = {}) {
      const hose = {
        from,
        to,
        radius,
        sag: new THREE.Vector3(...sag),
        startTangent: new THREE.Vector3(...startTangent),
        endTangent: new THREE.Vector3(...endTangent),
        mesh: addMesh(root, new THREE.BufferGeometry(), material, name),
        lastKey: '',
      };
      flexible.push(hose);
      return hose;
    },
    /** Rebuilds flexible hoses whose moving end changed since the last frame. */
    update() {
      flexible.forEach((hose) => {
        hose.to.getWorldPosition(worldB);
        root.worldToLocal(worldB);
        const key = worldB.toArray().map((value) => value.toFixed(4)).join();
        if (key !== hose.lastKey) rebuild(hose);
      });
    },
  };
}
