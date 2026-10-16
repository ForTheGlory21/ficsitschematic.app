// Sim-mode stress test on the generated factories (web/js/scenarios.js).
// node tools/stress_sim.js [scenario ids...]   (default: all)
// For each factory: build + Free run reference, Sim speed, time to saturate, exact rates of every machine /
// belt / splitter output against Free run, live readout accuracy, item conservation, power and memory.
global.window = global;
global.localStorage = { getItem() { return null; }, setItem() {} };
const W = __dirname + '/../web/';
['data.js', 'js/defs.js', 'js/model.js', 'js/sim.js', 'js/livesim.js', 'js/scenarios.js'].forEach(f => require(W + f));
const SF = window.SF, S = SF.state, L = SF.live;
const ids = process.argv.slice(2).length ? process.argv.slice(2) : SF.SCENARIOS.map(s => s.id);
const MAX_HOURS = +(process.env.MAX_HOURS || 12);
const ms = t => `${t.toFixed(0)} ms`;
const fmtT = s => `${Math.floor(s / 3600)}h${String(Math.floor(s / 60) % 60).padStart(2, '0')}m`;
const summary = [];

for (const id of ids) {
  const out = [];
  const log = s => { out.push(s); console.log(s); };
  let t = performance.now();
  const b = SF.buildScenario(id);
  const tBuild = performance.now() - t;
  t = performance.now();
  const fr = SF.sim.runSync();
  const tFree = performance.now() - t;
  const machines = [...S.entities.values()].filter(e => ['machine', 'extractor', 'generator'].includes(SF.defs[e.def].kind));
  log(`\n=== ${b.scenario.name} ===`);
  log(`size: ${S.entities.size} objects, ${S.links.size} belts/pipes, ${machines.length} machines/extractors/generators`);
  log(`build ${ms(tBuild)} · Free run ${ms(tFree)} (${fr.settleSteps} steps) · Free run machines below 99.5%: ${machines.filter(e => fr.nodes.get(e.id).eff < 0.995).length}`);

  // ---- speed
  L.active = true; L.reset();
  t = performance.now(); L.runFor(600); const t10 = performance.now() - t;
  const perSimSec = t10 / 600;
  t = performance.now(); for (let k = 0; k < 5; k++) L.runFor(0); const tPub = (performance.now() - t) / 5;
  const maxSpeed = 1000 / perSimSec;                         // sim seconds per real second on one core
  log(`speed: ${perSimSec.toFixed(2)} ms per sim-second → up to ~${maxSpeed.toFixed(0)}× real time (the UI also needs frame time) · one live update ${ms(tPub)}`);

  // ---- run until every machine matches Free run over a 10-minute window
  const cumProd = () => new Map(machines.map(e => [e.id, { ...L.nodes.get(e.id).st.cum.prod }]));
  const machineOff = (a, bb, span) => {
    const off = [];
    for (const e of machines) {
      const f = fr.nodes.get(e.id).outs, x = a.get(e.id), y = bb.get(e.id);
      // outputs arrive a whole craft at a time, so a window can be one craft short or over: allow that
      const r = e.recipe && SF.D.recipes[e.recipe];
      const batch = it => (r ? (r.out.find(o => o[0] === it) || [0, 1])[1] : 1);
      for (const it in f) { const v = ((y[it] || 0) - (x[it] || 0)) / span * 60; if (Math.abs(v - f[it]) > Math.max(0.01, f[it] * 0.005, batch(it) * 60 / span + 1e-9)) off.push({ e, it, v, f: f[it] }); }
    }
    return off;
  };
  let satAt = null, off = [];
  t = performance.now();
  while (L.t < MAX_HOURS * 3600) {
    const a = cumProd(); L.runFor(600); const bb = cumProd();
    off = machineOff(a, bb, 600);
    if (!off.length) { satAt = L.t; break; }
  }
  const tSat = performance.now() - t;
  log(`saturation: ${satAt ? `every machine at its Free run rate by ${fmtT(satAt)} sim time` : `NOT reached in ${MAX_HOURS} h — ${off.length} machine outputs still off`} (computed in ${(tSat / 1000).toFixed(1)} s)`);
  if (!satAt) off.slice(0, 6).forEach(o => log(`   ${SF.defs[o.e.def].name} (${o.e.x},${o.e.y}) ${SF.itemName(o.it)} ${o.v.toFixed(3)} vs ${o.f.toFixed(3)}`));

  // ---- exact rates over a 20-minute window: machines, every belt/pipe (so every splitter output), power
  const ea = new Map([...L.edges].map(([lid, ed]) => [lid, { ...ed.st.cum }]));
  const pa = cumProd();
  const energyA = new Map(machines.map(e => [e.id, L.nodes.get(e.id).st.energy || 0]));
  const busyA = new Map(machines.map(e => [e.id, L.nodes.get(e.id).st.busy]));
  L.runFor(1200);
  const pb = cumProd();
  const mOff = machineOff(pa, pb, 1200);
  let eOff = 0, eWorst = '', splitterOuts = 0;
  for (const [lid, ed] of L.edges) {
    const f = fr.edges.get(lid).total;
    const tot = Object.keys(ed.st.cum).reduce((s, it) => s + (ed.st.cum[it] - (ea.get(lid)[it] || 0)), 0) / 1200 * 60;
    if (ed.from.kind === 'splitter') splitterOuts++;
    if (Math.abs(tot - f) > Math.max(0.01, f * 0.005)) { eOff++; eWorst = `${SF.defs[ed.from.e.def].name} -> ${SF.defs[ed.to.e.def].name}: ${tot.toFixed(3)} vs ${f.toFixed(3)}`; }
  }
  let use = 0, gen = 0;
  for (const e of machines) {
    const n = L.nodes.get(e.id);
    if (n.kind === 'generator') gen += ((n.st.energy || 0) - energyA.get(e.id)) / 1200;
    else if (n.power) use += n.power * Math.min(1, (n.st.busy - busyA.get(e.id)) / 1200);
  }
  log(`rates (20 min window): machine outputs off by >0.5%: ${mOff.length}/${machines.length} · belts/pipes off: ${eOff}/${L.edges.size} (incl. ${splitterOuts} splitter outputs)${eWorst ? ' e.g. ' + eWorst : ''}`);
  log(`power: use ${use.toFixed(1)} MW (Free run ${fr.summary.powerUse.toFixed(1)}) · generated ${gen.toFixed(1)} MW (Free run ${fr.summary.powerGen.toFixed(1)})`);
  const prods = b.roots.map(rt => { const n = L.nodes.get(rt.box); return `${SF.itemName(rt.item)} ${(n.st.cum.cons[rt.item] || 0).toFixed(0)} delivered (${(fr.nodes.get(rt.box).ins[rt.item] || 0).toFixed(2)}/min target)`; });
  const pts = b.roots.reduce((s2, rt) => s2 + (L.nodes.get(rt.box).st.cum.cons[rt.item] || 0) * (SF.item(rt.item).sink || 0), 0);
  log(`products: ${prods.join(' · ')} · ${pts.toFixed(0)} sink points`);

  // ---- live readouts every second for a minute (what the UI shows)
  let liveOff = 0, liveN = 0;
  for (let k = 0; k < 60; k++) {
    const r = L.runFor(1);
    for (const [lid, e] of r.edges) { liveN++; const f = fr.edges.get(lid).total; if (Math.abs(e.total - f) > Math.max(0.02, f * 0.01)) liveOff++; }
    for (const e of machines) { const x = r.nodes.get(e.id), f = fr.nodes.get(e.id).outs; for (const it in f) { liveN++; if (Math.abs((x.outs[it] || 0) - f[it]) > Math.max(0.02, f[it] * 0.01)) liveOff++; } }
  }
  log(`live readouts: ${liveOff}/${liveN} per-second readings off by >1%`);

  // ---- conservation: everything produced is consumed, on a belt, in a pipe or inside a building
  const prod = {}, cons = {}, held = {};
  const add = (m, k, v) => { m[k] = (m[k] || 0) + v; };
  for (const n of L.nodes.values()) {
    const st = n.st;
    if (!['storage', 'sink', 'vsink'].includes(n.kind)) { for (const k in st.cum.prod) add(prod, k, st.cum.prod[k]); for (const k in st.cum.cons) add(cons, k, st.cum.cons[k]); }
    if (['sink', 'vsink'].includes(n.kind)) for (const k in st.cum.cons) add(cons, k, st.cum.cons[k]);
    for (const k in st.inv) add(held, k, st.inv[k]);
    for (const k in st.out) add(held, k, st.out[k]);
    if (st.buf) add(held, st.buf, 1);
    if (st.pool) for (const k in st.pool) add(held, k, st.pool[k]);
  }
  for (const ed of L.edges.values()) { if (ed.kind === 'belt') ed.items.forEach(x => add(held, x.it, 1)); else for (const k in ed.vol) add(held, k, ed.vol[k]); }
  const leaks = Object.keys(prod).filter(k => Math.abs(prod[k] - (cons[k] || 0) - (held[k] || 0)) > (SF.item(k).fluid ? 0.01 * prod[k] + 1 : 1e-6));
  log(`conservation: ${leaks.length ? 'LEAK in ' + leaks.map(k => `${SF.itemName(k)} (made ${prod[k].toFixed(1)}, used ${(cons[k] || 0).toFixed(1)}, held ${(held[k] || 0).toFixed(1)})`).join(', ') : `every item accounted for (${Object.keys(prod).length} item types)`}`);
  const mem = process.memoryUsage();
  log(`memory: heap ${(mem.heapUsed / 1048576).toFixed(0)} MB · items on belts ${L.itemsOnBelts()} · sim time ${fmtT(L.t)}`);
  summary.push({ id, objects: S.entities.size, perSimSec, maxSpeed, satAt, mOff: mOff.length, eOff, liveOff, liveN, leaks: leaks.length, tFree, tBuild });
  L.active = false;
}

console.log('\n=== summary ===');
console.log('factory  objects  ms/sim-s  max speed  saturated  machines off  belts off  live off  leaks  free run');
for (const s of summary) console.log(`${s.id.padEnd(8)} ${String(s.objects).padStart(7)}  ${s.perSimSec.toFixed(2).padStart(8)}  ${(s.maxSpeed.toFixed(0) + '×').padStart(9)}  ${(s.satAt ? fmtT(s.satAt) : 'no').padStart(9)}  ${String(s.mOff).padStart(12)}  ${String(s.eOff).padStart(9)}  ${String(s.liveOff).padStart(8)}  ${String(s.leaks).padStart(5)}  ${(s.tFree / 1000).toFixed(1)} s`);
