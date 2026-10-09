# 3D Digital Twin Visualization Demo

> **Proof-of-concept visualization layer for the Agentic Digital Twin Framework**

A web-based 3D Digital Twin demonstration built with **Three.js** for visualizing and interacting with industrial assets represented as GLB models.

The demo explores how different industrial machines and robots can be integrated into a common Digital Twin environment, with support for embedded GLB animations and interactive joint control for compatible articulated models.

---

## Overview

This project represents the **3D visualization layer** of our broader Agentic Digital Twin framework.

The goal is to provide a common environment where industrial assets can be:

- Loaded as 3D models
- Selected dynamically
- Visualized in a shared Digital Twin environment
- Animated when animations are embedded in the GLB
- Interactively controlled when a model provides a suitable joint structure
- Extended with additional assets without redesigning the visualization system

The current implementation is a **demo/prototype** and focuses specifically on the 3D visualization and asset interaction layer.

---

## Two tabs

The sidebar has two tabs that share one 3D view. The menu in the header follows the tab.

- **Machine**: one model at a time (built-in or imported), with its joints, poses, sequences,
  Joint Setup, Animation Setup and Reach. The header menu picks the model.
- **Scene**: whole scenes. The header menu has two kinds:
  - **Built-in scenes**: the lubricant line (Factory, and Stations 1, 2 and 3 on their own), made in
    code. Start, Reset and Speed run them; a live status shows in the sidebar. They can't be edited.
  - **My scenes**: scenes you build by drag and drop (Add, move, turn, mount tools, Play with
    physics). Each robot can have a **Program** (reach, grip, release, wait for a box, repeat
    across a grid…) that it runs when you press Play; **Pick & place** writes a whole palletizing
    cycle for you. Kept in this browser; Export makes a `.dtscene` file to share.

Code layout: `src/main.js` (shared view, tab switching, frame loop), `src/app/` (the two tabs),
`src/station/` (built-in scenes), `src/studio/` (scene editor), `src/ui/` (Machine panels and
header menus). Details: [`docs/SCENE_PLAN.md`](docs/SCENE_PLAN.md),
[`docs/LUBRICANT_LINE.md`](docs/LUBRICANT_LINE.md).

---

## Joints and animations

Any model, including imported STEP/IGES files, can be made movable and animated in the browser:

1. **Joint Setup**: pick the parts that move and define how they rotate or slide.
2. **Animation Setup**: jog the joints into position and save poses, then chain poses into
   sequences with move times and waits. Sequences play and loop in the app.
3. **Reach**: in the bar above the 3D view, set the **Tool tip** (click the very end of the tool, e.g.
   gripper fingertips), switch on **Reach** and click anywhere: the machine moves its tool there (inverse kinematics), or explains why
   it can't (too far, a joint would pass its range, or the tool can't point that way).
4. **Export GLB with animations**: every sequence becomes a real animation clip inside a `.glb`
   file that plays in Blender, Unity, Unreal and web viewers.

Imported models are kept in this browser (IndexedDB), so they are still listed after a page
refresh. Pick models from the menu in the header (Machine tab); the ✕ next to an imported model
deletes it from the device. Nothing is uploaded.

Joints, poses and sequences are saved in the browser and in the `.rig.json` file
(Joint Setup → Export), which can be loaded again onto the original model. Animated
exports are always GLB: STEP and other CAD formats have no way to store animation.

Plans and research for click-to-reach (inverse kinematics) are in [`docs/IK_PLAN.md`](docs/IK_PLAN.md).
