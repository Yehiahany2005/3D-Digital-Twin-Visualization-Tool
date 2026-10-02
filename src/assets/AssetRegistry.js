import { formatLabel } from '../loaders/ModelLoader.js';
// ?url makes Vite copy each model into the production build and return its final URL.
import robotUrl from './robot.glb?url';
import forkliftUrl from './Forklift.glb?url';
import depalletizerUrl from './Robotics_Depallatizer_IRB660_with_SafeMove_Zone.glb?url';
import itemPickerUrl from './Robotics_Item_Picker_IRB1300.glb?url';
import unitreeUrl from './Unitree_G1_Brooklyn_Uprock.glb?url';
import miraUrl from './sharable-bot.glb?url';
import roboticArmUrl from './robotic_arm.glb?url';

export const ASSET_REGISTRY = [
  {
    id: 'abb_irb6760',
    name: 'ABB IRB 6760',
    type: 'Industrial Robot',
    model: robotUrl,
    robotController: true,
  },
  {
    id: 'forklift',
    name: 'Forklift',
    type: 'Industrial Vehicle',
    model: forkliftUrl,
    robotController: false,
  },
  {
    id: 'abb_depalettizer',
    name: 'ABB Depalletizer',
    type: 'Industrial Machine',
    model: depalletizerUrl,
    robotController: false,
  },
  {
    id: 'abb_robotpicker',
    name: 'ABB Robot Picker',
    type: 'Industrial Machine',
    model: itemPickerUrl,
    robotController: false,
  },
    {
    id: 'Unitree_robot',
    name: 'Unitree Humanoid Robot',
    type: 'Robot',
    model: unitreeUrl,
    robotController: false,
  },
    {
    id: 'Mira_robot',
    name: 'Mira Robot',
    type: 'Robot',
    model: miraUrl,
    robotController: false,
  },
      {
    id: 'RoboticARM',
    name: 'Robotic Arm',
    type: 'Robot Arm',
    model: roboticArmUrl,
    robotController: false,
  },
];

export function getAssetConfig(assetId) {
  return ASSET_REGISTRY.find((asset) => asset.id === assetId);
}

let importCount = 0;

export function registerImportedAsset(file) {
  importCount += 1;
  const config = {
    id: `imported_${importCount}`,
    name: file.name.replace(/\.[^.]+$/, ''),
    type: `Imported ${formatLabel(file.name)} Model`,
    file,
    robotController: false,
    imported: true,
  };
  ASSET_REGISTRY.push(config);
  return config;
}

export function unregisterAsset(assetId) {
  const index = ASSET_REGISTRY.findIndex((asset) => asset.id === assetId);
  if (index !== -1) ASSET_REGISTRY.splice(index, 1);
}
