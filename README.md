# FICSIT Schematic Planner

An unofficial factory planner for **Satisfactory**, in your browser. Lay factories out at real
footprints in 2D, look at them in 3D, and run them: the planner works out every belt rate and
machine's efficiency, or simulates every item in real time.

**Live site:** https://ficsitschematic.app

> Unofficial fan-made tool, not affiliated with or endorsed by Coffee Stain Studios.
> Satisfactory and its game assets belong to Coffee Stain Studios.

## Features

- **Build like in game:** every production, extraction, power, logistics and storage building at
  its real footprint, plus foundations, walls, ramps, windows and railings. Belts Mk1–6 and pipes
  follow the game's rules: 2 m turns, 35° slopes and 56 m lengths, with poles, splitters, mergers
  and junctions.
- **Several floors:** floors at real heights, conveyor lifts (4–48 m) between them, and stacked walls.
- **Two ways to run a factory:**
  - **Free run** shows the steady state instantly: every belt rate, machine efficiency and the power use.
  - **Sim** runs real items and crafting cycles, with buffers filling from empty. It can skip ahead
    up to 24 hours.
- **Production planner:** say "10 reinforced plates per minute". It lists every machine, its clock
  speed, the power and the raw ore, then builds the whole line in one click. It handles alternate
  recipes, byproducts and recipe loops.
- **Game progress:** set your HUB tier, MAM research and found alternates. The planner and build menu
  then stick to what you have.
- **Fluids:** pipe throughput and head lift (pumps, extractors and buffers), as in the game.
- **Raw resource budget:** what your miners produce compared with what the factory needs, and how many
  more nodes you'd need.
- **Your factories:** a home screen with all your saved factories. They autosave in your browser.
  You can also export a factory to a file, or share it as a link.
- **3D view:** voxel ("cube") models, colour-coded belts, moving items, and hideable floors and walls.

## Run it locally

No build step and no dependencies. Serve the `web` folder with any static web server:

```
python -m http.server 8765 --directory web
```

Then open http://localhost:8765. Opening `web/index.html` directly also mostly works. Some browsers
limit saving for local files, though, so a server is better.

## Project layout

```
web/                  the website (this is what gets published)
  index.html          page + script load order
  css/style.css       all styles
  js/                 the app, plain JavaScript, no framework (see docs/HOW-IT-WORKS.md)
  data.js             game data: items, recipes, buildings, belts, unlocks   (generated)
  model_meta.js       building bounds + belt-height profiles (numbers only)   (generated)
  models_cubes/       voxel 3D models, one script per model                   (generated)
  img/, icons.js      item and building icons                                  (generated)
  vendor/three.min.js three.js r149 (MIT)
tools/                Python/Node scripts that generate the files above, plus the tests
docs/HOW-IT-WORKS.md  how the code fits together, for anyone who wants to change or add things
.github/workflows/    publishes web/ to GitHub Pages on every push to main
```

## Publishing

The live site is served by GitHub Pages from the `gh-pages` branch, which holds just the contents
of `web/` (Settings → Pages → Source: *Deploy from a branch*, `gh-pages`, `/ (root)`). To publish
your latest commit on `main`:

```
git push origin main
git push origin $(git subtree split --prefix web main):refs/heads/gh-pages --force
```

The second line copies `web/` into `gh-pages`. That branch is generated, so overwriting it is
expected. The site updates about a minute later. `.github/workflows/pages.yml` is an alternative
that uses GitHub Actions instead (run it by hand).

## Tests

```
node tools/test_sim.js       # ~500 checks: game maths, all 291 recipes, simulator, belt rules, planner, head lift
node tools/stress_sim.js     # Sim-mode stress test on the five generated test factories
```

## Updating game data (after a game patch)

These need a local Satisfactory install and are only for maintainers. Details are in
[docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md#the-data-pipeline).

```
python tools/extract.py "D:\SteamLibrary\steamapps\common\Satisfactory"   # -> web/data.js
```

## Contributing

Pull requests are welcome. Read [docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md) first. Run
`node tools/test_sim.js` before you send changes.

## License

The code is [MIT licensed](LICENSE): use it however you like, as long as you keep the copyright
notice (credit to Aidan Barry). Game content (icons, game data, models traced from the game) is
not covered by the license; it belongs to Coffee Stain Studios.
