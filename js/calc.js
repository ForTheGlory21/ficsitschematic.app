// Production calculator: "I want X per minute of Y". Works demand back through the chosen recipes to raw
// resources and reports machines (exact clocks), power, raw resources, byproducts and build cost.
// Recipes are chosen per item (default: the best unlocked standard recipe); any item can be marked as an input
// supplied from elsewhere. Handles byproducts and recipe loops (e.g. recycled rubber/plastic). DOM-free.
(function (SF) {
  const D = SF.D;
  const PURITY = [{ k: 0.5, name: 'Impure' }, { k: 1, name: 'Normal' }, { k: 2, name: 'Pure' }];
  const PREFER = {
    Desc_IronIngot_C: 'Recipe_IngotIron_C', Desc_CopperIngot_C: 'Recipe_IngotCopper_C', Desc_SteelIngot_C: 'Recipe_IngotSteel_C',
    Desc_Plastic_C: 'Recipe_Plastic_C', Desc_Rubber_C: 'Recipe_Rubber_C', Desc_Concrete_C: 'Recipe_Concrete_C',
    Desc_CateriumIngot_C: 'Recipe_IngotCaterium_C', Desc_QuartzCrystal_C: 'Recipe_QuartzCrystal_C',
  };
  const SKIP_MACHINE = new Set(['Build_Converter_C']);           // matter conversion turns anything into anything

  // extractors per raw resource
  const EXTRACT = {};
  for (const [id, b] of Object.entries(D.buildings)) for (const r of b.resources || []) (EXTRACT[r] ||= []).push(id);
  const isRaw = item => !!EXTRACT[item];

  // recipes that make an item (event recipes and matter conversion left out)
  const makers = {};
  for (const [rid, r] of Object.entries(D.recipes)) {
    if (r.event || SKIP_MACHINE.has(r.machine) || !SF.defs[r.machine]) continue;
    for (const [it] of r.out) (makers[it] ||= []).push(rid);
  }
  const recipesFor = (item) => (makers[item] || []).slice().sort((a, b) => {
    const A = D.recipes[a], B = D.recipes[b];
    return (A.alt - B.alt) || ((A.out[0][0] !== item) - (B.out[0][0] !== item)) || A.name.localeCompare(B.name);
  });
  function defaultRecipe(item) {
    const list = recipesFor(item);
    if (!list.length) return null;
    const ok = list.filter(SF.recipeUnlocked);
    if (PREFER[item] && ok.includes(PREFER[item])) return PREFER[item];
    // standard recipes whose main product is this item, fewest ingredients first
    const pick = arr => arr.slice().sort((a, b) => (D.recipes[a].alt - D.recipes[b].alt) || ((D.recipes[a].out[0][0] !== item) - (D.recipes[b].out[0][0] !== item))
      || D.recipes[a].in.length - D.recipes[b].in.length)[0];
    return pick(ok.length ? ok : list.filter(r => !D.recipes[r].alt).length ? list.filter(r => !D.recipes[r].alt) : list);
  }

  // ------------------------------------------------------------ solve
  // targets: [{item, rate}], opts: { recipes: {item: rid}, inputs: [item] (supplied from elsewhere) }
  function solve(targets, opts = {}) {
    const choose = item => (opts.recipes && opts.recipes[item] && D.recipes[opts.recipes[item]] ? opts.recipes[item] : defaultRecipe(item));
    const inputs = new Set(opts.inputs || []);
    const need = new Map();
    const add = (it, v) => need.set(it, (need.get(it) || 0) + v);
    for (const t of targets) if (t.item && t.rate > 0) add(t.item, t.rate);
    const crafts = new Map();                    // rid -> crafts/min
    const forItem = new Map();                   // rid -> the item it was chosen for
    const depth = new Map();
    // consumers before producers: order items by their longest distance from a target
    const order = () => {
      depth.clear();
      const visit = (it, d, path) => {
        if (path.has(it) || (depth.get(it) ?? -1) >= d) return;
        depth.set(it, d);
        if (inputs.has(it) || isRaw(it)) return;
        const rid = choose(it); if (!rid) return;
        path.add(it);
        for (const [i] of D.recipes[rid].in) visit(i, d + 1, path);
        path.delete(it);
      };
      for (const t of targets) if (t.item) visit(t.item, 0, new Set());
      return [...need.keys()].sort((a, b) => (depth.get(a) ?? 99) - (depth.get(b) ?? 99));
    };
    let loops = 0;
    for (let pass = 0; pass < 400; pass++) {
      let moved = false;
      for (const it of order()) {
        const v = need.get(it);
        if (!(v > 1e-9) || inputs.has(it) || isRaw(it)) continue;
        const rid = choose(it);
        if (!rid) continue;                       // nothing makes it: reported as an input
        const r = D.recipes[rid];
        const c = v / r.out.find(o => o[0] === it)[1];
        crafts.set(rid, (crafts.get(rid) || 0) + c);
        if (!forItem.has(rid)) forItem.set(rid, it);
        for (const [o, a] of r.out) add(o, -a * c);
        for (const [i, a] of r.in) add(i, a * c);
        moved = true;
      }
      if (!moved) break;
      loops = pass;
    }
    // what is left over
    const raw = {}, imports = {}, surplus = {};
    for (const [it, v] of need) {
      if (v > 1e-6) { if (isRaw(it) && !inputs.has(it)) raw[it] = v; else imports[it] = v; }
      else if (v < -1e-6) surplus[it] = -v;
    }
    // machines
    const steps = [...crafts].filter(([, c]) => c > 1e-9).map(([rid, c]) => {
      const r = D.recipes[rid], d = SF.defs[r.machine];
      const per = 60 / r.time;                   // crafts per minute per machine at 100 %
      const machines = c / per;
      const n = Math.max(1, Math.ceil(machines - 1e-6));
      const clock = machines / n;
      const item = forItem.get(rid);
      const power = n * SF.machinePower({ clock, sloops: 0, recipe: rid }, d);
      return {
        rid, item, def: r.machine, crafts: c, machines, n, clock, power, depth: depth.get(item) ?? 0,
        rate: c * r.out.find(o => o[0] === item)[1],
        ins: r.in.map(([i, a]) => [i, a * c]), outs: r.out.map(([i, a]) => [i, a * c]),
        locked: !SF.recipeUnlocked(rid),
      };
    }).sort((a, b) => a.depth - b.depth || SF.itemName(a.item).localeCompare(SF.itemName(b.item)));
    const totals = { machines: {}, power: 0, cost: {}, count: 0 };
    for (const s of steps) {
      totals.machines[s.def] = (totals.machines[s.def] || 0) + s.n;
      totals.count += s.n;
      totals.power += s.power;
      for (const [i, a] of SF.defs[s.def].raw.cost || []) totals.cost[i] = (totals.cost[i] || 0) + a * s.n;
    }
    return { steps, raw, imports, surplus, totals, choose, converged: loops < 399 };
  }

  // ------------------------------------------------------------ extraction: how many nodes for a raw resource
  // best unlocked extractor for each purity, at 100 % and at the 250 % overclock
  function extractOptions(item, rate) {
    const ids = (EXTRACT[item] || []).filter(id => SF.defs[id] && id !== 'Build_FrackingSmasher_C');
    if (!ids.length) return [];
    const ok = ids.filter(SF.buildingUnlocked);
    const pool = ok.length ? ok : ids;
    const best = pool.slice().sort((a, b) => D.buildings[b].rate - D.buildings[a].rate)[0];
    const b = D.buildings[best];
    const purities = b.purity ? PURITY : [{ k: 1, name: '' }];
    return purities.map(p => {
      const each = b.rate * p.k;
      return { def: best, purity: p.k, name: p.name, each, nodes: Math.ceil(rate / each - 1e-9), nodesOC: Math.ceil(rate / (each * 2.5) - 1e-9), locked: !ok.length };
    });
  }

  // ------------------------------------------------------------ raw resource budget of the current plan
  // what the extractors on the plan can mine vs what its machines and generators want at their clock speeds
  function rawBudget() {
    const S = SF.state, rows = {};
    const row = it => (rows[it] ||= { item: it, supply: 0, external: 0, want: 0, extractors: 0 });
    for (const e of S.entities.values()) {
      const d = SF.defs[e.def], b = d.raw;
      if (d.kind === 'extractor' && e.resource && b && b.rate) {
        const r = row(e.resource); r.supply += b.rate * (b.purity ? (e.purity ?? 1) : 1) * (e.clock ?? 1); r.extractors++;
      } else if (d.kind === 'source' && e.item && isRaw(e.item)) row(e.item).external += e.rate || 0;
      else if (d.kind === 'machine' && e.recipe && D.recipes[e.recipe]) {
        const r = D.recipes[e.recipe], k = 60 / r.time * (e.clock ?? 1);
        for (const [i, a] of r.in) if (isRaw(i)) row(i).want += a * k;
      } else if (d.kind === 'generator' && b && b.fuels && e.fuel) {
        const f = b.fuels.find(x => x.fuel === e.fuel); if (!f) continue;
        const P = b.produce * (e.clock ?? 1);
        if (isRaw(f.fuel)) row(f.fuel).want += P / (SF.item(f.fuel).energy || 1) * 60;
        if (f.supp && isRaw(f.supp)) row(f.supp).want += P * b.suppRatio / 1000 * 60;
      }
    }
    return Object.values(rows).map(r => ({ ...r, short: r.want - r.supply - r.external }))
      .sort((a, b) => SF.itemName(a.item).localeCompare(SF.itemName(b.item)));
  }

  SF.calc = { solve, rawBudget, recipesFor, defaultRecipe, isRaw, extractOptions, extractorsFor: item => EXTRACT[item] || [] };
})(window.SF);
