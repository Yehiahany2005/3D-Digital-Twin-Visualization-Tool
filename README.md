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

## Joints and animations

Any model, including imported STEP/IGES files, can be made movable and animated in the browser:

1. **Joint Setup**: pick the parts that move and define how they rotate or slide.
2. **Animation Setup**: jog the joints into position and save poses, then chain poses into
   sequences with move times and waits. Sequences play and loop in the app.
3. **Export GLB with animations**: every sequence becomes a real animation clip inside a `.glb`
   file that plays in Blender, Unity, Unreal and web viewers.

Imported models are kept in this browser (IndexedDB), so they are still listed after a page
refresh. Pick models from the asset picker in the header; the ✕ next to an imported model
deletes it from the device. Nothing is uploaded.

Joints, poses and sequences are saved in the browser and in the `.rig.json` file
(Joint Setup → Export), which can be loaded again onto the original model. Animated
exports are always GLB: STEP and other CAD formats have no way to store animation.

Plans and research for click-to-reach (inverse kinematics) are in [`docs/IK_PLAN.md`](docs/IK_PLAN.md).
