// Stress-test factories: generated from a target product list. A planner works out every recipe back to raw
// resources (standard recipes), sizes machine groups with exact underclocks so each one should run at 100 %,
// and lays the result out as a tree: miners on the left, final products on the right. Each group has a splitter
// manifold per solid input, a junction chain per fluid input, a merger chain on its product and a sink for any
// byproduct. DOM-free so the headless stress tests can build the same factories.
(function (SF) {
  const S = SF.state, D = SF.D;

  const RAW = {
    Desc_OreIron_C: 'miner', Desc_OreCopper_C: 'miner', Desc_Stone_C: 'miner', Desc_Coal_C: 'miner', Desc_RawQuartz_C: 'miner',
    Desc_Sulfur_C: 'miner', Desc_OreGold_C: 'miner', Desc_OreBauxite_C: 'miner', Desc_OreUranium_C: 'miner', Desc_SAM_C: 'miner',
    Desc_LiquidOil_C: 'oil', Desc_Water_C: 'water',
  };
  const PREFER = {
    Desc_IronIngot_C: 'Recipe_IngotIron_C', Desc_CopperIngot_C: 'Recipe_IngotCopper_C', Desc_SteelIngot_C: 'Recipe_IngotSteel_C',
    Desc_Plastic_C: 'Recipe_Plastic_C', Desc_Rubber_C: 'Recipe_Rubber_C', Desc_Concrete_C: 'Recipe_Concrete_C',
    Desc_CateriumIngot_C: 'Recipe_IngotCaterium_C', Desc_QuartzCrystal_C: 'Recipe_QuartzCrystal_C',
  };
  const SOLID_CAP = 1140, FLUID_CAP = 570, MAX_GROUP = 14;

  function recipeFor(item) {
    if (PREFER[item] && D.recipes[PREFER[item]]) return PREFER[item];
    const skip = new Set(['Build_Converter_C', 'Build_QuantumEncoder_C', 'Build_Packager_C', 'Build_HadronCollider_C']);
    const c = Object.entries(D.recipes).filter(([, r]) => !r.alt && !r.event && r.machine && !skip.has(r.machine) && SF.defs[r.machine]
      && SF.defs[r.machine].kind === 'machine' && r.out[0][0] === item);
    if (!c.length) throw new Error('No standard recipe for ' + item);
    c.sort((a, b) => a[1].in.length - b[1].in.length);
    return c[0][0];
  }
  const fluid = it => !!SF.item(it).fluid;
  const tierFor = (rate, isPipe) => {
    const list = isPipe ? D.pipes : D.belts;
    return (list.find(b => b.rate >= rate - 1e-6) || list[list.length - 1]).tier;
  };

  // ------------------------------------------------------------ planning: a tree of machine groups
  // group: { def, recipe, props, n (machines), clock, product, perMachine:{item:rate}, inputs:[{item, rate, child}] }
  // ctx: { choose(item) -> recipe id, inputs: Set (supplied from elsewhere), miner: {def, purity} } — the stress
  // tests use the defaults; the production calculator passes the player's choices
  const CTX0 = { choose: recipeFor, inputs: new Set(), miner: { def: 'Build_MinerMk3_C', purity: 2 } };
  function planSource(item, rate) {
    return [{ def: fluid(item) ? 'V_SourceF' : 'V_Source', source: true, n: 1, clock: 1, product: item, rate, inputs: [], byproducts: [] }];
  }
  function planGroups(item, rate, ctx = CTX0, path = new Set()) {
    if (ctx.inputs.has(item) || path.has(item)) return planSource(item, rate);
    if (RAW[item]) return planRaw(item, rate, ctx);
    const rid = ctx.choose(item), r = rid && D.recipes[rid];
    if (!r) return planSource(item, rate);
    const path2 = new Set(path).add(item);
    const per = 60 / r.time;                                     // crafts per minute at 100 %
    const outAmt = r.out.find(o => o[0] === item)[1];
    const nTotal = Math.max(1, Math.ceil(rate / (outAmt * per) - 1e-9));
    // split into chunks so no single belt / pipe carries more than it can and groups stay a sensible height
    let k = Math.ceil(nTotal / MAX_GROUP);
    for (const [it, a] of [...r.in, ...r.out]) k = Math.max(k, Math.ceil(rate * a / outAmt / (fluid(it) ? FLUID_CAP : SOLID_CAP)));
    k = Math.min(k, nTotal);
    const groups = [];
    let left = nTotal;
    for (let g = 0; g < k; g++) {
      const n = Math.ceil(left / (k - g)); left -= n;
      const share = rate * n / nTotal;                           // this chunk's product rate
      const crafts = share / outAmt;                            // crafts per minute
      const clock = crafts / (n * per);
      groups.push({
        def: r.machine, recipe: rid, n, clock, product: item, rate: share, byproducts: r.out.filter(o => o[0] !== item).map(([i, a]) => ({ item: i, rate: a * crafts })),
        inputs: r.in.map(([i, a]) => ({ item: i, rate: a * crafts, children: planGroups(i, a * crafts, ctx, path2) })),
      });
    }
    return groups;
  }
  function planRaw(item, rate, ctx = CTX0) {
    const kind = RAW[item];
    const def = kind === 'miner' ? ctx.miner.def : kind === 'oil' ? 'Build_OilPump_C' : 'Build_WaterPump_C';
    const b = SF.defs[def].raw, purity = kind === 'water' ? 1 : ctx.miner.purity;
    const each = b.rate * (b.purity ? purity : 1);
    const nTotal = Math.max(1, Math.ceil(rate / each - 1e-9));
    const k = Math.max(Math.ceil(nTotal / MAX_GROUP), Math.ceil(rate / (fluid(item) ? FLUID_CAP : SOLID_CAP)));
    const groups = [];
    let left = nTotal;
    for (let g = 0; g < k; g++) {
      const n = Math.ceil(left / (k - g)); left -= n;
      const share = rate * n / nTotal;
      groups.push({ def, raw: true, n, clock: share / (n * each), purity, product: item, rate: share, inputs: [], byproducts: [] });
    }
    return groups;
  }

  // ------------------------------------------------------------ layout + wiring
  function build(spec, opts = {}) {
    const into = !!opts.into, level = into ? S.level : 0;
    const before = into ? new Set(S.entities.keys()) : null;
    if (!into) { SF.load({ entities: [], links: [], levels: [{ name: spec.name }] }); S.level = 0; }
    const ctx = opts.ctx || CTX0;
    const add = (def, x, y, rot, props) => SF.addEntity(def, x, y, rot || 0, level, props);
    const link = (a, ap, b, bp, kind, tier) => {
      const l = SF.addLink([a.id, ap], [b.id, bp], kind, tier);
      if (l.error) throw new Error(`${l.error}: ${a.def}:${ap} -> ${b.def}:${bp}`);
      return l;
    };
    // long runs get conveyor poles / pipe supports so no single belt exceeds the game's 56 m
    const longLink = (a, ap, b, bp, kind, tier) => {
      const A = SF.portWorld(a, ap), B = SF.portWorld(b, bp);
      const dist = Math.hypot(B.x - A.x, B.y - A.y);
      if (dist <= 34) return link(a, ap, b, bp, kind, tier);
      const steps = Math.ceil(dist / 30);
      let prev = a, prevPort = ap;
      for (let s = 1; s < steps; s++) {
        const x = A.x + (B.x - A.x) * s / steps, y = A.y + (B.y - A.y) * s / steps;
        const pole = add(kind === 'pipe' ? 'PipePole' : 'Pole', Math.round(x), Math.round(y), 0, { h: 1, ang: Math.atan2(B.y - A.y, B.x - A.x) });
        link(prev, prevPort, pole, 0, kind, tier);
        prev = pole; prevPort = 1;
      }
      return link(prev, prevPort, b, bp, kind, tier);
    };
    const stats = { machines: 0, extractors: 0, logistics: 0 };

    // place a group with its right edge at xR, top at yT. Returns { h, out: {ent, port, kind} } for its product.
    function place(g, xR, yT) {
      const d = SF.defs[g.def];
      const stride = Math.max(d.h + 3, 6);
      const ins = d.ports.map((p, i) => ({ p, i })).filter(x => x.p.io === 'in');
      const outs = d.ports.map((p, i) => ({ p, i })).filter(x => x.p.io === 'out');
      const r = g.recipe && D.recipes[g.recipe];
      // which machine port carries which item
      const portFor = {};
      if (r) {
        const sIn = ins.filter(x => !x.p.fluid), fIn = ins.filter(x => x.p.fluid);
        r.in.filter(([i]) => !fluid(i)).forEach(([i], k) => { portFor['in:' + i] = sIn[k].i; });
        r.in.filter(([i]) => fluid(i)).forEach(([i], k) => { portFor['in:' + i] = fIn[k].i; });
        const sOut = outs.filter(x => !x.p.fluid), fOut = outs.filter(x => x.p.fluid);
        r.out.filter(([i]) => !fluid(i)).forEach(([i], k) => { portFor['out:' + i] = sOut[k].i; });
        r.out.filter(([i]) => fluid(i)).forEach(([i], k) => { portFor['out:' + i] = fOut[k].i; });
      } else portFor['out:' + g.product] = outs[0].i;
      const nIn = g.inputs.length;
      const manW = 6;                                      // one manifold column per input
      const outCols = 1 + g.byproducts.length;
      const xm = xR - outCols * manW - 4 - d.w / 2;          // machine centre x
      const machines = [];
      for (let k = 0; k < g.n; k++) {
        const y = yT + d.h / 2 + k * stride;
        const props = g.source ? { item: g.product, rate: Math.round(g.rate * 1e4) / 1e4, name: 'Input: ' + SF.itemName(g.product) }
          : g.raw ? { resource: g.product, purity: g.purity, clock: g.clock }
          : { recipe: g.recipe, clock: Math.round(g.clock * 1e6) / 1e6, sloops: 0 };
        machines.push(add(g.def, xm, y, 0, props));
        if (g.raw) stats.extractors++; else if (!g.source) stats.machines++;
      }
      const ownH = g.n * stride;
      // product + byproduct chains on the right: mergers for solids, junctions for fluids
      const chain = (item, col) => {
        const x = xm + d.w / 2 + 4 + col * manW;
        const pi = portFor['out:' + item];
        const isF = fluid(item);
        const total = item === g.product ? g.rate : (g.byproducts.find(b => b.item === item) || {}).rate || 0;
        const per = total / g.n;
        let prev = null;
        machines.forEach(m => {
          const P = SF.portWorld(m, pi);
          if (isF) {
            const j = add('Build_PipelineJunction_Cross_C', x, P.y, 0); stats.logistics++;
            link(m, pi, j, 0, 'pipe', tierFor(per, true));
            if (prev) link(prev, 2, j, 3, 'pipe', tierFor(total, true));
            prev = j;
          } else {
            const mg = add('Build_ConveyorAttachmentMerger_C', x, P.y, 1); stats.logistics++;
            link(m, pi, mg, 2, 'belt', tierFor(per, false));
            if (prev) link(prev, 3, mg, 1, 'belt', tierFor(total, false));
            prev = mg;
          }
        });
        return { ent: prev, port: isF ? 2 : 3, kind: isF ? 'pipe' : 'belt' };
      };
      const out = chain(g.product, 0);
      g.byproducts.forEach((b, k) => {
        const end = chain(b.item, k + 1);
        const P = SF.portWorld(end.ent, end.port);
        const sink = add(fluid(b.item) ? 'V_SinkF' : 'V_Sink', P.x, P.y + 6, 0, { name: 'Byproduct: ' + SF.itemName(b.item) });
        link(end.ent, end.port, sink, 0, end.kind, tierFor(b.rate, fluid(b.item)));
      });
      // input manifolds on the left, children further left
      let yC = yT;
      const childRight = xm - d.w / 2 - 4 - nIn * manW - 10;
      g.inputs.forEach((inp, k) => {
        const x = xm - d.w / 2 - 4 - k * manW;
        const pi = portFor['in:' + inp.item];
        const isF = fluid(inp.item);
        const per = inp.rate / g.n;
        let first = null, prev = null;
        machines.forEach(m => {
          const P = SF.portWorld(m, pi);
          if (isF) {
            const j = add('Build_PipelineJunction_Cross_C', x, P.y, 0); stats.logistics++;
            link(j, 1, m, pi, 'pipe', tierFor(per, true));
            if (prev) link(prev, 2, j, 3, 'pipe', tierFor(inp.rate, true));
            prev = j; first ||= j;
          } else {
            const sp = add('Build_ConveyorAttachmentSplitter_C', x, P.y, 1); stats.logistics++;
            link(sp, 1, m, pi, 'belt', tierFor(per, false));
            if (prev) link(prev, 2, sp, 0, 'belt', tierFor(inp.rate, false));
            prev = sp; first ||= sp;
          }
        });
        // children supplying this input, merged if there are several
        const kids = inp.children.map(c => { const res = place(c, childRight, yC); yC += res.h + 8; return res; });
        let feed = kids[0].out;
        if (kids.length > 1) {
          // join several supply groups: a merger (belts) or junction (pipes) chain next to the manifold
          const xj = x - manW / 2 - 3;
          let prevJ = null;
          kids.forEach((kd, i) => {
            const P = SF.portWorld(first, isF ? 3 : 0);
            const y = P.y - 6 - (kids.length - 1 - i) * 5;
            const j = isF ? add('Build_PipelineJunction_Cross_C', xj, y, 0) : add('Build_ConveyorAttachmentMerger_C', xj, y, 1);
            stats.logistics++;
            longLink(kd.out.ent, kd.out.port, j, isF ? 0 : 2, kd.out.kind, tierFor(inp.rate, isF));
            if (prevJ) link(prevJ, isF ? 2 : 3, j, isF ? 3 : 1, kd.out.kind, tierFor(inp.rate, isF));
            prevJ = j;
          });
          feed = { ent: prevJ, port: isF ? 2 : 3, kind: isF ? 'pipe' : 'belt' };
        }
        longLink(feed.ent, feed.port, first, isF ? 3 : 0, feed.kind, tierFor(inp.rate, isF));
      });
      return { h: Math.max(ownH, yC - yT - 8), out };
    }

    // final products go into AWESOME Sinks: they never fill, so the factory can run at steady state forever
    let y = 0;
    const roots = [];
    for (const t of spec.targets) {
      for (const g of planGroups(t.item, t.rate, ctx)) {
        const res = place(g, 0, y);
        const P = SF.portWorld(res.out.ent, res.out.port);
        const sinkDef = res.out.kind === 'pipe' ? 'V_SinkF' : into ? 'V_Sink' : 'Build_ResourceSink_C';
        const box = add(sinkDef, P.x + 16, P.y + 6, 0, { name: 'Product: ' + SF.itemName(t.item) });
        link(res.out.ent, res.out.port, box, 0, res.out.kind, tierFor(g.rate, res.out.kind === 'pipe'));
        roots.push({ item: t.item, rate: g.rate, box: box.id });
        y += res.h + 20;
      }
    }
    if (spec.extra) spec.extra({ add, link, longLink, y, stats });
    if (into) {
      // move the new part to the right of whatever is already on this floor
      const mine = [...S.entities.values()].filter(e => !before.has(e.id));
      const old = [...S.entities.values()].filter(e => before.has(e.id) && e.level === level && !SF.defs[e.def].structure);
      const box = list => list.reduce((b, e) => { const [w, h] = SF.entSize(e); return { x0: Math.min(b.x0, e.x - w / 2), x1: Math.max(b.x1, e.x + w / 2), y0: Math.min(b.y0, e.y - h / 2), y1: Math.max(b.y1, e.y + h / 2) }; }, { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity });
      const nb = box(mine);
      const ob = old.length ? box(old) : { x1: -40, y0: 0 };
      const dx = Math.round(ob.x1 + 40 - nb.x0), dy = Math.round(ob.y0 - nb.y0);
      for (const e of mine) { e.x += dx; e.y += dy; }
      if (spec.label !== false) add('V_Label', Math.round((nb.x0 + nb.x1) / 2 + dx), Math.round(nb.y0 + dy - 8), 0, { text: spec.name, size: 2, color: '#fbbf24' });
      SF.changed();
      return { roots, stats, ids: mine.map(e => e.id), bounds: { x0: nb.x0 + dx, x1: nb.x1 + dx, y0: nb.y0 + dy, y1: nb.y1 + dy } };
    }
    SF.changed();
    return { roots, stats };
  }

  // coal power: generators fed by coal miners and water extractors (power is reported, never limiting)
  function coalPower(count) {
    return ({ add, link, longLink, y, stats }) => {
      const g = SF.defs.Build_GeneratorCoal_C;
      const x0 = -40, y0 = y + 20, stride = g.h + 4;
      const coalNeed = 15 * count, waterNeed = 45 * count;
      const gens = [];
      for (let k = 0; k < count; k++) { gens.push(add('Build_GeneratorCoal_C', x0, y0 + g.h / 2 + k * stride, 0, { fuel: 'Desc_Coal_C', clock: 1 })); stats.machines++; }
      // coal: one Mk3 miner per 480/min on a pure node, splitter manifold
      const nMiner = Math.ceil(coalNeed / 480);
      let prevSp = null, firstSp = null;
      gens.forEach(gn => {
        const P = SF.portWorld(gn, 0);
        const sp = add('Build_ConveyorAttachmentSplitter_C', x0 - g.w / 2 - 6, P.y, 1); stats.logistics++;
        link(sp, 1, gn, 0, 'belt', 1);
        if (prevSp) link(prevSp, 2, sp, 0, 'belt', 4); prevSp = sp; firstSp ||= sp;
      });
      let prevMg = null;
      for (let k = 0; k < nMiner; k++) {
        const m = add('Build_MinerMk3_C', x0 - g.w / 2 - 40, y0 + k * 10, 0, { resource: 'Desc_Coal_C', purity: 2, clock: Math.round(coalNeed / nMiner / 480 * 1e6) / 1e6 }); stats.extractors++;
        const mg = add('Build_ConveyorAttachmentMerger_C', x0 - g.w / 2 - 28, y0 + k * 10, 1); stats.logistics++;
        link(m, 0, mg, 2, 'belt', 4);
        if (prevMg) link(prevMg, 3, mg, 1, 'belt', 4); prevMg = mg;
      }
      longLink(prevMg, 3, firstSp, 0, 'belt', 4);
      // water: extractors -> junction chain -> junction manifold
      const nPump = Math.ceil(waterNeed / 120);
      let prevJ = null, firstJ = null;
      gens.forEach(gn => {
        const P = SF.portWorld(gn, 1);
        const j = add('Build_PipelineJunction_Cross_C', x0 - g.w / 2 - 3, P.y, 0); stats.logistics++;
        link(j, 1, gn, 1, 'pipe', 1);
        if (prevJ) link(prevJ, 2, j, 3, 'pipe', 2); prevJ = j; firstJ ||= j;
      });
      let prevW = null;
      for (let k = 0; k < nPump; k++) {
        const w = add('Build_WaterPump_C', x0 - g.w / 2 - 70, y0 + nMiner * 10 + 12 + k * 22, 0, { clock: Math.round(waterNeed / nPump / 120 * 1e6) / 1e6 }); stats.extractors++;
        const j = add('Build_PipelineJunction_Cross_C', x0 - g.w / 2 - 54, y0 + nMiner * 10 + 12 + k * 22, 0); stats.logistics++;
        link(w, 0, j, 0, 'pipe', 2);
        if (prevW) link(prevW, 2, j, 3, 'pipe', 2); prevW = j;
      }
      longLink(prevW, 2, firstJ, 3, 'pipe', 2);
      add('V_Label', x0, y0 - 6, 0, { text: `Coal power — ${count} generators, ${count * 75} MW`, size: 2, color: '#facc15' });
    };
  }

  SF.SCENARIOS = [
    { id: 'early', name: '1 · Early: Reinforced plates & rotors', desc: 'Tier 1–2: iron ore to reinforced iron plates and rotors.',
      targets: [{ item: 'Desc_IronPlateReinforced_C', rate: 10 }, { item: 'Desc_Rotor_C', rate: 8 }] },
    { id: 'phase1', name: '2 · Early-mid: Smart plating & modular frames', desc: 'Space Elevator phase 1–2 parts.',
      targets: [{ item: 'Desc_SpaceElevatorPart_1_C', rate: 6 }, { item: 'Desc_ModularFrame_C', rate: 6 }] },
    { id: 'steel', name: '3 · Mid: Steel, motors & coal power', desc: 'Steel beams, motors and encased beams, with a 12-generator coal plant (900 MW).',
      targets: [{ item: 'Desc_Motor_C', rate: 10 }, { item: 'Desc_SteelPlateReinforced_C', rate: 8 }], extra: coalPower(12) },
    { id: 'oil', name: '4 · Late: Computers & heavy modular frames', desc: 'Oil, plastic and rubber feeding computers and heavy modular frames.',
      targets: [{ item: 'Desc_Computer_C', rate: 5 }, { item: 'Desc_ModularFrameHeavy_C', rate: 4 }] },
    { id: 'mega', name: '5 · Massive: Modular engines & adaptive control units', desc: 'Space Elevator phase 3: thousands of objects, every production tier.',
      targets: [{ item: 'Desc_SpaceElevatorPart_4_C', rate: 10 }, { item: 'Desc_SpaceElevatorPart_5_C', rate: 5 }] },
  ];
  SF.buildScenario = (id) => {
    const sc = SF.SCENARIOS.find(s => s.id === id);
    const res = build(sc);
    return { ...res, scenario: sc };
  };
  SF.scenarioRecipe = recipeFor;
  // production calculator: lay out a plan next to what is already on the current floor
  // targets: [{item, rate}], choices: { choose(item), inputs: [item], miner: {def, purity} }
  SF.placePlan = (name, targets, choices) => build({ name, targets }, {
    into: true,
    ctx: { choose: choices.choose, inputs: new Set(choices.inputs || []), miner: choices.miner || CTX0.miner },
  });
})(window.SF);
