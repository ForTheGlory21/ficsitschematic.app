# How it works

A guide for anyone who wants to change or add things. The whole app is plain JavaScript in
`web/js/`, with no framework, no bundler and no build step. Edit a file and reload the page.

- [The big picture](#the-big-picture)
- [Files, in load order](#files-in-load-order)
- [The document model](#the-document-model)
- [Change flow](#change-flow-how-an-edit-reaches-the-screen)
- [The two simulators](#the-two-simulators)
- [Drawing: 2D and 3D](#drawing-2d-and-3d)
- [The interface](#the-interface)
- [The data pipeline](#the-data-pipeline)
- [Common tasks](#common-tasks)
- [Conventions](#conventions)
- [Tests](#tests)

## The big picture

```
 game files ──tools/──▶ web/data.js ─┐
                                     ├─▶ defs.js ─▶ model.js (the plan) ──▶ sim.js / livesim.js (rates)
 web/models_cubes, model_meta.js ────┘                │                         │
                                                      ▼                         ▼
                                      render.js (2D) / view3d.js (3D)  ◀── results ──▶ ui.js panels
                                                      ▲
                                    editor.js (mouse + keys) changes the plan
```

- Every script adds to one global namespace, `window.SF`. Each file is wrapped in
  `(function (SF) { ... })(window.SF);` and exposes what others need as `SF.something`.
- The open plan lives in `SF.state` (see below).
- Any change goes through `SF.changed()`. That records undo history, autosaves, and tells everything
  else (simulator, panels, 3D) to update.
- The simulators read `SF.state` and publish `SF.sim.result`. The panels and both views read that result.

## Files, in load order

The order is set by the `<script>` tags in `web/index.html`, and it matters: a file can only use
what earlier files defined, at load time. At run time (inside functions), anything goes.

| File | What it does |
|---|---|
| `data.js` | **Generated.** `window.SF_DATA`: items, recipes, buildings (footprints, ports, power, costs), belts, pipes, structures, and unlock schematics. |
| `icons.js`, `img/` | **Generated.** Icon file per item/building id. |
| `models_cubes/index.js` | **Generated.** `window.SF_CUBES`: which models have a cube (voxel) version and where its file is. |
| `model_meta.js` | **Generated.** `SF_MODELS`: model bounds and belt-height profiles (used to line belt ports up with buildings). `SF_STRUCT`: structure id → cube model + colour tint. |
| `js/defs.js` | Turns `SF_DATA` into `SF.defs`: one definition per placeable thing, with its kind, size and **ports** (where belts/pipes connect). Adds the planner-only parts: poles, lifts, external inputs/outputs, labels, zones. Also power maths (`SF.machinePower`). |
| `js/model.js` | **The document.** `SF.state`, adding/removing entities and links, belt routing (`SF.routePath`), the game's belt rules, floors, conveyor lifts, head lift for pipes, undo/redo, copy/paste, autosave hook, share links. |
| `js/store.js` | Saved factories in IndexedDB (`SF.store`), with a localStorage fallback. |
| `js/progress.js` | Game progress: which recipes, buildings and belt tiers are unlocked (`SF.recipeUnlocked`, …). |
| `js/calc.js` | The production calculator (`SF.calc.solve`), and the raw resource budget. |
| `js/sim.js` | **Free run**: the steady-state simulator (`SF.sim`). |
| `js/livesim.js` | **Sim mode**: item-by-item real-time simulation (`SF.live`). |
| `js/render.js` | The 2D canvas view: grid, structures, buildings, belts with moving items, ports, overlays, the minimap and PNG export. |
| `js/editor.js` | Mouse and keyboard in 2D: tools (select, belt, pipe, delete, place), dragging, box select, belt drawing with poles, shortcuts. `SF.ed` is the editor state, `SF.sel` the selection. |
| `js/example.js` | Built-in factories: the example factory and the 3-storey building. |
| `js/scenarios.js` | The five generated stress-test factories, and the layout engine behind the planner's "Build it" (`SF.placePlan`). |
| `js/ui.js` | The panels: build palette, toolbar, floors, inspector, factory summary, issues, sim controls, menus. |
| `js/planner.js` | The Planner tab, the Game progress dialog, and the share-link box. |
| `js/home.js` | The home screen: saved factories, examples, settings. Autosaves the open factory. |
| `vendor/three.min.js` | three.js r149, used only by the 3D view. |
| `js/view3d.js` | The 3D view (`SF.view3d`): instanced cube models, belts as coloured boxes, items, picking, building in 3D. |
| `js/main.js` | Boot (home screen or a shared link) and the animation loop. |

## The document model

```js
SF.state = {
  entities: Map(id -> entity),     // everything placed
  links:    Map(id -> link),       // belts, pipes, lifts
  portLinks: Map('entId:port' -> link),   // index: which link uses a port (rebuilt by SF.changed)
  levels: [{ name, z, hidden }],   // floors; z = height in metres
  level: 0,                        // the floor being edited
  version: 0,                      // bumps on every change; caches compare against it
  settings: { ... },               // view/behaviour options (saved per browser)
}
```

**Entity** (a building, pole, structure, label…):

```js
{ id, def: 'Build_ConstructorMk1_C', x, y, rot /*0-3, quarter turns*/, level,
  recipe, clock /*1 = 100 %*/, sloops,            // machines
  resource, purity,                               // extractors
  dz,                                             // structures: raised above the floor (stacked walls)
  h, ang,                                         // poles: height, facing
  pair, liftH, liftDown, ph,                      // conveyor lift ends
  name, text, color, ... }
```

Positions are in **metres**, x right and y down (2D screen convention), with the entity centred
on (x, y). A definition's ports are in the building's own frame at `rot = 0`; `SF.portWorld(e, i)`
gives a port's world position and facing.

**Link** (belt, pipe or lift):

```js
{ id, kind: 'belt' | 'pipe' | 'lift', tier, from: [entId, port], to: [entId, port],
  pts: [...bend points], route: 'curve' | 'ortho' | 'straight' }
```

The path a link actually takes is computed by `SF.linkPath` / `SF.linkPath3D` (cached per link).
`SF.linkProblems(l)` lists anything the game wouldn't allow: turns too tight, too steep, too long,
lifts out of range, too little head lift.

## Change flow: how an edit reaches the screen

1. Code changes `SF.state` (e.g. `e.recipe = 'Recipe_IronRod_C'`, or `SF.addEntity(...)`).
2. It calls **`SF.changed()`**. This bumps `S.version`, re-indexes ports, fixes up lifts, pushes an undo
   step, schedules the autosave (`SF.autosave` in home.js), and calls every `SF.onChange` listener.
3. Listeners: `ui.js` re-renders the panels and asks for a new simulation (`SF.sim.request()`). The 2D
   view redraws every frame anyway, and the 3D view rebuilds what changed.
4. When the simulation finishes, `SF.sim.onResult` listeners update the readouts.

For fast, continuous edits (dragging, sliders) use **`SF.touch()`**. It bumps the version and redraws
without an undo step. Then call `SF.changed()` once when the drag ends.

## The two simulators

Both publish the same result shape in `SF.sim.result`, so every readout works with either:

```js
{ nodes: Map(entId -> { status, eff, ins: {item: perMin}, outs: {...}, maxIn, maxOut, power, ... }),
  edges: Map(linkId -> { total, cap, util, flows: {item: perMin}, jam, ... }),
  summary: { powerUse, powerGen, balance: {item: {prod, cons}}, external: {in, out}, sinkPoints } }
```

**Free run (`sim.js`)** is a time-stepped *flow* model. Every building and belt has a small buffer,
and the factory is stepped until it settles. It warms up for 2,400 steps, then measures in 600-step
windows until two windows agree. It handles back-pressure, starvation, splitter balancing,
smart-splitter filters, overflow and loops. Each building kind has a `make…` function (`makeMachine`,
`makeExtractor`, `makeGenerator`, `makePass` for splitters, mergers and storage, …) with
`init` / `pull` / `process` / `push` steps. It runs in short time slices so the page stays responsive;
`SF.sim.runSync()` runs it in one go (used by the tests).

**Sim mode (`livesim.js`)** moves *individual items*:
- belts carry items at their real speed, 1.2 m apart;
- machines run real crafting cycles with one-stack input and output slots;
- storage fills real slots.

Rates are measured from item timings. Each stream's repeating pattern is found, so a steady belt
reads its exact rate quickly. `SF.live.skipTo(seconds)` fast-forwards. Editing while it runs keeps
the contents of untouched parts.

## Drawing: 2D and 3D

**2D (`render.js`)** draws on one canvas each frame: the grid, other floors as ghosts, structures,
belts (with moving items), buildings with icons and status colours, ports, then selection and
overlays. Belt paths are cached per link (`linkScreenPath`); far zoom levels draw simplified versions.

**3D (`view3d.js`)** builds a three.js scene from the plan:
- **Buildings and structures** use the voxel models from `models_cubes/`. They're loaded on demand
  through `<script>` tags, so it works from `file://` too. Identical models are drawn as one
  `InstancedMesh`, so thousands of foundations cost a handful of draw calls.
- **Belts and pipes** are instanced boxes, coloured by belt tier (`SIMPLE_TIER`) or by the fluid inside.
- **Rebuilds:** the scene rebuilds when the plan's version, the floor or the visibility changes. In Sim
  mode only the moving items update each frame.

## The interface

- **`ui.js`** owns the main panels. `renderInspector()` picks a layout for what's selected: a building,
  a belt, a lift, or several things. Rarely used settings go in folded sections (the `fold()` helper),
  which remember being opened.
- **`planner.js`**: the Planner tab calls `SF.calc.solve(targets, {recipes, inputs})` and lists the
  steps. "Build it" calls `SF.placePlan` (in scenarios.js), which lays out machine groups with splitter
  and merger manifolds.
- **`home.js`**: the start screen. Each factory is one record in `SF.store`:
  `{ id, name, created, updated, objects, machines, floors, thumb, doc }`. `doc` is `SF.serialize()`.
  `SF.home.openBuilt(name, buildFn)` turns any builder function into a new saved factory.
- **Settings** live in `SF.state.settings` and are saved per browser (`SF.saveSettings()`).

## The data pipeline

The site never reads game files at run time. The `tools/` scripts turn them into the generated files
in `web/`. You only need these after a game update. They need Python 3 with numpy and Pillow, a local
Satisfactory install, and (for models) an FModel export of the game's meshes and Blender 5.

| Step | Command | Produces |
|---|---|---|
| Game data | `python tools/extract.py "<Satisfactory install>"` | `web/data.js` (from `CommunityResources/Docs/en-US.json`) |
| Icons | `python tools/scrape_icons.py` | `web/img/`, `web/icons.js` |
| Mesh conversion | `python tools/convert_models.py "<FModel export>/…/Buildable/Factory"` (`--structures` for walls etc.) | `_game_models/` (not published) and `web/model_meta.js` |
| Reference models | `python tools/painted_glb.py`, `python tools/structures_to_custom.py` | coloured references in `Custom/` (not published) |
| Voxel models | `blender -b -P tools/cubify.py -- "Custom" --force` | `Custom/**/* - cubes.glb` |
| Put them on the site | `python tools/cubes_to_web.py` | `web/models_cubes/` |

`Custom/manifest.json` lists every model folder: which planner ids it is used for, and its voxel
size (`"voxel"`). To rebuild one model with a different look, edit or replace its `- cubes.glb` in
Blender, then run `cubes_to_web.py` again.

## Common tasks

**Add a setting**
1. Give it a default in `SF.state.settings` (model.js).
2. Add a toggle to the View menu in `index.html` with `data-set="yourSetting"`. ui.js wires these
   automatically.
3. Optionally add it to `TOGGLES` in home.js, so it also appears in the home screen's Settings.

**Add a building kind or change its connectors**
- Ports come from `defs.js`. Find the `switch (b.kind)` and set `d.ports`.
- A port is `{ x, y, dx, dy, io: 'in'|'out'|'any', fluid, label }`: position from the centre, and the
  direction it faces.
- Then teach both simulators what it does:
  - add a `case` in `makeNode` in sim.js;
  - add a matching case in livesim.js.

**Add a planner-only part** (like the external input): add a `defs.X = {...}` next to `defs.V_Source`
in defs.js, with `virtual: true` so it doesn't count as a real building.

**Add a built-in example factory**
1. Write a builder like `SF.buildTower` in example.js. It uses `SF.load({...})`, `SF.addEntity`,
   `SF.addLink` and `SF.makeLift`, and finishes with `SF.changed()`.
2. Add it to `EXAMPLES()` in home.js.

**Change how something looks in 3D**: the `buildEntities()` loop in view3d.js handles each kind.
Cube models are looked up by planner id in `SF_CUBES`, or for structures through `SF_STRUCT`.

**Change a panel**: find its `…HTML()` function in ui.js / planner.js / home.js. They return HTML
strings; a matching `bind…()` function attaches the event handlers afterwards.

## Conventions

- **Cache busting:** every script and stylesheet in `index.html` has a `?v=N` query. Bump the number
  for any file you change, or browsers may keep running the old copy.
- **Units:** metres, items per minute (m³/min for fluids), clock as a fraction (1 = 100 %),
  angles in radians unless named `…Deg`.
- **Plans** are plain JSON (`SF.serialize()` / `SF.load(doc)`). Keep them backwards-compatible: older
  saves must still load, so new fields need sensible defaults.
- Code comments explain *why*, not what. Comments state game facts as they are, with the reason
  ("lifts are 4–48 m, like the game").

## Tests

```
node tools/test_sim.js
```

Runs the core scripts headless in Node, no browser needed. About 500 checks:
- every recipe produces its book rate;
- power, overclocking and somersloops;
- belt routing against the game's rules, across thousands of layouts;
- the simulator on the example factories, with Free run and Sim agreeing and no items created or lost;
- floors and lifts;
- the production planner, game progress and head lift.

Run it before sending changes.

`node tools/stress_sim.js` runs Sim mode on the five generated factories. It reports speed, time to
reach full rate, and accuracy against Free run.
