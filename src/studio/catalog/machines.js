import * as THREE from 'three';
import { createAssetWrapMachine } from '../../station/station-3/AssetWrapMachine.js';
import { createVacuumGripper } from '../../station/station-3/StationCycle.js';
import { anchor, choice, collider, disposeObject, number } from './shared.js';

// Stretch wrapper (from Wrapping.STEP). Origin: middle of the turntable, on the floor.
// While the scene plays it wraps once a pallet has been put on its turntable (a worker brings
// it), or over and over, or not at all.
const WRAP_SECONDS = 12;
// A pallet this close to the turntable's middle and resting at deck height, still for this long.
const ON_DECK_DISTANCE = 0.3;
const ON_DECK_SETTLE = 0.6;
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
    wraps: choice('Wraps when playing', 'pallet', [
      { value: 'pallet', label: 'Once a pallet is put on it' },
      { value: 'loop', label: 'Over and over' },
      { value: 'never', label: 'Never' },
    ]),
  },
  async build({ stackLength, stackWidth, stackHeight, wraps }) {
    const machine = await createAssetWrapMachine({ stackLength, stackWidth, stackHeight, palletHeight: 0.144, filmClearance: 0.012 });
    const root = machine.root;
    let progress = 0;
    let settled = 0;
    let lastSeen = null;
    let wrapping = false;
    const reset = () => {
      if (progress || wrapping) machine.resetWrap();
      progress = 0;
      settled = 0;
      lastSeen = null;
      wrapping = false;
    };
    // A pallet resting on the turntable (in the turntable's frame), or null.
    const palletOnDeck = (editor) => {
      for (const item of editor.items) {
        if (item.source.kind !== 'catalog' || item.source.id !== 'pallet') continue;
        const palletRoot = editor.runtimes.get(item.id)?.root;
        if (!palletRoot?.visible) continue;
        const local = root.worldToLocal(palletRoot.getWorldPosition(new THREE.Vector3()));
        if (Math.hypot(local.x, local.z) <= ON_DECK_DISTANCE && Math.abs(local.y - machine.deckHeight) <= 0.03) return local;
      }
      return null;
    };
    return {
      root,
      anchors: { surface: anchor('surface', [0, machine.deckHeight, 0], [0, 1, 0], { size: [1, 1] }) },
      colliders: [collider([1.4, machine.deckHeight, 1.4], [0, machine.deckHeight / 2, 0])],
      body: 'static',
      update(deltaTime, editor) {
        if (!editor?.playing || wraps === 'never') {
          reset();
          return;
        }
        if (wraps === 'pallet' && !wrapping) {
          // Waits until the pallet has been let go of (it stops moving), then wraps it once.
          const pallet = palletOnDeck(editor);
          settled = pallet && lastSeen && pallet.distanceTo(lastSeen) < 1e-4 ? settled + deltaTime : 0;
          lastSeen = pallet;
          if (settled < ON_DECK_SETTLE) return;
          wrapping = true;
        }
        if (wraps === 'loop') progress = (progress + deltaTime / WRAP_SECONDS) % 1;
        else progress = Math.min(1, progress + deltaTime / WRAP_SECONDS);
        machine.setWrapProgress(progress);
      },
      dispose: () => disposeObject(root),
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
