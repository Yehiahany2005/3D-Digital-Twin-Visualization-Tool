export const ASSET_REGISTRY = [
  {
    id: 'abb_irb6760',
    name: 'ABB IRB 6760',
    type: 'Industrial Robot',
    model: '/src/assets/robot.glb',
    robotController: true,
  },
  {
    id: 'forklift',
    name: 'Forklift',
    type: 'Industrial Vehicle',
    model: '/src/assets/Forklift.glb',
    robotController: false,
  },
  {
    id: 'abb_depalettizer',
    name: 'ABB Depalletizer',
    type: 'Industrial Machine',
    model: '/src/assets/Robotics_Depallatizer_IRB660_with_SafeMove_Zone.glb',
    robotController: false,
  },
  {
    id: 'abb_robotpicker',
    name: 'ABB Robot Picker',
    type: 'Industrial Machine',
    model: '/src/assets/Robotics_Item_Picker_IRB1300.glb',
    robotController: false,
  },
    {
    id: 'Unitree_robot',
    name: 'Unitree Humanoid Robot',
    type: 'Robot',
    model: '/src/assets/Unitree_G1_Brooklyn_Uprock.glb',
    robotController: false,
  },
    {
    id: 'Mira_robot',
    name: 'Mira Robot',
    type: 'Robot',
    model: '/src/assets/sharable-bot.glb',
    robotController: false,
  },
      {
    id: 'RoboticARM',
    name: 'Robotic Arm',
    type: 'Robot Arm',
    model: '/src/assets/robotic_arm.glb',
    robotController: false,
  },
];

export function getAssetConfig(assetId) {
  return ASSET_REGISTRY.find((asset) => asset.id === assetId);
}
