# Lubricant Production Line: Stations 1–3 and the Factory Scene

This document summarizes the work that turned the single robot station into a three-station lubricant line plus a unified Factory scene. It covers what was built, how it works, where the code lives, and how it was verified.

**Product flow:** raw materials → filling → capping → case packing → palletizing → wrapping → finished pallet.

| Scene (asset menu → Scenes) | What it is | Code |
|---|---|---|
| **Factory · Lubricant Line** | Stations 1 → 2 → 3 running as one continuous line, with supply racks, transfers and an interactive KPI overlay | `src/station/factory/` |
| **Station 1 · Oil Filling & Capping** | Procedural filling and capping line for HDPE jerry cans | `src/station/station-1/` |
| **Station 2 · Jerry Can Case Packing** | Gantry robot packs 4 cans per carton, then cartons are taped and discharged | `src/station/station-2/` |
| **Station 3** (formerly "Station") | ABB IRB 6760 palletizing cell: 3×3×3 stacking, pallet-jack transfer, stretch wrapping | `src/station/station-3/` |

---

## 1. Quick start

```bash
npm install
npm run dev
```

Open the asset switcher in the header and pick a scene under **Scenes**. Each scene has its own sidebar card with **Start**, **Reset** and **Speed** (1×, 2×, 10×), plus a live status list.

**Factory controls**

| Action | How |
|---|---|
| Inspect a station | Hover a station (label lifts, floor brackets appear), then click it or its label |
| Back to the full line | **Factory overview** button (top left), **Esc**, or click the factory title |
| Hide or show the floating UI | **Hide UI / Show UI** button (bottom right) or **H** |
| Run / reset production | Sidebar **Start** / **Reset**; one run produces one finished pallet |

---

## 2. File structure

```
src/station/
├── common/
│   └── StepSequencer.js          Timed step queue used by Station 2 and the factory transfers
│
├── station-1/                    STATION 1: oil filling & capping (all procedural)
│   ├── OilFillingDefinition.js   Dimensions, positions, timings, states (IDLE/FILLING/TRANSPORTING/CAPPING/OUTPUT), speeds
│   ├── OilFillingStation.js      Builds the hierarchy; scene controller (show/hide/update, env map, panel refresh)
│   ├── OilFillingCycle.js        Process controller: indexed conveyor, fill, cap, discharge
│   ├── OilGeometry.js            Shared helpers: bevelled boxes, cylinders, pipe runs, canvas textures, quintic ease
│   ├── OilMaterials.js           PBR material library (stainless, HDPE, oil, belt texture, labels, lamps)
│   ├── OilConveyor.js            Belt conveyor (drums, rollers, legs, side guides, gear motor) + tunnel hood
│   ├── FillingMachine.js         Portal frame, actuator, FillingHead with Nozzle_01..04, oil streams, stack light
│   ├── CappingMachine.js         Servo capper: CappingHead, 4 chucks, cap feeder bowl
│   ├── OilTank.js                Stainless tank (sight glass, manway) + transfer pump
│   ├── OilHoses.js               Rigid piping + flexible hoses that follow the moving filling head
│   ├── OilSensors.js             Photo-eyes with status LEDs + tank level transmitter
│   ├── JerryCan.js               HDPE jerry can factory (translucent body, oil volume, handle, neck) + cap factory
│   ├── ControlPanel.js           Pedestal HMI with a live canvas screen and E-stop
│   └── StationBase.js            Floor slab, safety-yellow markings, rear guard fence
│
├── station-2/                    STATION 2: jerry can case packing
│   ├── CasePackingDefinition.js  Reuses Station 3's box size; packable can; layout; states; timings
│   ├── CasePackingStation.js     Builds the hierarchy; scene controller
│   ├── CasePackingCycle.js       EMPTY → JERRYCANS_ARRIVE → PICK_4_CANS → PLACE_INTO_BOX → BOX_COMPLETED → OUTPUT
│   ├── CardboardCase.js          Open-top carton with foldable flaps and tape, materials taken from Station 3's box
│   ├── PickAndPlaceRobot.js      Cartesian gantry, 2×2 handle grippers, servo pitch change
│   └── PackingLineEquipment.js   Two-lane input conveyor, end stop, carton conveyors, swing box stop, case taper
│
├── station-3/                    STATION 3: ABB palletizing + wrapping (original station, moved here)
│   ├── StationDefinition.js      Layout: conveyor, box (0.62 × 0.42 × 0.42 m), 3×3×3 stack, pallet, wrapper, worker
│   ├── StationScene.js           Builds the cell around the ABB robot asset
│   ├── StationCycle.js           Robot pick/place cycle, outbound pallet transfer, wrapping
│   ├── AssetWrapMachine.js       Wrapping machine from Wrapping.STEP + spiral stretch film
│   ├── ProceduralBox.js          Cardboard box (also the source of the carton look in Station 2)
│   ├── ProceduralBoxSourceMachine.js, ProceduralConveyor.js, ProceduralPallet.js, ProceduralWorker.js
│
└── factory/                      UNIFIED FACTORY
    ├── FactoryLayout.js          World layout: station offsets, transfer geometry, queue slots, supply racks
    ├── LubricantFactory.js       Orchestrator: builds all stations, hooks handovers, back-pressure, status
    ├── TransferLines.js          S1→S2 can transfer (single-file guides, lane pushers, divider), S2→S3 case transfer, infeed port, floor bay
    ├── SupplyRack.js             Instanced stock (cans, cartons), pallet-rack frame, sign boards
    ├── FactoryOverlay.js         Floating title/KPIs, station labels, click-to-inspect camera, Hide UI
    └── factoryOverlay.css        Overlay styles (app tokens, single accent)
```

App wiring lives in `src/main.js` (scene open/close, sidebar cards, render loop), `src/ui/AssetSelectionPanel.js` (Scenes menu) and `index.html` (sidebar cards).

---

## 3. What was done, in order

### 3.1 Station 3: pallet transfer and wrapping fix

**Problems:** after the worker set the pallet down, the pallet-jack forks stayed inside the pallet. The "wrap" was a rectangular shell that simply grew taller, rather than film going round the stack.

**Pallet release** (`station-3/StationCycle.js`). New steps follow `JACK_LOWER`:

| Step | What happens |
|---|---|
| `JACK_RELEASE` | The pallet is seated exactly on the turntable centre, and the forks drop clear of the deck boards. |
| `WORKER_WITHDRAW` | The worker backs out until the fork tips are 0.6 m past the pallet edge. The distance is measured from the fork and pallet bounds. |
| `JACK_STOW` | The forks lower to travel height. A check confirms they no longer intersect the pallet, and only then does wrapping start. |

**Spiral film** (`station-3/AssetWrapMachine.js`)
- A single ribbon is generated along the stack's exact rectangular outline. The corners are hit exactly, so the film is never oval.
- It makes 1.5 turns at the stack bottom, rises at a pitch smaller than the band height so passes overlap with no gaps, then makes 1.5 turns at the top.
- The ribbon is revealed with a draw range, and a moving "leading edge" marks where film is being applied.
- The film carriage, turntable and rolls stay in sync with the film.
- Durations were added to `StationDefinition.js`: release, stow, and a 12 s wrap.

### 3.2 Station 1: Oil Filling & Capping

This is a standalone procedural production cell with no external models.

**Process.** The line is indexed in batches of 4 cans. Each machine cycle runs the following phases in order, skipping any phase with nothing to do:

```
TRANSPORTING (index 1.6 m) → OUTPUT (outfeed discharge) → FILLING → CAPPING
```

- **Filling:** the head descends and the valves open. The oil jet falls under gravity, then the fill runs in two stages: a fast bulk fill and a slow top-off. When the valves close, the jet's tail drops away, and the head retracts.
- **Capping:** the head descends to the thread start and the spindles tighten the caps (3 turns while descending by the thread lead). The caps are handed to the cans and the chucks are fed new caps.
- **Tank:** the tank level drops per batch and refills automatically.

**Visual details**
- **Machines and piping:** PBR stainless materials with bevelled edges, a translucent HDPE can body that shows the rising oil, and flexible hoses that follow the head.
- **Equipment and indicators:** photo-eyes with LEDs, a stack light, and an HMI with a live canvas screen.
- **Safety and site:** guards, a floor slab, yellow markings and a rear fence.

### 3.3 Station 2: Jerry Can Case Packing

- **Carton:** it imports `STATION_DEFINITION.box` (0.62 × 0.42 × 0.42 m), so the size is identical to Station 3. The cardboard and tape materials are taken directly from Station 3's `createProceduralBox`, so the look is identical too.
- **Can size:** Station 1's 20 L can is 0.425 m tall and doesn't fit. Station 2 uses the same can model with a 0.33 m body (0.40 m overall), which fits upright in a 2×2 layout with 9 mm to spare under the flaps.

**Process**
1. **Arrival:** cans arrive in two lanes and bank up against an end stop in a 2×2 block. They ease to a stop using a smooth-minimum blend, so nothing snaps. The open carton arrives against a swing-arm stop.
2. **Pick and place:** the gantry grippers hook under the can handles and lift all four cans above the open flaps. During transfer the grippers narrow the gap between rows from conveyor spacing (0.26 m) to carton spacing (0.20 m). The cans are lowered into the carton and released.
3. **Close and tape:** the end flaps fold while the robot returns, then the side flaps fold. The case taper lays tape from the leading edge back as the carton passes under it.

### 3.4 Rename

"Station" was renamed **Station 3** in the menu and on its card. Its behavior is unchanged.

### 3.5 Unified Factory scene

The three stations are **reused unmodified**: their own builders and cycles are instantiated by `LubricantFactory`. Integration is done only through **instance-level hooks** on those objects:

| Hook | Purpose |
|---|---|
| Station 1 `createCan` / `spawnBatch` | New cans come out of the jerry-can rack (108 cans = one pallet) |
| Station 1 `planNextPhase` | Back-pressure: a new machine cycle only starts when the transfer can accept its output |
| Station 1 discharge step `onEnd` | The discharged cans are **re-parented into the transfer** (same objects, same world position) instead of deleted |
| Station 2 `spawnCans` | Station 2's arrival adopts the staged cans from Station 1 instead of creating new ones |
| Station 2 `planCycle` | Waits for staged cans and for free space on the case transfer |
| Station 2 `parts.createCase` | Cartons come out of the carton rack |
| Station 2 discharge step `onEnd` | The taped case is handed to the S2→S3 transfer (same object) |
| Station 3 `boxFactory` / `createBoxAtInput` | Station 3 only receives boxes that Station 2 actually delivered |

**Single file → two lanes** (`TransferLines.js`, `LubricantFactory.planCanTransfer`):
1. Single-file guides bring the first pair of cans in front of pusher A, which pushes them into lane 1.
2. The belt advances one pair, and pusher B pushes the second pair into lane 2.
3. Both lanes accumulate against a metering point inside Station 2's infeed tunnel, which is exactly where Station 2 expects its cans to start.

**Station 2 → Station 3**
- The case travels on a transfer belt into a port on the back of Station 3's box-source cabinet.
- It waits in a hidden buffer inside the cabinet, stepping down 28 mm to Station 3's belt height on the way.
- When Station 3 asks for its next box, the case exits at exactly Station 3's input position, so there's no jump.

**Supply and believability**
- Racks hold empty jerry cans and empty cartons. They use instanced meshes, so 108 cans cost only a dozen draw calls, and the visible stock decreases as items are used.
- Tunnels that products now pass through become open-ended hoods.
- Station 3's worker starts from a marked pallet-jack bay.

A run ends with **FINISHED PALLET**: 108 cans, 27 cases, one wrapped 3×3×3 pallet. Pressing **Start** again resets and restarts.

### 3.6 Factory UI overlay

`FactoryOverlay.js` and `factoryOverlay.css` only add UI; they make no production or geometry changes.

**Removed signs:** the station-name signs were removed. Only the **Raw Materials** and **Carton Supply** boards remain.

**Factory title and KPIs**
- The title "Lubricant Line 01" floats above the line. On hover it lifts and an accent underline grows; clicking it returns to the overview.
- Four KPI cards sit under it, labelled "Sample data": Production output, Efficiency, OEE and Completed boxes.

**Station labels**
- Each station has a floating label with a leader line to the station.
- **Hover:** the label lifts, its number badge fills, a description and "Inspect station" are revealed, and accent corner brackets fade in on the floor.
- **Click:** the camera flies in over 1.15 s with an ease-in-out, and a focus panel appears. The panel shows a **live** state line from the simulation plus four mock KPIs.

**Navigation and visibility**
- Back to the overview: button, **Esc**, or the title.
- **Hide UI / Show UI** (button or **H**) hides every floating element. The 3D scene and production are untouched.

**Design rules**
- **Tokens:** the app's existing dark tokens and a single teal accent (`--accent`).
- **Shape:** 10px radius on surfaces and 8px on controls.
- **Numbers:** tabular numerals.
- **Motion:** transform/opacity only, with `prefers-reduced-motion` support.
- **Layout:** labels are clamped inside the viewport, and the title moves up if it would cover a station label.

### 3.7 Folder restructure

- The Station 3 files moved from `src/station/` into `src/station/station-3/`.
- `oil/` was renamed `station-1/`, and `packing/` was renamed `station-2/`.
- Moves used `git mv`, so history is kept. All relative imports were rewritten by a script, and the path in `docs/IK_PLAN.md` was updated.

---

## 4. Shared techniques

- **Definition-driven layout.** Every station has a `*Definition.js` file holding all dimensions, positions and timings. Builders and cycles read from it, so changing a can size or a timing propagates everywhere. For example, the factory runs Station 1 on the packable can just by passing a different definition.
- **Named hierarchy.** Major parts are separate named groups, so animation and future tooling can address them, e.g. `FillingMachine › FillingHead › Nozzle_01`, `PickAndPlaceRobot › VerticalAxis › GripperHead › Gripper_01`, `CardboardCase › Flaps`.
- **Step sequencing.** Processes are queues of timed steps (state, label, duration, `onStart` / `onUpdate` / `onEnd`):
  - Each frame consumes scaled time across as many steps as it covers, so **10× speed never skips callbacks**.
  - Positions are always computed from absolute start/end values, so speed changes never cause drift or teleporting.
- **Motion profiles.**
  - Quintic "smoother" ease for machine axes.
  - Ramped and trapezoidal belt profiles for conveyors.
  - A polynomial smooth-minimum for accumulating products against stops.
  - Belt textures, drums and rollers advance by the same distance as the products on them.
- **Handover without duplicates.** A product's world matrix is captured before a station releases it, then re-parented into the next owner at the identical world transform. Objects keep their identity from the rack to the pallet.
- **Back-pressure instead of delays.** Upstream stations hold at their cycle boundary with a short "Holding · …" step until downstream can accept. There are no arbitrary timers.

---

## 5. Verification

Automated checks were run headlessly in Node against the real station code. A canvas stub stands in for the browser, and loader hooks stub the Vite-only `?url` / `?raw` imports.

| Check | Result |
|---|---|
| **Station 1:** cans stay on the belt centre line and never overlap; the conveyor never moves with a head down; nozzles and chucks align with the necks; every output can is full and capped (1× and 10×) | 0 errors over 63 machine cycles, 240 cans |
| **Station 2:** carton is exactly 0.62 × 0.42 × 0.42; cans never overlap or cut the carton walls or open flaps; grip/release happen only at pick/place height; no frame-to-frame jumps; every delivered carton has 4 cans, closed flaps and full tape | 0 errors, 25 cartons |
| **Factory:** cans traced from Station 1 to the cartons Station 3 receives; no duplicate objects; no overlaps on the transfers or at the pushers; no jumps at the handovers; exact Station 3 hand-over position and height | 0 errors: 108 cans → 27 cases → finished pallet, then idle |

Station 3 cannot run in Node: it needs the ABB robot model and the wrapping STEP file. So in the factory test it was replaced by a stand-in cycle that calls the real `StationCycle.prototype.createBoxAtInput`. **The rendered visuals and the real Station 3 robot inside the Factory were not checked in a browser by the assistant.** Check them with `npm run dev`.

---

## 6. Known decisions and limitations

- **Can size in the Factory:** the Factory runs Station 1 on the packable 0.33 m-body can. Station 3's 0.42 m carton cannot hold the original 0.425 m can. The standalone Station 1 keeps its original can.
- **Station 3 stays at the world origin** in the Factory, because its cycle mixes station-local and world coordinates (IK targets, placement checks). Stations 1 and 2 are placed upstream along −X.
- **Pallet not rotated during wrapping:** in Station 3 the film travels around a stationary stack, so the pallet doesn't turn with the turntable.
- **KPIs are mock data:** they're labelled "Sample data" in the UI and kept mutually consistent. Only the "Live" line in a station's focus panel comes from the simulation.
- **Folder naming:** the folders are named `station-1` / `station-2` / `station-3`, with hyphens, so import paths contain no spaces.

---

## 7. Extending this as a template

1. **Station files:** copy a station folder's pattern. That means a `*Definition.js`, a builder that names every major part, a `*Cycle.js` built on `common/StepSequencer.js`, and a `*Station.js` controller with `show` / `hide` / `update` / `startCycle` / `resetCycle` / `setCycleSpeed`.
2. **Reuse:** use the shared geometry, materials and equipment (`station-1/OilGeometry.js`, `OilMaterials.js`, `OilConveyor.js`, `OilSensors.js`, `ControlPanel.js`, `StationBase.js`) to keep the visual language consistent.
3. **Factory chain:** to add a station to the Factory, give it a product source hook (like `createCan`) and a discharge step. Then add the handover and back-pressure rules in `LubricantFactory.js`, and the station's label and KPIs in `FactoryOverlay.js`.
