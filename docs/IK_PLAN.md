# Click-to-Reach (Inverse Kinematics): Research & Build Plan

> **Status:** **built** (phases 1–3, 2026-10-08). Phase 4 items remain open; see §12 and §15.
> **Purpose:** the single reference for building "click a point → the machine's tool moves there".
> It records the concepts, what exists in the code, what the model files contain, every
> experiment with its numbers, the bugs those experiments caught, the generic design, how
> impossible poses are detected and explained, the UI decisions, the build order, the known
> limits and the full prototype source.

---

## 0. Ground rules for this feature

| Rule | Why |
|---|---|
| **Generic. Nothing may depend on a vendor.** | The project is for **Siemens**, and it must not be limited to Siemens products either. ABB files are only *test material* because they happen to be in the repo. No code may assume ABB, six axes, axis names, a robot type, or vendor data in the file. |
| **Works on any model the user rigs** | STEP/IGES/GLB/STL/OBJ/FBX/3MF imports, rigged in Joint Setup: arms, gantries, SCARA, pan-tilt heads, linkages, redundant arms, and machines that are not robots. |
| **Local only** | No server and no cloud. Everything runs in the browser and is saved on the device (IndexedDB + localStorage), like the rest of the app. |
| **Commit authorship** | Commits are authored as the repository owner only: **Antoni-Mikhaiel <antoni.mikhaiel@gmail.com>**, with no co-author trailers. |
| **Vendor data is a bonus, never a requirement** | If a file carries kinematic data (e.g. ABB's `ABB_ro_int_*` extras), it may *pre-fill* things. The feature must work fully without it. |

---

## 1. Concepts (plain language)

| Term | Meaning | Example |
|---|---|---|
| **Mathematical model** | Umbrella term: equations describing how a system behaves so you can predict it. Genuine term, but vague. | — |
| **Kinematic model** | The *description* of a machine's motion geometry: parts, lengths, joint axes, how joints are chained, joint limits. **This is what IK needs.** In this app it is the **rig** built in Joint Setup. | "Upper arm 1.225 m, axis 2 turns −65…85°" |
| **Forward kinematics (FK)** | Joint values → where the tool is. | "Axis angles are these → tool is here" |
| **Inverse kinematics (IK)** | Where the tool should be → joint values. **Click-to-reach is IK.** | "Tool must be here → which angles?" |
| **Dynamic model** | Forces and torques: mass, inertia, motor effort. **Not needed** for click-to-reach. | "Can the motor lift this box this fast?" |
| **TCP (Tool Centre Point)** | The working tip of the tool: the point that should touch the clicked spot. | Suction-cup face, claw tip, welding torch tip |
| **Tool direction** | The direction the tool points (approach direction). | "Pointing straight down" |
| **DOF (degrees of freedom)** | Number of independent joints in the chain that moves the tool. | 6-axis arm = 6 DOF; pan-tilt = 2 DOF |
| **Workspace / reach envelope** | All points the tool can reach. | — |
| **Jacobian** | Table of "if joint *i* moves a little, how does the tool move?" The core of numerical IK. | — |
| **Geometric Jacobian** | Jacobian computed directly from joint axes and positions (rotation: axis × lever arm; slide: axis direction). Fast and exact for normal joints. | — |
| **Finite-difference Jacobian** | Jacobian measured by nudging each joint and watching the tool move. Slower, but always correct (needed when "follower" joints are involved). | — |
| **Damped least squares (DLS)** | The standard numerical IK step. Robust near singularities, with too few or too many joints. | — |
| **Singularity** | A pose where the machine momentarily loses the ability to move in some direction (arm fully stretched; wrist axes lined up). Naive IK explodes there; DLS stays calm. | — |
| **Redundant** | More joints than the task needs; infinitely many solutions. | 7-joint arm reaching a point |
| **Under-actuated** | Fewer joints than the task needs; most targets are impossible. | Pan-tilt asked to *touch* a point |
| **MoveJ / MoveL** | Industry names (used e.g. in ABB RAPID; similar notions exist across vendors). **MoveJ** = joints interpolate (tool path curves). **MoveL** = tool moves in a straight line. | v1 = MoveJ; MoveL later |

---

## 2. What already exists in the code (what IK plugs into)

| Piece | File | Relevance |
|---|---|---|
| **Rig engine** | `src/motion/Rig.js` | The kinematic model. Each joint is a `THREE.Group` at its pivot; children nest inside parents, which *is* FK. `setValues()` clamps to limits, applies joints, then solves followers. |
| Joint types | `Rig.js` | `revolute` (degrees), `prismatic` (**millimetres**). Followers: `aim` (rotate to keep pointing at a point carried by another joint) and `stretch` (slide to keep a distance). Followers are `driven` and not user-controllable. |
| Joint axis in world | `Rig.js` | `joint.axis` is in the group's local frame (after `restQuaternion`). World axis = `axis.transformDirection(group.matrixWorld)`. Pivot = `group.getWorldPosition()`. |
| Prismatic units | `Rig.js` `applyJoint` | Slide distance = `mm / 1000 / metresPerUnit` content units, along the axis in the parent frame. |
| Base joints | `Rig.js` | `base.x`, `base.z`, `base.y`, `base.yaw` move the whole model. **Excluded from IK.** |
| Rest pose / `zero` | `Rig.js` | `joint.zero` = the value the file was exported at (e.g. ABB axis 5 = 30°). `withRestPose(fn)` evaluates in the rest pose; joint pivots/axes are defined there. |
| Smooth moves | `src/motion/MotionPlayer.js` | `moveTo(values)` moves all joints with speed limits and trapezoidal easing, all arriving together. IK reuses this to animate to the solution. |
| Poses / sequences | `MotionPlayer.js`, `AnimationEditorPanel.js` | "Save pose" captures current joint values, so a reached pose can be saved for free. |
| Picking | `src/scene/RigHelpers.js` `ViewportPicker` | Click-vs-drag detection (5 px), raycast against one target object. **Only one handler at a time** (`setHandler`), so Reach mode must coordinate with Joint Setup's picking. Hits include `face.normal`, usable for "face the surface". |
| Highlights / gizmo | `RigHelpers.js` | `PartHighlight` (selection/linked/preview layers, dimming), `JointGizmo` (arrow, ring, target marker, dashed link line). Reusable for the IK target marker. |
| Station IK (existing) | `src/station/StationCycle.js` `solveTarget` | Finite-difference DLS, hardcoded to the ABB station gripper. **To be replaced** by the generic solver later. |
| Persistence | `src/motion/RigStore.js` (localStorage), `src/assets/ImportStore.js` (IndexedDB) | The tool definition will be saved inside the rig definition, so it persists and exports with `.rig.json`. |
| Asset structure | `src/scene/AssetManager.js` | `root` (base motion + unit scale) → `orientation` (up axis) → `content` (file). World units are **metres**. |
| Header asset picker | `src/ui/AssetSelectionPanel.js` | Done in preparation (see §11). |

---

## 3. What the model files contain (data research)

### 3.1 Which models carry kinematic data

| File | Kinematics embedded? | Notes |
|---|---|---|
| `robot.glb` (ABB IRB 6760) | ✅ `ABB_ro_int_kinematics` | Exported from ABB RobotStudio |
| `Robotics_Depallatizer_IRB660…glb` | ✅ | 4-axis palletizer with parallel linkage |
| `Robotics_Item_Picker_IRB1300.glb` | ✅ | 6-axis arm |
| `Unitree_G1…glb`, `robotic_arm.glb` | ❌ (skeleton/bones only) | Animator skeleton, no engineering data |
| `Forklift.glb` | ❌ | Shapes only (file unused) |
| `Wrapping.STEP` | ❌ | STEP *can* hold kinematics in theory; practically never does |
| *(removed)* `sharable-bot.glb` (Mira) | ❌ | Removed from the project |

**Conclusion:** most 3D files have **no** kinematics. The **rig built in Joint Setup is the universal source** of the kinematic model, and that is why the design is generic.

### 3.2 What ABB's embedded data looks like (reference only)

`robot.glb`, node `IRB6760_200_320_OC_01`, extras:

- `ABB_ro_int_jointvalues`: `[0, 0, 0, 0, 0.5236, 0]` (export pose; axis 5 = 30°)
- `ABB_ro_int_mountLinkIndex`: `6`, `ABB_ro_int_mountOffset`: translation `(0, 0, 0.2)` → **tool flange = link 6 + 0.2 m along its Z**
- `ABB_ro_int_kinematics`: XML `<ForwardKinematics>` with:
  - `NumActiveJoints` 6, `NumLinks` 9 (extra links = balancer linkage)
  - **DH parameters** (twist / length / rotation / offset) per joint. Main ones: axis 2 is 0.35 m in front of axis 1, upper arm 1.225 m, 0.2 m offset, forearm 1.5925 m
  - `KinematicBaseFrame`: base height 0.78 m
  - `JointLimitsVector` (radians): axis 1 ±170°, axis 2 −65…85°, axis 3 −180…70°, axis 4 ±300°, axis 5 ±130°, axis 6 ±360°
  - `JointDependencyFuncs`: the balancer follows axis 2 (`atan2(…)` formula)

`IRB660` palletizer (important nuance):
- 4 active joints plus many linkage links with dependency functions (parallelogram keeps the tool level)
- **Coupled joint limits**: `JointLimitsMatrix` rows combine joints (limits on *axis 2 and axis 3 together*). **The rig format cannot express coupled limits yet** (see §13).
- Contains a tool node `T_VacuumGripper` and SafeMove zone geometry (`ABB_ro_int_tag: safemove_zone`)

`IRB1300`: plain 6-axis, base frame 0.544 m, flange offset 0.09 m; tool node `T_Item_Vaccum_Gripper`.

**Use:** optional pre-fill only (e.g. suggest the tool point at the flange). Other vendors use their own formats (e.g. URDF in ROS, vendor-specific CAD/simulation exports). A future "import kinematics" feature could read several formats, but **the core IK never depends on any of them.**

### 3.3 Where to find kinematic data for a real machine (manual route)

In a vendor's **product specification / data sheet** (PDF), look for:
- **Dimension drawings**: side/top views with distances between joint axes (link lengths, offsets)
- **Working range / axis range table**: per axis "+X° to −Y°"
- **Axis max speed table** (°/s)
- **Load diagram** (payload vs distance; dynamics, not needed for IK)
- Keywords: *working range, axis, dimensions, DH parameters, Denavit–Hartenberg, kinematic parameters, link lengths, TCP, tool flange*

Simulation files (vendor simulation tools, ROS **URDF**) usually contain full kinematics. In this app the user builds the same thing in Joint Setup.

---

## 4. Experiments (method)

- **Where:** the real app modules loaded in a headless Chromium (Playwright) via the Vite dev server; real `Rig.js`, real `robot.glb`.
- **Targets:** generated by putting the machine in a **random valid pose** (within limits) and recording where the tool is. Every target is therefore **reachable**, so failures are the solver's fault, not the target's.
- **Start pose:** home/current pose (as a user would have it).
- **Success:** position error < tolerance (1 mm for the ABB; ≈0.02 % of model size generically) and, when orientation is requested, tool direction within 0.5°.
- **Prototype source:** Appendix A (generic solver). Harness details: Appendix B.

---

## 5. Experiment results

### 5.1 Round 1: ABB only, method comparison (300 targets, single try)

| Method | Success | Avg iterations | FK evaluations | Avg time | 95th pct time |
|---|---|---|---|---|---|
| Finite-difference Jacobian (**Station-style**) | 88.0 % | 34.6 | 243 | 7.8 ms | 31.2 ms |
| **Geometric Jacobian** | **96.7 %** | 25.0 | 26 | **1.1 ms** | 3.0 ms |

→ Geometric is **~7× faster** and more reliable.

### 5.2 Round 2: ABB, robustness tricks

| Variant | Success | Avg tries | Avg | p95 | Max |
|---|---|---|---|---|---|
| Position only, single try | 96.7 % | 1 | 1.2 ms | 4.6 ms | 13 ms |
| Position only, **aim + reseeds** | **99.0 %** | 1.11 | 1.5 ms | 2.5 ms | 37 ms |
| Position + tool direction (6-D), single | 94.3 % | 1 | 1.8 ms | 6.1 ms | 13 ms |
| 6-D, aim + reseeds | 95.3 % | 1.26 | 3.5 ms | 30.6 ms | 54 ms |

Other ABB measurements:
- **Reach at 1 m height:** about 0.9 m to 3.35 m from the base axis.
- **Grid of 1,125 points** (x, z −3.5…3.5 m, five heights): 592 reachable (position only), **483 reachable with the tool pointing straight down**.

  | Height | Points | Reachable (any angle) | Reachable (pointing down) |
  |---|---|---|---|
  | 0.05 m | 225 | 115 | 105 |
  | 0.5 m | 225 | 123 | 110 |
  | 1.0 m | 225 | 131 | 105 |
  | 1.5 m | 225 | 127 | 99 |
  | 2.5 m | 225 | 96 | 64 |

- **Continuity:** from 100 random poses, moving the target 5 cm → max joint change 13.1°, **0 sudden jumps** (>20°). Good for live dragging and future straight-line moves.
- **Unreachable target** (6 m away): the arm stretches toward it and stops as close as it can (axis 2 ≈78°, axis 3 ≈−80°). Correct "closest reach" behaviour.

### 5.3 Round 3: first generic version (regression, kept for the record)

| Machine | Position | Pos + direction |
|---|---|---|
| Gantry (mm) | **0 %** | **0 %** |
| SCARA | **3 %** | **3 %** |
| Pan-tilt | 100 % | 100 % |
| 7-joint arm | 95 % | **15 %** |
| Linkage (follower in chain) | 61 % | 91 % |
| ABB IRB 6760 | 90 % | 54 % |

**Cause:** the math was done *per degree* and *per millimetre*. Those units differ by orders of magnitude, so the damping term drowned sliding joints and slowed everything. See §6.

### 5.4 Round 4: final generic version (units fixed)

150 random reachable targets per machine, start from rest pose, robust seeding:

| Machine | Active joints | Jacobian | Position only | Position + direction |
|---|---|---|---|---|
| **Gantry built in millimetres** (3 slides + 2 rotations) | x(p) z(p) y(p) spin(r) tilt(r) | geometric | **99 %**, 1.1 ms | **99 %**, 1.6 ms |
| **SCARA** (2 rotations + slide + rotation) | j1(r) j2(r) j3(p) j4(r) | geometric | **100 %**, 0.2 ms | **100 %**, 1.9 ms |
| **Pan-tilt** (2 rotations) | pan(r) tilt(r) | geometric | **100 %**, 0.1 ms | **100 %**, 0.1 ms |
| **Redundant 7-joint arm** | q0…q6 (r) | geometric | **100 %**, 0.3 ms | **100 %**, 1.0 ms |
| **Linkage, tool on a follower** | crank(r) hand(r) | finite-difference | **100 %**, 0.3 ms | **100 %**, 0.3 ms |
| **ABB IRB 6760** (real file) | axis1…6 (r) | geometric | **100 %**, 0.7 ms | **99 %**, 2.9 ms |

(p = prismatic/slide, r = revolute/rotation)

→ **Fast enough to solve live on mouse-move** (budget ≈16 ms/frame at 60 fps).

### 5.5 Round 5: failure diagnosis (ABB, real file)

| Test point | Diagnosis returned | Verdict |
|---|---|---|
| In front, 1 m up, pointing down | reachable | ✅ |
| Directly behind the robot | reachable, by **bending over backwards** | ⚠️ valid but surprising (see §8) |
| 8 m away | **out of reach, 4.63 m short** | ✅ |
| Inside the base | **joint limits**: "Axis 3 needs 111°, range −180…70°", "Axis 5 needs 167°, range −130…130°" | ✅ |
| High up (3.6 m), pointing down | **out of reach, 0.40 m short** | ✅ |
| **Below the floor** | reachable | ⚠️ **needs an explicit floor check** (see §8) |

---

## 6. Lessons the experiments taught (must be kept in the real build)

1. **Solve in natural units.** Jacobian columns per **radian** (rotation) and per **metre of travel** (slide); convert the step back to degrees / millimetres for the rig. Mixing units breaks sliding joints (0 % → 99 %).
2. **Scale-aware numbers.** Tolerance ≈ 0.02 % of model size (min 0.1 mm), damping ≈ 0.5 % of size, orientation weight ≈ 15 % of size per radian. A 10 cm gripper and a 10 m gantry then behave the same.
3. **Chain = more than "mounted on".** If a follower joint is in the tool's chain, the joint it *follows* (and that joint's chain) also moves the tool and must be included.
4. **Followers in the chain → finite-difference Jacobian.** The geometric Jacobian ignores follower coupling; finite differences capture it (still fast: 0.3 ms in the test).
5. **Geometric Jacobian otherwise.** ~7× faster than finite differences, and more reliable.
6. **Robust seeding.** Try current pose → current with the first rotating joint "aimed" at the target (generic: rotate about *its own axis* so the tool's projection points at the target's projection) → rest pose → a few seeded random poses within limits. 97 % → 99–100 %.
7. **Step limits.** Cap each step (10° for rotations, 10 % of range for slides) to avoid overshoot; clamp to joint limits every step.
8. **Orientation error = rotation vector** (axis × angle from current tool direction to desired); angular Jacobian column = the joint's world axis. (A sign error here gave 0 % in an early test.)
9. **Test with machines that are *not* robot arms.** The gantry and SCARA exposed the units bug that the ABB alone hid.

---

## 7. Generic design

### 7.1 Tool definition (new, stored in the rig)
```js
// rig definition (saved in browser + exported in .rig.json)
tools: [{
  id: 'tool_1',
  name: 'Gripper',
  joint: 'axis6',            // joint whose parts carry the tool
  point: [x, y, z],          // tool point, model frame, rest pose (like joint pivots)
  direction: [x, y, z],      // tool pointing direction, model frame, rest pose
}]
```
- Set in **Joint Setup → "Set tool point"**: click on the model (like "Pick follow point"). The joint is found from the clicked part. The direction defaults to **out of the clicked surface** (face normal), with Reverse and the existing direction buttons.
- **Multiple tools allowed** (two-armed machines, humanoids). Reach asks which tool when there is more than one.
- **Optional pre-fill** when vendor data exists (e.g. ABB flange); never required.
- Converted at runtime to the joint group's local frame using `withRestPose` (same technique as pivots).

### 7.2 Chain detection (generic)
1. Start at the tool's joint; walk "mounted on" (`parent`) to the base.
2. For every **follower** found, also walk from the joint it follows (recursively).
3. **Active joints** = non-driven joints in that set; **base joints excluded**.
4. Joints not in the chain never move (the other arm of a two-armed machine stays still).
5. **0 active joints** → "This tool isn't on anything that moves."

### 7.3 Solver (`src/motion/InverseKinematics.js`, pure module, no UI)
- Damped least squares with: natural units, scale-aware tolerance/damping/weight, step caps, clamping.
- Jacobian: geometric by default; **finite-difference automatically** when a follower is in the chain.
- Tasks: **position (3-D)** or **position + tool direction (5-D: point + pointing axis)**. Full 6-D (including the twist about the tool axis) is unnecessary for click-to-reach and left for later.
- Robust wrapper: seeds as in §6.6; **keep the valid solution with the least total joint motion** (avoids surprise flips).
- **Wrap-around:** for joints with range > 360° (e.g. ±360°), choose the equivalent angle nearest the current value.
- Runs synchronously and restores the rig pose afterwards, so nothing visibly flickers (rendering only happens on the next animation frame).
- Budget: ~0.1–3 ms typical; worst cases ~50 ms (throttle hover to one solve per frame, and use the cached last solution as the seed).

### 7.4 Orientation modes
| Mode | Meaning | Default |
|---|---|---|
| **Point down** | Tool direction = straight down (world −Y) | ✅ **Default** (decided) |
| Any angle | Position only; reaches the most places | |
| Face the surface | Tool direction = into the clicked surface (−face normal) | |

If the chain has too few joints for the chosen mode, the mode still runs, the diagnosis says "can reach the point but not pointing down", and offers "Reach anyway (any angle)".

### 7.5 Motion
- Solve → `MotionPlayer.moveTo(solution)` (joint-space, speed limits, easing). Label "Reaching…".
- Stop / jog / Joint sliders interrupt as they already do.
- **Save as pose** is already possible from Animation Setup after reaching.
- Later: **straight-line moves (MoveL)**: solve IK at many points along the line, seeding each from the previous (continuity results in §5.2 show this is feasible).

---

## 8. "Physically impossible" poses: detection and explanation

A reach can fail for different reasons, and the user must be told **which one**. The diagnosis re-runs the solve with relaxed rules (prototype in Appendix A, `diagnose`):

| Step | Re-run with… | If it now succeeds, the cause is… | Message to the user (example) |
|---|---|---|---|
| 0 | normal rules | — (reachable) | green marker |
| 1 | **joint limits removed** | **a joint would have to turn or slide beyond its range** ("twist in a way it can't") | "Axis 3 would need 111°; its range is −180° to 70°. Axis 5 would need 167°; its range is −130° to 130°." |
| 2 | **orientation dropped** | **the point is reachable, but not with the tool pointing that way** (not enough joints, or limits) | "Can reach this point, but not pointing down (best: 35° off). Switch to 'Any angle'?" |
| 3 | nothing helps | **out of reach** (too far or too close for the machine's geometry) | "Out of reach: 38 cm too far." / "Too close to the base." |

Additional checks after a successful solve:

| Check | Why | Behaviour |
|---|---|---|
| **Target below the floor** (y < floor) | The math happily reaches below the floor (§5.5) | Red marker: "Below the floor" |
| **Any tool-chain part below the floor in the solution** | Arm could dip through the floor | Warning: "The arm would go through the floor" |
| **Large joint swing** (e.g. > 120° total, or a base flip) | "Bending over backwards" solutions (§5.5) are valid but surprising | Amber marker + "Big move: reaches behind by bending over the top." |
| **Near a singularity** (Jacobian nearly flat) | Motion becomes jerky near singular poses | Small note: "Close to a stretched/aligned pose; moves may be sudden" |
| **Chain fully stretched** | Tool is at the edge of its reach | Info only |

Not detected in v1 (documented limits): self-collision (arm hitting itself), collisions with other objects, coupled limits (§13).

---

## 9. UI / UX decisions

### 9.1 Where Reach lives (decided)
**Not in the sidebar** (too crowded). Reach is a **toolbar along the top edge of the 3D viewport**, overlaid on the scene:

```
┌───────────────────────────── 3D view ─────────────────────────────┐
│ [◎ Reach]  Tool: [Gripper ▾]  Mode: [Point down|Any angle|Face]  ⓘ status │
│                                                                    │
│                      (model)            ● target marker            │
```

- **Reach** toggles click-to-reach mode (crosshair cursor). **Esc** exits.
- **Tool** selector appears only if the rig has more than one tool.
- **Mode**: segmented control; **Point down** is the default.
- **Status**: "Reachable · 1.4 s", or the diagnosis message from §8.
- The header holds the **asset picker** (§11); the viewport top bar holds **tools that act on the 3D scene**. Clear separation.

### 9.2 Interaction details
| Situation | Behaviour |
|---|---|
| Hover in Reach mode | Solve live (throttled); marker green = reachable, red = not, amber = reachable but big swing; reason in the status |
| Click | Move there (MoveJ); marker stays until the next click |
| Click on the moving machine itself | Ignored: "Click a spot on the floor or on another object" |
| Click empty space (no hit) | Use the floor plane; if the floor isn't hit either, use a plane at the tool's current height |
| No joints yet | Reach disabled with "Set up joints first" + button to open Joint Setup |
| Joints but no tool point | "Set a tool point first" + button (opens Joint Setup at "Set tool point") |
| Joint Setup picking active | Only one click mode at a time: turning Reach on turns Joint Setup picking off, and vice versa |
| Station mode | Reach hidden (the station drives the robot), like Animation Setup |
| While a sequence plays | Clicking Reach stops it first |

---

## 10. Data format changes

- `rig.definition.tools = [...]` (§7.1). Backwards compatible: old rigs have no `tools` and simply show "Set a tool point first".
- `emptyRigDefinition()` gains `tools: []`; `Rig.setDefinition` normalises `tools`.
- Exported `.rig.json` includes tools automatically (the whole definition is exported).

---

## 11. Preparation already done (shipped before IK)

### 11.1 Asset picker redesign (the dropdown was getting crowded)
- **Moved out of the sidebar into the header** as a button showing the current asset (name + type).
- Opens a **searchable menu** grouped into **Scenes** (Station), **Built-in models**, and **Imported on this device** (with file-format badge and a ✕ to remove each).
- **Import 3D / CAD file** lives at the bottom of the menu. Keyboard: arrows move, Enter picks, Esc closes; click outside closes.
- Loading progress and errors now show as a small **status line over the 3D view** (bottom-left); errors are no longer wiped by the end-of-load reset.
- The sidebar "Digital Twin Asset" card was removed (frees sidebar space).
- Picking a model while Station runs leaves Station first.

### 11.2 Removed
- **Mira robot** (`sharable-bot.glb`) removed from the asset list and the repository.

### 11.3 Bugs fixed along the way (pre-existing)
- Leaving Station left the station's **suction gripper attached** to the robot's wrist → now removed on leave.
- Leaving Station left the robot's **base joints** at their station values → the next joint change snapped the robot back to its station position. Now reset on leave.

### 11.4 Earlier groundwork that IK relies on
- Local saving of imported models (IndexedDB) and rigs (localStorage).
- Joint Setup with follower joints, threaded joint list, part highlighting.
- Animation Setup (poses, sequences, GLB export).

---

## 12. Build plan (phased; each phase testable on its own)

| Phase | Deliverable | Acceptance criteria |
|---|---|---|
| **1. Solver** | `src/motion/InverseKinematics.js`: chain detection, geometric + finite-difference Jacobian, DLS, robust seeding, wrap-around, least-motion choice, `diagnose()` | Automated tests on the six machines of §5.4 reproduce ≥ 99 % (position) and ≥ 98 % (direction); diagnosis cases of §5.5 return the expected verdicts; below-floor rejected |
| **2. Tool point** | `tools` in the rig; Joint Setup "Set tool point" (click, normal-based direction, Reverse); marker on the model; saved + exported | Set, edit, delete tool; survives refresh and export/import; works on an imported STEP |
| **3. Reach toolbar** | Viewport top bar: Reach toggle, modes (Point down default), tool selector, status; hover preview, click to move, diagnosis messages, floor checks | Manual + automated browser test on the ABB and on a rigged non-ABB model |
| **4. Polish / later** | Undo last reach; MoveL straight-line moves; "Reach point" sequence step; optional vendor pre-fill; Station switched to the generic solver | — |

**Testing approach:** the repository has no test runner yet. Plan: add a small one (e.g. Vitest) for the pure solver module, and keep Playwright browser checks for the UI.

---

## 13. Known limits and future work

| Limit | Why | Possible future step |
|---|---|---|
| **Skeleton-animated models** (e.g. `Unitree`, `robotic_arm.glb`) | They move by bones, not separate parts; Joint Setup can't rig them | "Use the file's skeleton as joints" (three.js also has a bone-based CCD IK solver) |
| **Coupled joint limits** (e.g. palletizer "axis 2 + axis 3" limits) | Rig format has only per-joint limits | Add optional coupled-limit rules to the rig |
| **Collision** (self, other objects) | Not modelled | Simple bounding-volume checks first |
| **Straight-line moves (MoveL)** | v1 is joint-space | Phase 4 |
| **Dynamics** (payload, torque) | Out of scope for a visual twin | Physics engine later if needed |
| **Multi-model scenes** | App shows one model at a time | Needed later to rebuild Station as user data |
| **Vendor kinematics import** | Each vendor has its own format | Optional importers (URDF, vendor exports) feeding the same rig |

---

## 14. Decisions log

| Date | Decision |
|---|---|
| 2026-10-08 | IK must be **fully generic**: project is for Siemens, and not limited to Siemens products |
| 2026-10-08 | Reach lives in a **top toolbar over the 3D view**, not in the sidebar |
| 2026-10-08 | **Point down** is the default orientation mode; user can switch |
| 2026-10-08 | Asset selection moved to a **searchable header picker**; Mira robot removed |
| 2026-10-08 | Report *why* a reach fails (joint limit / orientation / out of reach / floor) |
| 2026-10-08 | Solver: damped least squares, geometric Jacobian, finite differences when followers are in the chain |
| 2026-10-08 | Clicking an unreachable spot does **not** move the machine; the status explains why (and offers "Use any angle" when only the direction is the problem) |
| 2026-10-08 | v1 uses position + pointing direction (5-D); the twist about the tool axis is left free |
| 2026-10-08 | **One tool tip per machine**, set from the Reach bar (not Joint Setup). Several tool points confused users; the data format still allows a list for later (tool changers). |
| 2026-10-08 | Modes renamed for clarity: Point down → **Straight down**, Face surface → **Square to surface**. Each has an icon and a one-line hint when clicked. |
| 2026-10-08 | "Pick from surface" renamed **Find axis on model**, with a live hover preview of the detected axis. "Find a joint" search removed. |

---

## 15. As built (2026-10-08)

| Piece | Where | Notes |
|---|---|---|
| Solver | `src/motion/InverseKinematics.js` | `chainFor`, `resolveTool`, `solveReach`, `diagnoseReach`. Pure module, no UI. |
| Tests | `src/motion/InverseKinematics.test.js` (`npm test`, Vitest) | 18 tests on generic machines built from boxes: six-axis arm, gantry in millimetres, SCARA, 7-joint arm, linkage with a follower, pan-tilt. Includes diagnosis cases (out of reach, below floor, joint range, orientation, big swing). |
| Tool points in the rig | `src/motion/Rig.js` (`tools`, `setTools`) | Saved with the rig (browser + `.rig.json`). Missing joints raise a rig warning. Deleting a joint removes its tool points. |
| Tool tip control (Reach bar) | `src/ui/ReachPanel.js`, `index.html` | "Tool tip" button opens a small card with a picture (tip ✓ at the very end of the tool, ✗ where it is bolted on), where it is now, and **Pick on model** / **Flip arrow** / **Reset** (built-in rigs) or **Remove** (imports). While picking, a pink dot + arrow follows the pointer over moving parts; fixed parts say "This part doesn't move". Direction = out of the clicked face (towards the camera). Uses `rig.tools[0]`. |
| Reach toolbar | `src/ui/ReachPanel.js`, `index.html` | Top-left over the 3D view: Reach toggle, Tool tip control, modes **Straight down** (default) / **Any angle** / **Square to surface** with icons, status line with action button. On the floor Straight down and Square to surface behave the same (the floor faces up); they differ on walls and sloped faces. Hover: quick solve every frame, full diagnosis after the pointer rests 180 ms. Click: full diagnosis, then `MotionPlayer.moveTo`. Esc stops. Hidden in Station. |
| Viewport picking | `src/scene/RigHelpers.js` `ViewportPicker` | Owner-based: Reach and Joint Setup take turns; several targets (model + floor); hover callback; hit filter (Reach ignores the moving machine itself). |
| Markers | `RigHelpers.js` `ToolMarkers`, `ReachMarker` | Tool point (pink dot + arrow); target (green = reachable, amber = reachable with a warning, red = not). |
| "Find axis on model" preview (Joint Setup) | `src/motion/surfaceAnalysis.js`, `RigHelpers.js` `SurfacePreview`, `RigEditorPanel.js` | Hovering shows the detected surface in amber, the axis as a dashed line, the pivot dot and a ring the size of the shaft/hole, with "Round surface, Ø N mm" or "Flat face" text. Surface analysis caches adjacency and results so hover stays smooth. |
| Built-in ABB rig | `src/rigs/abbIrb6760.js` | Ships with a tool point at the flange (data only; the solver has no vendor code). |

Verified in the browser: ABB flange lands on the clicked spot pointing down; far spots report "out of reach by N m"; a STEP import without joints offers "Set up joints"; a STEP with a single slide reports its limited reach; picking the tool tip on the flange works and turns Reach on; the axis preview appears on round and flat surfaces; Station hides the bar.

Still open (phase 4): undo last reach, straight-line moves (MoveL), "reach point" sequence step, optional vendor pre-fill for imports, switching the Station to this solver, singularity hints.

## Appendix A: Prototype solver (reference; not used by the app)

Throwaway prototype used for the experiments in §5. It runs in the browser against the real `Rig.js`. The production version will be a cleaned-up `src/motion/InverseKinematics.js`.

```js
// Generic IK prototype: works on any rig. Nothing here knows about ABB.
import * as THREE from 'three';
import { Rig } from '/src/motion/Rig.js';
export { THREE, Rig };
const D2R = Math.PI / 180;

// A tool = a point (and optional pointing direction) fixed to one joint's group.
// chain = that joint and the joints it is mounted on, in base → tip order.
export function makeTool(rig, jointId, localPoint, localDir = new THREE.Vector3(0, 0, 1)) {
  const tip = rig.jointsById.get(jointId);
  // Everything that can move the tool: the joints it is mounted on, plus (for followers in
  // that chain) the joints they follow and what those are mounted on.
  const found = new Set();
  const visit = (j) => {
    for (let c = j; c && !found.has(c); c = rig.jointsById.get(c.definition.parent)) {
      found.add(c);
      const link = c.definition.aim || c.definition.stretch;
      if (link) visit(rig.jointsById.get(link.joint));
    }
  };
  visit(tip);
  const chain = rig.joints.filter((j) => found.has(j)); // rig order = parents first
  return {
    chain,
    active: chain.filter((j) => !j.driven),
    hasDrivenInChain: chain.some((j) => j.driven),
    position: () => tip.group.localToWorld(localPoint.clone()),
    direction: () => localDir.clone().transformDirection(tip.group.matrixWorld),
  };
}

// Jacobian columns in natural units: per radian for rotations, per metre of travel for slides.
// unit = how many rig units (degrees or mm) one natural unit is, to convert the step back.
function geometricColumn(joint, p) {
  const g = joint.group;
  const w = joint.axis.clone().transformDirection(g.matrixWorld);
  if (joint.type === 'revolute') {
    const o = g.getWorldPosition(new THREE.Vector3());
    return { lin: new THREE.Vector3().crossVectors(w, p.clone().sub(o)), ang: w, unit: 1 / D2R };
  }
  const perMm = mmToWorld(joint).length(); // world metres moved by 1 mm of joint value
  return { lin: w, ang: new THREE.Vector3(), unit: 1 / perMm };
}
function mmToWorld(joint) {
  const g = joint.group;
  const before = g.getWorldPosition(new THREE.Vector3());
  const localAxis = joint.axis.clone().applyQuaternion(joint.restQuaternion);
  const after = g.parent.localToWorld(g.position.clone().addScaledVector(localAxis, 1 / 1000 / joint.__mpu));
  return after.sub(before);
}

export function solve(rig, tool, target, { orient = null, seed = null, maxIter = 150, lambda = null, tol = null, fd = null, weight = null } = {}) {
  const joints = tool.active;
  joints.forEach((j) => { j.__mpu = rig.metresPerUnit; });
  const useFd = fd ?? tool.hasDrivenInChain;
  const size = rig.__size ??= new THREE.Box3().setFromObject(rig.root).getSize(new THREE.Vector3()).length();
  const tolerance = tol ?? Math.max(1e-4, size * 2e-4);       // ~0.02% of model size
  const damping = lambda ?? size * 0.005;                     // scale-aware damping (≈0.02 for a 4 m robot)
  const W = weight ?? size * 0.15;                            // 1 rad of tilt counts like 15% of the model's size
  const q = joints.map((j) => (seed?.[j.id] ?? j.value));
  const apply = () => rig.setValues(Object.fromEntries(joints.map((j, i) => [j.id, q[i]])));
  let err = Infinity; let oriErr = 0; let iter = 0;
  for (; iter < maxIter; iter++) {
    apply();
    const p = tool.position();
    const e = target.clone().sub(p);
    const rows = [e.x, e.y, e.z];
    if (orient) {
      const z = tool.direction();
      const axis = new THREE.Vector3().crossVectors(z, orient);
      const ang = Math.atan2(axis.length(), z.dot(orient));
      if (axis.lengthSq() < 1e-12) axis.set(0, 0, 0); else axis.setLength(ang);
      if (ang > 3.1) axis.copy(new THREE.Vector3(1, 0, 0).cross(z).setLength(ang));
      rows.push(axis.x * W, axis.y * W, axis.z * W);
      oriErr = ang / D2R;
    }
    err = e.length();
    if (err < tolerance && (!orient || oriErr < 0.5)) break;
    const units = [];
    const cols = joints.map((j, i) => {
      if (useFd) {
        // Nudge in rig units, then express per natural unit (radian / metre) like the geometric path.
        const h = j.type === 'revolute' ? 0.05 : 0.5; const save = q[i];
        const unit = j.type === 'revolute' ? 1 / D2R : 1 / mmToWorld(j).length();
        const zc = orient ? tool.direction() : null;
        q[i] = save + h; apply();
        const k = unit / h;
        const dp = tool.position().sub(p).multiplyScalar(k);
        let da = [];
        if (orient) { const cr = new THREE.Vector3().crossVectors(zc, tool.direction()).multiplyScalar(k); da = [cr.x * W, cr.y * W, cr.z * W]; }
        q[i] = save; apply();
        units[i] = unit;
        return [dp.x, dp.y, dp.z, ...da];
      }
      const c = geometricColumn(j, p);
      units[i] = c.unit;
      return orient ? [c.lin.x, c.lin.y, c.lin.z, c.ang.x * W, c.ang.y * W, c.ang.z * W] : [c.lin.x, c.lin.y, c.lin.z];
    });
    // Damped least squares, scaled per joint so degrees and millimetres are comparable.
    const m = rows.length;
    const A = Array.from({ length: m }, (_, r) => Array.from({ length: m }, (_, c) => cols.reduce((s, col) => s + col[r] * col[c], 0) + (r === c ? damping * damping : 0)));
    const y = gauss(A, rows);
    const dq = cols.map((col, i) => col.reduce((s, v, r) => s + v * y[r], 0) * units[i]); // back to ° / mm
    // Limit each step: 10° for rotation, 10% of the slide range for slides.
    let scale = 1;
    joints.forEach((j, i) => { const cap = j.type === 'revolute' ? 10 : (j.max - j.min) * 0.1; if (Math.abs(dq[i]) > cap) scale = Math.min(scale, cap / Math.abs(dq[i])); });
    joints.forEach((j, i) => { q[i] = THREE.MathUtils.clamp(q[i] + dq[i] * scale, j.min, j.max); });
  }
  apply();
  return { q: Object.fromEntries(joints.map((j, i) => [j.id, q[i]])), err, oriErr, iter, tolerance };
}

function gauss(A, b) {
  const n = b.length; const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) if (r !== c) { const f = M[r][c] / M[c][c]; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
  }
  return M.map((row, i) => row[n] / row[i]);
}

// Generic seeding: current pose, rest pose, "aim" (turn the first rotating joint so the tool
// faces the target, about whatever axis it has), then seeded random restarts within limits.
export function solveRobust(rig, tool, target, opts = {}, { restarts = 6, rand = mulberry(1) } = {}) {
  const joints = tool.active;
  const current = Object.fromEntries(joints.map((j) => [j.id, j.value]));
  const rest = Object.fromEntries(joints.map((j) => [j.id, j.zero]));
  const seeds = [current, rest];
  const first = joints.find((j) => j.type === 'revolute');
  if (first) {
    rig.setValues(current);
    const w = first.axis.clone().transformDirection(first.group.matrixWorld);
    const o = first.group.getWorldPosition(new THREE.Vector3());
    const a = tool.position().sub(o).projectOnPlane(w); const b = target.clone().sub(o).projectOnPlane(w);
    if (a.lengthSq() > 1e-10 && b.lengthSq() > 1e-10) {
      const ang = Math.atan2(new THREE.Vector3().crossVectors(a, b).dot(w), a.dot(b)) / D2R;
      seeds.splice(1, 0, { ...current, [first.id]: THREE.MathUtils.clamp(current[first.id] + ang, first.min, first.max) });
    }
  }
  for (let i = 0; i < restarts; i++) seeds.push(Object.fromEntries(joints.map((j) => [j.id, j.min + (j.max - j.min) * rand()])));
  let best = null; let tries = 0;
  for (const seed of seeds) {
    tries++;
    const r = solve(rig, tool, target, { ...opts, seed });
    const score = r.err + (opts.orient ? r.oriErr * r.tolerance : 0);
    if (!best || score < best.score) best = { ...r, score };
    if (r.err < r.tolerance && (!opts.orient || r.oriErr < 0.5)) break;
  }
  return { ...best, tries };
}

export function mulberry(seed) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

// ---- Synthetic machines (plain boxes), built like an imported file -------------------------
export function buildModel(parts, unitScale = 1) {
  const content = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial();
  parts.forEach(({ name, size, at }) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(...size), mat); m.name = name; m.position.set(...at); content.add(m);
  });
  const root = new THREE.Group(); root.scale.setScalar(unitScale); root.add(content); root.updateMatrixWorld(true);
  return { root, content };
}
export function rigFor(model, joints) {
  return new Rig({ root: model.root, content: model.content, definition: { version: 1, joints, poses: [], sequences: [] } });
}

// Why did a reach fail? Re-run the solve with relaxed rules to find which rule blocked it.
export function diagnose(rig, tool, target, opts = {}) {
  const first = solveRobust(rig, tool, target, opts);
  if (first.err < first.tolerance && (!opts.orient || first.oriErr < 0.5)) return { verdict: 'reachable', first };
  const saved = tool.active.map((j) => [j.min, j.max]);
  tool.active.forEach((j) => { j.min = j.type === 'revolute' ? -720 : j.min * 10; j.max = j.type === 'revolute' ? 720 : j.max * 10; });
  const free = solveRobust(rig, tool, target, opts);
  tool.active.forEach((j, i) => { [j.min, j.max] = saved[i]; });
  if (free.err < free.tolerance && (!opts.orient || free.oriErr < 0.5)) {
    const over = tool.active.map((j, i) => ({ joint: j.name, needs: free.q[j.id], min: saved[i][0], max: saved[i][1] }))
      .filter((x) => x.needs < x.min - 0.5 || x.needs > x.max + 0.5);
    return { verdict: 'joint-limit', over, first };
  }
  if (opts.orient) {
    const pos = solveRobust(rig, tool, target, {});
    if (pos.err < pos.tolerance) return { verdict: 'orientation-impossible', bestTilt: first.oriErr, first };
  }
  return { verdict: 'out-of-reach', shortBy: free.err, first };
}

```

## Appendix B: Test harness (how the numbers were produced)

- Start the dev server (`npm run dev`) and open a headless Chromium with Playwright.
- In the page, `import()` the prototype module and the app's own modules (`/src/motion/Rig.js`, `/src/loaders/ModelLoader.js`, `/src/rigs/abbIrb6760.js`); load `robot.glb` through `ModelLoader` into `root → orientation → content`, exactly as `AssetManager` does.
- **ABB tool point:** the `axis6` group's frame, at 0.2 m along `Link6`'s local Z (the flange from `ABB_ro_int_mountOffset`); direction = `Link6` Z.
- **Synthetic machines** are built from plain boxes with `buildModel(parts, unitScale)` and rigged with `rigFor(model, joints)`. The gantry uses `unitScale = 0.001` (built in millimetres) to test units.
- **Targets:** random poses within limits (seeded RNG `mulberry`) → record tool position (and direction) → solve back from the start pose.
- **Timing:** `performance.now()` around each solve, in headless Chromium with software rendering on a cloud container. Real machines will usually be faster.

## Appendix C: ABB IRB 6760 DH parameters (as stored in `robot.glb`)

| Joint | twist (rad) | length (m) | rotation (rad) | offset (m) |
|---|---|---|---|---|
| 1 | 0 | 0 | 0 | 0 |
| 2 | −π/2 | 0.35 | −π/2 | 0 |
| 3 | 0 | 1.225 | 0 | 0 |
| 4 | −π/2 | 0.2 | 0 | 1.5925 |
| 5 | +π/2 | 0 | −π | 0 |
| 6 | +π/2 | 0 | 0 | 0 |
| (balancer links 7–8) | −π/2, −π | 0.3525, 0.23 | 0 | 0 |

Base frame height 0.78 m; tool flange 0.2 m beyond joint 6. **Reference only, as test material; nothing in the design depends on it.**
