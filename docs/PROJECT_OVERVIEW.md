# 3D Digital Twin Visualization Tool: Project Documentation

> **The visualization layer of the Agentic Digital Twin Framework.**
> A browser-based 3D environment where industrial machines, robots, conveyors, people and
> factory floor plans are loaded, rigged, laid out, programmed and run as a live digital twin.

---

## ⭐ Why this demo exists: a preview of the Scene Builder Agent

Our framework is a **multi-agent system**. One of its agents is the **Scene Builder Agent**: the
agent responsible for turning a description of a factory (a floor plan, a list of equipment, a
process) into a working 3D digital twin.

**This demo shows the expected future output of the Scene Builder Agent.** Everything you see in
the app (stations laid out on a floor plan, robots with grippers mounted, conveyors snapped end to
end, robots running pick-and-place programs, a full production line producing a wrapped pallet)
is exactly the kind of result the agent is meant to generate automatically.

Today, a person builds these scenes by hand (drag and drop, or in code). Tomorrow, the Scene
Builder Agent will produce the same result from a request such as:

> *"Here is our hall's AutoCAD plan. Place an ABB IRB 6760 palletizer next to the infeed conveyor,
> stack 3 × 3 × 3 boxes on a pallet, then have a worker take the pallet to the stretch wrapper."*

### How the demo maps to the agent's job

The app was deliberately designed so that a scene is **structured data** an agent can write, not
a hand-made 3D file. Every building block an agent needs already exists:

| What the Scene Builder Agent must do | What already exists in this demo |
|---|---|
| Understand the site | **DXF floor-plan import**: the real AutoCAD plan, at true scale, with layers and walls |
| Choose equipment | A **catalog** of parametric components (conveyors, pallets, boxes, wrappers, grippers, fences, people…) plus built-in and imported robot models |
| Place equipment | A small, versioned **scene document** (JSON): each item is a source + position + turn + parameters |
| Connect equipment | **Anchors** (named connection points) with automatic **snapping** and **mounting** (gripper → robot flange, conveyor end → conveyor end) |
| Make machines move | **Rigs** (joint definitions) and **inverse kinematics** (reach any point automatically, or explain why not) |
| Define the process | **Robot and worker programs** (reach, grip, release, wait for a box, repeat across a grid…) with a one-click **Pick & place** generator |
| Check that it works | **Physics simulation** (Rapier), **reachability checks** (green/red targets), and clear error reasons |
| Hand over the result | **`.dtscene` bundle**: one file containing the scene, the models and their rigs |

In other words: **the demo is the target output; the agent is the author.** The two built-in
reference outputs (the stand-alone Stations and the unified Lubricant Factory) show the quality bar
the agent is expected to reach.

---

## Table of contents

1. [Project at a glance](#1-project-at-a-glance)
2. [Technology stack](#2-technology-stack)
3. [Application structure](#3-application-structure)
4. [Machine tab: one model in depth](#4-machine-tab-one-model-in-depth)
5. [Inverse kinematics (click-to-reach)](#5-inverse-kinematics-click-to-reach)
6. [Scene tab: the scene studio](#6-scene-tab-the-scene-studio)
7. [Robot and worker programs](#7-robot-and-worker-programs)
8. [Physics simulation](#8-physics-simulation)
9. [Floor plans from AutoCAD (DXF)](#9-floor-plans-from-autocad-dxf)
10. [Built-in scenes: the Lubricant Production Line](#10-built-in-scenes-the-lubricant-production-line)
11. [Visual modes and the 3D view](#11-visual-modes-and-the-3d-view)
12. [Saving, sharing and data formats](#12-saving-sharing-and-data-formats)
13. [Performance](#13-performance)
14. [Quality and testing](#14-quality-and-testing)
15. [Design principles](#15-design-principles)
16. [Known limits and roadmap](#16-known-limits-and-roadmap)
17. [Running the project](#17-running-the-project)
18. [Glossary](#18-glossary)
19. [Suggested presentation flow](#19-suggested-presentation-flow)

---

## 1. Project at a glance

| | |
|---|---|
| **What it is** | A web-based 3D digital twin tool built on Three.js |
| **Role in the framework** | The 3D visualization layer, and the preview of the Scene Builder Agent's output |
| **Runs where** | Entirely in the browser. No server, no cloud, nothing uploaded |
| **Main capabilities** | Import CAD/3D models · define joints · animate · inverse kinematics · build multi-machine scenes · program robots · simulate physics · import factory floor plans · run complete production lines |
| **Vendor policy** | Generic: no code depends on a vendor. ABB robots are used only as test material |

**The two halves of the app:**

- **Machine tab**: one machine at a time, in depth (joints, poses, animations, reach).
- **Scene tab**: many machines together, as a factory cell or a full production line.

---

## 2. Technology stack

| Layer | Technology | Purpose |
|---|---|---|
| 3D rendering | **Three.js** (r186) + `three-stdlib` | Scene graph, PBR materials, lighting, shadows, gizmos |
| CAD import | **occt-import-js** (OpenCascade compiled to WebAssembly, in a Web Worker) | Reads STEP and IGES files directly in the browser |
| Compression | Draco and Meshopt decoders | Compressed GLB models |
| Physics | **Rapier 3D** (`@dimforge/rapier3d-compat`, WebAssembly) | Boxes falling, sliding on belts, colliding with machines |
| Bundling files | **fflate** | Zips scenes, models and rigs into a single `.dtscene` file |
| Icons | **Lucide** | UI icons |
| Build / dev server | **Vite** | Fast development and production build |
| Tests | **Vitest** | Unit and integration tests |
| Storage | IndexedDB + localStorage | Imported models, scenes and rigs saved on the device |

---

## 3. Application structure

### 3.1 User interface layout

```
┌──────────────────────────── Header ─────────────────────────────────────────┐
│  Digital Twin    [ Model / Scene menu ▾ ]                  [ View toggle ]  │
├──────────────────┬──────────────────────────────────────────────────────────┤
│ [Machine][Scene] │  Toolbar (Reach / Add · Select · Move · Turn · Play…)    │
│                  │                                                          │
│   Sidebar        │                  Shared 3D view                          │
│   (panels of     │                                                          │
│    the active    │                                         camera buttons → │
│    tab)          │                                                          │
└──────────────────┴──────────────────────────────────────────────────────────┘
```

Both tabs share one 3D view. Switching tabs puts away everything the other tab owns (its models,
overlays, click handlers), so the two never interfere.

### 3.2 Code layout

| Folder | Contents |
|---|---|
| `src/main.js` | Builds the shared 3D view, switches tabs, runs the frame loop |
| `src/app/` | The two tabs: `MachineTab.js`, `SceneTab.js` |
| `src/assets/` | Built-in models (`AssetRegistry.js`), imported-model storage (`ImportStore.js`) |
| `src/loaders/` | Model loading (GLB, glTF, STEP, IGES, STL, OBJ, FBX), CAD worker |
| `src/motion/` | Rig engine, inverse kinematics, motion player, animation export |
| `src/rigs/` | Ready-made rigs for the built-in robots |
| `src/scene/` | Renderer, camera, lighting, Digital Twin View, environment fitting |
| `src/ui/` | Machine-tab panels (joints, joint setup, animation setup, reach) |
| `src/studio/` | The scene studio: document, editor, catalog, anchors, simulation, programs, floor plans |
| `src/station/` | Built-in scenes: Stations 1–3 and the unified Lubricant Factory |
| `docs/` | Design documents: `IK_PLAN.md`, `SCENE_PLAN.md`, `LUBRICANT_LINE.md` |

---

## 4. Machine tab: one model in depth

The Machine tab focuses on a single model: a built-in robot or a file the user imports.

### 4.1 Built-in models

| Model | Notes |
|---|---|
| **ABB IRB 6760** | Large industrial robot, ships with a ready-made rig and tool point |
| **ABB Depalletizer (IRB 660)** | 4-axis palletizer with a parallel linkage |
| **ABB Robot Picker (IRB 1300)** | 6-axis arm |
| **Unitree Humanoid Robot** | Skinned humanoid with an embedded animation |
| **Robotic Arm** | Skinned arm with embedded animations |

### 4.2 Importing models

- **Formats:** GLB, glTF, **STEP / STP**, **IGES / IGS**, STL, OBJ, FBX.
- **CAD in the browser:** STEP and IGES are converted with OpenCascade (WebAssembly) in a
  background worker, so the page never freezes.
- **Helpful errors:** native CAD formats are recognised and the user is told how to export them.
  Example: a SolidWorks `.sldprt` → *"In SolidWorks, use File → Save As → STEP, then import that
  file."* (Same for Inventor, Fusion, CATIA, Creo/NX, SketchUp; `.dwg` → "save it as DXF".)
- **Units:** detected and converted to metres.
- **Kept on the device:** imported models are stored in IndexedDB and are still listed after a
  page refresh. Nothing is uploaded. The ✕ next to a model deletes it.

### 4.3 Joint Setup: making any model movable

Most CAD files are just shapes: they don't know which parts move. **Joint Setup** turns any model
into a machine:

1. **Pick the parts** that move (click them in the 3D view).
2. **Define the joint**:
   - **Revolute** (rotates, in degrees) or **prismatic** (slides, in millimetres).
   - Pivot and axis, with limits.
3. **"Select from Surface"**: hover a round shaft or hole and the tool detects its axis
   automatically ("Round surface, Ø 80 mm"); hover a flat rail face and it detects the slide
   direction. The detected surface is highlighted in amber with the axis drawn as a dashed line.
4. **Follower joints** for mechanisms: `aim` (keeps pointing at a point on another part, e.g. a
   balancer cylinder) and `stretch` (slides to keep a distance, e.g. a piston rod). They move
   automatically with the joint that drives them.
5. **Tool tip**: the working point of the tool (e.g. suction cup face), used by Reach.

Rigs are saved in the browser per model type and can be exported/imported as a **`.rig.json`**
file. Rigs for the ABB robots are generated from the kinematic data ABB embeds in its files, but
this is only a bonus: any model can be rigged by hand.

### 4.4 Joints panel and Commands

- **Joints**: a slider and jog buttons for every joint, with the joint limits enforced.
- **Commands**: one-click buttons for each saved pose ("go to") and sequence ("play"), plus Stop.

### 4.5 Animation Setup: poses and sequences

1. Jog the joints into position and **save a pose**.
2. Chain poses into a **sequence**: each step has a move time; waits can be inserted.
3. Sequences **play and loop** in the app. All joints move together with smooth, speed-limited,
   trapezoidal motion and arrive at the same moment.

### 4.6 Export GLB with animations

Every sequence becomes a real **animation clip inside a `.glb` file**, which plays in Blender,
Unity, Unreal and any web viewer. (STEP and other CAD formats cannot store animation, so animated
exports are always GLB.)

### 4.7 Embedded animations

Models that already contain animations (e.g. the Unitree humanoid) can play them directly.

---

## 5. Inverse kinematics (click-to-reach)

**Inverse kinematics (IK)** answers: *"The tool must be here: what angle does each joint need?"*
In the app, the user switches on **Reach** and clicks anywhere: the machine moves its tool there.

### 5.1 How it works

| Piece | Description |
|---|---|
| **Chain detection** | Finds which joints move the tool tip, on any rig (arm, gantry, SCARA, pan-tilt, linkage…) |
| **Solver** | Damped least squares (DLS), the industry-standard numerical method. Stable near singularities, with too few or too many joints |
| **Jacobian** | Geometric (fast, exact) for normal joints; finite-difference for follower joints |
| **Robust seeding** | Several starting guesses, angle wrap-around, and preference for the solution with the least motion |
| **Motion** | The solution is animated smoothly with the motion player |

### 5.2 Orientation modes

| Mode | Behaviour |
|---|---|
| **Straight down** (default) | Tool points vertically down, as in most pick-and-place |
| **Any angle** | Only the position matters |
| **Square to surface** | Tool faces the clicked surface (walls, sloped faces) |

### 5.3 Live feedback and "impossible" poses explained

While hovering, the target is solved every frame and coloured: **green** (reachable), **amber**
(reachable with a warning), **red** (not reachable). When a point can't be reached, the app says
**why**, by re-running the solve with relaxed rules:

| Cause | Example message |
|---|---|
| Joint beyond its range | "Axis 3 would need 111°; its range is −180° to 70°." |
| Right point, wrong direction | "Can reach this point, but not pointing down (best: 35° off). Switch to 'Any angle'?" |
| Out of reach | "Out of reach: 38 cm too far." / "Too close to the base." |
| Below the floor | "Below the floor" |
| Arm would dip through the floor | Warning |
| Big swing ("bending over backwards") | "Big move: reaches behind by bending over the top." |

### 5.4 Measured accuracy and speed

150 random reachable targets per machine:

| Machine | Position only | Position + direction |
|---|---|---|
| Gantry built in millimetres | 99 %, 1.1 ms | 99 %, 1.6 ms |
| SCARA | 100 %, 0.2 ms | 100 %, 1.9 ms |
| Pan-tilt head | 100 %, 0.1 ms | 100 %, 0.1 ms |
| Redundant 7-joint arm | 100 %, 0.3 ms | 100 %, 1.0 ms |
| Linkage with tool on a follower | 100 %, 0.3 ms | 100 %, 0.3 ms |
| **ABB IRB 6760 (real file)** | **100 %, 0.7 ms** | **99 %, 2.9 ms** |

All solves are well under the 16 ms frame budget, so IK runs **live on mouse move**.

> **Relevance to the agent:** IK is what lets the Scene Builder Agent say "put the tool here"
> instead of computing joint angles, and the diagnosis tells it *why* a layout fails so it can
> move the robot and try again.

---

## 6. Scene tab: the scene studio

The Scene tab is a full layout editor for multi-machine scenes, inspired by tools like Roblox
Studio, Visual Components, FlexSim, RoboDK and Siemens Process Simulate.

### 6.1 Two kinds of scenes

| Kind | Made by | Editable |
|---|---|---|
| **Built-in scenes** | Code (the Lubricant Line: Factory and Stations 1–3) | No: run with Start / Reset / Speed |
| **My scenes** | The user, by drag and drop | Yes: fully editable, saved in the browser, exportable |

### 6.2 The Add drawer (catalog)

| Category | Items |
|---|---|
| **Robots & models** | Built-in models (ABB IRB 6760, depalletizer, item picker, humanoid, arm) and every imported file |
| **Flow** | Belt conveyor, Box source (feeds boxes), End of line (removes boxes) |
| **Loads** | Pallet, Box |
| **Machines** | Stretch wrapper, Vacuum gripper |
| **People** | Worker with pallet jack, Person (animated, KayKit "Rogue", CC0 licence) |
| **Fixtures** | Table, Safety fence, Floor marking |
| **Floor plan** | AutoCAD DXF (see §9) |

Catalog parts are **parametric**: change a conveyor's length, width, height or speed and it
rebuilds in place, keeping its position and connections. Thumbnails are rendered automatically.
Items can be placed by drag or by click, with a ghost preview and R to rotate.

### 6.3 Editing tools

- **Select / Move / Turn / Tilt** with a 3D gizmo; **snap** increments (Alt disables snapping).
- **Free 3D rotation** behind the "3D" toggle (T) for the rare wall-mounted case.
- **Undo / redo** for every edit; duplicate, copy/paste at the pointer, delete with an
  "Undo" toast.
- **Numeric fields** with drag-to-scrub labels (Shift for fine control).
- **Hide / Lock** per object; **search** in the object list; rename (F2).

### 6.4 Panels

- **Objects**: every item in the scene, with eye/padlock toggles and a badge on robots that have
  a program.
- **Selected**: quick actions (Frame, Duplicate, Hide, Lock, Delete), then groups in plain words:
  Position, Settings, Attach, Animation, Robot, *Move joints by hand*, *When playing*, Program.

### 6.5 Anchors, snapping and mounting

**Anchors** are named connection points on components: a conveyor's `input`, `output` and belt
`surface`; a pallet's top; a robot's tool `flange`; a gripper's `base` and `tip`.

- **Snapping:** drag a conveyor near another and their ends snap together (end to end, facing
  each other, same turn). Measured precision: **0.0000 m**.
- **Mounting:** a gripper snaps onto the robot's flange and follows it from then on. The robot's
  IK tool tip automatically becomes the **gripper's tip**. Measured: gripper on flange 0.0000 m;
  IK with gripper tip 0.0000 m from target.
- **Two attach modes:** *Mount* (jump onto the anchor) and *Attach in place* (keep the world
  position, follow the parent). "Move along with" lets any object follow another object or one
  specific robot axis, chosen in the view or from a list.

### 6.6 Comfort and guidance

- Empty scene shows three first steps and "Add your first object".
- A hint line tells the user what they can do now, or why something can't move (locked, mounted,
  playing).
- Hover highlights and names objects; the selected object's actual parts are tinted.
- Right-click menus on objects (zoom, rename, duplicate, copy, hide, lock, program, delete) and on
  the floor (paste here, add, view from above / front).
- Camera buttons: everything, selected, from above, from the front, with smooth flights.
- Floor grid (1 m squares) sized to the scene.
- **?** shows every shortcut.

**Keyboard shortcuts:** Q select · W move · E turn · T free rotation · R turn 90° · arrows nudge ·
F frame · A Add · Ctrl+D duplicate · Delete · Ctrl+Z / Ctrl+Shift+Z · Ctrl+C / Ctrl+V ·
Ctrl+Enter play/stop · Space pause · Esc cancel.

### 6.7 Machine tools in the scene

Selecting a robot in a scene makes it the active machine: Joints, Reach, poses and sequences all
work on it, and Reach can target **any object** in the scene (e.g. reach onto a conveyor), not
just the floor. Several copies of the same model can be placed; each moves independently.

---

## 7. Robot and worker programs

Each robot in a scene can have a **Program**: the steps it runs when the scene plays. Programs
refer to things in the scene ("the box at the end of this conveyor", "the next spot on that
pallet"), so they are saved with the scene.

### 7.1 Robot steps

| Step | What it does |
|---|---|
| **Reach** | Moves the tool tip to a spot (conveyor end, pallet top, clicked point), to **the box waiting at a spot**, or to **the next spot of a grid**. "Come from above" lifts, crosses at a safe height and comes straight down |
| **Grip** | Picks up the box the tool tip is touching |
| **Release** | Lets go of the box |
| **Wait for a box** | Pauses until a box has arrived at a spot (e.g. against the end stop) |
| **Repeat across a grid** | Runs its inner steps once per grid spot: columns × rows × layers, layer by layer (e.g. 3 × 3 × 3 on a pallet) |
| **Go to pose / Play sequence** | Uses the robot's saved poses and sequences |
| **Wait / Repeat** | Timing and loops |
| **Conveyor on / off** | Starts or stops a conveyor |

### 7.2 Worker (pallet jack) steps

| Step | What it does |
|---|---|
| **Pick up pallet** | Walks to the pallet, slides the forks under it and lifts it with its boxes |
| **Go to** | Walks somewhere carrying the pallet (onto a wrapper's turntable, a marked bay, a floor point) |
| **Put pallet down** | Lowers the pallet and backs away |
| **Wait for boxes** | Waits until a pallet holds N boxes (e.g. the robot finished stacking) |

### 7.3 One-click Pick & place

**Pick & place** writes a full palletizing cycle from two choices (where boxes come from, where
they go):

```
Home → Repeat across grid { Wait for box → Reach box → Grip → Reach grid spot → Release } → Home
```

Box size is taken from the scene's box source.

### 7.4 Live validation

- While editing, the open step's targets are drawn in the view (dots, ghost boxes for each grid
  spot): **green** if the robot can reach them, **red** if not (computed in the background).
- **"Show me"** moves the robot to a target.
- While playing, the running step is highlighted; a robot that cannot do a step stops and shows
  the reason on that step and over the view.

> **Relevance to the agent:** a program is plain, structured data (`{ type: 'reach', target:
> { kind: 'grid' } }`). This is exactly the level of abstraction the Scene Builder Agent will
> write: *intent*, not joint angles.

---

## 8. Physics simulation

Pressing **Play** runs a **Rapier** physics simulation:

- **Belts** move whatever stands on them; **end stops** stop boxes; boxes queue one box length apart.
- **Box sources** spawn boxes when there is room; **end of line** removes what enters it.
- Boxes hand over between snapped conveyors.
- **Solid models** collide with their **real shape** (one exact triangle-mesh collider per part),
  so boxes pass through gaps in a gantry; moving parts carry their colliders.
- Gripped boxes follow the tool and push other boxes.
- Pause / Resume and speed (½× to 4×).
- **Stop restores everything**: positions, poses, removed items; boxes made during play are deleted.

---

## 9. Floor plans from AutoCAD (DXF)

A factory's real **AutoCAD DXF floor plan** can be imported into a scene as the reference for
placing machines. It is drawn flat on the floor at **true size**.

| Feature | Details |
|---|---|
| **Own parser** | Written in-house (no GPL dependency). Supports lines, polylines with arcs, arcs, circles, ellipses, splines, text, leaders, blocks (with scale, rotation, arrays, nesting) and dimensions. Unsupported entities are listed ("Not drawn: 12 hatch") |
| **Precision** | Curves accurate to about 1/20,000 of the plan (2 mm on a 40 m hall) |
| **Units** | Read from the file; if missing, guessed so the building is a realistic size and marked "check them"; can be corrected |
| **Layers** | Listed with on/off switches; notes, dimensions and title blocks start hidden |
| **Walls** | Any layer can be raised into walls (height and opacity adjustable), which become **physics colliders** |
| **Behaviour** | A normal scene item: select, move, turn, lock, hide, undo; saved with the scene and packed into the `.dtscene` bundle |
| **Performance** | 210,000 line segments on 15 layers + 2,000 labels = 38 draw calls, imported in ~2 s |
| **Errors** | Clear messages for DWG files, binary DXF, damaged files |

> **Relevance to the agent:** the floor plan is the agent's **input**. It reads the real site and
> places equipment on it, respecting walls.

---

## 10. Built-in scenes: the Lubricant Production Line

The built-in scenes are a complete, believable **lubricant production line**, built in code as
the **reference output** for what the Scene Builder Agent should eventually produce.

**Product flow:** raw materials → filling → capping → case packing → palletizing → wrapping →
finished pallet.

### 10.1 Station 1: Oil Filling & Capping

A fully procedural filling and capping cell for 20 L HDPE jerry cans, in batches of 4.

- **Indexed conveyor** moves 4 cans at a time into position.
- **Filling:** the head descends, valves open, the oil jet falls under gravity; a fast bulk fill
  is followed by a slow top-off; the jet's tail drops away when the valves close.
- **Capping:** a servo capper tightens 4 caps (3 turns while descending by the thread lead);
  the cap feeder bowl refills the chucks.
- **Tank** level drops per batch and refills; flexible hoses follow the moving filling head.
- **Details:** translucent cans showing the rising oil, stainless PBR materials, photo-eyes with
  LEDs, stack light, a control panel with a **live HMI screen** and E-stop, safety guards and floor
  markings.

### 10.2 Station 2: Jerry Can Case Packing

- Cans arrive in **two lanes** and bank up gently against an end stop in a 2 × 2 block.
- A **Cartesian gantry robot** with 4 handle grippers lifts all 4 cans, narrows their spacing
  during transfer (0.26 m → 0.20 m), and lowers them into the carton.
- The carton's flaps fold and a **case taper** applies tape as the carton passes.

### 10.3 Station 3: Palletizing & Wrapping

- An **ABB IRB 6760** with a vacuum gripper picks cases from the conveyor and stacks a
  **3 × 3 × 3** pallet.
- A **worker with a pallet jack** takes the full pallet to the stretch wrapper, releases it and
  backs away safely.
- A **stretch wrapper** (from a real STEP file) applies a **spiral film** that follows the stack's
  exact outline, overlapping on each pass.

### 10.4 The unified Factory

The three stations run as **one continuous line**, reusing each station unchanged and linking
them only through hand-over hooks.

| Feature | Description |
|---|---|
| **Supply racks** | Racks of empty jerry cans and cartons; the visible stock goes down as items are used (108 cans = one pallet) |
| **Transfers** | Station 1 → 2: single-file guides and lane pushers split cans into two lanes. Station 2 → 3: cases travel into Station 3's infeed |
| **Object identity** | The same can travels from the rack, through filling and packing, onto the pallet: no copies, no jumps |
| **Back-pressure** | Upstream stations wait ("Holding…") until downstream has room, with no arbitrary timers |
| **Result** | One run = **108 cans → 27 cases → 1 wrapped pallet** ("FINISHED PALLET") |

### 10.5 Factory overlay (dashboard)

- Floating title **"Lubricant Line 01"** with four **KPI cards**: Production output, Efficiency,
  OEE, Completed boxes (labelled "Sample data").
- **Station labels** with leader lines; hover reveals a description and corner brackets on the
  floor.
- **Click to inspect:** the camera flies to the station and a focus panel shows the **live**
  state of the simulation plus KPIs.
- **Esc** / Factory overview to return; **H** hides all floating UI.

### 10.6 Controls

Every built-in scene has **Start**, **Reset** and **Speed** (1×, 2×, 10×) with a live status
list in the sidebar.

### 10.7 Engineering techniques behind the line

| Technique | Benefit |
|---|---|
| **Definition files** (`*Definition.js`) | All sizes, positions and timings in one place: change one value and it propagates everywhere |
| **Named hierarchy** | Parts are addressable, e.g. `FillingMachine › FillingHead › Nozzle_01` |
| **Step sequencer** | Processes are queues of timed steps; 10× speed never skips a step and never drifts |
| **Motion profiles** | Quintic easing for machine axes, trapezoidal profiles for belts, smooth accumulation against stops |
| **Hand-over without duplicates** | Products are re-parented at the exact same world position |

---

## 11. Visual modes and the 3D view

| Feature | Description |
|---|---|
| **CAD View / Digital Twin View** | A header toggle. Digital Twin View switches to a dark, teal, glowing "twin" look with a smooth 0.4 s transition; floor plans render as glowing accent lines |
| **Environment fitting** | Floor, fog, shadows and grid automatically sized to the model or scene |
| **Lighting** | Physically based lighting with shadows |
| **Camera** | Orbit / pan / zoom, framing presets, smooth flights |

---

## 12. Saving, sharing and data formats

| Format | Contents | Use |
|---|---|---|
| **Scene document** (JSON) | Items (source, position, turn, parameters, mounts, pose, program), camera | The core format: small, readable, versioned, **agent-writable** |
| **`.dtscene` bundle** (zip) | Scene + every imported model file + their rigs + floor plans | Share a complete scene with a colleague |
| **`.rig.json`** | Joints, tool points, poses, sequences | Reuse a machine's setup |
| **`.glb` with animations** | Model + sequences as animation clips | Use in Blender, Unity, Unreal, web viewers |

Example scene document (simplified):

```json
{
  "format": "digital-twin-scene",
  "version": 1,
  "name": "Palletizing cell",
  "items": [
    { "id": "robot_1", "source": { "kind": "builtin", "id": "abb_irb6760" },
      "position": [0.19, 0, 1.36], "yaw": 180 },
    { "id": "gripper_1", "source": { "kind": "catalog", "id": "vacuum_gripper" },
      "mount": { "to": "robot_1", "anchor": "flange" } },
    { "id": "conveyor_1", "source": { "kind": "catalog", "id": "belt_conveyor" },
      "params": { "length": 4.8, "width": 1.05, "speed": 0.7 },
      "position": [0, 0, 0], "yaw": 0 }
  ]
}
```

**Robustness:**

- A `version` field with migrations; unknown fields are kept, not dropped.
- A missing model or plan shows as a grey placeholder box with **"Locate file…"**.
- Everything stays on the device (IndexedDB / localStorage); nothing is uploaded.

> **Relevance to the agent:** this small JSON is the **contract** between the Scene Builder Agent
> and the visualization layer. The agent only has to write this document; the app turns it into
> a running 3D digital twin.

---

## 13. Performance

Industrial CAD models are heavy (one ABB item picker has ~913 separate parts). Optimisations:

| Technique | Result |
|---|---|
| **Static mesh merging** per moving link and material | Heavy scene: **4,971 → 1,227 draw calls (−75 %)**; IRB 1300: 913 parts drawn as 143 |
| **Shared geometry across copies** | A second copy of a 50 MB robot costs almost nothing on the GPU |
| **CAD conversion in a Web Worker** | The page stays responsive during STEP/IGES import |
| **Instanced meshes** for stock racks | 108 cans for about a dozen draw calls |
| **One draw call per floor-plan layer** | 210,000 line segments in 38 draw calls |
| **Background reachability checks** | Spread across frames so editing stays smooth |
| **Lazy-loaded physics** | Rapier loads only on first Play |

---

## 14. Quality and testing

**Automated tests (Vitest, `npm test`):**

| Area | What is tested |
|---|---|
| Inverse kinematics | 18 tests on generic machines (6-axis arm, gantry in mm, SCARA, 7-joint arm, linkage, pan-tilt), including every diagnosis case |
| Surface analysis | Automatic axis detection on rails, angled rails, rods |
| Scene document | Round trip, version migration, unknown fields kept |
| Scene bundle | `.dtscene` packing and unpacking |
| Simulation | Boxes dropped onto and under a gantry, beam lifted, collisions with real shapes |
| Programs | Program model and runner: a gantry picks two boxes onto a 2-spot grid with physics; worker programs |
| Floor plans | Every DXF entity type, nested blocks, units, mirroring, errors, 100k segments; walls and picking |
| Built-in scenes | Scene registry checks |

**Headless production-line checks** (run against the real station code):

| Check | Result |
|---|---|
| Station 1: no overlaps, no conveyor movement with a head down, every can full and capped (1× and 10×) | 0 errors, 63 cycles, 240 cans |
| Station 2: carton size exact, no collisions, every carton has 4 cans, closed flaps, full tape | 0 errors, 25 cartons |
| Factory: cans traced from Station 1 to Station 3, no duplicates, no jumps | 0 errors: 108 cans → 27 cases → finished pallet |

**Browser check:** `npm run check:floor-plan` imports a sample 40 × 25 m hall and verifies scale,
layers, walls, picking, Digital Twin View, save/reload and export/reopen.

---

## 15. Design principles

| Principle | Why |
|---|---|
| **Generic, vendor-neutral** | Works with any machine a user can rig, not only one brand |
| **Local-first** | No server, no cloud: data never leaves the device |
| **Data, not hand-made 3D files** | Scenes are small structured documents: easy to save, share, version, **and generate by an agent** |
| **Parametric components with anchors** | Layouts are fast to build and connections are exact |
| **Intent-level programs** | "Reach the box, grip, place on the next grid spot" rather than joint angles |
| **Explain failures** | Every "can't" comes with a reason the user (or agent) can act on |
| **Plain-language UI** | Labels and hints in everyday words, progressive disclosure of advanced options |

---

## 16. Known limits and roadmap

**Current limits:**

- KPIs in the Factory overlay are sample data (only the "Live" state line comes from the
  simulation).
- IK does not yet detect self-collisions or collisions with other objects.
- Very heavy imports still cost triangles (merging reduces draw calls only).
- Copies of the same robot share one rig definition (by design).

**Roadmap:**

| Next step | Description |
|---|---|
| **Scene Builder Agent integration** | The agent generates scene documents (layout, mounts, programs) from floor plans and process descriptions; this app renders, simulates and validates them |
| Built-in stations as saved scenes | Rebuild the coded stations with the generic studio tools, proving the studio can express everything |
| Straight-line moves (MoveL) | Tool travels in a straight line, not just joint interpolation |
| Snap to floor-plan lines | Align machines to walls and corners while moving them |
| Live data | Replace sample KPIs with real machine data |
| LOD / simplification | Lighter rendering for very large CAD imports |

---

## 17. Running the project

```bash
npm install          # install dependencies
npm run dev          # start the development server (Vite)
npm test             # run the automated tests (Vitest)
npm run build        # production build
npm run check:floor-plan   # browser check for DXF import (with npm run dev running)
```

Then open the local address Vite prints.

- **Machine tab:** pick a model from the header menu, or import a file.
- **Scene tab:** pick a built-in scene (Factory, Stations 1–3) and press **Start**, or create a
  new scene and build it from the Add drawer.

---

## 18. Glossary

| Term | Meaning |
|---|---|
| **Digital twin** | A virtual, behaving replica of a real system |
| **Scene Builder Agent** | The agent in our multi-agent framework that will generate 3D digital twin scenes automatically; this demo shows its expected output |
| **Rig** | A model's joint definitions (what moves, how, within which limits) |
| **Revolute / prismatic joint** | Rotating / sliding joint |
| **Inverse kinematics (IK)** | Computing joint values from a desired tool position |
| **Tool tip (TCP)** | The working point of a tool |
| **Anchor** | A named connection point on a component (conveyor end, robot flange) |
| **Mount** | Attaching a tool or part to an anchor so it follows it |
| **Catalog** | The library of parametric components in the Add drawer |
| **Scene document** | The small JSON describing a scene |
| **`.dtscene`** | A zip bundle of a scene with its models and rigs |
| **DXF** | AutoCAD's exchange format for drawings such as floor plans |
| **Back-pressure** | Upstream equipment waits until downstream has room |
| **OEE** | Overall Equipment Effectiveness, a standard manufacturing KPI |

---

## 19. Suggested presentation flow

1. **The vision:** our multi-agent Digital Twin Framework and the **Scene Builder Agent**.
2. **The message:** *this demo is the expected output of the Scene Builder Agent.*
3. **Live demo, the end result:** open the **Factory · Lubricant Line**, press Start, inspect a
   station, show the KPIs, finish on the wrapped pallet.
4. **The building blocks the agent will use:**
   - Import a CAD model and rig it (Joint Setup).
   - Click-to-reach IK with explained failures.
   - Build a cell in the Scene tab: floor plan → robot → gripper snaps on → conveyor → pallet.
   - **Pick & place** in one click, then Play with physics.
5. **Under the hood:** the scene document (JSON) as the agent ↔ visualization contract.
6. **Quality:** tests, measured accuracy, performance numbers.
7. **Next steps:** connecting the Scene Builder Agent to generate these scenes automatically.
