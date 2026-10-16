// Sim mode: real-time, item-by-item factory simulation.
// Belts carry individual items at real speed (1.2 m minimum spacing), machines run real crafting cycles
// with stack-limited input/output slots, storage fills real slots, generators burn real fuel (power is
// reported but never limits machines). Results are published in the same shape as the free-run
// calculator (SF.sim.result) so every existing readout works in Sim mode.
(function (SF) {
  const S = SF.state, D = SF.D;
  const DT = 1 / 30;            // fixed simulation step (s)
  const SPACING = 1.2;          // metres between items on a full belt (Mk1 1.2 m/s -> 60/min)
  const WINDOW = 60;            // seconds of sim time used for live rates
  const FLUID_BUF = 50;         // m3 machine fluid slot (game default)
  // Sim mode behaves like the game: an unconnected output or a belt that leads nowhere backs up
  // (items stay in the machine / on the belt). The 'spill' option only applies to Free run.
  const SPILL = false;

  const live = SF.live = {
    active: false, running: false, speed: 1, t: 0,
    nodes: new Map(), edges: new Map(),
    keep: new Map(),            // entity id -> persistent state (survives edits)
    keepBelts: new Map(),       // link id -> persistent belt contents
    builtVersion: -1, powerHist: [], listeners: [],
  };
  live.onUpdate = fn => live.listeners.push(fn);

  const stackOf = it => (SF.item(it).fluid ? FLUID_BUF : (SF.item(it).stack || 100));
  const add = (m, k, v) => { m[k] = (m[k] || 0) + v; };

  // ------------------------------------------------------------ fast rate measurement
  // Every item leaving a belt and every finished craft is time-stamped. In a steady factory these events repeat
  // with a fixed rhythm (e.g. 4 screws every 6 s), so measuring between two events at the same point of that
  // rhythm gives the exact rate after a couple of cycles instead of averaging over a long window.
  const EV_KEEP = 90, EV_MAX = 2000, EV_MIN_SPAN = 6;
  function logEv(ev, x) {
    ev.push(x);
    const t = typeof x === 'number' ? x : x[0];
    // keep the last 90 s, but always at least 64 events so slow belts (an item every 30 s) still show a pattern
    while (ev.length > EV_MAX || (ev.length > 64 && t - (typeof ev[0] === 'number' ? ev[0] : ev[0][0]) > EV_KEEP)) ev.shift();
  }
  // Find the repeating pattern of an event stream: the smallest b such that the last gaps repeat every b events
  // (the sim runs in fixed steps, so a steady flow is exactly periodic). 0 = no pattern yet (still changing).
  // does the stream repeat every b events? 1 = yes, 0 = no, -1 = not enough history yet
  function periodHolds(ev, b) {
    const n = ev.length, T = k => (typeof ev[k] === 'number' ? ev[k] : ev[k][0]);
    const tol = DT * 0.6, last = T(n - 1);
    let k = n - 1, cnt = 0;
    // the pattern must hold for at least 15 s of history (and at least a full period), not just a few events
    for (; k - b >= 1 && (cnt < Math.max(b, 4) || last - T(k) < 15); k--, cnt++) {
      if (Math.abs((T(k) - T(k - 1)) - (T(k - b) - T(k - b - 1))) > tol) return 0;
    }
    return cnt < Math.max(b, 4) || last - T(k) < 15 ? -1 : 1;
  }
  function findPeriod(ev, maxB = 96) {
    const n = ev.length;
    if (n < 2) return 0;
    const lastT = typeof ev[n - 1] === 'number' ? ev[n - 1] : ev[n - 1][0];
    if (ev._pN === n && ev._pT === lastT) return ev._p;         // nothing new since last time
    let p = 0;
    if (ev._p > 0 && periodHolds(ev, ev._p) === 1) p = ev._p;   // the known pattern usually still holds
    else {
      for (let b = 1; b <= maxB; b++) {
        const h = periodHolds(ev, b);
        if (h === 1) { p = b; break; }
        if (h === -1) break;
      }
    }
    ev._p = p; ev._pN = n; ev._pT = lastT;
    return p;
  }
  // -> { perMin, i0, i1 } or null. A whole number of periods is measured, so a steady flow reads exactly;
  // without a pattern (flow still changing, or many merged sources) the last ~40 s are averaged.
  function eventRate(ev, now) {
    const T = k => (typeof ev[k] === 'number' ? ev[k] : ev[k][0]);
    const i = ev.length - 1;
    if (i < 1) return null;
    const b = findPeriod(ev);
    let m;
    if (b) { m = b; while (i - m - b >= 0 && T(i) - T(i - m) < EV_MIN_SPAN) m += b; }
    else { m = 1; while (i - m - 1 >= 0 && (T(i) - T(i - m) < 40 || m < 8)) m++; }
    let span = T(i) - T(i - m);
    if (span <= 1e-9) return null;
    const per = span / m;                                 // average time between events
    const quiet = now - T(i);
    const longestGap = b ? Math.max(...Array.from({ length: b }, (_, k) => T(i - k) - T(i - k - 1))) : per;
    if (quiet > Math.max(longestGap * 3, 3)) return { perMin: 0, i0: i - m + 1, i1: i, exact: true };   // stopped
    if (quiet > longestGap * 1.5) span = now - T(i - m) - longestGap * 0.5;                  // slowing down
    return { perMin: m / span * 60, i0: i - m + 1, i1: i, exact: !!b && quiet <= longestGap * 1.5 };
  }

  // ------------------------------------------------------------ edges
  function makeBelt(l, from, fp, to, tp, prev) {
    const spec = SF.linkSpec(l);
    const len = Math.max(0.6, SF.linkLength(l));
    const v = (D.belts.find(b => b.tier === l.tier) || D.belts[0]).speed;     // m/s
    const items = prev && prev.items ? prev.items.map(x => ({ it: x.it, s: Math.min(x.s, len) })) : [];
    // keep spacing valid after a length change
    for (let i = 1; i < items.length; i++) items[i].s = Math.min(items[i].s, items[i - 1].s - SPACING);
    while (items.length && items[items.length - 1].s < 0) items.pop();
    return { l, kind: 'belt', from, fp, to, tp, len, v, cap: spec.rate, items, ev: prev && prev.ev || [], st: prev && prev.st || { cum: {}, snaps: [] } };
  }
  function makePipe(l, from, fp, to, tp, prev) {
    const spec = SF.linkSpec(l);
    const len = Math.max(0.6, SF.linkLength(l));
    const hf = SF.pipeFactor(l);                                                // head lift: too high = less or no flow
    const rate = spec.rate * hf / 60;                                           // m3/s
    return { l, kind: 'pipe', from, fp, to, tp, len, rate, cap: spec.rate * hf, headFactor: hf, vol: prev && prev.vol ? { ...prev.vol } : {},
      max: Math.max(len * 0.1, rate * 0.5), st: prev && prev.st || { cum: {}, snaps: [] }, budget: 0 };
  }
  const beltRoom = ed => !ed.items.length || ed.items[ed.items.length - 1].s >= SPACING - 1e-9;
  // a new item starts exactly one spacing behind the last one (it may have entered part-way through this step),
  // so a fully loaded belt carries its full rated throughput instead of losing a fraction every gap
  const beltEnter = (ed, it) => {
    const last = ed.items[ed.items.length - 1];
    const s = last ? Math.min(Math.max(0, last.s - SPACING), ed.v * DT) : 0;
    ed.items.push({ it, s });
  };
  const beltHead = ed => (ed.items.length && ed.items[0].s >= ed.len - 1e-6 ? ed.items[0].it : null);
  const beltTake = ed => { const x = ed.items.shift(); ed.packed = 0; add(ed.st.cum, x.it, 1); logEv(ed.ev, [live.t, x.it]); return x.it; };
  const pipeVol = ed => (ed.vt ??= Object.values(ed.vol).reduce((a, b) => a + b, 0));
  function pipePush(ed, it, amt) {           // returns amount accepted
    const a = Math.max(0, Math.min(amt, ed.max - pipeVol(ed), ed.budget));
    if (a <= 0) return 0;
    add(ed.vol, it, a); ed.budget -= a; ed.vt = pipeVol(ed) + a;
    return a;
  }
  function pipePull(ed, accept) {            // accept(item, amount) -> amount taken
    let budget = ed.rate * DT;
    for (const it of Object.keys(ed.vol)) {
      const want = Math.min(ed.vol[it], budget);
      if (want <= 1e-9) continue;
      const got = accept(it, want);
      ed.vol[it] -= got; budget -= got; ed.vt = pipeVol(ed) - got;
      add(ed.st.cum, it, got);
      if (ed.vol[it] < 1e-9) delete ed.vol[it];
    }
  }

  // ------------------------------------------------------------ nodes
  function baseNode(e, d, st) {
    return { e, d, kind: d.kind, inE: [], outE: [], ins: [], outs: [], st };
  }
  function freshState() {
    return { inv: {}, out: {}, cum: { prod: {}, cons: {}, void: {} }, busy: 0, snaps: [], ev: [], running: false, timer: 0, rr: 0, buf: null };
  }
  // push one item from `inv` onto a belt/void; returns true if it left
  function emitSolid(n, port, it) {
    const ed = n.outE[port];
    if (ed) { if (beltRoom(ed)) { beltEnter(ed, it); return true; } return false; }
    if (SPILL) { add(n.st.cum.void, it, 1); return true; }
    return false;
  }
  function emitFluid(n, port, it, amt) {
    const ed = n.outE[port];
    if (ed) return pipePush(ed, it, amt);
    if (SPILL) { add(n.st.cum.void, it, amt); return amt; }
    return 0;
  }

  function machine(n) {
    const { e, d, st } = n;
    const r = D.recipes[e.recipe];
    if (!r) { n.noRecipe = true; n.step = () => {}; return n; }
    const mult = d.raw.sloops ? 1 + (e.sloops || 0) / d.raw.sloops : 1;
    const cycle = r.time / (e.clock ?? 1);
    n.cycle = cycle; n.r = r; n.mult = mult;
    n.maxIn = Object.fromEntries(r.in.map(([i, a]) => [i, a * 60 / cycle]));
    n.maxOut = Object.fromEntries(r.out.map(([i, a]) => [i, a * mult * 60 / cycle]));
    n.power = SF.machinePower(e, d);
    // drop leftovers that are not part of the current recipe
    for (const k of Object.keys(st.inv)) if (!r.in.some(([i]) => i === k)) delete st.inv[k];
    for (const k of Object.keys(st.out)) if (!r.out.some(([i]) => i === k)) delete st.out[k];
    // output port -> product
    const outPorts = d.ports.map((p, i) => ({ p, i })).filter(x => x.p.io === 'out');
    const sol = r.out.filter(([i]) => !SF.item(i).fluid), flu = r.out.filter(([i]) => SF.item(i).fluid);
    n.portItem = {};
    outPorts.filter(x => !x.p.fluid).forEach((x, k) => { if (sol[k]) n.portItem[x.i] = sol[k][0]; });
    outPorts.filter(x => x.p.fluid).forEach((x, k) => { if (flu[k]) n.portItem[x.i] = flu[k][0]; });
    const inCap = new Map(r.in.map(([i, a]) => [i, Math.max(stackOf(i), a * 2)]));
    const outCap = new Map(r.out.map(([i, a]) => [i, Math.max(stackOf(i), a * mult * 2)]));
    const capIn = i => inCap.get(i) || stackOf(i);
    const capOut = i => outCap.get(i) || stackOf(i);
    n.capIn = capIn; n.capOut = capOut;
    const outAmt = r.out.map(([i, a]) => [i, a * mult, outCap.get(i)]);
    const emitList = Object.entries(n.portItem).map(([pi, it]) => [+pi, it, !!SF.item(it).fluid]);
    // crafting cycle: ingredients leave at the start, products appear at the end.
    const tryStart = () => {
      let haveIn = true, roomOut = true;
      for (const [i, a] of r.in) if ((st.inv[i] || 0) < a - 1e-9) { haveIn = false; break; }
      for (const [i, a, c] of outAmt) if ((st.out[i] || 0) + a > c + 1e-9) { roomOut = false; break; }
      if (!(haveIn && roomOut)) { n.state = haveIn ? 'blocked' : 'starved'; return false; }
      for (const [i, a] of r.in) { st.inv[i] -= a; add(st.cum.cons, i, a); }
      st.running = true;
      return true;
    };
    const pipeAccept = (it, amt) => {
      const c = inCap.get(it);
      if (c == null) return 0;
      const take = Math.min(amt, c - (st.inv[it] || 0));
      if (take > 0) add(st.inv, it, take);
      return Math.max(0, take);
    };
    n.step = () => {
      // pull ingredients from belts / pipes
      for (const ed of n.ins) {
        if (ed.kind === 'belt') {
          const it = beltHead(ed);
          if (it) { const c = inCap.get(it); if (c != null && (st.inv[it] || 0) + 1 <= c) { beltTake(ed); add(st.inv, it, 1); } }
        } else pipePull(ed, pipeAccept);
      }
      // Leftover time carries into the next cycle so cycles are exactly r.time / clock long.
      n.state = 'idle';
      if (!st.running) { st.timer = 0; tryStart(); }
      if (st.running) {
        st.timer += DT; st.busy += DT; n.state = 'ok';
        while (st.running && st.timer >= cycle - 1e-7) {
          for (const [i, a] of outAmt) { add(st.out, i, a); add(st.cum.prod, i, a); }
          logEv(st.ev, live.t - Math.max(0, st.timer - cycle));
          st.running = false; st.timer -= cycle;
          if (tryStart()) n.state = 'ok';
          else { st.busy -= Math.max(0, st.timer); st.timer = 0; }
        }
      }
      // push products
      for (const [pi, it, fluid] of emitList) {
        if (fluid) {
          if ((st.out[it] || 0) > 0) st.out[it] -= emitFluid(n, pi, it, Math.min(st.out[it], (n.outE[pi] ? n.outE[pi].rate : 1e9) * DT));
        } else if ((st.out[it] || 0) >= 1 && emitSolid(n, pi, it)) st.out[it] -= 1;
      }
    };
    n.progress = () => (st.running ? st.timer / cycle : 0);
    return n;
  }

  function extractor(n) {
    const { e, d, st } = n;
    const b = d.raw;
    const it = e.resource;
    const perSec = b.rate * (b.purity ? (e.purity ?? 1) : 1) * (e.clock ?? 1) / 60;
    n.maxOut = { [it]: perSec * 60 };
    n.power = SF.machinePower(e, d);
    const fluid = b.fluidOut;
    const cap = fluid ? FLUID_BUF : stackOf(it);
    n.step = () => {
      if (!it) return;
      if ((st.out[it] || 0) + (fluid ? perSec * DT : 1) <= cap + 1e-9) {
        st.timer += DT; st.busy += DT; n.state = 'ok';
        if (fluid) { add(st.out, it, perSec * DT); add(st.cum.prod, it, perSec * DT); }
        else if (st.timer >= 1 / perSec - 1e-7) { st.timer -= 1 / perSec; add(st.out, it, 1); add(st.cum.prod, it, 1); logEv(st.ev, live.t - st.timer); }
      } else n.state = 'blocked';
      if (fluid) { if ((st.out[it] || 0) > 0) st.out[it] -= emitFluid(n, 0, it, st.out[it]); }
      else if ((st.out[it] || 0) >= 1 && emitSolid(n, 0, it)) st.out[it] -= 1;
    };
    n.progress = () => (fluid ? 0 : Math.min(1, st.timer * perSec));
    return n;
  }

  function generator(n) {
    const { e, d, st } = n;
    const b = d.raw;
    if (b.geo) { n.P = b.produce * (e.purity ?? 1); n.step = () => { n.gen = n.P; st.busy += DT; st.energy = (st.energy || 0) + n.P * DT; n.state = 'ok'; }; return n; }
    const f = b.fuels.find(x => x.fuel === e.fuel);
    if (!f) { n.noFuel = true; n.step = () => { n.gen = 0; }; return n; }
    const P = b.produce * (e.clock ?? 1);
    const energy = SF.item(f.fuel).energy || 1;
    const fluidFuel = SF.item(f.fuel).fluid;
    const suppRate = f.supp ? P * b.suppRatio / 1000 : 0;          // m3/s
    n.P = P; n.fuel = f.fuel;
    n.maxIn = { [f.fuel]: P / energy * 60 };
    if (f.supp) n.maxIn[f.supp] = suppRate * 60;
    if (f.by) n.maxOut = { [f.by]: P / energy * f.byAmt * 60 };
    const byPort = d.ports.findIndex(p => p.io === 'out');
    for (const k of Object.keys(st.inv)) if (k !== f.fuel && k !== f.supp) delete st.inv[k];
    n.step = () => {
      for (const ed of n.ins) {
        if (ed.kind === 'belt') {
          const it = beltHead(ed);
          if (it === f.fuel && (st.inv[it] || 0) + 1 <= stackOf(it)) { beltTake(ed); add(st.inv, it, 1); }
        } else {
          pipePull(ed, (it, amt) => {
            if (it !== f.fuel && it !== f.supp) return 0;
            const take = Math.min(amt, FLUID_BUF - (st.inv[it] || 0));
            if (take > 0) add(st.inv, it, take);
            return Math.max(0, take);
          });
        }
      }
      n.gen = 0;
      const water = !f.supp || (st.inv[f.supp] || 0) >= suppRate * DT - 1e-9;
      if (fluidFuel) {
        const need = P / energy * DT;
        if ((st.inv[f.fuel] || 0) >= need - 1e-9 && water) {
          st.inv[f.fuel] -= need; add(st.cum.cons, f.fuel, need); n.gen = P;
        }
      } else {
        // load the next item just before the current one runs out, so burning is seamless
        if ((st.burn || 0) < DT - 1e-9 && (st.inv[f.fuel] || 0) >= 1 && water) {
          st.inv[f.fuel] -= 1; add(st.cum.cons, f.fuel, 1); st.burn = (st.burn || 0) + energy / P;
          if (f.by) { add(st.out, f.by, f.byAmt); add(st.cum.prod, f.by, f.byAmt); }
        }
        if ((st.burn || 0) > 1e-9 && water) { const d = Math.min(DT, st.burn); st.burn -= d; n.gen = P * d / DT; }
      }
      if (n.gen > 0) {
        const frac = n.gen / P;
        st.busy += DT * frac; st.energy = (st.energy || 0) + n.gen * DT; n.state = 'ok';
        if (f.supp) { st.inv[f.supp] -= suppRate * DT * frac; add(st.cum.cons, f.supp, suppRate * DT * frac); }
      } else n.state = 'starved';
      if (f.by && (st.out[f.by] || 0) >= 1 && byPort >= 0 && emitSolid(n, byPort, f.by)) st.out[f.by] -= 1;
    };
    n.progress = () => (fluidFuel ? 0 : Math.max(0, 1 - (st.burn || 0) / (energy / P)));
    return n;
  }

  // one-item pass-through with round-robin routing (splitters, mergers, poles)
  function router(n, rules) {
    const { st } = n;
    let explicit = null;
    if (rules) { explicit = new Set(); rules.forEach(r => (r || []).forEach(t => { if (D.items[t]) explicit.add(t); })); }
    n.step = () => {
      // pull: round-robin over inputs (priority mergers try higher priority first)
      if (st.buf == null && n.ins.length) {
        const N = n.ins.length;
        if (n.d.raw && n.d.raw.priority) {
          const pr = n.e.prio || [];
          const order = n.ins.map((_, i) => (i + st.rr) % N).sort((a, b) => (pr[n.ins[a].tp] ?? 2) - (pr[n.ins[b].tp] ?? 2));
          for (const k of order) {
            const ed = n.ins[k];
            if (ed.kind === 'belt' && beltHead(ed)) { st.buf = beltTake(ed); st.rr = (k + 1) % N; break; }
          }
        } else {
          for (let j = 0; j < N; j++) {
            const k = (j + st.rr) % N, ed = n.ins[k];
            if (ed.kind === 'belt' && beltHead(ed)) { st.buf = beltTake(ed); st.rr = (k + 1) % N; break; }
          }
        }
      }
      if (st.buf == null) return;
      const it = st.buf;
      // candidate outputs (connected only), cached per item type
      let cand = n.cand && n.cand.get(it);
      if (!cand) {
        const outs = n.d.ports.map((p, i) => i).filter(i => n.d.ports[i].io !== 'in');
        let prim = outs, over = [];
        if (rules) {
          prim = []; over = [];
          outs.forEach((pi, k) => {
            const r = rules[k] || ['any'];
            if (r.includes('overflow')) over.push(pi);
            else if (r.includes('any') || r.includes(it) || (r.includes('anyUndefined') && !explicit.has(it))) prim.push(pi);
          });
        }
        cand = { prim: prim.filter(pi => n.outE[pi]), over: over.filter(pi => n.outE[pi]), any: outs.some(pi => n.outE[pi]) };
        (n.cand ||= new Map()).set(it, cand);
      }
      const tryList = c => {
        for (let k = 0; k < c.length; k++) {
          const pi = c[(k + st.rr2 || 0) % c.length];
          const ed = n.outE[pi];
          if (ed && beltRoom(ed)) { beltEnter(ed, it); st.rr2 = ((st.rr2 || 0) + k + 1) % Math.max(1, c.length); return true; }
        }
        return false;
      };
      if (tryList(cand.prim) || tryList(cand.over)) { st.buf = null; n.moved = (n.moved || 0) + 1; return; }
      if (!cand.any && SPILL) { add(st.cum.void, it, 1); st.buf = null; }
    };
    return n;
  }

  // fluid pass-through (pipe junctions, pumps, valves, pipe supports)
  function fluidPass(n, limit) {
    const { st } = n;
    st.pool = st.pool || {};
    n.step = () => {
      const poolVol = () => (st.poolT ??= Object.values(st.pool).reduce((a, b) => a + b, 0));
      for (const ed of n.ins) if (ed.kind === 'pipe') pipePull(ed, (it, amt) => { const t = Math.min(amt, 20 - poolVol()); if (t > 0) { add(st.pool, it, t); st.poolT += t; } return Math.max(0, t); });
      const outs = n.outs.filter(ed => ed.kind === 'pipe');
      let budget = limit ? limit / 60 * DT : Infinity;
      for (const it of Object.keys(st.pool)) {
        if (!outs.length) { if (SPILL) { add(st.cum.void, it, st.pool[it]); st.poolT = poolVol() - st.pool[it]; delete st.pool[it]; } continue; }
        const share = Math.min(st.pool[it], budget) / outs.length;
        for (const ed of outs) { const a = pipePush(ed, it, share); st.pool[it] -= a; st.poolT = poolVol() - a; budget -= a; }
        if (st.pool[it] < 1e-9) delete st.pool[it];
      }
    };
    return n;
  }

  function storage(n) {
    const { e, d, st } = n;
    const b = d.raw;
    const fluidTank = !!b.fluidStorage;
    const slots = b.slots || 24;
    const cap = b.capacity || 400;
    const used = () => (fluidTank ? Object.values(st.inv).reduce((a, x) => a + x, 0) : Object.entries(st.inv).reduce((a, [k, v]) => a + Math.ceil(v / stackOf(k)), 0));
    const canAccept = it => (fluidTank ? used() < cap : ((st.inv[it] || 0) % stackOf(it) !== 0) || used() < slots);
    n.fill = () => (fluidTank ? used() / cap : used() / slots);
    n.capacityText = () => (fluidTank ? `${SF.fmt(used(), 0)} / ${cap} m³` : `${used()} / ${slots} slots`);
    n.step = () => {
      for (const ed of n.ins) {
        if (ed.kind === 'belt') { const it = beltHead(ed); if (it && canAccept(it)) { beltTake(ed); add(st.inv, it, 1); add(st.cum.cons, it, 1); } }
        else pipePull(ed, (it, amt) => { const t = Math.min(amt, cap - used()); if (t > 0) { add(st.inv, it, t); add(st.cum.cons, it, t); } return Math.max(0, t); });
      }
      // outputs: send whatever is stored, round-robin across item types
      const keys = Object.keys(st.inv).filter(k => st.inv[k] > 1e-9);
      if (!keys.length) return;
      n.d.ports.forEach((p, pi) => {
        if (p.io !== 'out' || !n.outE[pi]) return;
        const it = keys[(st.rr++) % keys.length];
        if (fluidTank) { const a = pipePush(n.outE[pi], it, st.inv[it]); st.inv[it] -= a; add(st.cum.prod, it, a); }
        else if (st.inv[it] >= 1 && beltRoom(n.outE[pi])) { beltEnter(n.outE[pi], it); st.inv[it] -= 1; add(st.cum.prod, it, 1); }
        if (st.inv[it] < 1e-9) delete st.inv[it];
      });
    };
    void e;
    return n;
  }

  function sink(n, limitPerMin) {
    const { st } = n;
    n.step = () => {
      let tokens = limitPerMin ? limitPerMin / 60 * DT + (st.carry || 0) : Infinity;
      for (const ed of n.ins) {
        if (ed.kind === 'belt') {
          const it = beltHead(ed);
          if (it && tokens >= 1) { beltTake(ed); add(st.cum.cons, it, 1); tokens -= 1; }
        } else pipePull(ed, (it, amt) => { const t = Math.min(amt, tokens); add(st.cum.cons, it, t); tokens -= t; return t; });
      }
      if (limitPerMin) st.carry = Math.min(tokens, 2);
    };
    return n;
  }

  function source(n) {
    const { e, st } = n;
    const it = e.item, rate = (e.rate || 0) / 60;
    const fluid = SF.item(it).fluid;
    n.step = () => {
      if (!it) return;
      const ed = n.outE[0];
      if (fluid) {
        st.timer += DT;
        const want = rate ? rate * DT : (ed ? ed.rate * DT : 0);
        if (ed) add(st.cum.prod, it, pipePush(ed, it, want));
        return;
      }
      if (rate) { st.timer = Math.min(st.timer + DT * rate, 2); }
      if ((rate ? st.timer >= 1 : true) && ed && beltRoom(ed)) { beltEnter(ed, it); add(st.cum.prod, it, 1); if (rate) st.timer -= 1; }
    };
    return n;
  }

  function pressurizer(n) {
    n.power = SF.machinePower(n.e, n.d);
    n.step = () => { n.st.busy += DT; n.state = 'ok'; };
    return n;
  }

  function makeNode(e, d, st) {
    const n = baseNode(e, d, st);
    switch (d.kind) {
      case 'machine': return machine(n);
      case 'extractor': return extractor(n);
      case 'generator': return generator(n);
      case 'splitter': return router(n, d.raw.smart ? (e.rules || [['any'], ['any'], ['any']]) : null);
      case 'merger': return router(n, null);
      case 'pole': return d.ports[0].fluid ? fluidPass(n) : router(n, null);
      case 'liftend': return router(n, null);
      case 'junction': return fluidPass(n);
      case 'pump': return fluidPass(n, e.def === 'Build_Valve_C' ? (e.limit ?? 600) : 0);
      case 'storage': return storage(n);
      case 'sink': return sink(n);
      case 'vsink': return sink(n, e.rate || 0);
      case 'source': return source(n);
      case 'pressurizer': return pressurizer(n);
      default: return null;
    }
  }

  // ------------------------------------------------------------ build / rebuild (keeps state of unchanged parts)
  function build() {
    // remember previous edge state by link id
    for (const ed of live.edges.values()) live.keepBelts.set(ed.l.id, ed);
    live.nodes.clear(); live.edges.clear();
    for (const e of S.entities.values()) {
      const d = SF.defs[e.def];
      // reset an entity's state if its type or recipe changed
      const sig = e.def + '|' + (e.recipe || '') + '|' + (e.fuel || '') + '|' + (e.resource || '');
      let st = live.keep.get(e.id);
      if (!st || st.sig !== sig) { st = freshState(); st.sig = sig; }
      const n = makeNode(e, d, st);
      if (!n) continue;
      live.keep.set(e.id, st);
      live.nodes.set(e.id, n);
    }
    for (const id of [...live.keep.keys()]) if (!S.entities.has(id)) live.keep.delete(id);
    for (const l of S.links.values()) {
      const a = live.nodes.get(l.from[0]), b = live.nodes.get(l.to[0]);
      if (!a || !b) continue;
      const prev = live.keepBelts.get(l.id);
      const ed = l.kind === 'pipe' ? makePipe(l, a, l.from[1], b, l.to[1], prev) : makeBelt(l, a, l.from[1], b, l.to[1], prev);
      ed.burst = 1;
      if (a.kind === 'machine' && a.portItem && a.r) {
        const o = a.r.out.find(([i]) => i === a.portItem[l.from[1]]);
        const amt = o ? o[1] * a.mult : 1;
        if (Math.abs(amt - Math.round(amt)) < 1e-9 && amt >= 1) ed.burst = Math.round(amt);
      }
      a.outE[l.from[1]] = ed; a.outs.push(ed);
      b.inE[l.to[1]] = ed; b.ins.push(ed);
      live.edges.set(l.id, ed);
    }
    for (const id of [...live.keepBelts.keys()]) if (!S.links.has(id)) live.keepBelts.delete(id);
    live.builtVersion = S.version;
  }

  // ------------------------------------------------------------ stepping
  function step() {
    for (const ed of live.edges.values()) {
      if (ed.kind === 'belt') {
        // items packed nose-to-tail against the head can't move until the front one is taken: skip them
        // The front item may run up to one step past the end before it is taken: it keeps the movement it had
        // left this step, so the items behind it keep exact spacing and a full belt delivers its rated amount.
        const it = ed.items, N = it.length, mv = ed.v * DT;
        let k = ed.packed || 0;
        let limit = k ? it[k - 1].s - SPACING : ed.len + mv;
        for (; k < N; k++) {
          const x = it[k];
          if (k === 0 && x.s >= ed.len - 1e-9) { ed.packed = 1; limit = x.s - SPACING; continue; }   // waiting at the end
          if (k > 0 && x.s >= limit - 1e-9 && k === (ed.packed || 0)) { x.s = limit; ed.packed = k + 1; limit = x.s - SPACING; continue; }
          x.s = Math.min(x.s + mv, limit); limit = x.s - SPACING;
        }
      } else ed.budget = ed.rate * DT;
    }
    for (const n of live.nodes.values()) n.step();
    live.t += DT;
    if (Math.floor(live.t) !== Math.floor(live.t - DT)) snapshot();
  }

  // once per sim second: cumulative counters for rolling-window rates
  function snapshot() {
    const t = live.t;
    for (const n of live.nodes.values()) {
      const st = n.st;
      st.snaps.push({ t, prod: { ...st.cum.prod }, cons: { ...st.cum.cons }, void: { ...st.cum.void }, busy: st.busy, energy: st.energy || 0 });
      while (st.snaps.length > WINDOW + 1) st.snaps.shift();
    }
    for (const ed of live.edges.values()) {
      ed.st.snaps.push({ t, cum: { ...ed.st.cum } });
      while (ed.st.snaps.length > WINDOW + 1) ed.st.snaps.shift();
    }
    // power over the last second (cheap: no full publish, which only happens a few times per real second)
    let gen = 0, use = 0;
    for (const n of live.nodes.values()) {
      const sn = n.st.snaps, a = sn[sn.length - 2], b = sn[sn.length - 1];
      if (!a || !b) continue;
      const span = b.t - a.t || 1;
      if (n.kind === 'generator') gen += (b.energy - a.energy) / span;
      else if (n.power) use += n.power * Math.min(1, (b.busy - a.busy) / span);
    }
    live.powerHist.push({ t, gen, use });
    while (live.powerHist.length > 600) live.powerHist.shift();
  }

  const rateMap = (now, old, span) => {
    const out = {};
    for (const k in now) { const v = (now[k] - (old[k] || 0)) / span * 60; if (v > 1e-6) out[k] = v; }
    return out;
  };

  // publish a result object in the free-run calculator's shape
  function publish() {
    const res = { nodes: new Map(), edges: new Map(), version: S.version, live: true };
    let powerUse = 0, powerMax = 0, powerGen = 0, powerNow = 0, sinkPoints = 0;
    const bal = {}, external = { in: {}, out: {} };
    // belts: event timing (fast). pipes: last 10 s of flow (fluids move continuously, so this settles quickly)
    const edgeFlows = new Map(), exact = new Set();
    for (const ed of live.edges.values()) {
      let flows = {};
      if (ed.kind === 'belt') {
        const er = eventRate(ed.ev, live.t);
        if (er && er.exact) exact.add(ed);
        if (er) {
          const cnt = {}; let n = 0;
          for (let k = er.i0; k <= er.i1; k++) { add(cnt, ed.ev[k][1], 1); n++; }
          for (const it in cnt) flows[it] = er.perMin * cnt[it] / n;
        }
      } else {
        const sn = ed.st.snaps, old = sn.length > 1 ? sn[Math.max(0, sn.length - 11)] : { t: 0, cum: {} };
        const now = sn.length > 1 ? sn[sn.length - 1] : { t: live.t, cum: ed.st.cum };
        flows = rateMap(now.cum, old.cum, Math.max(1e-6, now.t - old.t));
      }
      edgeFlows.set(ed, flows);
    }
    // a belt leaving a merger or pole without a repeating pattern of its own (several sources mixed together)
    // carries exactly the sum of what goes in, and those inputs usually do have a pattern: use the sum
    const resolving = new Set();
    const resolve = ed => {
      if (exact.has(ed)) return edgeFlows.get(ed);
      const src = ed.from;
      if (ed.kind !== 'belt' || !(src.kind === 'merger' || (src.kind === 'pole' && !src.d.ports[0].fluid)) || resolving.has(ed) || !src.ins.length) return null;
      resolving.add(ed);
      const sum = {};
      for (const e2 of src.ins) { const f = resolve(e2); if (!f) { resolving.delete(ed); return null; } for (const k in f) add(sum, k, f[k]); }
      resolving.delete(ed);
      edgeFlows.set(ed, sum); exact.add(ed);
      return sum;
    };
    for (const ed of live.edges.values()) resolve(ed);
    for (const ed of live.edges.values()) {
      const flows = edgeFlows.get(ed);
      const total = Object.values(flows).reduce((a, b) => a + b, 0);
      const full = ed.kind === 'belt' ? ed.items.length >= Math.floor(ed.len / SPACING) && !beltRoom(ed) : pipeVol(ed) >= ed.max * 0.99;
      res.edges.set(ed.l.id, { flows, total, cap: ed.cap, util: total / ed.cap, jam: 0, len: ed.len, count: ed.kind === 'belt' ? ed.items.length : pipeVol(ed), full });
    }
    const sumFlows = list => { const o = {}; list.forEach(ed => { const f = edgeFlows.get(ed) || {}; for (const k in f) add(o, k, f[k]); }); return o; };
    for (const n of live.nodes.values()) {
      const st = n.st, sn = st.snaps;
      // rates between whole-second snapshots (stable, no partial-second bias); live values before the first two
      const old = sn.length > 1 ? sn[0] : { t: 0, prod: {}, cons: {}, void: {}, busy: 0, energy: 0 };
      const now = sn.length > 1 ? sn[sn.length - 1] : { t: live.t, prod: st.cum.prod, cons: st.cum.cons, void: st.cum.void, busy: st.busy, energy: st.energy || 0 };
      const span = Math.max(1e-6, now.t - old.t);
      const eff = Math.min(1, (now.busy - old.busy) / span);
      const r = {
        eff, ins: rateMap(now.cons, old.cons, span), outs: rateMap(now.prod, old.prod, span), voided: rateMap(now.void, old.void, span),
        maxIn: n.maxIn, maxOut: n.maxOut, power: 0, gen: 0,
      };
      // fast rates: machines from craft timing, extractors from item timing, everything else from its belts
      if (n.kind === 'machine' && n.r) {
        const er = eventRate(st.ev, live.t);
        const cpm = er ? er.perMin : 0;                     // crafts per minute
        r.ins = {}; r.outs = {};
        if (cpm > 1e-9) {
          for (const [i, a] of n.r.in) r.ins[i] = a * cpm;
          for (const [i, a] of n.r.out) r.outs[i] = a * n.mult * cpm;
        }
        r.eff = Math.min(1, cpm * n.cycle / 60);
      } else if (n.kind === 'extractor' && !n.d.raw.fluidOut && n.e.resource) {
        const er = eventRate(st.ev, live.t);
        r.outs = er ? { [n.e.resource]: er.perMin } : {};
        r.eff = n.maxOut ? Math.min(1, (er ? er.perMin : 0) / n.maxOut[n.e.resource]) : 0;
      } else if (['storage', 'sink', 'vsink', 'source', 'splitter', 'merger', 'pole', 'junction', 'pump'].includes(n.kind)) {
        r.ins = sumFlows(n.ins); r.outs = sumFlows(n.outs);
        if (n.kind === 'source') r.ins = {};
        if (n.kind === 'sink' || n.kind === 'vsink') r.outs = {};
      } else if (n.kind === 'generator' && !n.d.raw.geo) {
        const fi = sumFlows(n.ins);
        if (n.fuel && SF.item(n.fuel).energy && !SF.item(n.fuel).fluid) {
          // solid fuel: power follows the measured fuel feed once the generator is burning steadily
          if (n.state === 'ok' && fi[n.fuel]) { r.ins = fi; }
        }
      }
      if (n.kind === 'machine' || n.kind === 'extractor' || n.kind === 'pressurizer') {
        r.power = (n.power || 0) * eff; powerUse += r.power; powerMax += n.power || 0;
        if (n.state === 'ok') powerNow += n.power || 0;
      }
      if (n.kind === 'generator') {
        r.gen = ((now.energy || 0) - (old.energy || 0)) / span; r.maxGen = n.P; powerGen += r.gen;
      }
      if (n.noRecipe) r.status = 'noRecipe';
      else if (n.noFuel) r.status = 'noFuel';
      else if (['machine', 'extractor', 'generator'].includes(n.kind)) {
        r.status = n.state === 'ok' ? 'ok' : n.state === 'blocked' ? (n.kind === 'extractor' ? 'throttled' : 'blocked') : (st.busy > 0 ? 'starved' : 'idle');
      } else r.status = 'ok';
      // live details for the inspector / renderers
      r.live = {
        inv: { ...st.inv }, out: { ...st.out }, progress: n.progress ? n.progress() : 0, running: n.state === 'ok',
        fill: n.fill ? n.fill() : null, capacity: n.capacityText ? n.capacityText() : '', buf: st.buf, capIn: n.capIn, capOut: n.capOut,
      };
      if (n.kind === 'sink' && n.d.raw && n.d.raw.awesome) for (const it in r.ins) sinkPoints += r.ins[it] * (SF.item(it).sink || 0);
      if (['machine', 'extractor', 'generator'].includes(n.kind)) {
        for (const it in r.ins) (bal[it] ||= { prod: 0, cons: 0 }).cons += r.ins[it];
        for (const it in r.outs) (bal[it] ||= { prod: 0, cons: 0 }).prod += r.outs[it];
      }
      if (n.kind === 'source') for (const it in r.outs) add(external.in, it, r.outs[it]);
      if (n.kind === 'vsink' || n.kind === 'sink' || n.kind === 'storage') for (const it in r.ins) add(external.out, it, r.ins[it]);
      for (const it in r.voided) add(external.out, it, r.voided[it]);
      res.nodes.set(n.e.id, r);
    }
    res.summary = { powerUse, powerMax, powerGen, powerNow, sinkPoints, balance: bal, external };
    SF.sim.result = res;
    live.listeners.forEach(fn => fn(res));
    SF.sim.listeners.forEach(fn => fn(res));
    return res;
  }

  // ------------------------------------------------------------ public API
  live.setActive = (on) => {
    live.active = on;
    if (on) { live.reset(); live.running = true; }
    else { live.running = false; SF.sim.request(); }
    SF.onSimMode && SF.onSimMode();
  };
  live.reset = () => {
    if (live.skipping) live.skipping.cancelled = true;
    live.keep.clear(); live.keepBelts.clear(); live.edges.clear(); live.nodes.clear();
    live.t = 0; live.powerHist = [];
    build(); publish();
  };
  live.stepOnce = () => { if (S.version !== live.builtVersion) build(); for (let i = 0; i < 30; i++) step(); publish(); };
  live.itemsOnBelts = () => { let n = 0; for (const ed of live.edges.values()) if (ed.kind === 'belt') n += ed.items.length; return n; };

  // positions of real items on a belt as fractions of its length (renderers draw these in Sim mode)
  live.beltItems = (lid) => {
    const ed = live.edges.get(lid);
    if (!ed || ed.kind !== 'belt') return null;
    return ed.items.map(x => ({ it: x.it, f: Math.min(1, x.s / ed.len) }));
  };

  // called every animation frame with real elapsed seconds
  let acc = 0, lastPub = 0;
  live.tick = (realDt) => {
    if (!live.active) return;
    // while something is being dragged, rebuild at most a few times a second (the drop rebuilds anyway)
    const dragging = SF.ed && SF.ed.drag && SF.ed.drag.type !== 'pan' && SF.ed.drag.type !== 'rpan';
    if (S.version !== live.builtVersion && (!dragging || performance.now() - (live.lastBuildAt || 0) > 400)) { build(); live.lastBuildAt = performance.now(); }
    if (!live.running || live.skipping) return;
    acc += Math.min(realDt, 0.25) * live.speed;
    let n = 0;
    const max = 2400;              // cap work per frame; at very high speeds the clock just runs slower
    while (acc >= DT && n < max) { step(); acc -= DT; n++; }
    if (n >= max) acc = 0;
    live.lag = n >= max;
    lastPub += realDt;
    if (lastPub > 0.25) { lastPub = 0; publish(); }
  };

  // fast-forward to sim time T (seconds) as quickly as the computer allows, in slices so the page stays responsive.
  // Going back in time restarts from t = 0. Resolves with true when reached, false if cancelled.
  live.skipTo = (T, onProgress) => {
    if (live.skipping) live.cancelSkip();
    if (T <= live.t + 1e-9) live.reset();
    const wasRunning = live.running;
    live.running = false;
    const t0 = live.t;
    const job = live.skipping = { cancelled: false, target: T, from: t0 };
    return new Promise(resolve => {
      const slice = () => {
        if (job.cancelled) { if (live.skipping === job) { live.skipping = null; live.running = wasRunning; publish(); } resolve(false); return; }
        if (S.version !== live.builtVersion) build();
        const until = performance.now() + 40;
        while (live.t < T - DT / 2 && performance.now() < until) for (let k = 0; k < 300 && live.t < T - DT / 2; k++) step();
        job.progress = (live.t - t0) / Math.max(1e-9, T - t0);
        onProgress && onProgress(job.progress);
        if (live.t >= T - DT / 2) { live.skipping = null; live.running = wasRunning; publish(); resolve(true); }
        else setTimeout(slice, 0);
      };
      slice();
    });
  };
  live.cancelSkip = () => { if (live.skipping) live.skipping.cancelled = true; };

  // headless helper for tests: run `seconds` of sim time
  live.runFor = (seconds) => {
    if (S.version !== live.builtVersion) build();
    const steps = Math.round(seconds / DT);
    for (let i = 0; i < steps; i++) step();
    return publish();
  };
  live.DT = DT;
})(window.SF);
