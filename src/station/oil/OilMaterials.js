import * as THREE from 'three';
import { canvasTexture } from './OilGeometry.js';

function beltTexture() {
  const texture = canvasTexture(256, 64, (context, width, height) => {
    context.fillStyle = '#25292c';
    context.fillRect(0, 0, width, height);
    for (let index = 0; index < 1100; index += 1) {
      const value = 32 + Math.random() * 16;
      context.fillStyle = `rgb(${value},${value + 2},${value + 4})`;
      context.fillRect(Math.random() * width, Math.random() * height, 2, 1);
    }
    // Belt splice / cleat lines make the belt motion readable.
    context.fillStyle = '#3a4045';
    for (let x = 0; x < width; x += 64) context.fillRect(x, 0, 3, height);
  });
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  return texture;
}

function labelTexture() {
  return canvasTexture(512, 600, (context, width, height) => {
    context.fillStyle = '#1d4f8f';
    context.fillRect(0, 0, width, height);
    context.fillStyle = '#e39a26';
    context.fillRect(0, height * 0.68, width, height * 0.07);
    context.fillStyle = '#f4f6f8';
    context.textAlign = 'center';
    context.font = 'bold 64px Arial, sans-serif';
    context.fillText('INDUSTRIAL', width / 2, height * 0.2);
    context.fillText('LUBRICANT', width / 2, height * 0.32);
    context.font = 'bold 88px Arial, sans-serif';
    context.fillText('15W-40', width / 2, height * 0.52);
    context.font = 'bold 72px Arial, sans-serif';
    context.fillText('20 L', width / 2, height * 0.9);
  });
}

function wireMeshTexture() {
  const texture = canvasTexture(128, 128, (context, width, height) => {
    context.clearRect(0, 0, width, height);
    context.fillStyle = '#c9ced1';
    for (let offset = 0; offset < width; offset += 16) {
      context.fillRect(offset, 0, 3, height);
      context.fillRect(0, offset, width, 3);
    }
  });
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  return texture;
}

/** PBR material library for the oil filling station. */
export function createOilStationMaterials() {
  const standard = (parameters) => new THREE.MeshStandardMaterial(parameters);
  return {
    stainless: standard({ color: 0xd2d7db, metalness: 0.9, roughness: 0.24 }),
    brushed: standard({ color: 0xaeb6bc, metalness: 0.86, roughness: 0.38 }),
    chrome: standard({ color: 0xe9edf0, metalness: 1, roughness: 0.08 }),
    aluminium: standard({ color: 0xbcc3c8, metalness: 0.78, roughness: 0.34 }),
    frame: standard({ color: 0x55616a, metalness: 0.4, roughness: 0.5 }),
    frameDark: standard({ color: 0x2b3136, metalness: 0.45, roughness: 0.48 }),
    motor: standard({ color: 0x4f6475, metalness: 0.45, roughness: 0.42 }),
    safetyYellow: standard({ color: 0xe0a621, metalness: 0.15, roughness: 0.5 }),
    floorLine: standard({ color: 0xd9a21e, metalness: 0, roughness: 0.7 }),
    floor: standard({ color: 0x59625f, metalness: 0.05, roughness: 0.86 }),
    rubber: standard({ color: 0x1b1d1f, metalness: 0.02, roughness: 0.86 }),
    plasticBlack: standard({ color: 0x202326, metalness: 0.1, roughness: 0.45 }),
    guide: standard({ color: 0xe6e3d8, metalness: 0, roughness: 0.55 }),
    belt: standard({ color: 0xffffff, map: beltTexture(), metalness: 0.02, roughness: 0.82 }),
    beltReturn: standard({ color: 0x1f2326, metalness: 0.02, roughness: 0.85 }),
    hdpe: new THREE.MeshPhysicalMaterial({
      color: 0xf0ebdd,
      metalness: 0,
      roughness: 0.46,
      clearcoat: 0.25,
      clearcoatRoughness: 0.5,
      transparent: true,
      opacity: 0.56,
      depthWrite: false,
    }),
    hdpeSolid: standard({ color: 0xe8e2d0, metalness: 0, roughness: 0.5 }),
    label: standard({ map: labelTexture(), metalness: 0, roughness: 0.6 }),
    oil: new THREE.MeshPhysicalMaterial({
      color: 0xc2860f,
      emissive: 0x2a1800,
      metalness: 0,
      roughness: 0.12,
      clearcoat: 0.6,
    }),
    oilStream: new THREE.MeshPhysicalMaterial({
      color: 0xd49a1c,
      emissive: 0x3a2200,
      metalness: 0,
      roughness: 0.06,
      clearcoat: 1,
    }),
    cap: standard({ color: 0x1f5ea8, metalness: 0.05, roughness: 0.4 }),
    hose: standard({ color: 0x23272a, metalness: 0.1, roughness: 0.6 }),
    airLine: standard({ color: 0x2a78c4, metalness: 0.05, roughness: 0.45 }),
    guard: new THREE.MeshPhysicalMaterial({
      color: 0xd9eef5,
      metalness: 0,
      roughness: 0.06,
      transparent: true,
      opacity: 0.1,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
    sightGlass: new THREE.MeshPhysicalMaterial({
      color: 0xeaf6fa,
      metalness: 0,
      roughness: 0.05,
      transparent: true,
      opacity: 0.35,
      depthWrite: false,
    }),
    lens: standard({ color: 0x0d1418, metalness: 0.2, roughness: 0.1 }),
    fence: standard({
      color: 0xffffff,
      map: wireMeshTexture(),
      alphaTest: 0.5,
      side: THREE.DoubleSide,
      metalness: 0.6,
      roughness: 0.4,
    }),
    emergency: standard({ color: 0xc8231d, metalness: 0.1, roughness: 0.35 }),
    buttonGreen: standard({ color: 0x2f9a4a, metalness: 0.1, roughness: 0.35 }),
  };
}

/** Indicator lamp material with its own emissive state. */
export function createLampMaterial(color) {
  const material = new THREE.MeshStandardMaterial({
    color,
    emissive: color,
    emissiveIntensity: 0,
    metalness: 0.05,
    roughness: 0.3,
    transparent: true,
    opacity: 0.92,
  });
  material.userData.baseColor = new THREE.Color(color);
  return material;
}

export function setLamp(material, on, intensity = 1.6) {
  material.emissiveIntensity = on ? intensity : 0;
  material.color.copy(material.userData.baseColor).multiplyScalar(on ? 1 : 0.35);
}
