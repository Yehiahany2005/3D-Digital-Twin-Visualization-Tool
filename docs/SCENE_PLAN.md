# Multi-Model Scenes: Research & Build Plan

> **Status:** **built** (2a–2f, 2026-10-08), including physics, conveyor flow and free rotation. See §9.
> **Purpose:** the reference for step 2 of the road to a generic Station: place several models
> (a robot, a conveyor, a wrapper, people…) in one scene, edit the layout, and save it. It
> records what the code assumes today, how other tools solve the same problem, the design, the
> UI/UX, the risks with their fixes, and the build order.

The road (decided):

1. **Click-to-reach IK** — done (`docs/IK_PLAN.md`).
2. **Multi-model scenes** — this document.
3. **Smarter sequence steps** — "reach point P", "grip", "release", "repeat across a grid" in Animation Setup.
4. **Station rebuilt as a saved scene** made with 1–3; the hardcoded Station is then retired.

Step 2 must be built so that step 4 is possible: the scene has to be able to hold everything the
Station shows today, with the named points the Station logic needs.

---

## 0. Ground rules

| Rule | Why |
|---|---|
| **Generic. Nothing may depend on a vendor or on the Station.** | Same rule as IK. The Station becomes *one saved scene*, not special code. |
| **Local only** | No server. Scenes are saved in the browser (IndexedDB) and as files the user can keep or share. |
| **One model on screen = a scene with one item** | Avoids two parallel worlds ("model view" vs "scene view") with two sets of code and two mental models. |
| **Every existing tool keeps working on the selected item** | Joints, Joint Setup, Animation Setup and Reach already take one `asset`; they follow the selection instead of the asset picker. |
| **Commit authorship** | Commits are authored as **Antoni-Mikhaiel <antoni.mikhaiel@gmail.com>** only, no co-author trailers. |

---

## 1. What the code assumes today (findings)

### 1.1 "One model at a time" is built in at these places

| Where | Assumption | What has to change |
|---|---|---|
| `AssetManager.select()` / `replaceCurrent()` | Removes the current model from the scene before adding the next. | Load a model as a **template**, add **instances**; never remove others. |
| `AssetManager.cache` (keyed by asset id) | One three.js object per model **type**. Two ABB robots are impossible: there is only one object to add. | Cache the parsed file (template); **clone** per instance. |
| `AssetManager.applyPlacement()` | Re-centres every model on the origin, resting on the floor. | Keep it for the template's own origin (centred, on the floor); the **instance** carries its placement on top. |
| `main.js handleAssetLoaded()` | Wires one `activeAsset` into Joints, Commands, Joint Setup, Animation Setup, Reach, the asset picker, the view manager and `fitEnvironment`. | Same wiring, driven by **selection** instead of loading. |
| `ViewportPicker` + panels | Targets are `asset.model` (+ floor for Reach). | Targets become "the selected item" (Joint Setup) or "every item + floor" (Reach, scene selection). |
| `ReachPanel.targets()` | `[asset.model, floor]`, ignoring the machine itself. | All items + floor, ignoring only the moving chain. This *improves* Reach: you can reach onto a conveyor. |
| `DigitalTwinViewManager.replaceRobot()` | Swaps materials on one model. | Apply to every item (and to items added later). |
| `fitEnvironment()` | Floor, fog, shadow camera and grid sized to one model. | Size to the **scene's** bounds; refit when items move far. |
| Rig base joints `base.x/z/y/yaw` (`Rig.js`) | The model's placement on the floor is stored as joint values (in mm/°). The Station sets them to place the robot. | **Placement ≠ motion.** The instance gets its own transform; base joints stay for things that really drive around (AGV, forklift, gantry on rails). |
| `RigStore` (localStorage, keyed by model type: `asset:<id>` or `file:<name>:<size>`) | One rig per model type. | Keep: two copies of the same robot share the same rig *definition* (joints, tool tip, poses). Each instance gets its own `Rig` object and pose. |
| `ImportStore` (IndexedDB `imported-models`) | Imported files saved by id `import:<name>:<size>:<lastModified>`. | Reused as-is: scenes refer to imported models by this id. |
| `lastAsset` / `rememberLastAsset` | Reopens the last model. | Reopen the last **scene**. |

### 1.2 How the Station is hardcoded

| Piece | File | Notes for step 4 |
|---|---|---|
| Numbers | `StationDefinition.js` | Conveyor/box/stack/pallet/wrapper sizes and offsets. |
| Layout | `resolveStationLayout()` | Every position is **computed** from other positions (robot beside the conveyor's pickup point, pallet from the stack origin, wrapper offset from the pallet…). A saved scene stores positions instead. |
| Components | `Procedural*.js`, `AssetWrapMachine.js` | Each returns `{ root, references }`: a three.js group plus **named points** (conveyor `input`, `pickup`, `output`, `drop`, `beltSurface`; pallet top; box grasp…). **This is already the shape of a catalog component with anchors** (see §3.3), which makes porting them cheap. |
| Gripper | `createVacuumGripper()` in `StationCycle.js` | Built in code and parented to the joint called `axis6`. In a scene this is an item **mounted on** the robot's tool flange. |
| Behaviour | `StationCycle.js` (758 lines) | A hand-written state machine: conveyor runs, robot picks with its own IK, stacks a 3×3×3 grid, worker forks the pallet to the wrapper, wrapper wraps. Steps 3–4 replace this with sequences; step 2 only has to provide the objects and named points it uses. |

### 1.3 How heavy the models are (measured from the GLB files)

| Model | File size | Draw calls* | Triangles |
|---|---|---|---|
| ABB IRB 6760 (`robot.glb`) | 4.3 MB | ~28 | 0.12 M |
| ABB Depalletizer IRB660 | 46 MB | **~508** | 1.38 M |
| ABB Item Picker IRB1300 | 50 MB | **~913** | 1.31 M |
| Unitree humanoid (skinned) | 22 MB | ~49 | 0.63 M |
| Robotic arm (skinned) | 43 MB | ~9 | 0.01 M (size is textures/animation) |
| Forklift | 0.06 MB | ~12 | — |
| Station procedural parts | — | ~100 in total | small |

\* one per mesh primitive, before any merging. Forum rules of thumb for smooth frame rates on ordinary hardware are "under ~100–300 draw calls, a few million triangles" ([three.js forum](https://discourse.threejs.org/t/question-about-how-to-optimize-performance-for-a-mesh-non-repeating-heavy-scene/88117)). **Two IRB1300s plus a depalletizer is ~2,300 draw calls**: that will stutter on a laptop GPU. This is the single biggest technical risk; see §5.1.

---

## 2. How other tools do it (research)

| Tool | What it does | Lesson for us |
|---|---|---|
| **Roblox Studio** | **Toolbox** of ready models; **Explorer** tree of every instance (drag to re-parent); **Properties** panel for the selected one; Select / Move / Scale / Rotate tools with **snap increments** (studs, degrees), a **Collisions** toggle (off lets things overlap; the community advises keeping it off while building), and a world/local axis toggle (Ctrl+L). ([Roblox docs: Home tab](https://create.roblox.com/docs/es-es/studio/home-tab), [Model tab](https://create.roblox.com/docs/studio/model-tab), [Roblox Wiki: Building](https://roblox.fandom.com/wiki/Building)) | The Toolbox → Explorer → Properties trio is the right mental model, and users already know it. Snapping on by default, collisions off by default. |
| **Visual Components** (closest industrial match) | **eCatalog** of 2,000+ components (robots, conveyors…) dragged into the 3D world; **Plug-and-Play**: components carry **interfaces** at frames that snap together within a **distance tolerance** and **angle tolerance**; parameters (size, speed, colour) are edited in a properties panel; double-click places at the world origin. ([eCatalog blog](https://www.visualcomponents.com/blog/design-optimize-visualize/), [Layout tutorial (PDF)](https://academy.visualcomponents.com/app/uploads/2025/05/introduction-to-layout-configuration_pm_v2.pdf), [One-to-One Interface](https://help.visualcomponents.com/4.10/Premium/en/English/Component%20Modeling/Behaviors/Interfaces/One_to_One_Interface.htm), [Connect Interfaces](https://help.visualcomponents.com/4.10/Professional/en/English/Layout%20Configuration/Connect_Interfaces.htm)) | **Parametric components with named connection frames** are what make layout fast. Our procedural Station parts already have named points; formalise them as anchors with a type and snap tolerance. |
| **FlexSim** | Drag objects from a library; hold **A** and drag between two objects to connect output → input ports (flow), **S** for reference links; conveyors are drawn by clicking one end and dragging the other. ([FlexSim tutorial](https://www.scribd.com/document/703040208/FirstModel), [Autodesk: create and connect conveyors](https://www-pt.autodesk.com/learn/ondemand/curated/work-with-conveyors-in-flexsim/1W1kMd8d9w4YT5Pm6EG9wt)) | Flow connections (this conveyor feeds that one) are a separate idea from physical placement. Keep them for step 3/4; don't build them now. |
| **RoboDK** | A **station tree**: every item has one parent. Two ways to attach: `setParent` keeps the *relative* offset (item jumps), `setParentStatic` keeps the *world* position (item stays). Tools attach to robots; picking uses "attach closest to tool". A known trap: an object attached to a gripper *mechanism* rather than its tool frame detaches together with the gripper. ([RoboDK API](https://robodk.com/doc/cn/PythonAPI/robolink.html), [forum thread](https://robodk.com/forum/Thread-Custom-mechanism-gripper-detaches-along-with-object)) | We need both attach modes: **mount** (snap to an anchor) and **attach in place** (keep world position — what "grip" in step 3 does). Attach picked objects to the **tool frame**, never to the gripper's parts. |
| **Siemens Process Simulate** | Resources from a library; a tool is mounted on a robot with **Mount Tool** using the robot's **mount frame** and the tool's **base frame**; a "snap resource" command places things on frames; mounting fails if the robot has no mount port. ([third-party summary](https://nps-tissueconverting.valmet.com/process-simulate-mount-tool.html), [3DEXPERIENCE forum](https://3dswym.3dexperience.3ds.com/question/3dexperience-edu-students/problem-with-mounting-tool-to-robot-arm_B6kRLCghScC1-c1eBi2D1Q)) | Same pattern: robot flange frame + tool base frame. Our IK **tool tip** is already a frame on the last joint; the **flange** (mount point) is a second frame on the same joint. |
| **three.js editor** | Saves projects as three.js JSON (`toJSON` / `ObjectLoader`). ([ObjectLoader docs](https://threejs.org/docs/pages/ObjectLoader.html), [forum](https://discourse.threejs.org/t/how-can-i-save-and-load-workspace-in-threejs/6960)) | **Don't** save the three.js scene graph: it would embed every mesh (hundreds of MB). Save a small **scene document** that refers to models and stores placements; rebuild on load. |

Building blocks confirmed:

- **`TransformControls`** (three.js addon) gives the move/rotate gizmo, with `setTranslationSnap` / `setRotationSnap`; OrbitControls must be disabled while dragging (`dragging-changed` event). ([three.js docs](https://threejs.org/docs/pages/TransformControls.html))
- **Cloning:** `SkeletonUtils.clone()` for skinned models (Unitree, robotic arm); both it and `Object3D.clone()` share geometry and materials by reference, so a second copy costs scene nodes, not GPU memory. Per-instance colours need cloned materials. ([SkeletonUtils docs](https://threejs.org/docs/pages/module-SkeletonUtils.html), [forum](https://discourse.threejs.org/t/are-there-disadvantages-to-always-using-skeletonutils-clone/24995))
- **Draw calls:** `BatchedMesh` / merging static meshes that share a material is the standard fix for many-part CAD models; merged meshes lose per-part picking unless a lookup is kept. ([forum: large BIM models](https://discourse.threejs.org/t/optimized-rendering-of-large-3d-bim-models/93709), [forum: many GLB models](https://discourse.threejs.org/t/how-to-load-a-lot-of-gtb-models-without-performance-drops/54692))
- **Storage:** IndexedDB is "best effort" unless `navigator.storage.persist()` is granted (Chrome/Safari decide silently; Firefox asks). Quotas are large on desktop (Chrome: a share of free disk; Firefox desktop ~2 GB). ([MDN: storage quotas](https://developer.mozilla.org/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria), [web.dev: persistent storage](https://web.dev/articles/persistent-storage))

---

## 3. Design

### 3.1 Template, instance, item

| Word | Meaning | In code |
|---|---|---|
| **Template** | A model file parsed once (GLB/STEP/…), or a catalog component's builder. Never shown directly. | `AssetManager` cache becomes a template cache. |
| **Instance** | A clone of a template placed in the scene, with its own `Rig` and `MotionPlayer` (pose, playback). | Today's `asset` object, one per placed copy. |
| **Item** | Anything in the Explorer: an instance, plus its name, placement, parameters and attachment. | Scene document entry (§3.2). |

Clone **from the template, never from a rigged instance**: a `Rig` re-parents parts under joint
groups, so cloning a rigged model would copy those groups. Part paths (`partPath`, "0/3/1") are
computed from the original hierarchy, so a clone of the template gets identical paths and the
shared rig definition applies to it unchanged. (Test this explicitly: §7.)

### 3.2 Scene document (what is saved)

Small JSON, no meshes. Example:

```json
{
  "format": "digital-twin-scene",
  "version": 1,
  "name": "Palletizing cell",
  "units": "m",
  "items": [
    {
      "id": "robot_1", "name": "ABB IRB 6760",
      "source": { "kind": "builtin", "id": "abb_irb6760" },
      "position": [0.19, 0, 1.36], "yaw": 180,
      "pose": { "axis1": 0, "axis2": 10 }
    },
    {
      "id": "gripper_1", "name": "Vacuum gripper",
      "source": { "kind": "catalog", "id": "vacuum_gripper" },
      "params": { "cupCount": 4 },
      "mount": { "to": "robot_1", "anchor": "flange" }
    },
    {
      "id": "conveyor_1", "name": "Infeed conveyor",
      "source": { "kind": "catalog", "id": "belt_conveyor" },
      "params": { "length": 4.8, "width": 1.05, "beltHeight": 0.82, "speed": 0.7 },
      "position": [0, 0, 0], "yaw": 0
    },
    {
      "id": "part_7", "name": "Imported fixture",
      "source": { "kind": "import", "id": "import:fixture.step:183422:1728380000000", "name": "fixture.step" },
      "position": [2, 0, -1], "yaw": 90
    }
  ],
  "camera": { "position": [6, 4, 6], "target": [0, 0.8, 0] }
}
```

Decisions inside it:

- **Placement = position + yaw (rotation about the vertical).** Industrial layouts are floor plans; tilting is rare. A full `quaternion` field is allowed for the rare case (wall-mounted robot) but the UI only exposes yaw at first.
- **Rigs are not stored in the scene**: they stay per model type in `RigStore`, so fixing a robot's joints fixes it in every scene. A per-item `pose` is stored (where the robot was left).
- **`mount`** = attached to another item's anchor (§3.3); the item's own position is then relative to that anchor (usually zero).
- **`source.kind`** `builtin` (in `AssetRegistry`), `catalog` (parametric component, §3.4) or `import` (a file in `ImportStore`, with its name kept for "missing model" messages).
- **`version`** from day one, with a migration function per version.

### 3.3 Anchors (named frames that things snap to)

Generalises the Station's `references`, Visual Components' interfaces and Process Simulate's mount frames.

```js
anchors: {
  flange:  { joint: 'axis6', point: [...], direction: [...], accepts: 'tool' },   // robot: where tools mount
  input:   { point: [-2.4, 0.82, 0], direction: [-1, 0, 0], type: 'flow-in'  },   // conveyor ends
  output:  { point: [ 2.4, 0.82, 0], direction: [ 1, 0, 0], type: 'flow-out' },
  surface: { point: [0, 0.82, 0], normal: [0, 1, 0], type: 'surface' },          // belt / pallet top: things sit here
  base:    { point: [0, 0, 0], direction: [0, -1, 0], type: 'tool' },            // gripper: its mounting face
}
```

- **Catalog components** define anchors in code (they already compute these points).
- **Robots** get a **flange** anchor in the rig, set like the IK tool tip ("Tool mount" next to "Tool tip"). For the ABB it can be pre-filled from `ABB_ro_int_mountOffset`, as noted in `IK_PLAN.md` §3.2.
- **Snapping while dragging:** when a dragged item's anchor comes within a distance tolerance of a compatible anchor on another item (`tool` ↔ `tool` mount, `flow-out` ↔ `flow-in`), show a highlight; releasing snaps it there (Visual Components' plug-and-play, simplified).
- **After a gripper is mounted, the robot's IK tool tip is the gripper's tip**: the gripper declares a `tip` anchor, and Reach uses it. This replaces the Station's hardcoded `TOOL_OFFSET`.

### 3.4 Catalog (the "Toolbox")

| Category | First items | Built from |
|---|---|---|
| Robots | ABB IRB 6760 | `AssetRegistry` (already rigged) |
| Conveyors | Belt conveyor (length, width, height, speed) | `ProceduralConveyor.js` |
| Pallets & loads | Pallet (size), Box (size), Box source / infeed machine | `ProceduralPallet.js`, `ProceduralBox.js`, `ProceduralBoxSourceMachine.js` |
| People | Worker | `ProceduralWorker.js` |
| Machines | Stretch wrapper | `AssetWrapMachine.js` (STEP) |
| Tools | Vacuum gripper | `createVacuumGripper()` |
| Fixtures (cheap, high value) | Table, safety fence panel, floor marking, light curtain post | new, simple boxes with parameters |
| My models | Every imported file | `ImportStore` |

A catalog entry is plain data plus a builder:

```js
{ id: 'belt_conveyor', name: 'Belt conveyor', category: 'Conveyors', icon: 'conveyor',
  params: { length: { default: 4.8, min: 0.5, max: 30, unit: 'm' }, ... },
  build(params) { return { root, anchors }; } }
```

Changing a parameter rebuilds the component's geometry in place, keeping its id, placement and
attachments. Thumbnails: rendered once in the browser with an offscreen renderer and cached, so
nothing has to be drawn by hand.

**"Humans like Roblox"**: the procedural worker is a good start (cheap, rigged in code). Real-looking
people are skinned GLB characters (like the Unitree). Pragmatic path: ship the procedural worker
now; add one or two skinned, license-free characters later and play their walk/idle clips with
an `AnimationMixer` per instance (clips are shared, not copied).

### 3.5 Attaching (two modes, from RoboDK)

| Mode | Behaviour | Used for |
|---|---|---|
| **Mount** (snap to anchor) | Item jumps onto the anchor; follows it from then on. | Gripper on a robot flange; conveyor end to conveyor end. |
| **Attach in place** | Item keeps its world position; follows the parent from then on. | Step 3's "grip": the box stays where it is and moves with the tool. |

Both re-parent the item's root under the anchor's object (joint group or item root) with
three.js `attach()` (keeps world transform) or `add()` + anchor offset (snaps). Picked parts are
attached to the **tip anchor**, never to the gripper's meshes (the RoboDK trap).

### 3.6 Selection drives every existing panel

Click an item → it becomes the **active item**:

- Joints, Joint Setup, Animation Setup and Reach call `setAsset(item.instance)` exactly as today.
- The header shows "Editing: ABB IRB 6760 #1" so it is always clear which machine the panels act on.
- Joint Setup's part picking only hits the active item (as today); scene selection, Reach targets
  and snapping see every item.

This keeps most of today's code unchanged: the panels already accept "an asset"; only *who
chooses* the asset changes.

---

## 4. UI/UX

### 4.1 The problem today

The 320 px sidebar stacks seven cards (Asset info, Commands, Joints, Joint Setup, Animation
Setup, Asset Animations, Station) for **one** model. Adding a scene tree, a properties panel and
a model library to the same column would make it unusable.

### 4.2 Proposal: split "the scene" from "the machine"

```
┌──────────────────────────── header ──────────────────────────────────────────────┐
│ Digital Twin   [▣ Palletizing cell ▾]   Editing: ABB IRB 6760 #1      [View]     │
├───────────────┬──────────────────────────────────────────────────────────────────┤
│ [Scene][Machine]│ ┌ viewport toolbar ─────────────────────────────────────────┐   │
│               │ │ [+ Add] │ ⬚ Select  ✥ Move  ⟳ Rotate │ Snap 0.1 m ▾ │ ◎ Reach…│   │
│ SCENE tab     │ └────────────────────────────────────────────────────────────┘   │
│ ▾ Explorer    │                                                                  │
│   🤖 ABB #1   │                       3D view                                     │
│     └ 🔧 Grip │                                                                  │
│   ▭ Conveyor  │                                                                  │
│   ▦ Pallet    │                                                                  │
│   👷 Worker   │ ┌ Add drawer (opens from [+ Add]) ─────────────────────────────┐ │
│ ▾ Properties  │ │ 🔍 search   Robots · Conveyors · Pallets · People · Machines · │ │
│   Name  [   ] │ │ [img][img][img][img][img][img]   My models: [img][img]       │ │
│   X Z  Yaw    │ │  drag onto the floor, or click then click to place (R rotates)│ │
│   Length [4.8]│ └──────────────────────────────────────────────────────────────┘ │
│   Mounted on ▾│                                                                  │
└───────────────┴──────────────────────────────────────────────────────────────────┘
```

- **Two tabs at the top of the sidebar**:
  - **Scene**: Explorer (tree: mounted items nest under what they are mounted on; eye and lock icons) and Properties (name, position, yaw, component parameters, "Mounted on", Delete/Duplicate).
  - **Machine**: today's Joints, Joint Setup, Animation Setup and Commands cards, acting on the active item. Unchanged code.
  - Double-clicking a machine in the Explorer or the 3D view opens the Machine tab for it.
- **Header asset picker → scene picker**: lists saved scenes ("Station" becomes one of them in step 4), "New scene", and "Open a model" (makes a one-item scene, so the old one-model workflow stays one click away).
- **Viewport toolbar** (extends today's Reach bar instead of adding another): `+ Add`, Select / Move / Rotate, snap size, then the Reach group. Reach's mode buttons collapse until Reach is on, to save space.
- **Add drawer** at the bottom of the viewport, not in the sidebar: a horizontal strip of thumbnails with search and category chips. Two ways to place:
  1. **Drag** a thumbnail onto the floor.
  2. **Click** a thumbnail: a semi-transparent ghost follows the pointer on the floor, **R** turns it 90°, click places, **Esc** cancels; it stays armed to place several in a row (Shift).
- **Moving**: drag an item on the floor plane directly (like Roblox), or use the gizmo for exact moves; arrow keys nudge by the snap size; numbers in Properties for exact values.
- **Defaults** (from Roblox): snapping **on** (0.1 m, 15°), collisions **off** (overlaps allowed but an overlapping item gets a soft orange outline).
- **Keyboard**: `Delete`, `Ctrl+D` duplicate, `Ctrl+Z` / `Ctrl+Shift+Z` undo/redo, `F` frame selection, `R` rotate 90°, `Esc` deselect.
- **Small screens**: below 900 px the sidebar is already narrower (270 px) and below 680 px it stacks above the viewport; there the Add drawer goes full width and Properties opens as a bottom sheet.

### 4.3 What gets simpler

- The Station card disappears in step 4 (its debug readouts become a "Show reference points" toggle for anchors).
- "Asset Information" moves into Properties.
- The asset picker stops being the main navigation; scenes are.

---

## 5. Risks, issues and how to handle them

### 5.1 Performance (biggest risk)

| Issue | Fix | Effort |
|---|---|---|
| Heavy CAD GLBs have hundreds of meshes (~500–900 draw calls each, §1.3). | **Merge static meshes per rig link**: after the rig is built, merge all meshes under the same joint group that share a material into one (`mergeGeometries`). Keeps joints moving; draw calls drop to roughly *links × materials* (tens instead of hundreds). Keep a triangle → original part lookup so Joint Setup's part picking still works, or un-merge while Joint Setup is open. | Medium |
| Two copies of a 50 MB model. | Clones share geometry and textures (§2): the second copy costs almost nothing on the GPU. Load each file once. | Low |
| Re-rendering 60× a second when nothing moves. | Render on demand when nothing is animating (fan laptops, battery). Optional. | Low |
| Very large imports. | Show triangle/draw-call counts in Properties; warn above a budget; later, optional simplification (meshoptimizer) or Draco/meshopt-compressed GLBs (Draco decoder is already in `public/draco`). | Later |
| Shadows over a big floor. | Fit the shadow camera to the scene bounds (extend `fitEnvironment`). | Low |

### 5.2 Correctness

| Issue | Fix |
|---|---|
| Cloning a model that already has a rig copies the rig's joint groups. | Always clone the **pristine template** (§3.1); test that two instances move independently. |
| Skinned models (Unitree, robotic arm) break with `Object3D.clone()`. | Use `SkeletonUtils.clone()` for all clones; one `AnimationMixer` per instance. |
| Placement stored in base joints (mm/°) *and* now in the instance transform. | Placement lives in the item; base joints reset to 0 and stay for real driving motion. Migrate the Station's use (it sets base joints) in step 4. |
| IK and safety checks assume the floor at y = 0 and one machine. | Floor stays at y = 0. Reach targets every item; "below the floor" stays world-based. |
| The IK solver's `size` comes from `rig.root`: for a mounted gripper the chain grows. | The robot's resolved tool includes the mounted tool's tip; recompute when something is mounted/unmounted. |
| Two copies of a robot share one rig definition. Editing joints of copy #2 changes copy #1. | That is the intended behaviour (it is the same robot type); say so in Joint Setup ("Changes apply to all 2 ABB IRB 6760 in this scene"). Per-copy differences (e.g. a different tool) come from what is **mounted**, not from the rig. |
| Selection vs Joint Setup vs Reach all want viewport clicks. | `ViewportPicker` already has owners; add `scene` as the default owner. Joint Setup and Reach take over while active (as today). |
| Undo/redo bolted on later never works well. | Every edit goes through a small command (`move`, `add`, `delete`, `set param`, `mount`) from the first version. |

### 5.3 Saving and sharing

| Issue | Fix |
|---|---|
| A scene refers to an imported file that isn't on this computer (shared scene, cleared storage). | Load everything else; show the item as a grey **placeholder box** named after the file, with "Locate file…" to relink. |
| Sharing a scene with its models. | Two exports: `.scene.json` (small, references only) and later a **bundle** (`.zip` with the scene, imported files and their rigs) for sending to someone else. |
| Browser storage cleared or full. | Scenes are small (KB); models are the big part and already in IndexedDB. Request `persist()` on first save; check `navigator.storage.estimate()` and warn when nearly full; encourage exporting. |
| Format changes later. | `version` field + migration functions; unknown fields are kept, not dropped. |
| Built-in model ids or catalog parameters change. | Catalog builders read params with defaults; unknown `source` → placeholder. |

### 5.4 Pragmatism (what **not** to build in step 2)

- **No physics engine.** Boxes don't fall or collide; step 3's grip/release puts them where they belong. Physics (e.g. Rapier) can come later if needed.
- **No collision blocking while placing**: overlaps are allowed and only highlighted.
- **No flow logic** (conveyor feeding conveyor, item spawning): that is step 3/4 behaviour, not layout.
- **No full 3D rotation in the UI** at first: yaw only, plus "Mounted on".
- **No asset store / online library**: the catalog is built in, plus the user's own imports.

---

## 6. Build plan (phased; each phase usable on its own)

| Phase | Deliverable | Done when |
|---|---|---|
| **2a. Scene core** | Template cache + instances (clone per item, own rig/player); scene document; Explorer + Properties (Scene tab), Machine tab = today's cards for the active item; select by clicking; move/rotate with gizmo, snapping and numbers; duplicate/delete; undo/redo; save to IndexedDB, export/import `.scene.json`; "Open a model" = one-item scene; Digital Twin View and `fitEnvironment` over the whole scene. | Two ABB robots side by side, each posed differently, Reach and Animation working on the selected one; scene survives refresh and export/import. |
| **2b. Add drawer + catalog** | Catalog entries for the Station's parts (conveyor, pallet, box, box source, worker, wrapper, vacuum gripper) + table and fence; thumbnails; drag or click-to-place with ghost and R-rotate; parameter editing rebuilds in place. | The Station's objects can be placed by hand from the drawer, with the Station's sizes. |
| **2c. Anchors + mounting** | Anchors on catalog parts; robot flange anchor (Tool mount) in the rig; snap-on-drag highlights; Mount and Attach-in-place; Reach uses the mounted tool's tip. | Gripper snaps onto the robot and moves with it; Reach puts the suction cup on the belt; conveyors snap end to end. |
| **2d. Performance pass** | Merge static meshes per rig link; on-demand rendering; heavy-model warning; shadow fit to scene. | Robot + depalletizer + item picker + Station parts stay smooth on the test laptop. |

Then step 3 adds the sequence steps ("reach anchor", "grip" = attach in place to the tip anchor,
"release", "repeat across a grid"), and step 4 saves the Station as a scene and deletes
`StationDefinition.js`, `StationCycle.js` and the Station card.

---

## 7. Testing

| What | How |
|---|---|
| Scene document round trip, version migration, unknown fields kept | Vitest |
| Two clones of one template: identical part paths, rig applies to both, moving one doesn't move the other | Vitest (boxes, like the IK tests) + one on `robot.glb` in the browser |
| Mount / attach-in-place math (world position kept vs snapped), unmount | Vitest |
| Snapping between anchors (tolerance, compatible types only) | Vitest |
| Add / move / undo / save / reload / export / import flows; placeholder for a missing import | Playwright (Chromium is available in the dev environment) |
| Frame time and draw calls with the heavy models | Playwright + `renderer.info`, before and after 2d |

---

## 8. Open questions for the owner

1. **Single-model view**: OK to make "open a model" a one-item scene (recommended), or keep the current single-model mode alongside scenes?
2. **Sidebar tabs (Scene / Machine)** vs a second sidebar on the right for Properties (more Roblox-like, but costs viewport width on a laptop)?
3. **Rotation**: yaw only at first (recommended), or full 3D rotation from the start?
4. **Humans**: procedural worker only for now, or source a skinned character model as well?
5. **Sharing**: is `.scene.json` (references only) enough at first, or is the bundled `.zip` needed early (e.g. to send scenes to colleagues)?

---

## Sources

- Roblox: [Home tab](https://create.roblox.com/docs/es-es/studio/home-tab), [Model tab](https://create.roblox.com/docs/studio/model-tab), [Roblox Wiki: Building](https://roblox.fandom.com/wiki/Building), [DevForum: building tips](https://devforum.roblox.com/t/building-tips-and-tricks-1/796555)
- Visual Components: [Design, optimize, visualize](https://www.visualcomponents.com/blog/design-optimize-visualize/), [Layout configuration (PDF)](https://academy.visualcomponents.com/app/uploads/2025/05/introduction-to-layout-configuration_pm_v2.pdf), [One-to-One Interface](https://help.visualcomponents.com/4.10/Premium/en/English/Component%20Modeling/Behaviors/Interfaces/One_to_One_Interface.htm), [Connect Interfaces](https://help.visualcomponents.com/4.10/Professional/en/English/Layout%20Configuration/Connect_Interfaces.htm), [Essentials](https://www.automate.org/products/visual-components/visual-components-essentials)
- FlexSim: [First model tutorial](https://www.scribd.com/document/703040208/FirstModel), [WSC 2002 paper](https://www.informs-sim.org/wsc02papers/032.pdf), [Autodesk: conveyors in FlexSim](https://www-pt.autodesk.com/learn/ondemand/curated/work-with-conveyors-in-flexsim/1W1kMd8d9w4YT5Pm6EG9wt)
- RoboDK: [robolink API](https://robodk.com/doc/cn/PythonAPI/robolink.html), [C++ API Item](https://robodk.com/doc/en/CppAPI/class_robo_d_k___a_p_i_1_1_item.html), [forum: gripper detaches with object](https://robodk.com/forum/Thread-Custom-mechanism-gripper-detaches-along-with-object)
- Siemens / mounting: [Process Simulate mount tool overview](https://nps-tissueconverting.valmet.com/process-simulate-mount-tool.html), [Tecnomatix blog](https://blogs.sw.siemens.com/tecnomatix/process-simulate-how-to-create-more-attachments-for-robot-cables/), [3DEXPERIENCE forum](https://3dswym.3dexperience.3ds.com/question/3dexperience-edu-students/problem-with-mounting-tool-to-robot-arm_B6kRLCghScC1-c1eBi2D1Q)
- three.js: [TransformControls](https://threejs.org/docs/pages/TransformControls.html), [SkeletonUtils](https://threejs.org/docs/pages/module-SkeletonUtils.html), [ObjectLoader](https://threejs.org/docs/pages/ObjectLoader.html), forum threads on [cloning](https://discourse.threejs.org/t/are-there-disadvantages-to-always-using-skeletonutils-clone/24995), [heavy scenes](https://discourse.threejs.org/t/question-about-how-to-optimize-performance-for-a-mesh-non-repeating-heavy-scene/88117), [BIM models](https://discourse.threejs.org/t/optimized-rendering-of-large-3d-bim-models/93709), [many GLBs](https://discourse.threejs.org/t/how-to-load-a-lot-of-gtb-models-without-performance-drops/54692)
- Storage: [MDN storage quotas](https://developer.mozilla.org/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria), [web.dev persistent storage](https://web.dev/articles/persistent-storage)

---

## 9. As built (2026-10-08)

### 9.1 Decisions taken with the owner

| Question (§8) | Decision |
|---|---|
| Single model | **Two distinct modes.** Machine mode is the original one-model app (unchanged, Station included). Scene mode is the studio. Tabs at the top of the sidebar switch. Importing in Scene mode adds the file to the scene; importing in Machine mode opens it on its own. |
| Where the panels go | Left sidebar, Machine/Scene tabs. |
| Rotation | Turning only by default; **free 3D rotation** behind the toolbar's "3D" toggle (T). |
| People | The simple procedural worker **and** an animated person: KayKit "Rogue" (Kay Lousberg, **CC0**, `src/assets/people/`), props removed. |
| Sharing | **`.dtscene` bundle** (one zip: scene + imported model files + their rigs), because a scene that only refers to files is useless on a colleague's computer. Plain `.json` scenes open too. |
| Physics / flow | Built (§9.4), not deferred. |

### 9.2 Where things are

| Piece | File |
|---|---|
| Scene document (versioned JSON, unknown fields kept), copy names, dependents | `src/studio/SceneDocument.js` (+ tests) |
| Browser storage (scenes; shared DB with imports) | `src/studio/SceneStore.js`, `src/assets/db.js` |
| `.dtscene` bundle | `src/studio/SceneBundle.js` (+ tests), uses `fflate` |
| Templates & copies (clone per item, own rig/player/animations) | `src/studio/ModelTemplates.js` |
| Editor: reconcile with the document, selection, gizmo, undo/redo, links, snapping | `src/studio/SceneEditor.js` |
| Anchors, snapping maths, mounting alignment | `src/studio/Anchors.js` |
| Mesh merging (performance) | `src/studio/mergeStatic.js` |
| Simulation (Rapier) | `src/studio/Simulation.js` |
| Scene editor controller (files, toolbar, keys, Reach binding, play) | `src/studio/SceneMode.js` |
| Scene tab: header scene menu, built-in scenes vs. the editor | `src/app/SceneTab.js`, `src/station/BuiltInScenes.js` |
| UI: Explorer, Properties, Add drawer, icons, thumbnails | `src/studio/ui/*`, `src/studio/thumbnails.js` |
| Catalog (12 parts) | `src/studio/catalog/*` |

### 9.3 Keys (Scene mode)

Q select · W move · E turn · T free rotation · R turn 90° (Shift: −90°) · arrows nudge by the snap · F frame · A Add drawer · Ctrl+D duplicate · Delete · Ctrl+Z / Ctrl+Shift+Z · Ctrl+Enter play/stop · Esc deselect / cancel placing · Alt while dragging: no snapping.

### 9.4 Simulation

Play runs Rapier physics (loaded on first Play, ~1.6 MB gzipped); Stop restores the document (positions, poses, items an end of line removed) and deletes boxes made while playing. Belts set the velocity of bodies standing on them; end stops are colliders; box sources spawn when there is room; ends of line remove what enters their volume. Models are not solid unless marked (their bounding box is used); mounted/attached items are kinematic and push boxes.

### 9.5 Measured

| Check | Result |
|---|---|
| Heavy scene (ABB 6760, depalletizer, 2× IRB1300, conveyor, source, pallet, wrapper, person) | 4,971 → **1,227** draw calls per frame after merging (−75%); IRB1300 913 parts drawn as 143 |
| Mounting | gripper face on flange: 0.0000 m; IK with the gripper tip: 0.0000 m from target |
| Conveyor snap | ends coincide (0.0000 m), facing (−1.000), turn copied |
| Flow | boxes queue at an end stop one box length apart; hand over between snapped conveyors; removed at an end of line; Stop restores everything |

### 9.6 Known limits / next

- Robot sequences don't yet grip or release boxes (step 3: "reach anchor", "grip" = attach in place to the tool tip, "release", "repeat across a grid").
- A model marked solid uses one box; robots should stay non-solid.
- Very heavy imports still cost triangles (merging only cuts draw calls); simplification/LOD is future work.
- Two copies of the same robot share its rig (by design); per-copy differences come from what is mounted.

### 9.7 Restructure (2026-10-09)

The station scenes (Factory, Stations 1–3) used to sit in the Machine tab's model menu and borrowed its robot. They are now **built-in scenes** in the Scene tab:

- The header shows a **scene menu** in the Scene tab (like the model menu in the Machine tab): *Built-in scenes* (made in code, run with Start/Reset/Speed) and *My scenes* (drag and drop), plus New scene / Open file.
- `src/main.js` builds the shared 3D view, switches tabs and runs the frame loop. Each tab (`src/app/MachineTab.js`, `src/app/SceneTab.js`) has `enter()` / `exit()`, and `exit()` puts away everything the tab owns (Reach, viewport clicks, 3D content, overlays), so nothing of one tab shows in the other.
- Station 3 and the factory get their own ABB copy (`ModelTemplates.createInstance(config, { rig })`), so they never move or re-rig the Machine tab's robot.
