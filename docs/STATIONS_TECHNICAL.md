# Lubricant Line: How the Three.js Stations Were Built, Animated and Connected

> Technical reference for the built-in production line: Station 1 (oil filling & capping),
> Station 2 (case packing), Station 3 (robot palletizing & stretch wrapping) and the unified
> Factory scene that runs them as one line.
>
> Part A covers how the stations are generated and animated in code. Part B covers how the
> three stations are connected. Part C covers Station 3: how a GLB robot model and a STEP CAD
> model were assembled into one cell and animated.

---

## Table of contents

- [Part A: Generating and animating the stations](#part-a-generating-and-animating-the-stations)
  - [A1. Architecture of a station](#a1-architecture-of-a-station)
  - [A2. Procedural geometry](#a2-procedural-geometry)
  - [A3. Materials and lighting](#a3-materials-and-lighting)
  - [A4. Named hierarchy as the animation interface](#a4-named-hierarchy-as-the-animation-interface)
  - [A5. The animation engine: timed step queues](#a5-the-animation-engine-timed-step-queues)
  - [A6. Motion profiles](#a6-motion-profiles)
  - [A7. Station 1 in detail](#a7-station-1-oil-filling--capping-in-detail)
  - [A8. Station 2 in detail](#a8-station-2-jerry-can-case-packing-in-detail)
  - [A9. Integration with the app](#a9-integration-with-the-app)
- [Part B: Connecting the three stations](#part-b-connecting-the-three-stations)
  - [B1. Design rule: reuse stations unchanged](#b1-design-rule-reuse-stations-unchanged)
  - [B2. World layout](#b2-world-layout)
  - [B3. Instance-level hooks](#b3-instance-level-hooks)
  - [B4. Hand-over without duplicates](#b4-hand-over-without-duplicates)
  - [B5. Station 1 → Station 2 transfer](#b5-station-1--station-2-transfer)
  - [B6. Station 2 → Station 3 transfer](#b6-station-2--station-3-transfer)
  - [B7. Back-pressure](#b7-back-pressure)
  - [B8. Supply racks](#b8-supply-racks)
  - [B9. Factory lifecycle and update order](#b9-factory-lifecycle-and-update-order)
- [Part C: Station 3, assembling imported models and animating them](#part-c-station-3-assembling-imported-models-and-animating-them)
  - [C1. What Station 3 is made of](#c1-what-station-3-is-made-of)
  - [C2. Loading the ABB robot (GLB)](#c2-loading-the-abb-robot-glb)
  - [C3. Making the robot movable: the rig](#c3-making-the-robot-movable-the-rig)
  - [C4. Loading the wrapping machine (STEP)](#c4-loading-the-wrapping-machine-step)
  - [C5. Re-structuring the STEP assembly for animation](#c5-re-structuring-the-step-assembly-for-animation)
  - [C6. Assembling the cell](#c6-assembling-the-cell)
  - [C7. Mounting the vacuum gripper on the robot](#c7-mounting-the-vacuum-gripper-on-the-robot)
  - [C8. Animating the robot: inverse kinematics and path planning](#c8-animating-the-robot-inverse-kinematics-and-path-planning)
  - [C9. The palletizing state machine](#c9-the-palletizing-state-machine)
  - [C10. Pallet transfer with the worker](#c10-pallet-transfer-with-the-worker)
  - [C11. Animating the stretch wrapper and the spiral film](#c11-animating-the-stretch-wrapper-and-the-spiral-film)
  - [C12. Robustness checks](#c12-robustness-checks)
- [Appendix: file map](#appendix-file-map)

---

# Part A: Generating and animating the stations

## A1. Architecture of a station

Stations 1 and 2 are **100 % procedural**: every mesh is generated in JavaScript with Three.js
primitives. No model files are loaded. Each station follows the same four-file pattern:

| File | Role |
|---|---|
| `*Definition.js` | **Single source of truth**: every dimension, position, timing, speed and state name, as plain data |
| Component builders (`FillingMachine.js`, `CappingMachine.js`, `OilConveyor.js`, `PickAndPlaceRobot.js`…) | Functions that build one piece of equipment and return its `root` group plus a small **control API** (`setHeadTravel()`, `setGrip()`, `advance()`…) |
| `*Station.js` | Builds the station hierarchy from the components and exposes a uniform controller: `build`, `show`, `hide`, `update`, `startCycle`, `resetCycle`, `setCycleSpeed` |
| `*Cycle.js` | The **process controller**: plans the production steps and drives the component APIs every frame |

```
OilFillingDefinition.js ──► OilFillingStation.build() ──► components (root + API)
                                       │
                                       └──► OilFillingCycle (step queue) ──► calls component APIs each frame
```

Because builders and cycles read every number from the definition, changing one value (for
example the can height) propagates to geometry, positions and motion. The Factory uses this to run
Station 1 on a shorter "packable" can just by passing a different definition
(`FACTORY_STATION1_DEFINITION`).

## A2. Procedural geometry

Shared helpers live in `station-1/OilGeometry.js` and are reused by Station 2 and the Factory:

| Helper | What it produces |
|---|---|
| `group(parent, name, position)` | A named `THREE.Group` added to a parent: the building block of the hierarchy |
| `addMesh(parent, geometry, material, name, position)` | A named mesh with shadows configured |
| `roundedBoxGeometry([w, h, d], radius)` | Bevelled boxes (frames, cabinets, can bodies); the radius is clamped so thin plates stay valid |
| `box`, `roundedBox`, `cylinder`, `cylinderBetween` | Primitives; `cylinderBetween(a, b, r)` orients a cylinder between two points (pipes, rails, chute rods) |
| `canvasTexture(w, h, draw)` | A `CanvasTexture` drawn with the 2D canvas API (labels, belt texture, HMI screen, signs) |
| `smoother(t)` | Quintic ease (see A6) |

Examples of how the geometry is built:

- **Jerry can** (`JerryCan.js`): a rounded box body, a box "oil volume" inside it scaled in Y to
  show the fill level, a cylinder neck with two torus threads, and a three-piece handle. The
  **screw cap** uses a `CylinderGeometry` whose outer vertices are pushed out on every other
  segment to mould grip ribs:

  ```js
  const rib = Math.round(((angle + Math.PI) / (Math.PI * 2)) * segments) % 2 === 0 ? 1.045 : 1;
  position.setXYZ(index, x * rib, position.getY(index), z * rib);
  ```

- **Feeder bowl** (`CappingMachine.js`): a `LatheGeometry` revolved from a 2D profile.
- **Stretch film** (Station 3): a custom `BufferGeometry` generated along a path (see C11).
- **Supply stock** (Factory): `InstancedMesh`, one per template part, so 108 cans cost about a
  dozen draw calls (see B8).

Each builder also returns **reference points** (`references`): named `Vector3`s such as the
can's `neckTop` and `capSeat`, or a conveyor's `input`, `pickup` and `beltSurface`. Cycles use
these instead of hard-coded numbers, so the machines always meet the product at the right spot.

## A3. Materials and lighting

- `OilMaterials.js` is a **PBR material library**: `MeshStandardMaterial` for stainless steel,
  brushed aluminium, painted frames and rubber; `MeshPhysicalMaterial` with clearcoat for the
  translucent HDPE can body (`opacity: 0.56`, `depthWrite: false`) and the oil.
- Canvas textures give the belt a moving pattern (splice lines make the motion readable), and the
  labels and control-panel screen their content.
- Station 2's carton reuses the cardboard and tape materials of Station 3's box
  (`getCardboardMaterials`), so both stations show the same carton.
- **Image-based lighting:** `common/StationEnvironment.js` builds a `RoomEnvironment` once per
  renderer with `PMREMGenerator` and assigns it to `scene.environment` while a station is shown.
  Without it, metal and plastic look flat. `restore()` puts the app's own environment back.

## A4. Named hierarchy as the animation interface

Every moving assembly is a separate, **named** `THREE.Group` whose origin is placed at its
pivot or reference point. Animation then only means setting a group's `position` or `rotation`:

```
FillingMachine
 └─ FillingHead            ← moves in Y (all four nozzles together)
     ├─ Nozzle_01 … Nozzle_04
     │   ├─ Oil stream     ← scaled/shown during dispensing
     │   └─ Oil splash
CappingMachine
 └─ CappingHead            ← moves in Y
     └─ Spindle_01 … 04
         └─ Chuck_01 … 04  ← rotates in Y; holds a Cap at its origin
PickAndPlaceRobot
 └─ … VerticalAxis › GripperHead › Gripper_01 … 04
CardboardCase
 └─ Flaps (end + side flaps hinge on their edges), Tape
```

The origins are chosen so the maths stays trivial. For example, the capping head's origin is
the cap centre, so "head at cap-seat height" means the cap is exactly on the can neck.

## A5. The animation engine: timed step queues

All station processes are driven by a **queue of timed steps** rather than by keyframes. A step is:

```js
{ state, label, duration, status, onStart?, onUpdate?(progress, previous), onEnd? }
```

The generic implementation is `common/StepSequencer.js` (used by Station 2 and the Factory
transfers). Station 1's cycle contains the same loop inline. The core is `advance(time)`:

```js
advance(time) {
  let remaining = time;
  for (let guard = 0; remaining > 1e-9 && guard < 128; guard += 1) {
    if (!this.active && !this.begin()) return;          // begin() asks plan() for more steps
    const step = this.active;
    const previous = step.duration > 0 ? step.elapsed / step.duration : 0;
    const used = Math.min(remaining, step.duration - step.elapsed);
    step.elapsed += used;
    remaining -= used;
    const progress = step.duration > 0 ? step.elapsed / step.duration : 1;
    step.onUpdate?.(progress, previous, step);
    if (step.elapsed >= step.duration - 1e-9) { step.onEnd?.(); this.active = null; }
  }
}
```

Properties of this design:

| Property | How it is achieved | Why it matters |
|---|---|---|
| **Speed changes never skip events** | Each frame's scaled time (`delta × speed`) is *consumed across as many steps as it covers*; every step still gets its final `onUpdate(1)` and its `onEnd` | At 10× speed a single frame may finish several steps; nothing is skipped |
| **No drift, no teleporting** | `onUpdate` computes positions from **absolute** start/end values and `progress`, never by adding to the previous frame | Frame-rate and speed independent |
| **Incremental quantities** | `onUpdate` also receives `previous`, so belts advance by `f(progress) − f(previous)` | Belt textures and rollers move by exactly the distance the product moved |
| **Self-planning** | When the queue is empty, `plan()` queues the next phase | The process runs indefinitely without a script |
| **Live status** | Each step carries a `status` patch (`{ fillingHead: 'DESCENDING' }`) merged into the station status | Drives the sidebar read-out, the HMI screen and the Factory overlay |

## A6. Motion profiles

| Profile | Formula / behaviour | Used for |
|---|---|---|
| **Quintic "smoother"** | `x³(x(6x − 15) + 10)`: zero velocity *and* acceleration at both ends | Machine axes: filling head, capping head, gantry axes, pushers, flaps |
| **Ease-out** | `1 − (1 − t)²` | Cap tightening (spindles slow as torque builds) |
| **Ramped belt** | Constant acceleration to speed `v` over `ramp` seconds, then constant speed | Conveyors starting |
| **Trapezoidal travel** | Accelerate, cruise, decelerate to an exact distance | Indexed belt moves, case transfers |
| **Polynomial smooth minimum** | `smin(a, b, k) = min(a, b) − h²k/4`, `h = max(k − |a − b|, 0)/k` | Products accumulating against a stop: they ease into place instead of snapping |
| **Two-stage fill curve** | Linear to 85 % over 75 % of the time, then ease-out to 100 % | Oil filling: bulk fill, then slow top-off |

The smooth minimum is what makes accumulation look physical. Each can follows the belt
(`s`) until it nears its stop position (`travel`), then blends smoothly into it:

```js
mover.object.position.x = mover.start + smoothMin(s, mover.travel, STOP_BLEND);
```

## A7. Station 1 (Oil Filling & Capping) in detail

**Components** (`station-1/`): indexed belt conveyor with drums, rollers and gear motor
(`OilConveyor.js`); filling machine on a stainless portal frame with a vertical actuator and a
4-nozzle `FillingHead` (`FillingMachine.js`); 4-spindle servo capper with a vibratory cap-feeder
bowl and chute (`CappingMachine.js`); oil tank with sight glass and transfer pump (`OilTank.js`);
rigid piping and **flexible hoses that follow the moving head** (`OilHoses.js`); photo-eyes with
status LEDs (`OilSensors.js`); a pedestal HMI whose canvas screen is redrawn with live status
(`ControlPanel.js`); floor slab, safety markings and fence (`StationBase.js`).

**Process.** Cans travel in **batches of 4**. Each machine cycle cycles through four phases and
skips any phase that has nothing to do:

```
PHASES = ['transport', 'output', 'filling', 'capping']
```

| Phase | Steps queued | What animates |
|---|---|---|
| `planTransport` | Conveyor starting → **Indexing conveyor** (one batch pitch) → Conveyor stopped | All cans move together (`queueMove` with quintic ease); main and outfeed belt textures advance by the same distance; a new batch spawns at the infeed |
| `planOutput` | Outfeed starting → Discharging finished cans | Capped cans leave on the outfeed belt and are removed (or handed to the Factory transfer, see B3) |
| `planFilling` | Cans in position → Head descending → Nozzles engaged → **Valves opening** → **Dispensing** → **Valves closing** → Drip settle → Head retracting | Head travel; oil jets; oil level inside the translucent cans |
| `planCapping` | Head descending → Caps engaging threads → **Tightening** → Torque reached → Head retracting → **Feeding new caps** | Head height; chuck rotation; cap hand-over; new caps sliding into the chucks |

**Selecting the batch.** `batchAt(center, state)` returns the four cans in a given state that
sit exactly in the four slots around a machine (within 1 cm). Machines therefore only run when a
complete batch of the right kind is in place.

**Oil streams.** Each nozzle has a cylinder "stream" mesh scaled between the nozzle tip and the
oil surface inside its can. Three effects use the step progress:

- *Valves opening:* `front = progress²`: the jet front accelerates under gravity.
- *Dispensing:* the level follows the two-stage `fillCurve`; the jet narrows (`widthScale 0.6`)
  for the top-off.
- *Valves closing:* `tail = progress²`: the jet's top falls away from the closed nozzle.

**Capping.** The head descends to the thread start (`seat + threadLead`). During *Tightening*
the head lowers by the thread lead **while** the chucks turn 3 full turns
(`fullTurn = −2π × tighteningTurns`), so the cap visibly screws down. At *Torque reached* the caps
are re-parented from the chucks to the cans:

```js
entry.can.root.attach(cap);                         // keeps world transform
cap.position.copy(entry.can.references.capSeat);    // exact seat, no float drift
```

During *Feeding new caps* the chuck angle is reset to 0 (a whole number of turns, so the reset is
invisible) and new caps slide down from inside the sleeves.

**Tank.** Each batch lowers the tank level; below a threshold it refills gradually.

## A8. Station 2 (Jerry Can Case Packing) in detail

**Components** (`station-2/`): two-lane input conveyor with an end stop and tunnel hood, carton
conveyors with a swing-arm box stop and a case taper (`PackingLineEquipment.js`); a Cartesian
gantry robot with four handle grippers on a **pitch-change rail** (`PickAndPlaceRobot.js`); a
flap closer with tuckers and side folders (`CaseCloser.js`); an open-top carton with hinged flaps
and a tape strip (`CardboardCase.js`).

**Sizing.** The carton imports Station 3's box size (0.62 × 0.42 × 0.42 m), so the case Station 2
produces is exactly the box Station 3 palletizes. Station 1's 20 L can (0.425 m tall) doesn't fit
upright, so Station 2 uses the same can model with a 0.33 m body. It fits 2 × 2 with 9 mm to spare
under the flaps.

**Cycle** (`CasePackingCycle.planCycle`, one queue per carton):

| Stage | Steps | Animation technique |
|---|---|---|
| `planArrival` | Cans & empty case arriving → Conveyors stopping → Cans in 2 × 2 position | Ramped belt travel; every can and the carton blend into their stop with `smoothMin`; the swing-arm box stop closes; belts decelerate under the held products |
| `planPick` | Lowering to handles → Closing grippers → Lifting 4 cans | `setY` and `setGrip` with the quintic ease; the gripper lips hook under the can handles |
| `planPlace` | Transferring to case → Lowering into case → Releasing → Retracting | Gantry moves in Z while `setPitch()` narrows the row gap from conveyor spacing (0.26 m) to carton spacing (0.20 m), delayed and eased (`smoother((progress − 0.15) / 0.6)`) |
| `planCompletion` | Robot returning | Gantry returns, pitch widens again |
| `planClosing` | Box stop releases → Index to closer → Tuckers lower → **Fold end flaps** → Tuckers retract → Tamp → **Fold side flaps** → Folders retract → Press closed | Each flap is a hinged group whose rotation follows the tucker/folder bar position |
| `planOutput` | **Taping & discharging case** → Case delivered | Trapezoidal travel; the tape strip is revealed from the leading edge back as the case passes under the taper (`box.setTape(headLocal)`), and the taper roller spins only while in contact |

## A9. Integration with the app

`src/station/BuiltInScenes.js` registers each station as a **built-in scene** with a common
runtime interface (`show`, `hide`, `start`, `reset`, `setSpeed`, `update`, `listen`). One sidebar
card (Start, Reset, Speed 1×/2×/10×, status fields) works for every scene. The app's frame loop
calls `runtime.update(delta)`. A loading screen covers the view while a scene builds, so a
half-built line never shows.

---

# Part B: Connecting the three stations

## B1. Design rule: reuse stations unchanged

The Factory (`factory/LubricantFactory.js`) instantiates the **same** `OilFillingStation`,
`CasePackingStation` and `StationScene` classes used for the stand-alone scenes. The station
source code is not modified for the Factory. All integration happens through **instance-level
hooks**: the Factory replaces individual methods on its own station *instances*, often wrapping
the original prototype method. The stand-alone stations keep working exactly as before.

## B2. World layout

`factory/FactoryLayout.js` defines the world positions:

- **Station 3 stays at the world origin.** Its cycle mixes station-local and world coordinates
  (IK targets, placement checks), so moving it would break those calculations.
- Stations 1 and 2 are placed **upstream along −X**, so the product flows +X through the hall.
- The layout also holds the transfer geometry (lane positions, pusher positions, staging points,
  queue slots on the case transfer), the supply-rack positions, belt speed and ramp.

```
   −X  ◄────────────────────────────────────────────────────────►  +X
 [Can rack] → [Station 1] → can transfer → [Station 2] → case transfer → [Station 3 @ origin]
               fill + cap     single file      pack 4/case     queue + drop    palletize + wrap
                              → 2 lanes
```

## B3. Instance-level hooks

| Station | Hook | Purpose |
|---|---|---|
| 1 | `cycle.createCan` | Each new can takes one from the **jerry-can rack** (`canStock.take()`) |
| 1 | `cycle.spawnBatch` | Only spawns a batch if the rack still holds 4 cans |
| 1 | `cycle.planNextPhase` | Same phase order as the original, but the **transport** phase (start of a machine cycle) is held while the transfer is busy (back-pressure) |
| 1 | `cycle.beginNextStep` | When the step *"Discharging finished cans"* begins, its `onEnd` is wrapped: the leaving cans' world matrices are captured, the original discharge runs, then the cans are handed to the transfer instead of being deleted |
| 2 | `cycle.spawnCans` | Instead of creating cans, Station 2 **adopts** the cans staged by the transfer |
| 2 | `cycle.planCycle` | Waits until cans are staged, the carton rack isn't empty and the case transfer has space |
| 2 | `parts.createCase` | Cartons are taken from the **carton rack** |
| 2 | `sequencer.onStepStart` | When *"Taping & discharging case"* begins, its `onEnd` is wrapped to hand the taped case to the S2 → S3 transfer |
| 3 | `cycle.boxFactory` / `cycle.createBoxAtInput` | Station 3 no longer spawns its own boxes: it only receives a box that Station 2 actually delivered (`pendingS3Box`) |

Hooks identify steps by their `label`, so no station code had to expose new events.

## B4. Hand-over without duplicates

A product keeps its **object identity** from the rack to the pallet: the same `Object3D` that
Station 1 filled is the one packed by Station 2 and palletized by Station 3. Hand-over is done by
re-parenting at the identical world transform:

```js
function reparentPreservingWorld(object, parent, worldMatrix) {
  parent.updateMatrixWorld(true);
  parent.matrixWorld.clone().invert().multiply(worldMatrix)
    .decompose(object.position, object.quaternion, object.scale);
  parent.add(object);
}
```

The world matrix is captured **before** the releasing station's own cleanup runs, so the
object never jumps, even if the releasing station would normally remove it.

## B5. Station 1 → Station 2 transfer

Station 1 discharges cans **single file**; Station 2 expects them in **two lanes** as a 2 × 2 block.
The transfer (`TransferLines.createCanTransfer` geometry + `LubricantFactory.planCanTransfer`
logic, on its own `StepSequencer`) forms the lanes:

1. **Single-file transfer to row former** (`queueRigidMove`): all 4 cans move together with a
   trapezoidal profile until the leading pair is in front of pusher A.
2. **Pusher A** (`queuePush`) extends across the belt with the quintic ease and pushes the
   leading pair into lane 1. The cans' Z position is clamped to the pusher face, so they're pushed
   by contact, not teleported.
3. **Indexing second pair**: the belt advances exactly one pair spacing.
4. **Pusher B** pushes the trailing pair into lane 2 from the opposite side.
5. **Feeding Station 2 infeed**: both lanes accumulate (`smoothMin`) against a metering point
   inside Station 2's infeed tunnel, which is exactly where Station 2's own arrival step expects
   its cans to start. The cans become `stagedCans`.
6. Station 2's hooked `spawnCans` re-parents the staged cans into its input conveyor with
   `attach()` and runs its normal arrival.

Belt textures stay consistent across the boundary: `advanceCanBelts` moves the transfer belt
always, and the adjoining Station 1 outfeed / Station 2 infeed belts only while those stations
aren't driving them themselves.

## B6. Station 2 → Station 3 transfer

1. `receiveCase` wraps the taped case in a **centred carrier group** (Station 3 handles boxes by
   their centre; Station 2's case origin is its base).
2. Cases queue in fixed **slots** on the case transfer belt. Each move is a trapezoidal travel to
   the next free slot.
3. Over the last section the case **steps down 28 mm** from Station 2's belt height to Station 3's
   (`caseBaseY` interpolates with the quintic ease between two X positions).
4. The case enters a port in the back of Station 3's box-source cabinet and waits there hidden.
5. When Station 3's cycle is in `CONVEYOR_RUNNING` with no box, the first case is delivered:
   `deliverToStation3` builds a box record (`root` + `references.center / bottom / grasp /
   topSurface`) and calls Station 3's `createBoxAtInput`. The case appears at exactly Station 3's
   input position and height, with no jump.

## B7. Back-pressure

Upstream stations never run ahead of downstream ones, and there are **no arbitrary timers**.
At a cycle boundary each station asks the Factory for a hold reason; if there is one it queues a
short `0.1 s` "Holding · …" step and asks again next time:

| Station | Holds when |
|---|---|
| 1 | The can transfer still carries a batch (`'Holding · transfer to Station 2 busy'`), or the rack can't supply another batch (`'Can supply used · run complete'`) |
| 2 | No cans are staged (`'Waiting for jerry cans from Station 1'`), the carton rack is empty, or every slot on the case transfer is occupied (`'Holding · Station 3 infeed full'`) |
| 3 | Its box request is only satisfied when a case reaches the delivery point |

The hold step's label is shown live in the status panel and the Factory overlay.

## B8. Supply racks

`factory/SupplyRack.js`:

- `createRackFrame`: blue uprights, orange beams, wire decks.
- `createInstancedStock({ template, slots })`: traverses a template object (a real can or carton)
  and creates **one `InstancedMesh` per visible part**, with one instance per slot. `take()`
  lowers `mesh.count`, so the visible stock shrinks as items are used, and `refill()` restores it.
  108 cans (3 decks × 6 × 6 = exactly one pallet: 108 cans → 27 cases → 3 × 3 × 3) cost only about
  a dozen draw calls.

## B9. Factory lifecycle and update order

- `build()` creates the three stations, positions them, opens the tunnels products now pass
  through (end walls hidden), builds racks, transfers and signs, then installs the hooks.
- `show(robot)` awaits Station 3's asset loading (C2–C6), patches Station 3 and resets everything.
- `start()` starts all three cycles; `setSpeed()` applies the same multiplier to all three cycles
  and the transfers, so the whole line stays in sync at 1×, 2× or 10×.
- Each frame the Factory updates Stations 1, 2 and 3 (each scales the frame time by its own
  speed multiplier), then, while running, advances the can transfer sequencer and the case
  transfer with the same scaled time, and declares the run finished when Station 3's cycle
  reaches `COMPLETE`. A run ends in **FINISHED PALLET**: 108 cans, 27 cases and
  one wrapped pallet.

The interactive overlay (`FactoryOverlay.js`: title, KPIs, station labels, click-to-inspect
camera flights) is purely presentational. It reads the station status but never changes
geometry or production state.

---

# Part C: Station 3, assembling imported models and animating them

## C1. What Station 3 is made of

Station 3 is a palletizing and wrapping cell. Unlike Stations 1 and 2, it combines **two
imported industrial models** with procedural parts:

| Part | Source | Format |
|---|---|---|
| **ABB IRB 6760 robot** | `src/assets/robot.glb`, exported from ABB RobotStudio | **GLB** (binary glTF) |
| **Stretch wrapping machine** | `src/assets/Wrapping.STEP`, a SolidWorks assembly (`Assem1`) | **STEP** CAD, converted to Three.js meshes in the browser |
| Belt conveyor, box-source cabinet, pallet, boxes, worker with pallet jack, vacuum gripper | Code (`Procedural*.js`, `createVacuumGripper`) | Procedural |

The challenge was to make the two imported files behave like machines. Neither file can be
animated as delivered: the GLB has no usable animation for the task and the STEP file has no
motion at all. Both had to be restructured so their moving parts have proper pivots, then driven
by code.

## C2. Loading the ABB robot (GLB)

1. The GLB URL is registered in `AssetRegistry.js` (`id: 'abb_irb6760'`, imported with Vite's
   `?url` so it ships in the build).
2. `BuiltInScenes.loadRobot()` calls `ModelTemplates.createInstance(config, { rig })`:
   - The file is parsed **once** by `GLTFLoader` (with Draco and Meshopt decoders) into a
     **template**. Every Station 3 / Factory instance is a clone (`cloneWithSkeletons`), so the
     Machine tab's copy is never borrowed or modified.
   - The clone is wrapped: `AssetRoot` (placement) → `Orientation` (up-axis correction) →
     `content` (the file's scene), and placed on the floor with metre units.
   - A `Rig` is built on it from the built-in rig definition (next section).

## C3. Making the robot movable: the rig

The GLB from RobotStudio contains the link meshes `Link1 … Link6` (plus the balancer links
`LinkD1`, `LinkD2`). RobotStudio places every link node **on its joint, with the rotation axis
as its local Z** (the Denavit–Hartenberg convention). The rig definition
(`rigs/abbIrb6760.js`, built by `abbRobotStudioRig()`) uses that:

```js
const joint = (number, [min, max], speed, zero) => ({
  id: `axis${number}`, type: 'revolute',
  parent: number > 1 ? `axis${number - 1}` : null,   // a kinematic chain
  parts: [{ name: `Link${number}` }],
  frame: 'part', axis: [0, 0, 1], pivot: [0, 0, 0],  // rotate about the link's own Z
  min, max, speed, ...(zero ? { zero } : {}),
});
```

- **Limits** (degrees) come from the kinematics ABB embeds in the file
  (`extras.ABB_ro_int_kinematics`): axis 1 ±170°, axis 2 −65…85°, axis 3 −180…70°, axis 4 ±300°,
  axis 5 ±130°, axis 6 ±360°.
- **Rest pose:** the file was exported with axis 5 at 30°, so `zero` for axis 5 is 30°.
- **Balancer linkage:** two **follower joints** keep the counterbalance cylinder attached to the
  upper arm: `balancer` *aims* at a pin carried by axis 2, and `balancer_rod` *stretches* to keep
  the pin distance. They move automatically whenever axis 2 moves.
- **Tool flange:** a tool point 0.2 m along Link 6's Z (`extras.ABB_ro_int_mountOffset`).

`Rig.js` turns this into real hierarchy: each joint becomes a `THREE.Group` at its pivot, the
link meshes are re-parented under it, and child joints nest inside parent joints. Forward
kinematics is then just the scene graph: `rig.setValues({ axis1: 20, axis2: 35, … })` rotates
the groups, clamps to limits and solves the followers.

## C4. Loading the wrapping machine (STEP)

STEP is a CAD exchange format that browsers can't read natively. `AssetWrapMachine.js` loads it
through the app's `ModelLoader`:

1. `downloadModel(wrappingUrl)` fetches the file as an `ArrayBuffer`.
2. `ModelLoader.parse(buffer, 'Wrapping.STEP')` sends it to a **Web Worker** running
   **occt-import-js** (OpenCascade compiled to WebAssembly), which tessellates the B-rep solids
   into triangle meshes and keeps the assembly tree and part names.
3. The result is converted to a Three.js scene; shadows are enabled on every mesh.
4. The parsed content is **cached**; each build uses `cachedContent.clone(true)`, so the
   expensive CAD conversion happens once per session.

## C5. Re-structuring the STEP assembly for animation

The SolidWorks assembly arrives as a flat list of parts with their CAD names:

| CAD node(s) | Meaning |
|---|---|
| `wraping machine`, `Part1` | Fixed frame, mast and inbound ramp |
| `rotor` | Turntable ring |
| `cone holder`, `cones`, `cone2` | Film carriage and film rolls on the mast |

The code looks these up **by name among the direct children** of `Assem1` (mesh descendants
reuse the same names) and throws a clear error if one is missing. It then builds pivots so each
part can move correctly:

```js
// Turntable: pivot at its geometric centre so rotation is coaxial.
const rotorCenter = new THREE.Box3().setFromObject(rotorNode).getCenter(new THREE.Vector3());
const rotorPivot = new THREE.Group();          // 'TurntablePivot'
rotorPivot.position.copy(rotorCenter);
assembly.add(rotorPivot);
rotorPivot.attach(rotorNode);                  // attach() keeps the part where it is

// Film carriage: one group so all its parts rise together along the mast.
const carriage = new THREE.Group();            // 'FilmCarriage'
assembly.add(carriage);
carriageNodes.forEach((node) => carriage.attach(node));

// Film rolls: a vertical spin pivot at each roll's centre, inside the carriage.
```

Measured values are taken from the CAD geometry instead of being hard-coded:

- **Deck height** = top of the rotor's bounding box (where the pallet sits).
- **Carriage travel** = from the carriage's top to the mast top (minus clearance), limited to
  the stack height.
- **Bay length / width / height** = the model's bounds. They're written back into the station
  layout so the worker's approach positions match the real machine.

The STEP file stays a static drawing; the pivots added in code are what make it a machine.

## C6. Assembling the cell

`StationScene.show(asset)` builds the cell around the robot:

1. **Layout resolution.** `resolveStationLayout(STATION_DEFINITION, robotSize)` computes every
   position from a few rules:
   - the conveyor at the origin, with the pickup point 8 % past its centre;
   - the robot beside the pickup, at a clearance from the belt that depends on the **measured robot
     footprint**;
   - the pallet centred under the 3 × 3 × 3 stack footprint, whose origin is chosen so every cell
     is reachable with the cup held flat;
   - the wrapping machine 4.2 m along +X from the pallet;
   - the worker's spawn, engage and withdraw positions.
2. **Procedural parts** are created from the same definition: conveyor (4.8 × 1.05 m, 13
   rollers), box-source cabinet (opening sized from the box), pallet (stack footprint + 8 cm
   overhang).
3. **Wrapping machine** is loaded (`await createAssetWrapMachine(...)`) with the stack's
   footprint and height, so its film is generated to fit the stack exactly (C11).
4. **Robot placement.** The robot model is positioned and turned to face the conveyor, and the
   rig's base values are set to match.
5. Everything is added to the station root: conveyor, source cabinet, pallet, wrapper, robot.
6. The **vacuum gripper** is mounted on the robot (C7) and the `StationCycle` is created with
   references to all parts.
7. Optional **debug frames** (coloured spheres and axes at every reference point: conveyor
   input/pickup, box grasp, stack target, robot base and TCP) can be switched on from the sidebar.

## C7. Mounting the vacuum gripper on the robot

The gripper is procedural (`createVacuumGripper()`): mounting body, stem, rubber bellows,
suction cup and a status LED that changes colour per state (open, approaching, gripping,
holding, releasing). It declares its own frame data in `userData`:

- `suctionPoint`: centre of the cup lip (the TCP).
- `toolAxis`: local −Y (the direction the cup points).
- `mountOffset`: half the mounting-body height (its top face is the mounting face).

It is added under the **axis 6 joint group** (so it inherits all robot motion) and seated on
the flange with `mountOnFlange()`:

```js
const flange = resolveTool(rig, rig.tools.find((tool) => tool.joint === 'axis6'));
const inverse = tcpJoint.matrixWorld.clone().invert();
const point = flange.position().applyMatrix4(inverse);        // flange point in axis-6 space
const axis = flange.direction().transformDirection(inverse);   // flange axis in axis-6 space
gripper.quaternion.setFromUnitVectors(gripper.userData.toolAxis, axis);
gripper.position.copy(point).addScaledVector(axis, gripper.userData.mountOffset);
```

The gripper's tool axis is aligned with the flange axis, and its mounting face sits exactly on
the flange.

## C8. Animating the robot: inverse kinematics and path planning

The robot's motion is computed, not keyframed. For every box the cycle **plans** joint poses
with inverse kinematics, then **plays** them by interpolating joint values.

**Solver** (`StationCycle.solveTarget`): damped least squares on **position and orientation**:

- **Residual:** a 6-vector made of the position error (target − suction point, metres) and the
  rotation error between the desired and current gripper orientation, as a rotation vector
  weighted by 0.6 m/rad.
- **Jacobian:** finite differences. Each joint is nudged by 0.05° (towards the inside of its
  range, so a joint resting on a limit still shows its effect) and the residual change is measured.
- **Update:** `Δq = Jᵀ (J Jᵀ + λ² I)⁻¹ e` with damping λ = 0.012, solved by Gaussian elimination;
  each joint step is clamped to ±0.12 rad and the result to the joint limits.
- **Stopping:** converged at < 0.4 mm and < 0.05°, or after 200 iterations, or when the error
  stops improving for 12 iterations (a seed pinned on a limit is abandoned).

**Tool orientation.** The cup must arrive flat on the box, and a held box must keep its pose
relative to the cup. `getToolOrientation()` uses a pure yaw: cup axis straight down, with the
wrist roll taken from the home pose so the tool turns as little as possible.

**Planning one box** (`prepareTargets`):

1. Measure the box top (`measureBoxTop`) and compute the stack cell target for box *n*.
2. **Choose the grip point** on the box top: several offsets are tried, because placing into the
   farthest cells is the hardest reach. The first offset with a fully solvable path wins.
3. Solve a set of **paths**, each a list of IK poses sampled along a straight line
   (`planPath(from, to, seed, steps)`, every pose seeded with the previous one so the arm moves
   continuously):

| Path | From → to | Purpose |
|---|---|---|
| `approach` | home → 0.3 m above the box | Come over the box |
| `pickup` | hover → contact (6 samples) | Straight vertical descent, cup flat |
| `lift` | contact → max(contact + 0.52 m, carry height) | Rise straight up before swinging, so the box never sweeps over lower stack layers |
| `stackCarry` | lift → above the stack cell (12 samples, `planSwing`) | Swing across, blending the seed pose between start and end so the arm doesn't flip configuration |
| `stackLower` | above cell → contact | Straight vertical placement (the retract path reversed) |
| `retract` | contact → above cell | Lift the open cup straight off the placed box |

**Playing a path.** During a move, `update(delta)` evaluates joint values from progress with a
`smoothstep` ease:

- single target → `lerpPose(from, to, progress)` (linear per joint);
- path → `samplePosePath([from, ...poses], progress)`: a **Catmull-Rom spline through the joint
  poses**, so the arm passes smoothly through every sampled IK pose without stopping.

**Gripping and releasing.** The box is attached to the gripper with `gripper.attach(box.root)`
(world transform preserved), so it follows the cup rigidly. On release it's re-attached to the
station root and its placement is **verified**; if verification fails, the targets are re-planned
and the lowering is retried.

## C9. The palletizing state machine

The cycle is a finite state machine; each state is a timed move or hold, and the transition
happens when its duration completes:

```
IDLE → SPAWN_BOX → CONVEYOR_RUNNING → BOX_AT_PICKUP
     → APPROACH_BOX (1.8 s) → LOWER_TO_BOX (1.0 s) → GRIPPING (0.45 s)
     → LIFT (1.1 s) → MOVE_TO_STACK (2.0 s) → LOWER_TO_STACK (0.9 s) → RELEASING (0.45 s)
     → VERIFY_PLACEMENT (0.16 s) → RETRACT (0.8 s) → RETURN_HOME (2.2 s)
     → (box < 27) SPAWN_BOX …   |   (box = 27) OUTBOUND (C10)
```

- **Conveyor:** while `CONVEYOR_RUNNING`, the box moves along the conveyor direction at 0.7 m/s
  until it reaches the pickup point exactly; rollers rotate by `travel / rollerRadius`.
- **Speed:** all durations are divided by the speed multiplier through
  `elapsed += delta × speedMultiplier`.
- **Status:** every transition updates the conveyor, robot, box and gripper states shown in the
  sidebar, and the gripper LED.

## C10. Pallet transfer with the worker

After the 27th box, `startOutbound()` spawns the procedural worker with a pallet jack and runs a
second timed sequence (`finishOutboundStep` / `updateOutbound`, with `smoothstep` easing):

| Step | What happens |
|---|---|
| `WORKER_SPAWN`, `WORKER_APPROACH` | Worker appears at its bay and walks to the pallet |
| `JACK_INSERT` | Forks slide under the pallet |
| `JACK_LIFT` | Forks rise; the pallet and all 27 boxes are grouped into one **cargo** group (`attach`) and attached to the jack's `cargoAnchor` |
| `TRANSPORT_PALLET`, `PLACE_IN_WRAP` | Worker carries the load to the wrapper, raised to clear the turntable deck |
| `JACK_LOWER` | Cargo lowered onto the turntable |
| `JACK_RELEASE` | Cargo re-attached to the station, **seated exactly on the turntable centre**; forks drop clear of the deck boards |
| `WORKER_WITHDRAW` | Worker backs out until the fork tips are 0.6 m clear, measured from the fork and pallet bounds |
| `JACK_STOW` | Forks lower; a bounds check confirms they no longer intersect the pallet before wrapping may start |
| `WRAPPING` | 12 s wrap (C11) |

## C11. Animating the stretch wrapper and the spiral film

**Film geometry** (`createSpiralFilm`) is generated once for the actual stack size:

1. `rectPerimeterLoop(halfX, halfZ)` samples the stack's rectangular outline (plus 12 mm
   clearance) every ≤ 5 cm. **Corners are included exactly** and their outward offset combines
   both side normals, so the film stays a true rectangle and never rounds into an oval.
2. The path loops around this outline: **1.5 turns at the bottom**, a constant-pitch rise, then
   **1.5 turns at the top**. The pitch is 55 % of the band height, so consecutive passes overlap
   with no gaps.
3. For each path sample two vertices are written (band bottom and top), and each pair is joined to
   the previous pair with two triangles. A tiny outward growth per turn (`layerGrowth`) prevents
   z-fighting between overlapping layers.
4. The vertices are **ordered along the path**, so the wrap can be revealed progressively with
   `geometry.setDrawRange()`.

**Driving the wrap** (`setWrapProgress(progress)`, called every frame of the 12 s step):

| Element | Driven by |
|---|---|
| Film revealed | `length = progress × totalLength`; a binary search finds the last path sample before the head, the next vertex pair is moved to the **exact** head position and the draw range is set to it |
| Leading edge | A thin bright bar placed at the head, marking where film is being applied |
| Turntable | `rotorPivot.rotation.y = (length / perimeter) × 2π`, i.e. one revolution per perimeter of film |
| Film carriage | `carriage.position.y` follows the band height (`bandBottomAt(length) / riseHeight × carriageTravel`) |
| Film rolls | Spin pivots rotate faster than the turntable (`turns × (1.8 + index × 0.15)`) as film pays out |

Because the turntable angle, carriage height and film reveal are all computed from the same
`length`, they stay perfectly in sync at any speed. `resetWrap()` returns everything to zero.

## C12. Robustness checks

- `assertRootTransform`: verifies the robot's base didn't move during initialisation and restores
  it if it did.
- `validateStackTarget`: every stack cell must sit on the pallet plane and must not intersect the
  conveyor; otherwise an error is thrown.
- Placement verification after each release, with automatic re-planning.
- Fork-clearance check before wrapping (C10).
- Clear errors when the STEP file lacks the expected `rotor` or carriage nodes, or the rig lacks
  `axis6`.
- In the Factory, Station 3 uses its **own clone** of the robot with the built-in rig, so joint
  edits in the Machine tab can never break the cell.

---

## Appendix: file map

```
src/station/
├── common/
│   ├── StepSequencer.js        timed step queue (A5)
│   └── StationEnvironment.js   room environment map for PBR (A3)
├── station-1/                  Station 1, fully procedural (A7)
│   ├── OilFillingDefinition.js · OilFillingStation.js · OilFillingCycle.js
│   ├── OilGeometry.js · OilMaterials.js
│   └── OilConveyor.js · FillingMachine.js · CappingMachine.js · OilTank.js · OilHoses.js
│       OilSensors.js · JerryCan.js · ControlPanel.js · StationBase.js
├── station-2/                  Station 2, fully procedural (A8)
│   ├── CasePackingDefinition.js · CasePackingStation.js · CasePackingCycle.js
│   └── CardboardCase.js · PickAndPlaceRobot.js · PackingLineEquipment.js · CaseCloser.js
├── station-3/                  Station 3, GLB robot + STEP wrapper + procedural parts (Part C)
│   ├── StationDefinition.js    layout data + resolveStationLayout()
│   ├── StationScene.js         assembly, gripper mounting, debug frames
│   ├── StationCycle.js         IK, path planning, state machine, worker transfer, vacuum gripper
│   ├── AssetWrapMachine.js     STEP loading, pivots, spiral film, wrap animation
│   └── ProceduralBox.js · ProceduralBoxSourceMachine.js · ProceduralConveyor.js
│       ProceduralPallet.js · ProceduralWorker.js
├── factory/                    the connected line (Part B)
│   ├── FactoryLayout.js · LubricantFactory.js · TransferLines.js · SupplyRack.js
│   └── FactoryOverlay.js · factoryOverlay.css
├── BuiltInScenes.js            registers the scenes with the app (A9)
└── LoadingScreen.js

src/assets/robot.glb            ABB IRB 6760 (GLB, RobotStudio export)
src/assets/Wrapping.STEP        stretch wrapper (STEP, SolidWorks assembly)
src/rigs/abbIrb6760.js          robot rig (limits, rest pose, balancer, flange)
src/rigs/abbRobotStudio.js      rig builder for RobotStudio GLBs
src/motion/Rig.js               joint hierarchy / forward kinematics
src/loaders/ModelLoader.js      GLB / STEP loading (occt-import-js worker for CAD)
src/studio/ModelTemplates.js    template cache + per-instance clones
```
