// Headless regression test for game maths + simulator. Run: node tools/test_sim.js
global.window = global;
global.localStorage = { getItem() { return null; }, setItem() {} };
const W = __dirname + '/../web/';
require(W + 'data.js'); require(W + 'js/defs.js'); require(W + 'js/model.js'); require(W + 'js/progress.js'); require(W + 'js/calc.js'); require(W + 'js/sim.js'); require(W + 'js/livesim.js'); require(W + 'js/example.js'); require(W + 'js/scenarios.js');
const SF = window.SF, S = SF.state, D = SF.D;
let fails = 0, checks = 0;
const near = (a, b, tol = 0.01) => Math.abs(a - b) <= Math.max(tol, Math.abs(b) * 0.005);
function check(cond, msg) { checks++; if (!cond) { fails++; console.log('  FAIL', msg); } }

// ---------------------------------------------------------------- static data
const beltRates = D.belts.map(b => b.rate).join(',');
check(beltRates === '60,120,270,480,780,1200', 'belt rates ' + beltRates);
check(D.pipes.map(p => p.rate).join(',') === '300,600', 'pipe rates');
const R = id => D.recipes[id];
const perMin = (r, i = 0) => r.out[i][1] * 60 / r.time;
check(near(perMin(R('Recipe_IngotIron_C')), 30), 'iron ingot 30/min');
check(near(perMin(R('Recipe_IronPlate_C')), 20), 'iron plate 20/min');
check(near(perMin(R('Recipe_IronRod_C')), 15), 'iron rod 15/min');
check(near(perMin(R('Recipe_Screw_C')), 40), 'screw 40/min');
check(near(perMin(R('Recipe_IronPlateReinforced_C')), 5), 'reinforced plate 5/min');
check(near(perMin(R('Recipe_Motor_C')), 5), 'motor 5/min');
check(near(perMin(R('Recipe_Plastic_C')), 20), 'plastic 20/min');
const B = id => D.buildings[id];
check(B('Build_MinerMk1_C').rate === 60 && B('Build_MinerMk2_C').rate === 120 && B('Build_MinerMk3_C').rate === 240, 'miner rates');
check(B('Build_OilPump_C').rate === 120 && B('Build_WaterPump_C').rate === 120, 'oil/water extractor 120 m³/min');
check(B('Build_ConstructorMk1_C').power === 4 && B('Build_ManufacturerMk1_C').power === 55, 'machine power');
check(near(B('Build_ConstructorMk1_C').powerExp, 1.321929, 1e-5), 'overclock exponent');
check(SF.shardsFor(1) === 0 && SF.shardsFor(1.01) === 1 && SF.shardsFor(1.5) === 1 && SF.shardsFor(1.51) === 2 && SF.shardsFor(2) === 2 && SF.shardsFor(2.5) === 3, 'power shard counts');
{ const e = { clock: 2.5, sloops: 0 }; check(near(SF.machinePower(e, SF.defs.Build_ConstructorMk1_C), 4 * Math.pow(2.5, 1.321929)), 'overclocked power'); }
{ const e = { clock: 1, sloops: 1 }; check(near(SF.machinePower(e, SF.defs.Build_ConstructorMk1_C), 16), 'somersloop power x4'); }

// ---------------------------------------------------------------- every recipe on its machine
function feedAndRun(machineId, props) {
  SF.load({ entities: [], links: [] });
  const m = SF.addEntity(machineId, 0, 0, 0, 0, props);
  const d = SF.defs[machineId];
  const r = D.recipes[props.recipe];
  const ports = d.ports.map((p, i) => ({ ...p, i }));
  const inS = ports.filter(p => p.io === 'in' && !p.fluid), inF = ports.filter(p => p.io === 'in' && p.fluid);
  const outS = ports.filter(p => p.io === 'out' && !p.fluid), outF = ports.filter(p => p.io === 'out' && p.fluid);
  let y = -40;
  for (const [item] of r.in) {
    const fluid = SF.item(item).fluid;
    const port = (fluid ? inF : inS).shift();
    if (!port) return { error: 'no port for ' + item };
    const src = SF.addEntity(fluid ? 'V_SourceF' : 'V_Source', -60, y += 10, 0, 0, { item, rate: 0 });
    const l = SF.addLink([src.id, 0], [m.id, port.i], fluid ? 'pipe' : 'belt', fluid ? 2 : 6);
    if (l.error) return { error: l.error };
  }
  for (const [item] of r.out) {
    const fluid = SF.item(item).fluid;
    const port = (fluid ? outF : outS).shift();
    if (!port) return { error: 'no out port for ' + item };
    const sink = SF.addEntity(fluid ? 'V_SinkF' : 'V_Sink', 60, y += 10, 0, 0, {});
    const l = SF.addLink([m.id, port.i], [sink.id, 0], fluid ? 'pipe' : 'belt', fluid ? 2 : 6);
    if (l.error) return { error: l.error };
  }
  SF.changed();
  return { res: SF.sim.runSync().nodes.get(m.id), r };
}

let recipeFails = 0, recipeCount = 0;
for (const [id, r] of Object.entries(D.recipes)) {
  const d = SF.defs[r.machine];
  if (!d) continue;
  recipeCount++;
  const clock = 1;
  const out = feedAndRun(r.machine, { recipe: id, clock, sloops: 0 });
  if (out.error) { recipeFails++; console.log('  FAIL', r.name, out.error); continue; }
  for (const [item, amt] of r.out) {
    const want = amt * 60 / r.time;
    // belts cap at 1200/min, pipes at 600/min
    const cap = SF.item(item).fluid ? 600 : 1200;
    const got = out.res.outs[item] || 0;
    if (!near(got, Math.min(want, cap), 0.05)) { recipeFails++; console.log(`  FAIL ${r.name} (${d.name}): ${SF.itemName(item)} ${got.toFixed(3)} vs ${want.toFixed(3)}/min, status ${out.res.status}`); }
  }
}
checks += recipeCount; fails += recipeFails;
console.log(`recipes: ${recipeCount - recipeFails}/${recipeCount} produce their book rate`);

// overclock + somersloop
{
  const o = feedAndRun('Build_ConstructorMk1_C', { recipe: 'Recipe_IronPlate_C', clock: 2.5, sloops: 1 });
  check(near(o.res.outs.Desc_IronPlate_C, 20 * 2.5 * 2), 'constructor 250% + somersloop = 100/min (' + o.res.outs.Desc_IronPlate_C + ')');
  check(near(o.res.ins.Desc_IronIngot_C, 30 * 2.5), 'somersloop does not increase input (' + o.res.ins.Desc_IronIngot_C + ')');
}

// ---------------------------------------------------------------- extractors
for (const [id, mk] of [['Build_MinerMk1_C', 60], ['Build_MinerMk2_C', 120], ['Build_MinerMk3_C', 240]]) {
  for (const [purity, f] of [[0.5, 0.5], [1, 1], [2, 2]]) {
    for (const clock of [0.5, 1, 2.5]) {
      SF.load({ entities: [], links: [] });
      const m = SF.addEntity(id, 0, 0, 0, 0, { resource: 'Desc_OreIron_C', purity, clock });
      const k = SF.addEntity('V_Sink', 30, 0);
      SF.addLink([m.id, 0], [k.id, 0], 'belt', 6); SF.changed();
      const got = SF.sim.runSync().nodes.get(m.id).outs.Desc_OreIron_C;
      const want = Math.min(mk * f * clock, 1200);
      check(near(got, want, 0.05), `${id} purity ${purity} clock ${clock}: ${got} vs ${want}`);
    }
  }
}

// ---------------------------------------------------------------- generators
for (const [gid, g] of Object.entries(D.buildings).filter(([, b]) => b.kind === 'generator' && !b.geo)) {
  for (const f of g.fuels) {
    SF.load({ entities: [], links: [] });
    const gen = SF.addEntity(gid, 0, 0, 0, 0, { fuel: f.fuel, clock: 1 });
    const d = SF.defs[gid];
    const fluidFuel = SF.item(f.fuel).fluid;
    const pS = d.ports.findIndex(p => p.io === 'in' && !p.fluid), pF = d.ports.findIndex(p => p.io === 'in' && p.fluid);
    const src = SF.addEntity(fluidFuel ? 'V_SourceF' : 'V_Source', -40, 0, 0, 0, { item: f.fuel, rate: 0 });
    SF.addLink([src.id, 0], [gen.id, fluidFuel ? pF : pS], fluidFuel ? 'pipe' : 'belt', fluidFuel ? 2 : 6);
    if (f.supp) {
      const w = SF.addEntity('V_SourceF', -40, 20, 0, 0, { item: f.supp, rate: 0 });
      SF.addLink([w.id, 0], [gen.id, pF], 'pipe', 2);
    }
    if (f.by) {
      const pO = d.ports.findIndex(p => p.io === 'out');
      const k = SF.addEntity('V_Sink', 40, 0); SF.addLink([gen.id, pO], [k.id, 0], 'belt', 6);
    }
    SF.changed();
    const res = SF.sim.runSync().nodes.get(gen.id);
    const want = g.produce * 60 / SF.item(f.fuel).energy;
    check(near(res.gen, g.produce, 0.1), `${SF.defs[gid].name} on ${SF.itemName(f.fuel)}: ${res.gen.toFixed(1)} MW vs ${g.produce}`);
    check(near(res.ins[f.fuel], want, 0.01), `${SF.defs[gid].name} burns ${SF.itemName(f.fuel)} ${res.ins[f.fuel]?.toFixed(4)} vs ${want.toFixed(4)}/min`);
  }
}
// known in-game values
{
  const coal = D.buildings.Build_GeneratorCoal_C;
  check(near(coal.produce * 60 / SF.item('Desc_Coal_C').energy, 15) && near(coal.produce * coal.suppRatio * 60 / 1000, 45), 'coal gen: 15 coal + 45 water /min');
  const fuel = D.buildings.Build_GeneratorFuel_C;
  check(near(fuel.produce * 60 / SF.item('Desc_LiquidFuel_C').energy, 20), 'fuel gen: 20 m³ fuel /min');
}

// ---------------------------------------------------------------- belts, poles, splitters
{
  SF.load({ entities: [], links: [] });
  const s = SF.addEntity('V_Source', 0, 0, 0, 0, { item: 'Desc_OreIron_C', rate: 0 });
  const p1 = SF.addEntity('Pole', 10, 0, 0, 0, { h: 1, ang: 0 });
  const p2 = SF.addEntity('Pole', 20, 6, 0, 0, { h: 4, ang: 0.5 });
  const k = SF.addEntity('V_Sink', 30, 6);
  SF.addLink([s.id, 0], [p1.id, 0], 'belt', 3); SF.addLink([p1.id, 1], [p2.id, 0], 'belt', 2); SF.addLink([p2.id, 1], [k.id, 0], 'belt', 4);
  SF.changed();
  const r = SF.sim.runSync();
  check(near(r.nodes.get(k.id).ins.Desc_OreIron_C, 120), 'pole chain limited by slowest belt (Mk2 = 120): ' + r.nodes.get(k.id).ins.Desc_OreIron_C);
  for (const l of S.links.values()) {
    const P = SF.linkPath3(l);
    check(P.length >= 2 && P.every(p => p.every(Number.isFinite)), 'finite path points');
    const d0 = Math.hypot(P[0][0] - SF.portWorld(S.entities.get(l.from[0]), l.from[1]).x, P[0][1] - SF.portWorld(S.entities.get(l.from[0]), l.from[1]).y);
    check(d0 < 1e-6, 'path starts at its port');
  }
  const l2 = [...S.links.values()][1];
  const P2 = SF.linkPath3(l2);
  check(near(P2[0][2], 1) && near(P2[P2.length - 1][2], 4), 'belt heights follow the poles (1 m -> 4 m)');
}
for (const style of ['curve', 'straight', 'ortho']) {
  const pts = SF.routePath({ x: 0, y: 0, dx: 1, dy: 0, h: 1 }, { x: 20, y: 10, dx: -1, dy: 0, h: 1 }, [], style);
  const ok = pts.every(p => p.every(Number.isFinite)) && near(pts[0][0], 0) && near(pts[pts.length - 1][0], 20) && near(pts[pts.length - 1][1], 10);
  check(ok, 'route style ' + style + ' joins both ends');
  // no reversed steps along a right-angle route (no zig-zags)
  if (style === 'ortho') check(SF.pathLength(pts) < 20 + 10 + 4, 'ortho path length sane: ' + SF.pathLength(pts).toFixed(1));
}
{
  // splitter splits evenly; 3 outputs of a 90/min feed -> 30 each
  SF.load({ entities: [], links: [] });
  const s = SF.addEntity('V_Source', -10, 0, 0, 0, { item: 'Desc_OreIron_C', rate: 90 });
  const sp = SF.addEntity('Build_ConveyorAttachmentSplitter_C', 0, 0);
  const ks = [1, 2, 3].map(i => SF.addEntity('V_Sink', 10, i * 8 - 16));
  SF.addLink([s.id, 0], [sp.id, 0], 'belt', 3);
  ks.forEach((k, i) => SF.addLink([sp.id, i + 1], [k.id, 0], 'belt', 3));
  SF.changed();
  const r = SF.sim.runSync();
  ks.forEach(k => check(near(r.nodes.get(k.id).ins.Desc_OreIron_C, 30, 0.05), 'splitter even split ' + r.nodes.get(k.id).ins.Desc_OreIron_C));
}

// ---------------------------------------------------------------- unfinished lines keep running (open ends discard)
function line(minerId, beltTier, endWith) {
  SF.load({ entities: [], links: [] });
  const m = SF.addEntity(minerId, 0, 0, 0, 0, { resource: 'Desc_OreIron_C', purity: 1, clock: 1 });
  let end;
  if (endWith === 'smelter') end = SF.addEntity('Build_SmelterMk1_C', 30, 0, 0, 0, { recipe: 'Recipe_IngotIron_C' });
  else end = SF.addEntity('Pole', 30, 0, 0, 0, { h: 1, ang: 0 });
  const l = SF.addLink([m.id, 0], [end.id, 0], 'belt', beltTier);
  SF.changed();
  const r = SF.sim.runSync();
  return { m: r.nodes.get(m.id), end: r.nodes.get(end.id), belt: r.edges.get(l.id) };
}
{
  const a = line('Build_MinerMk1_C', 1, 'smelter');
  check(a.end.status === 'ok' && near(a.end.ins.Desc_OreIron_C, 30), 'smelter with no output still runs: ' + a.end.status + ' ' + a.end.ins.Desc_OreIron_C);
  check(near(a.end.voided.Desc_IronIngot_C, 30), 'its ingots spill off the open output: ' + a.end.voided.Desc_IronIngot_C);
  check(near(a.m.outs.Desc_OreIron_C, 30) && a.m.status === 'throttled', 'miner (60) is drawn at the smelter rate (30): ' + a.m.outs.Desc_OreIron_C + ' ' + a.m.status);
  const b = line('Build_MinerMk2_C', 1, 'pole');
  check(near(b.belt.total, 60) && near(b.belt.util, 1), 'Mk2 miner (120) on Mk1 belt is capped at 60: ' + b.belt.total);
  check(b.m.status === 'throttled', 'miner reports it is belt-limited: ' + b.m.status);
  const c = line('Build_MinerMk1_C', 2, 'pole');
  check(near(c.belt.total, 60) && near(c.belt.util, 0.5), 'Mk1 miner (60) on Mk2 belt flows 60 at 50%: ' + c.belt.total + ' ' + c.belt.util);
  check(near(c.end.voided.Desc_OreIron_C, 60), 'dangling belt end spills 60/min: ' + JSON.stringify(c.end.voided));
  S.settings.openOutputsBlock = true;
  const d = line('Build_MinerMk1_C', 1, 'smelter');
  check(near(d.end.ins.Desc_OreIron_C || 0, 0) && d.end.status !== 'ok', 'strict mode: smelter with no output backs up: ' + d.end.status);
  S.settings.openOutputsBlock = false;
}


// ---------------------------------------------------------------- Sim mode (real items, real time)
{
  const L = SF.live;
  const fresh = () => { SF.load({ entities: [], links: [] }); };
  const go = secs => { L.active = true; L.reset(); return L.runFor(secs); };
  // miner -> smelter -> storage
  fresh();
  const m = SF.addEntity('Build_MinerMk1_C', 0, 0, 0, 0, { resource: 'Desc_OreIron_C', purity: 1, clock: 1 });
  const sm = SF.addEntity('Build_SmelterMk1_C', 20, 0, 0, 0, { recipe: 'Recipe_IngotIron_C' });
  const box = SF.addEntity('Build_StorageContainerMk1_C', 40, 0, 0, 0, {});
  const b1 = SF.addLink([m.id, 0], [sm.id, 0], 'belt', 1); SF.addLink([sm.id, 1], [box.id, 0], 'belt', 1);
  SF.changed();
  let r = go(0);
  check(L.itemsOnBelts() === 0 && L.t === 0, 'sim starts empty at t=0');
  r = L.runFor(3);
  check(!(r.nodes.get(box.id).live.inv.Desc_IronIngot_C), 'no ingots arrive in the first seconds');
  r = L.runFor(600);
  check(near(r.nodes.get(sm.id).outs.Desc_IronIngot_C, 30, 1), 'smelter makes ~30 ingots/min once running: ' + r.nodes.get(sm.id).outs.Desc_IronIngot_C);
  check(near(r.nodes.get(m.id).outs.Desc_OreIron_C, 30, 1), 'miner (60) slows to what the smelter takes (30): ' + r.nodes.get(m.id).outs.Desc_OreIron_C);
  check(r.edges.get(b1.id).full, 'ore belt backs up when the smelter is slower than the miner');
  check(near(r.nodes.get(box.id).ins.Desc_IronIngot_C, 30, 1), 'storage receives 30/min: ' + r.nodes.get(box.id).ins.Desc_IronIngot_C);
  const stored = r.nodes.get(box.id).live.inv.Desc_IronIngot_C;
  check(stored > 270 && stored < 305, 'storage holds ~5 min of ingots after 603 s: ' + stored);
  // belt speed: Mk1 1.2 m/s, items 1.2 m apart -> 60/min max
  fresh();
  const m3 = SF.addEntity('Build_MinerMk3_C', 0, 0, 0, 0, { resource: 'Desc_OreIron_C', purity: 1, clock: 1 });
  const sk = SF.addEntity('V_Sink', 30, 0, 0, 0, {});
  const b3 = SF.addLink([m3.id, 0], [sk.id, 0], 'belt', 1);
  SF.changed();
  r = go(300);
  check(near(r.edges.get(b3.id).total, 60, 1), 'Mk1 belt carries 60/min in Sim mode: ' + r.edges.get(b3.id).total);
  // storage fills to capacity: Mk3 miner (240) on Mk3 belt into a 24-slot container
  fresh();
  const m4 = SF.addEntity('Build_MinerMk3_C', 0, 0, 0, 0, { resource: 'Desc_OreIron_C', purity: 1, clock: 1 });
  const box2 = SF.addEntity('Build_StorageContainerMk1_C', 30, 0, 0, 0, {});
  SF.addLink([m4.id, 0], [box2.id, 0], 'belt', 3);
  SF.changed();
  r = go(15 * 60);
  const inv = r.nodes.get(box2.id).live.inv.Desc_OreIron_C;
  check(inv === 24 * SF.item('Desc_OreIron_C').stack, 'storage fills to 24 stacks and stops: ' + inv);
  check(r.nodes.get(m4.id).status !== 'ok' && near(r.nodes.get(m4.id).outs.Desc_OreIron_C || 0, 0, 0.5), 'miner stops once everything is full: ' + r.nodes.get(m4.id).status);
  // splitter round robin
  fresh();
  const m5 = SF.addEntity('Build_MinerMk1_C', 0, 0, 0, 0, { resource: 'Desc_OreIron_C', purity: 1, clock: 1 });
  const sp = SF.addEntity('Build_ConveyorAttachmentSplitter_C', 20, 0, 0, 0, {});
  SF.addLink([m5.id, 0], [sp.id, 0], 'belt', 1);
  const sinks = [1, 2, 3].map(k => { const s2 = SF.addEntity('V_Sink', 40, (k - 2) * 10, 0, 0, {}); SF.addLink([sp.id, k], [s2.id, 0], 'belt', 1); return s2; });
  SF.changed();
  r = go(400);
  const split = sinks.map(s2 => r.nodes.get(s2.id).ins.Desc_OreIron_C || 0);
  check(split.every(v => near(v, 20, 1)), 'splitter round-robins 60 into 3 x 20: ' + split.map(v => v.toFixed(1)));
  // generator burns real fuel and reports MW
  fresh();
  const src = SF.addEntity('V_Source', 0, 0, 0, 0, { item: 'Desc_Leaves_C', rate: 60 });
  const gen = SF.addEntity('Build_GeneratorBiomass_Automated_C', 20, 0, 0, 0, { fuel: 'Desc_Leaves_C', clock: 1 });
  SF.addLink([src.id, 0], [gen.id, 0], 'belt', 1);
  SF.changed();
  r = go(400);
  const g = r.nodes.get(gen.id);
  L.active = false; const gf = SF.sim.runSync().nodes.get(gen.id);
  check(near(g.gen, gf.gen, 0.5) && g.gen > 0, 'generator makes the free-run MW: ' + g.gen + ' vs ' + gf.gen);
  check(near(g.ins.Desc_Leaves_C, gf.ins.Desc_Leaves_C, 0.5), 'and burns the free-run fuel rate: ' + g.ins.Desc_Leaves_C + ' vs ' + gf.ins.Desc_Leaves_C);
  // external input supplies forever at its set rate
  fresh();
  const src2 = SF.addEntity('V_Source', 0, 0, 0, 0, { item: 'Desc_IronPlate_C', rate: 45 });
  const sk2 = SF.addEntity('V_Sink', 20, 0, 0, 0, {});
  SF.addLink([src2.id, 0], [sk2.id, 0], 'belt', 2);
  SF.changed();
  r = go(3600);
  check(near(r.nodes.get(sk2.id).ins.Desc_IronPlate_C, 45, 0.5), 'external input keeps supplying 45/min after an hour: ' + r.nodes.get(sk2.id).ins.Desc_IronPlate_C);
  // fluids: refinery plastic from a piped oil source
  fresh();
  const oil = SF.addEntity('V_SourceF', 0, 0, 0, 0, { item: 'Desc_LiquidOil_C', rate: 30 });
  const ref = SF.addEntity('Build_OilRefinery_C', 20, 0, 0, 0, { recipe: 'Recipe_Plastic_C' });
  const di = SF.defs.Build_OilRefinery_C.ports.findIndex(p => p.io === 'in' && p.fluid);
  SF.addLink([oil.id, 0], [ref.id, di], 'pipe', 1);
  // the heavy oil residue byproduct must go somewhere, or (like in game) the refinery backs up and stops
  const res = SF.addEntity('V_SinkF', 40, 0, 0, 0, {});
  SF.addLink([ref.id, SF.defs.Build_OilRefinery_C.ports.findIndex(p => p.io === 'out' && p.fluid)], [res.id, 0], 'pipe', 1);
  SF.changed();
  r = go(600);
  check(near(r.nodes.get(ref.id).outs.Desc_Plastic_C || 0, 20, 1), 'refinery makes 20 plastic/min from piped oil: ' + JSON.stringify(r.nodes.get(ref.id).outs));
  L.active = false;
}


// ---------------------------------------------------------------- Sim mode: in-game back-up behaviour
{
  const L = SF.live;
  const go = secs => { L.active = true; L.reset(); return L.runFor(secs); };
  // a smelter with nothing on its output fills its output slot (100 ingots) and stops, then the ore belt backs up
  SF.load({ entities: [], links: [] });
  const m = SF.addEntity('Build_MinerMk1_C', 0, 0, 0, 0, { resource: 'Desc_OreIron_C', purity: 1, clock: 1 });
  const sm = SF.addEntity('Build_SmelterMk1_C', 20, 0, 0, 0, { recipe: 'Recipe_IngotIron_C' });
  const b = SF.addLink([m.id, 0], [sm.id, 0], 'belt', 1);
  SF.changed();
  let r = go(60);
  check(r.nodes.get(sm.id).live.out.Desc_IronIngot_C >= 20 && r.nodes.get(sm.id).live.out.Desc_IronIngot_C <= 30 && !Object.keys(r.nodes.get(sm.id).voided).length, 'open output: ingots build up inside the smelter, none are discarded: ' + r.nodes.get(sm.id).live.out.Desc_IronIngot_C);
  r = L.runFor(600);
  const n = r.nodes.get(sm.id);
  check(n.live.out.Desc_IronIngot_C === 100 && n.status === 'blocked', 'smelter output fills to one stack (100) and the smelter stops: ' + n.live.out.Desc_IronIngot_C + ' ' + n.status);
  check(n.live.inv.Desc_OreIron_C === 100 && r.edges.get(b.id).full, 'then its input fills and the belt backs up');
  check(r.nodes.get(m.id).status !== 'ok' && r.nodes.get(m.id).live.out.Desc_OreIron_C === 100, 'and finally the miner fills and stops');
  // a belt that ends at a pole (leads nowhere) backs up instead of discarding
  SF.load({ entities: [], links: [] });
  const m2 = SF.addEntity('Build_MinerMk1_C', 0, 0, 0, 0, { resource: 'Desc_OreIron_C', purity: 1, clock: 1 });
  const pole = SF.addEntity('Pole', 30, 0, 0, 0, { h: 1, ang: 0 });
  const b2 = SF.addLink([m2.id, 0], [pole.id, 0], 'belt', 1);
  SF.changed();
  r = go(300);
  check(r.edges.get(b2.id).full && near(r.edges.get(b2.id).total, 0, 0.01), 'dead-end belt fills and stops: ' + r.edges.get(b2.id).count + ' items');
  check(r.nodes.get(m2.id).status !== 'ok', 'miner on a dead-end belt stops once it is full');
  // a belt loaded at exactly its rated speed carries the full rate (no rounding loss between items)
  SF.load({ entities: [], links: [] });
  const m3 = SF.addEntity('Build_MinerMk2_C', 0, 0, 0, 0, { resource: 'Desc_OreIron_C', purity: 1, clock: 1 });
  const sk = SF.addEntity('V_Sink', 40, 0, 0, 0, {});
  const b3 = SF.addLink([m3.id, 0], [sk.id, 0], 'belt', 2);
  SF.changed();
  r = go(1200);
  check(near(r.edges.get(b3.id).total, 120, 1e-6) && (r.nodes.get(m3.id).live.out.Desc_OreIron_C || 0) <= 1, 'Mk2 miner (120) on a Mk2 belt (120) runs at exactly 120 without backing up: ' + r.edges.get(b3.id).total);
  // exact crafting cycle: 6 s plate recipe = exactly 20/min over a long run
  SF.load({ entities: [], links: [] });
  const src = SF.addEntity('V_Source', 0, 0, 0, 0, { item: 'Desc_IronIngot_C', rate: 0 });
  const c = SF.addEntity('Build_ConstructorMk1_C', 20, 0, 0, 0, { recipe: 'Recipe_IronPlate_C' });
  const sk2 = SF.addEntity('V_Sink', 40, 0, 0, 0, {});
  SF.addLink([src.id, 0], [c.id, 0], 'belt', 1); SF.addLink([c.id, 1], [sk2.id, 0], 'belt', 1);
  SF.changed();
  go(60); const before = L.nodes.get(c.id).st.cum.prod.Desc_IronPlate_C;
  L.runFor(3600);
  check(L.nodes.get(c.id).st.cum.prod.Desc_IronPlate_C - before === 1200, 'constructor makes exactly 1200 plates in an hour (6 s cycles, no drift): ' + (L.nodes.get(c.id).st.cum.prod.Desc_IronPlate_C - before));
  L.active = false;
}

// ---------------------------------------------------------------- Sim mode: the example factory, 2 sim-hours
{
  const L = SF.live;
  SF.buildExample();
  const fr = SF.sim.runSync();
  L.active = true; L.reset();
  L.runFor(100 * 60);
  const take = () => new Map([...L.nodes].map(([id, n]) => [id, { prod: { ...n.st.cum.prod }, busy: n.st.busy }]));
  const takeE = () => new Map([...L.edges].map(([id, ed]) => [id, Object.values(ed.st.cum).reduce((a, b) => a + b, 0)]));
  const a = take(), ae = takeE();
  L.runFor(20 * 60);
  const b = take(), be = takeE();
  let bad = [];
  for (const [id, n] of L.nodes) {
    const f = fr.nodes.get(id);
    if (!['machine', 'extractor', 'generator'].includes(n.kind)) continue;
    for (const it in f.outs) { const v = ((b.get(id).prod[it] || 0) - (a.get(id).prod[it] || 0)) / 20; if (Math.abs(v - f.outs[it]) > 1e-6) bad.push(`${SF.defs[n.e.def].name} ${it} ${v} vs ${f.outs[it]}`); }
    const eff = (b.get(id).busy - a.get(id).busy) / 1200;
    if (Math.abs(eff - f.eff) > 0.001) bad.push(`${SF.defs[n.e.def].name} busy ${eff}`);
  }
  check(!bad.length, 'example factory after saturation: every machine matches Free run exactly ' + bad.slice(0, 4).join('; '));
  bad = [];
  for (const [id, ed] of L.edges) { const v = (be.get(id) - ae.get(id)) / 20, f = fr.edges.get(id).total; if (Math.abs(v - f) > 1e-6) bad.push(`${id} ${v} vs ${f}`); }
  check(!bad.length, 'example factory after saturation: every belt and pipe matches Free run (incl. every splitter output) ' + bad.slice(0, 4).join('; '));
  const box = [...S.entities.values()].find(e => e.def === 'Build_StorageContainerMk2_C');
  const stored = L.nodes.get(box.id).st.inv.Desc_IronPlateReinforced_C;
  check(stored > 900 && stored < 1200, 'finished goods storage holds ~1000 reinforced plates after 2 h: ' + stored);
  // conservation: every item made is consumed, on a belt, or inside a building
  const prod = {}, cons = {}, held = {};
  const add = (m, k, v) => { m[k] = (m[k] || 0) + v; };
  for (const n of L.nodes.values()) {
    const st = n.st;
    if (n.kind !== 'storage') { for (const k in st.cum.prod) add(prod, k, st.cum.prod[k]); for (const k in st.cum.cons) add(cons, k, st.cum.cons[k]); }
    for (const k in st.inv) add(held, k, st.inv[k]);
    for (const k in st.out) add(held, k, st.out[k]);
    if (st.buf) add(held, st.buf, 1);
  }
  for (const ed of L.edges.values()) if (ed.kind === 'belt') ed.items.forEach(x => add(held, x.it, 1));
  bad = Object.keys(prod).filter(k => !SF.item(k).fluid && Math.abs(prod[k] - (cons[k] || 0) - (held[k] || 0)) > 1e-6);
  check(!bad.length, 'no item is created or lost anywhere in the factory ' + bad.join(','));
  // live readings: once saturated, every belt and machine reads its exact rate every single second
  let off = 0, worst = '';
  for (let k = 0; k < 60; k++) {
    const r = L.runFor(1);
    for (const [id, e] of r.edges) { const f = fr.edges.get(id).total; if (Math.abs(e.total - f) > Math.max(0.01, f * 0.001)) { off++; worst = id + ' ' + e.total + ' vs ' + f; } }
    for (const [id, n] of r.nodes) { const f = fr.nodes.get(id); for (const it in f.outs) if (Math.abs((n.outs[it] || 0) - f.outs[it]) > Math.max(0.01, f.outs[it] * 0.001)) { off++; worst = id + ' ' + it; } }
  }
  check(off === 0, 'saturated factory: live belt/machine rates are exact every second for a minute (' + off + ' off) ' + worst);
  L.active = false;
}
{
  // a belt reads its rate within seconds of the first item arriving (no 60 s averaging)
  const L = SF.live;
  SF.load({ entities: [], links: [] });
  const m = SF.addEntity('Build_MinerMk1_C', 0, 0, 0, 0, { resource: 'Desc_OreIron_C', purity: 1, clock: 0.5 });
  const sk = SF.addEntity('V_Sink', 20, 0, 0, 0, {});
  const l = SF.addLink([m.id, 0], [sk.id, 0], 'belt', 1);
  SF.changed();
  L.active = true; L.reset();
  const r = L.runFor(40);
  check(near(r.edges.get(l.id).total, 30, 0.05) && near(r.nodes.get(m.id).outs.Desc_OreIron_C, 30, 0.05), 'belt and miner show 30/min after 40 s: ' + r.edges.get(l.id).total);
  L.active = false;
}


// ---------------------------------------------------------------- copy / blueprint must not touch the originals
{
  SF.load({ entities: [], links: [] });
  const a = SF.addEntity('Build_SmelterMk1_C', 40, 24, 0, 0, { recipe: 'Recipe_IngotIron_C' });
  const b = SF.addEntity('Build_ConstructorMk1_C', 60, 24, 0, 0, { recipe: 'Recipe_IronPlate_C' });
  const l = SF.addLink([a.id, 1], [b.id, 0], 'belt', 1);
  l.pts = [[50, 26]];
  SF.changed();
  const before = JSON.stringify(SF.serialize());
  const g = SF.makeGroup([a.id, b.id]);
  check(JSON.stringify(SF.serialize()) === before, 'copying (Ctrl+C / blueprint) leaves the original buildings and belts untouched');
  check(g.entities.length === 2 && g.links.length === 1 && Math.abs(g.entities[0].x - (40 - 50)) < 1e-9, 'the copied group is re-centred: ' + g.entities[0].x);
}
// ---------------------------------------------------------------- industrial storage: stacked connectors in 3D
{
  const d = SF.defs.Build_StorageContainerMk2_C;
  const ins = d.ports.filter(p => p.io === 'in');
  check(ins.every(p => p.y3 === 0) && ins.map(p => p.h3).sort().join() === '1,5' && ins[0].y !== ins[1].y, 'industrial container: 2D ports side by side, 3D ports centred at 1 m and 5 m');
  SF.load({ entities: [], links: [] });
  const c = SF.addEntity('Build_StorageContainerMk2_C', 0, 0, 1, 0, {});
  const P2 = SF.portWorld(c, 1), P3 = SF.portWorld3(c, 1);
  check(Math.abs(P3.y - P2.y) < 1e-9 && Math.abs(P3.x) < 1e-9 && Math.abs(P2.x) === 1, 'rotated container: 3D port moves to the centre line: ' + JSON.stringify([P2.x, P2.y, P3.x, P3.y]));
}
// ---------------------------------------------------------------- belt routing: no folds, right way into every port
{
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [Math.SQRT1_2, Math.SQRT1_2], [0.8, -0.6]];
  const res = {};
  for (const mode of ['curve', 'ortho']) {
    let bad = 0, n = 0, ex = '';
    for (const da of dirs) for (const db of dirs) for (let x = -12; x <= 12; x += 3) for (let y = -12; y <= 12; y += 3) {
      if (Math.hypot(x, y) < 3) continue;
      n++;
      const A = { x: 0, y: 0, dx: da[0], dy: da[1], h: 1 }, B = { x, y, dx: db[0], dy: db[1], h: 1 };
      const pts = SF.routePath(A, B, [], mode);
      const segs = [];
      for (let i = 1; i < pts.length; i++) { const dx = pts[i][0] - pts[i - 1][0], dy = pts[i][1] - pts[i - 1][1], l = Math.hypot(dx, dy); if (l > 1e-4) segs.push([dx / l, dy / l]); }
      let ok = segs.every((u, i) => !i || u[0] * segs[i - 1][0] + u[1] * segs[i - 1][1] > -0.2);
      const L = segs[segs.length - 1];
      if (mode === 'ortho') ok = ok && L[0] * -B.dx + L[1] * -B.dy > 0.5 && segs[0][0] * A.dx + segs[0][1] * A.dy > 0.5;
      if (!ok) { bad++; ex = `${da} -> (${x},${y}) ${db}`; }
    }
    res[mode] = bad;
    check(bad === 0, `${mode} belts never fold back or enter a port backwards (${bad}/${n} bad) ${ex}`);
  }
}
// ---------------------------------------------------------------- belts vs the game's placement rules
{
  const dirs = [];
  for (let k = 0; k < 8; k++) dirs.push([Math.round(Math.cos(k * Math.PI / 4) * 1e6) / 1e6, Math.round(Math.sin(k * Math.PI / 4) * 1e6) / 1e6]);
  for (const mode of ['curve', 'ortho', 'straight']) {
    let tight = 0, folds = 0, missed = 0, n = 0, ex = '';
    for (const da of dirs) for (const db of dirs) for (let x = -24; x <= 24; x += 6) for (let y = -24; y <= 24; y += 6) for (const dz of [0, 3]) {
      if (Math.hypot(x, y) < 4) continue;
      n++;
      const A = { x: 0, y: 0, dx: da[0], dy: da[1], h: 1 }, B = { x, y, dx: db[0], dy: db[1], h: 1 + dz };
      const pts = SF.routePath(A, B, [], mode);
      if (SF.pathMinRadius(pts) < 1.9) { tight++; ex = `${da} -> (${x},${y}) ${db}`; }
      for (let i = 2; i < pts.length; i++) {
        const ax = pts[i - 1][0] - pts[i - 2][0], ay = pts[i - 1][1] - pts[i - 2][1], bx = pts[i][0] - pts[i - 1][0], by = pts[i][1] - pts[i - 1][1];
        const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
        if (la > 1e-3 && lb > 1e-3 && (ax * bx + ay * by) / (la * lb) < -0.2) { folds++; break; }
      }
      // anything steeper than 35° must be reported
      if (Math.atan(SF.pathMaxSlope(pts)) * 180 / Math.PI > 35.5 && !SF.beltProblems(pts).some(p => p.code === 'steep')) missed++;
    }
    const name = SF.BELT_STYLES.find(s => s[0] === mode)[1];
    check(tight === 0, `${name} belts never turn tighter than the game's 2 m radius (${tight}/${n}) ${ex}`);
    check(folds === 0 && missed === 0, `${name} belts never fold back, and every over-steep belt is reported (${folds} folds, ${missed} unreported)`);
  }
  // climbing happens on straights, not in the turn (90° turn then a 3 m rise)
  const P = SF.routePath({ x: 0, y: 0, dx: 1, dy: 0, h: 1 }, { x: 10, y: 20, dx: 0, dy: 1, h: 4 }, [], 'ortho');
  check(!SF.beltProblems(P).length, 'a turn followed by a climb is buildable: ' + JSON.stringify(SF.beltProblems(P)));
  // rule checks
  const straight = n => Array.from({ length: n + 1 }, (_, i) => [i, 0, 1]);
  check(SF.beltProblems(straight(60)).some(p => p.code === 'long') && !SF.beltProblems(straight(56)).length, 'belts over 56 m are reported, 56 m is fine');
  check(SF.beltProblems([[0, 0, 1], [4, 0, 1], [8, 0, 5]]).some(p => p.code === 'steep'), '45° slope is reported');
  check(SF.BELT_STYLES.map(s => s[1]).join() === 'Default,Straight,Curve', 'belt style names match the game: ' + SF.BELT_STYLES.map(s => s[1]));
  // connection rules
  SF.load({ entities: [], links: [] });
  const sm = SF.addEntity('Build_SmelterMk1_C', 0, 0, 0, 0, { recipe: 'Recipe_IngotIron_C' });
  const c1 = SF.addEntity('Build_ConstructorMk1_C', 20, 0, 0, 0, { recipe: 'Recipe_IronPlate_C' });
  const ref = SF.addEntity('Build_OilRefinery_C', 40, 0, 0, 0, { recipe: 'Recipe_Plastic_C' });
  const fluidIn = SF.defs.Build_OilRefinery_C.ports.findIndex(p => p.io === 'in' && p.fluid);
  check(!SF.canConnect([sm.id, 1], [c1.id, 0]).error, 'output -> input connects');
  check(SF.canConnect([c1.id, 1], [sm.id, 0]).from[0] === c1.id, 'drawing from an output to an input in either order gives the right direction');
  check(SF.canConnect([sm.id, 0], [c1.id, 0]).error === 'Both ports are inputs', 'input -> input is refused');
  check(/belt port to a pipe/.test(SF.canConnect([sm.id, 1], [ref.id, fluidIn]).error), 'belt port -> pipe port is refused');
  check(SF.canConnect([sm.id, 1], [sm.id, 0]).error === 'Same building', 'a building cannot feed itself directly');
  SF.addLink([sm.id, 1], [c1.id, 0], 'belt', 1);
  check(SF.canConnect([sm.id, 1], [ref.id, 0]).error === 'Port already connected', 'one belt per connector');
  // conveyor lifts between floors: 4–48 m
  SF.load({ entities: [], links: [], levels: [{ name: 'A' }, { name: 'B' }] });
  const lo = SF.addEntity('Build_SmelterMk1_C', 0, 0, 0, 0, { recipe: 'Recipe_IngotIron_C' });
  const hi = SF.addEntity('Build_ConstructorMk1_C', 20, 0, 0, 1, { recipe: 'Recipe_IronPlate_C' });
  const lift = SF.addLink([lo.id, 1], [hi.id, 0], 'belt', 1);
  check(S.levels[1].z === 4, 'old plans get one wall height (4 m) per floor: ' + S.levels[1].z);
  check(!SF.linkProblems(lift).some(p => p.code === 'lift'), 'a one-floor (4 m) lift is buildable');
  S.levels[1].z = 60;
  check(SF.linkProblems(lift).some(p => p.code === 'lift'), 'a 60 m lift is reported (one lift reaches 48 m)');
  check(Math.abs(SF.linkLength(lift) - SF.pathLength(SF.linkPath3(lift)) - 60) < 1e-9, 'lift length follows the floor height');
  // new floors go one wall height above the top floor
  S.levels[1].z = 4;
  const n = SF.addLevel();
  check(SF.levelZ(n) === 8 && S.levels.length === 3, 'a new floor is one wall (4 m) above the top floor: ' + SF.levelZ(n));
}
// ---------------------------------------------------------------- every belt tier delivers its full rated amount in Sim mode
{
  const L = SF.live;
  const got = [];
  for (const b of D.belts) {
    SF.load({ entities: [], links: [] });
    const src = SF.addEntity('V_Source', 0, 0, 0, 0, { item: 'Desc_OreIron_C', rate: b.rate });
    const sk = SF.addEntity('V_Sink', 33, 0, 0, 0, {});
    const l = SF.addLink([src.id, 0], [sk.id, 0], 'belt', b.tier);
    SF.changed();
    L.active = true; L.reset(); L.runFor(120);
    const a = L.edges.get(l.id).st.cum.Desc_OreIron_C || 0; L.runFor(600);
    got.push([b.tier, b.rate, ((L.edges.get(l.id).st.cum.Desc_OreIron_C || 0) - a) / 10]);
  }
  L.active = false;
  check(got.every(([, r, v]) => Math.abs(v - r) <= 0.1), 'every belt tier carries its full rated amount when fed at capacity: ' + got.map(([t, r, v]) => `Mk${t} ${v}/${r}`).join(', '));
}
// ---------------------------------------------------------------- conveyor lifts between floors
{
  const L = SF.live;
  const build = (down) => {
    SF.load({ entities: [], links: [], levels: [{ name: 'Ground' }] });
    const lb = SF.addEntity('LiftBottom', 20, 0, 0, 0, {});
    const lt = SF.makeLift(lb, 1);
    const m = SF.addEntity('Build_MinerMk1_C', 0, 0, 0, down ? 1 : 0, { resource: 'Desc_OreIron_C', purity: 1, clock: 1 });
    const sm = SF.addEntity('Build_SmelterMk1_C', 40, 0, 0, down ? 0 : 1, { recipe: 'Recipe_IngotIron_C' });
    const sk = SF.addEntity('V_Sink', 60, 0, 0, down ? 0 : 1, {});
    if (!down) { SF.addLink([m.id, 0], [lb.id, 0], 'belt', 1); SF.addLink([lt.id, 1], [sm.id, 0], 'belt', 1); }
    else { SF.addLink([m.id, 0], [lt.id, 1], 'belt', 1); SF.addLink([lb.id, 0], [sm.id, 0], 'belt', 1); }
    SF.addLink([sm.id, 1], [sk.id, 0], 'belt', 1);
    SF.changed();
    return { lb, lt, sm };
  };
  for (const down of [false, true]) {
    const { lb, lt, sm } = build(down);
    const info = SF.liftOf(lb);
    check(S.levels.length === 2 && lt.level === 1 && info.height === 4, 'placing a lift adds its top one floor (4 m) up: ' + info.height);
    check(info.up === !down, `lift direction follows the belts (${down ? 'down' : 'up'})`);
    check(Math.abs(SF.linkLength(info.link) - 4) < 1e-9 && !SF.linkProblems(info.link).length, 'the vertical part is 4 m long and buildable');
    const fr = SF.sim.runSync();
    check(near(fr.nodes.get(sm.id).ins.Desc_OreIron_C, 30) && near(fr.edges.get(info.link.id).total, 30), `Free run: ore goes ${down ? 'down' : 'up'} the lift at 30/min`);
    L.active = true; L.reset(); L.runFor(900);
    const r = L.runFor(60);
    check(near(r.nodes.get(sm.id).outs.Desc_IronIngot_C || 0, 30, 0.5), `Sim: items travel ${down ? 'down' : 'up'} the lift (${r.nodes.get(sm.id).outs.Desc_IronIngot_C})`);
    L.active = false;
  }
  // with no belts the inspector's direction is used; each end's connector faces its own way
  {
    SF.load({ entities: [], links: [], levels: [{ name: 'Ground' }] });
    const b0 = SF.addEntity('LiftBottom', 0, 0, 0, 0, {}); const t0 = SF.makeLift(b0, 1);
    b0.liftDown = true; t0.rot = 2; SF.changed();
    const i0 = SF.liftOf(b0);
    check(!i0.up && !i0.fixed && i0.link.from[0] === t0.id, 'an unconnected lift can be switched to run down');
    check(t0.rot === 2 && b0.rot === 0, 'the top and bottom connectors keep their own facing');
    b0.x = 10; SF.changed();
    check(t0.x === 10, 'the top follows the bottom when it moves');
  }
  // a lift can span several floors; too tall is reported
  const { lb } = build(false);
  SF.addLevel(); SF.addLevel();
  const info = SF.liftOf(lb);
  lb.liftH = 60; SF.changed();
  check(SF.linkProblems(SF.liftOf(lb).link).some(p => p.code === 'lift'), 'a 60 m lift is reported (lifts reach 48 m)');
  // height in whole metres, independent of floors: a 6 m lift tops out 2 m above the 4 m floor
  lb.liftH = 6; SF.changed();
  {
    const i6 = SF.liftOf(lb);
    check(i6.height === 6 && i6.top.level === 1 && SF.portHeight(i6.top, 1) === 3, 'a 6 m lift: top on the 4 m floor with its connector 2 m higher: ' + SF.portHeight(i6.top, 1));
    check(Math.abs(SF.linkLength(i6.link) - 6) < 1e-9 && !SF.linkProblems(i6.link).length, 'its vertical part is 6 m and buildable');
    lb.liftH = 8; SF.changed();
    check(SF.liftOf(lb).top.level === 2 && SF.liftOf(lb).top.ph == null, 'an 8 m lift tops out exactly on the 8 m floor');
  }
  // the two ends belong together
  const g = SF.makeGroup([lb.id]);
  check(g.entities.length === 2 && g.links.some(l => l.kind === 'lift'), 'copying a lift bottom copies the whole lift');
  const made = SF.instantiate(g, 100, 0, 0, 0);
  const nb = made.find(e => e.def === 'LiftBottom');
  check(nb && SF.liftOf(nb) && SF.liftOf(nb).top !== info.top, 'a pasted lift is its own complete lift');
  const n0 = S.entities.size;
  SF.removeEntity(nb.id);
  check(S.entities.size === n0 - 2 && ![...S.links.values()].some(l => l.from[0] === nb.id || l.to[0] === nb.id), 'deleting one end removes the whole lift');
}
// ---------------------------------------------------------------- 3-storey building (foundations, walls, lifts)
{
  const t = SF.buildTower();
  const L = t.lifts.map(b => SF.liftOf(b));
  check(S.levels.length === 4 && L.length === 4 && L.filter(x => x.up).length === 3 && L.some(x => !x.up && x.height === 24),
    'building: 4 floors, 3 lifts up and one 24 m lift down');
  check(![...S.links.values()].some(l => SF.linkProblems(l).length), 'building: every belt and lift is buildable');
  const walls = [...S.entities.values()].filter(e => SF.defs[e.def].kind === 'wall');
  check(walls.some(e => e.dz === 8) && Math.max(...walls.map(e => SF.levelZ(e.level) + (e.dz || 0) + 4)) === 36, 'building: walls stacked to 36 m');
  const fr = SF.sim.runSync();
  check(near(fr.nodes.get(t.box.id).ins.Desc_IronPlateReinforced_C, 10) && [...t.sm, ...t.con, ...t.scr, ...t.asm].every(e => near(Object.values(fr.nodes.get(e.id).outs)[0], SF.defs[e.def] && D.recipes[e.recipe].out[0][1] * 60 / D.recipes[e.recipe].time)),
    'building: Free run — every machine at 100 %, 10 reinforced plates/min reach the ground floor');
  const live = SF.live; live.active = true; live.reset(); live.runFor(6600);
  const r = live.runFor(120);
  check(near(r.nodes.get(t.box.id).ins.Desc_IronPlateReinforced_C, 10, 0.05), 'building: Sim reaches 10/min once the buffers are full: ' + r.nodes.get(t.box.id).ins.Desc_IronPlateReinforced_C);
  live.active = false;
}
// ---------------------------------------------------------------- production calculator + unlocks
{
  const C = SF.calc;
  let r = C.solve([{ item: 'Desc_IronPlateReinforced_C', rate: 10 }]);
  const n = id => (r.steps.find(s => s.def === id && s.item) || {});
  check(r.steps.length === 5 && r.totals.count === 14 && near(r.raw.Desc_OreIron_C, 120) && near(r.totals.power, 78), 'calculator: 10 reinforced plates = 14 machines, 120 iron ore, 78 MW');
  r = C.solve([{ item: 'Desc_IronPlateReinforced_C', rate: 10 }], { recipes: { Desc_IronScrew_C: 'Recipe_Alternate_Screw_C' }, inputs: ['Desc_IronIngot_C'] });
  check(near(r.imports.Desc_IronIngot_C, 120) && r.steps.some(s => s.rid === 'Recipe_Alternate_Screw_C' && near(s.clock, 0.8)), 'calculator: alternate recipe + item supplied from elsewhere');
  r = C.solve([{ item: 'Desc_Plastic_C', rate: 60 }]);
  check(near(r.raw.Desc_LiquidOil_C, 90) && near(r.surplus.Desc_HeavyOilResidue_C, 30), 'calculator: byproducts are reported (heavy oil from plastic)');
  r = C.solve([{ item: 'Desc_Rubber_C', rate: 60 }], { recipes: { Desc_Rubber_C: 'Recipe_Alternate_RecycledRubber_C', Desc_Plastic_C: 'Recipe_Alternate_Plastic_1_C' } });
  check(r.converged && near(r.raw.Desc_LiquidOil_C, 90), 'calculator: recipe loops (recycled rubber/plastic) settle');
  SF.progress.set({ mode: 'custom', tier: 2, mam: [], alts: [] });
  check(!SF.recipeUnlocked('Recipe_Motor_C') && SF.recipeUnlocked('Recipe_IronPlateReinforced_C') && !SF.buildingUnlocked('Build_FoundryMk1_C') && !SF.tierUnlocked('belt', 3) && SF.tierUnlocked('belt', 2),
    'unlocks: tier 2 has assemblers and Mk2 belts, not motors, foundries or Mk3 belts');
  check(SF.calc.defaultRecipe('Desc_IronScrew_C') === 'Recipe_Screw_C' && !SF.recipeUnlocked('Recipe_Alternate_Screw_C'), 'unlocks: alternates are locked until ticked');
  SF.progress.set({ alts: [SF.altSchematicOf('Recipe_Alternate_Screw_C')] });
  check(SF.recipeUnlocked('Recipe_Alternate_Screw_C'), 'unlocks: ticking an alternate unlocks it');
  const ex = C.extractOptions('Desc_OreIron_C', 300);
  check(ex.length === 3 && ex.every(o => o.def === 'Build_MinerMk1_C') && ex[1].nodes === 5, 'raw budget: tier 2 suggests Mk1 miners (5 normal nodes for 300/min)');
  SF.progress.set({ mode: 'all', tier: 9, mam: [], alts: [] });
  // placing a plan: next to the existing factory, every machine at its planned clock
  SF.buildExample();
  const res = SF.placePlan('Motors', [{ item: 'Desc_Motor_C', rate: 5 }], { choose: C.defaultRecipe, inputs: ['Desc_SteelIngot_C'], miner: { def: 'Build_MinerMk2_C', purity: 1 } });
  const fr = SF.sim.runSync();
  const sink = [...S.entities.values()].find(e => e.name === 'Product: Motor');
  check(near(fr.nodes.get(sink.id).ins.Desc_Motor_C, 5) && res.bounds.x0 > 160, 'calculator: placed motor line makes 5/min beside the example factory');
  const rb = C.rawBudget();
  check(rb.every(x => Math.abs(x.short) < 0.01), 'raw budget: placed lines mine exactly what they use');
}
// ---------------------------------------------------------------- fluids: head lift
{
  const run = (z, pump) => {
    SF.load({ entities: [], links: [], levels: [{ name: 'G', z: 0 }, { name: 'Up', z }] });
    const w = SF.addEntity('Build_WaterPump_C', 0, 0, 0, 0, { clock: 1 });
    const sk = SF.addEntity('V_SinkF', 40, 0, 0, 1, {});
    let from = [w.id, 0];
    if (pump) { const p = SF.addEntity(pump, 20, 0, 0, 0, {}); SF.addLink(from, [p.id, 0], 'pipe', 1); from = [p.id, 1]; }
    const l = SF.addLink(from, [sk.id, 0], 'pipe', 1);
    SF.changed();
    const fr = SF.sim.runSync();
    return { got: fr.nodes.get(sk.id).ins.Desc_Water_C || 0, pr: SF.linkProblems(l).filter(p => p.code === 'head') };
  };
  let t = run(8);
  check(near(t.got, 120) && !t.pr.length, 'head lift: a water extractor lifts 9 m fine');
  t = run(20);
  check(t.got === 0 && t.pr.length === 1, 'head lift: 21 m above the extractor nothing flows, and it says so');
  t = run(20, 'Build_PipelinePump_C');
  check(near(t.got, 120) && !t.pr.length, 'head lift: a Mk1 pump lifts it 20 m');
  t = run(40, 'Build_PipelinePump_C');
  check(t.got === 0 && t.pr.length === 1, 'head lift: 40 m is too much for a Mk1 pump');
  t = run(40, 'Build_PipelinePumpMk2_C');
  check(near(t.got, 120), 'head lift: a Mk2 pump lifts it 40 m');
}
// ---------------------------------------------------------------- Sim mode: skip ahead (async, in slices)
(async () => {
  const L = SF.live;
  SF.buildExample(); L.active = true; L.reset();
  const ok = await L.skipTo(600);
  check(ok && Math.abs(L.t - 600) < 0.05, 'skip to 10 min lands on 10:00: ' + L.t);
  const box = [...S.entities.values()].find(e => e.def === 'Build_StorageContainerMk2_C');
  const at10 = L.nodes.get(box.id).st.inv.Desc_IronPlateReinforced_C || 0;
  L.reset(); L.runFor(600);
  check((L.nodes.get(box.id).st.inv.Desc_IronPlateReinforced_C || 0) === at10, 'skipping gives exactly the same factory as running normally: ' + at10);
  await L.skipTo(1200); const ok2 = await L.skipTo(300);
  check(ok2 && Math.abs(L.t - 300) < 0.05, 'skipping to an earlier time restarts from 0:00:00');
  L.active = false;
  finish();
})();
function finish() {
console.log(`\n${checks - fails}/${checks} checks passed${fails ? ` — ${fails} FAILED` : ''}`);
process.exit(fails ? 1 : 0);
}
