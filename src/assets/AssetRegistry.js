import { formatLabel } from '../loaders/ModelLoader.js';
import { ABB_IRB6730S_RIG } from '../rigs/abbIrb6730s.js';
import { ABB_IRB6760_RIG } from '../rigs/abbIrb6760.js';
// ?url makes Vite copy each model into the production build and return its final URL.
import robotUrl from './robot.glb?url';
import depalletizerUrl from './Robotics_Depallatizer_IRB660_with_SafeMove_Zone.glb?url';
import itemPickerUrl from './Robotics_Item_Picker_IRB1300.glb?url';
import unitreeUrl from './Unitree_G1_Brooklyn_Uprock.glb?url';
import roboticArmUrl from './robotic_arm.glb?url';

// inScenes: false keeps a model out of the Scene tab's Add drawer (it still opens in the Machine
// tab, and scenes that already use it still load): whole pre-built cells and showcase models that
// can't be programmed.
export const ASSET_REGISTRY = [
  {
    id: 'abb_irb6760',
    name: 'ABB IRB 6760',
    type: 'Industrial Robot',
    model: robotUrl,
    rig: ABB_IRB6760_RIG,
  },
  {
    id: 'abb_depalettizer',
    name: 'ABB Depalletizer',
    type: 'Industrial Machine',
    model: depalletizerUrl,
    inScenes: false,
  },
  {
    id: 'abb_robotpicker',
    name: 'ABB Robot Picker',
    type: 'Industrial Machine',
    model: itemPickerUrl,
    inScenes: false,
  },
  {
    id: 'Unitree_robot',
    name: 'Unitree Humanoid Robot',
    type: 'Robot',
    model: unitreeUrl,
    inScenes: false,
  },
  {
    id: 'RoboticARM',
    name: 'Robotic Arm',
    type: 'Robot Arm',
    model: roboticArmUrl,
    inScenes: false,
  },
];

export function getAssetConfig(assetId) {
  return ASSET_REGISTRY.find((asset) => asset.id === assetId);
}

// Models the app has a rig for but doesn't ship: an imported file with a matching name gets the
// rig as its preset (Joint Setup → Reset goes back to it). A rig the user saved still comes first.
const KNOWN_IMPORTS = [
  { match: /^IRB6730S_150_400_OC_01\b/i, type: 'Industrial Robot', rig: ABB_IRB6730S_RIG },
];

let importCount = 0;

// stored: the file is also saved in this browser (ImportStore), under that id.
export function registerImportedAsset(file, { id, stored = false } = {}) {
  importCount += 1;
  const known = KNOWN_IMPORTS.find((candidate) => candidate.match.test(file.name));
  const config = {
    id: id || `imported_${importCount}`,
    name: file.name.replace(/\.[^.]+$/, ''),
    type: known?.type || `Imported ${formatLabel(file.name)} Model`,
    file,
    imported: true,
    stored,
    ...(known ? { rig: known.rig } : {}),
  };
  ASSET_REGISTRY.push(config);
  return config;
}

export function unregisterAsset(assetId) {
  const index = ASSET_REGISTRY.findIndex((asset) => asset.id === assetId);
  if (index !== -1) ASSET_REGISTRY.splice(index, 1);
}
