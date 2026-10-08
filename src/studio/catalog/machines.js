import * as THREE from 'three';
import { createAssetWrapMachine } from '../../station/AssetWrapMachine.js';
import { createVacuumGripper } from '../../station/StationCycle.js';
import { anchor, collider, disposeObject, number, toggle } from './shared.js';

// Stretch wrapper (from Wrapping.STEP). Origin: middle of the turntable, on the floor.
export const stretchWrapper = {
  id: 'stretch_wrapper',
  name: 'Stretch wrapper',
  category: 'Machines',
  description: 'Turntable pallet wrapper (CAD model)',
  icon: 'Box',
  params: {
    stackLength: number('Load length', 1.9, { min: 0.3, max: 2.5, step: 0.05, unit: 'm' }),
    stackWidth: number('Load width', 1.3, { min: 0.3, max: 2.5, step: 0.05, unit: 'm' }),
    stackHeight: number('Load height', 1.26, { min: 0.2, max: 2.5, step: 0.05, unit: 'm' }),
    spin: toggle('Turntable turns when playing', false),
  },
  async build({ stackLength, stackWidth, stackHeight, spin }) {
    const machine = await createAssetWrapMachine({ stackLength, stackWidth, stackHeight, palletHeight: 0.144, filmClearance: 0.012 });
    let progress = 0;
    return {
      root: machine.root,
      anchors: { surface: anchor('surface', [0, machine.deckHeight, 0], [0, 1, 0], { size: [1, 1] }) },
      colliders: [collider([1.4, machine.deckHeight, 1.4], [0, machine.deckHeight / 2, 0])],
      body: 'static',
      update(deltaTime, editor) {
        if (spin && editor?.playing) {
          progress = (progress + deltaTime / 12) % 1;
          machine.setWrapProgress(progress);
        } else if (progress) {
          progress = 0;
          machine.resetWrap();
        }
      },
      dispose: () => disposeObject(machine.root),
    };
  },
};

// Vacuum gripper: a tool for a robot. Origin: the suction cup's face, so it can stand on the floor
// until it is mounted; the mounting face is at the top.
const GRIPPER_FACE = 0.07; // top of the mounting body above the gripper's own origin
const GRIPPER_CUP = -0.3325; // bottom of the suction cup
export const vacuumGripper = {
  id: 'vacuum_gripper',
  name: 'Vacuum gripper',
  category: 'Tools',
  description: 'Suction gripper to mount on a robot',
  icon: 'Wrench',
  params: {},
  build() {
    const gripper = createVacuumGripper();
    const root = new THREE.Group();
    root.name = 'VacuumGripper';
    gripper.position.y = -GRIPPER_CUP;
    root.add(gripper);
    const length = GRIPPER_FACE - GRIPPER_CUP;
    return {
      root,
      anchors: {
        mount: anchor('tool-mount', [0, length, 0], [0, 1, 0]),
        tip: anchor('tool-tip', [0, 0, 0], [0, -1, 0]),
      },
      colliders: [],
      body: 'none',
      setState: gripper.userData.setState,
      dispose: () => disposeObject(root),
    };
  },
};
