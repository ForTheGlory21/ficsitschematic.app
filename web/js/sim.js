// Throughput simulator: continuous-flow, time-stepped model of the factory graph.
// Machines, belts and logistics nodes have small buffers; the sim runs to steady
// state and then measures average flows. This handles back-pressure, starvation,
// splitter/merger balancing, smart-splitter filters, overflow and loops.
(function (SF) {
  const S = SF.state, D = SF.D;
  const DT = 1;          // seconds per step
  const WARM = 2400;     // steps before measuring
  const MEAS = 600;      // measured steps
  const EPS = 1e-9;

  const sim = SF.sim = { result: null, running: false, progress: 0, listeners: [] };
  sim.onResult = fn => sim.listeners.push(fn);

  const add = (m, k, v) => { m[k] = (m[k] || 0) + v; };

  function pushTo(ed, item, amt) {
    const a = Math.min(amt, ed.inLeft, ed.qmax - ed.qt);
    if (a <= EPS) return 0;
    ed.q[item] = (ed.q[item] || 0) + a; ed.qt += a; ed.inLeft -= a;
    return a;
  }

  // move a chunk from an edge into a node; FIFO-ish: an unaccepted item jams the belt
  function deliver(ed, accepts, space, accept, meas) {
    if (ed.qt <= EPS || ed.outLeft <= EPS) return;
    const chunk = Math.min(ed.outLeft, ed.qt);
    // fast path: almost every belt carries a single item type
    let only = null, n = 0;
    for (const it in ed.q) { only = it; if (++n > 1) break; }
    if (n === 1) {
      if (!accepts(only)) { if (meas) { ed.jam++; ed.jamItem = only; } return; }
      const m = Math.min(chunk, Math.max(0, space(only)));
      if (m <= EPS) return;
      ed.q[only] -= m; ed.qt -= m;
      if (ed.q[only] < EPS) { ed.qt -= ed.q[only]; delete ed.q[only]; }
      if (ed.qt < EPS) ed.qt = 0;
      accept(only, m);
      if (meas) add(ed.moved, only, m);
      ed.outLeft -= m;
      return;
    }
    const fr = chunk / ed.qt;
    let s = 1;
    for (const it in ed.q) {
      const c = ed.q[it] * fr;
      if (c <= EPS) continue;
      if (!accepts(it)) { if (meas) { ed.jam++; ed.jamItem = it; } return; }
      const sp = space(it);
      if (sp < c) s = Math.min(s, Math.max(0, sp) / c);
    }
    if (s <= EPS) return;
    for (const it in ed.q) {
      const m = ed.q[it] * fr * s;
      if (m <= 0) continue;
      ed.q[it] -= m; ed.qt -= m;
      if (ed.q[it] < EPS) { ed.qt -= ed.q[it]; delete ed.q[it]; }
      accept(it, m);
      if (meas) add(ed.moved, it, m);
    }
    if (ed.qt < EPS) ed.qt = 0;
    ed.outLeft -= chunk * s;
  }

  // equal split of an item across edges, re-distributing what full edges can't take
  function waterFill(eds, item, amount) {
    let moved = 0, open = eds.slice();
    for (let guard = 0; guard < 6 && amount > EPS && open.length; guard++) {
      const share = amount / open.length;
      const next = [];
      for (const ed of open) {
        const m = pushTo(ed, item, share);
        moved += m; amount -= m;
        if (m >= share - EPS) next.push(ed);
      }
      if (next.length === open.length) break;
      open = next;
    }
    return moved;
  }

  function rotated(arr, k) {
    if (arr.length < 2) return arr;
    const o = k % arr.length;
    return arr.slice(o).concat(arr.slice(0, o));
  }

  // ------------------------------------------------------------ node factories
  function base(e, d) {
    return {
      e, d, kind: d.kind, out: [], in: [], outs: [], ins: [],
      st: { frac: 0, starve: 0, block: 0, cons: {}, prod: {}, gen: 0, power: 0, voided: {} },
      init() {}, process() {}, push() {}, pull() {},
    };
  }

  function makeMachine(n) {
    const { e, d } = n;
    n.init = function () {
      const r = D.recipes[e.recipe];
      if (!r) { n.noRecipe = true; return; }
      const clock = e.clock ?? 1;
      const mult = d.raw.sloops ? 1 + (e.sloops || 0) / d.raw.sloops : 1;
      n.cps = clock / r.time;
      n.rin = r.in; n.rout = r.out.map(([i, a]) => [i, a * mult]);
      n.inBuf = {}; n.outBuf = {}; n.inCap = {}; n.outCap = {};
      for (const [i, a] of n.rin) { n.inBuf[i] = 0; n.inCap[i] = Math.max(2 * a, a * n.cps * DT * 4); }
      for (const [i, a] of n.rout) { n.outBuf[i] = 0; n.outCap[i] = Math.max(2 * a, a * n.cps * DT * 4); }
      // map output ports to products of matching form
      n.portItem = {};
      const outPorts = d.ports.map((p, pi) => ({ p, pi })).filter(x => x.p.io === 'out');
      const solids = n.rout.filter(([i]) => !SF.item(i).fluid), fluids = n.rout.filter(([i]) => SF.item(i).fluid);
      outPorts.filter(x => !x.p.fluid).forEach((x, k) => { if (solids[k]) n.portItem[x.pi] = solids[k][0]; });
      outPorts.filter(x => x.p.fluid).forEach((x, k) => { if (fluids[k]) n.portItem[x.pi] = fluids[k][0]; });
      n.maxPower = SF.machinePower(e, d);
    };
    n.process = function (meas) {
      if (n.noRecipe) return;
      const want = n.cps * DT;
      let f = want, lim = 0;
      for (const [i, a] of n.rin) { const v = n.inBuf[i] / a; if (v < f) { f = v; lim = 1; } }
      for (const [i, a] of n.rout) { const v = (n.outCap[i] - n.outBuf[i]) / a; if (v < f) { f = v; lim = 2; } }
      if (f < 0) f = 0;
      for (const [i, a] of n.rin) n.inBuf[i] -= a * f;
      for (const [i, a] of n.rout) n.outBuf[i] += a * f;
      if (meas) {
        const r = f / want;
        n.st.frac += r;
        if (r < 0.999) { if (lim === 1) n.st.starve += 1 - r; else if (lim === 2) n.st.block += 1 - r; }
        for (const [i, a] of n.rin) add(n.st.cons, i, a * f);
        for (const [i, a] of n.rout) add(n.st.prod, i, a * f);
        n.st.power += n.maxPower * r;
      }
    };
    n.push = function (meas) {
      if (n.noRecipe) return;
      for (const pi in n.portItem) {
        const it = n.portItem[pi], ed = n.out[pi];
        if (ed) n.outBuf[it] -= pushTo(ed, it, n.outBuf[it]);
        else if (!S.settings.openOutputsBlock) { if (meas) add(n.st.voided, it, n.outBuf[it]); n.outBuf[it] = 0; }
      }
    };
    n.pull = function (meas, step) {
      if (n.noRecipe) return;
      for (const ed of rotated(n.ins, step)) {
        deliver(ed, it => it in n.inCap, it => n.inCap[it] - n.inBuf[it], (it, m) => { n.inBuf[it] += m; }, meas);
      }
    };
    return n;
  }

  function makeExtractor(n) {
    const { e, d } = n;
    const b = d.raw;
    n.init = function () {
      n.item = e.resource;
      n.rate = b.rate * (b.purity ? (e.purity ?? 1) : 1) * (e.clock ?? 1) / 60;
      n.buf = 0; n.cap = Math.max(n.rate * DT * 4, 2);
      n.maxPower = SF.machinePower(e, d);
    };
    n.process = function (meas) {
      if (!n.item) return;
      const want = n.rate * DT;
      const a = Math.max(0, Math.min(want, n.cap - n.buf));
      n.buf += a;
      if (meas) {
        const r = want ? a / want : 0;
        n.st.frac += r; if (r < 0.999) n.st.block += 1 - r;
        add(n.st.prod, n.item, a); n.st.power += n.maxPower * r;
      }
    };
    n.push = function (meas) {
      const ed = n.out[0];
      if (ed) n.buf -= pushTo(ed, n.item, n.buf);
      else if (!S.settings.openOutputsBlock) { if (meas) add(n.st.voided, n.item, n.buf); n.buf = 0; }
    };
    return n;
  }

  function makeGenerator(n) {
    const { e, d } = n;
    const b = d.raw;
    n.init = function () {
      const clock = e.clock ?? 1;
      n.P = b.produce * clock;
      if (b.geo) { n.geo = true; n.P = b.produce * (e.purity ?? 1); return; }
      const f = b.fuels.find(x => x.fuel === e.fuel);
      if (!f) { n.noFuel = true; return; }
      n.fuel = f.fuel; n.supp = f.supp; n.by = f.by;
      const energy = SF.item(f.fuel).energy || 1;
      n.fuelRate = n.P / energy;                                   // items (or m³) per second
      n.suppRate = f.supp ? n.P * b.suppRatio / 1000 : 0;          // m³ per second
      n.byRate = f.by ? n.fuelRate * f.byAmt : 0;
      n.inBuf = { [n.fuel]: 0 }; n.inCap = { [n.fuel]: Math.max(n.fuelRate * DT * 4, 2) };
      if (n.supp) { n.inBuf[n.supp] = 0; n.inCap[n.supp] = Math.max(n.suppRate * DT * 4, 2); }
      n.byBuf = 0; n.byCap = Math.max(n.byRate * DT * 4, 2);
      n.byPort = d.ports.findIndex(p => p.io === 'out');
    };
    n.process = function (meas) {
      if (n.geo) { if (meas) { n.st.frac += 1; n.st.gen += n.P; } return; }
      if (n.noFuel) return;
      let f = 1, lim = 0;
      const fr = n.fuelRate * DT;
      if (n.inBuf[n.fuel] / fr < f) { f = n.inBuf[n.fuel] / fr; lim = 1; }
      if (n.supp) { const s = n.inBuf[n.supp] / (n.suppRate * DT); if (s < f) { f = s; lim = 1; } }
      if (n.by) { const s = (n.byCap - n.byBuf) / (n.byRate * DT); if (s < f) { f = s; lim = 2; } }
      f = Math.max(0, f);
      n.inBuf[n.fuel] -= fr * f;
      if (n.supp) n.inBuf[n.supp] -= n.suppRate * DT * f;
      if (n.by) n.byBuf += n.byRate * DT * f;
      if (meas) {
        n.st.frac += f; n.st.gen += n.P * f;
        if (f < 0.999) { if (lim === 1) n.st.starve += 1 - f; else n.st.block += 1 - f; }
        add(n.st.cons, n.fuel, fr * f);
        if (n.supp) add(n.st.cons, n.supp, n.suppRate * DT * f);
        if (n.by) add(n.st.prod, n.by, n.byRate * DT * f);
      }
    };
    n.push = function (meas) {
      if (!n.by) return;
      const ed = n.out[n.byPort];
      if (ed) n.byBuf -= pushTo(ed, n.by, n.byBuf);
      else if (!S.settings.openOutputsBlock) { if (meas) add(n.st.voided, n.by, n.byBuf); n.byBuf = 0; }
    };
    n.pull = function (meas, step) {
      if (n.geo || n.noFuel) return;
      for (const ed of rotated(n.ins, step)) {
        deliver(ed, it => it in n.inCap, it => n.inCap[it] - n.inBuf[it], (it, m) => { n.inBuf[it] += m; }, meas);
      }
    };
    return n;
  }

  // generic mixed-buffer pass-through (splitter, merger, junction, pump, storage)
  function makePass(n, opts = {}) {
    const { e, d } = n;
    n.buf = {}; n.bt = 0;
    n.init = function () {
      const rates = [...n.ins, ...n.outs].map(ed => ed.rate);
      n.cap = Math.max(4, ...rates.map(r => r * DT * 2));
      if (opts.limit) n.limit = opts.limit / 60 * DT;
    };
    n.pull = function (meas, step) {
      let ins = n.ins;
      if (d.raw && d.raw.priority) {
        const pr = e.prio || [];
        ins = ins.slice().sort((a, b) => (pr[a.tp] ?? 2) - (pr[b.tp] ?? 2));
        // rotate within equal-priority groups
        const groups = [];
        ins.forEach(ed => {
          const p = pr[ed.tp] ?? 2;
          if (!groups.length || groups[groups.length - 1].p !== p) groups.push({ p, list: [] });
          groups[groups.length - 1].list.push(ed);
        });
        ins = groups.flatMap(g => rotated(g.list, step));
      } else ins = rotated(ins, step);
      for (const ed of ins) {
        deliver(ed, () => true, () => n.cap - n.bt, (it, m) => { add(n.buf, it, m); n.bt += m; }, meas);
      }
    };
    n.push = function (meas, step) {
      if (n.bt <= EPS) return;
      if (!n.outs.length) {
        if (opts.absorbIfOpen) { // storage with nothing taken out: it fills up
          if (meas) for (const it in n.buf) add(n.st.cons, it, n.buf[it]);
          n.buf = {}; n.bt = 0;
        } else if (!S.settings.openOutputsBlock) {
          // dangling belt end (pole / splitter / merger with nothing after it): items spill off the end
          if (meas) for (const it in n.buf) add(n.st.voided, it, n.buf[it]);
          n.buf = {}; n.bt = 0;
        }
        return;
      }
      let budget = n.limit ?? Infinity;
      const items = rotated(Object.keys(n.buf), step);
      const rules = opts.rules;
      let explicit = null;
      if (rules) {
        explicit = new Set();
        rules.forEach(r => (r || []).forEach(t => { if (D.items[t]) explicit.add(t); }));
      }
      for (const it of items) {
        let a = Math.min(n.buf[it], budget);
        if (a <= EPS) continue;
        let moved = 0;
        if (rules) {
          const prim = [], over = [];
          for (let k = 0; k < 3; k++) {
            const ed = n.out[k + 1];
            if (!ed) continue;
            const r = rules[k] || ['any'];
            if (r.includes('overflow')) over.push(ed);
            else if (r.includes('any') || r.includes(it) || (r.includes('anyUndefined') && !explicit.has(it))) prim.push(ed);
          }
          moved = waterFill(rotated(prim, step), it, a);
          if (a - moved > EPS && over.length) moved += waterFill(over, it, a - moved);
        } else {
          moved = waterFill(rotated(n.outs, step), it, a);
        }
        n.buf[it] -= moved; n.bt -= moved; budget -= moved;
        if (n.buf[it] < EPS) { n.bt -= n.buf[it]; delete n.buf[it]; }
      }
      if (meas && n.bt > n.cap * 0.95) n.st.block += 1;
    };
    return n;
  }

  function makeSink(n, opts = {}) {
    const { e } = n;
    n.init = function () { n.lim = opts.rate ? (e.rate || 0) / 60 * DT : 0; n.left = 0; };
    n.process = function () { n.left = n.lim || Infinity; };
    n.pull = function (meas, step) {
      for (const ed of rotated(n.ins, step)) {
        deliver(ed, () => true, () => n.left, (it, m) => { n.left -= m; if (meas) add(n.st.cons, it, m); }, meas);
      }
    };
    return n;
  }

  function makeSource(n) {
    const { e } = n;
    n.init = function () {
      n.item = e.item; n.rate = (e.rate || 0) / 60;
      n.buf = 0; n.cap = n.rate ? Math.max(n.rate * DT * 4, 2) : Infinity;
    };
    n.process = function () {
      if (!n.item) return;
      n.buf = n.rate ? Math.min(n.cap, n.buf + n.rate * DT) : 1e12;
    };
    n.push = function (meas) {
      const ed = n.out[0];
      if (!ed || !n.item) return;
      const m = pushTo(ed, n.item, n.buf);
      n.buf -= m;
      if (meas) { add(n.st.prod, n.item, m); n.st.frac += n.rate ? m / (n.rate * DT) : 1; }
    };
    return n;
  }

  // resource well pressurizer: no items, constant power draw (scales with clock like other machines)
  function makePressurizer(n) {
    n.init = function () { n.maxPower = SF.machinePower(n.e, n.d); };
    n.process = function (meas) { if (meas) { n.st.frac += 1; n.st.power += n.maxPower; } };
    return n;
  }

  function makeNode(e, d) {
    const n = base(e, d);
    switch (d.kind) {
      case 'machine': return makeMachine(n);
      case 'extractor': return makeExtractor(n);
      case 'generator': return makeGenerator(n);
      case 'splitter': return makePass(n, { rules: d.raw.smart ? (e.rules || [['any'], ['any'], ['any']]) : null });
      case 'merger': case 'junction': case 'pole': case 'liftend': return makePass(n);
      case 'pump': return makePass(n, { limit: e.def === 'Build_Valve_C' ? (e.limit ?? 600) : 0 });
      case 'storage': return makePass(n, { absorbIfOpen: true });
      case 'sink': return makeSink(n);
      case 'vsink': return makeSink(n, { rate: true });
      case 'source': return makeSource(n);
      case 'pressurizer': return makePressurizer(n);
      default: return null;
    }
  }

  // ------------------------------------------------------------ graph
  function build() {
    const nodes = new Map();
    for (const e of S.entities.values()) {
      const d = SF.defs[e.def];
      const n = makeNode(e, d);
      if (n) nodes.set(e.id, n);
    }
    const edges = [];
    for (const l of S.links.values()) {
      const a = nodes.get(l.from[0]), b = nodes.get(l.to[0]);
      if (!a || !b) continue;
      const spec = SF.linkSpec(l);
      const hf = l.kind === 'pipe' ? SF.pipeFactor(l) : 1;            // head lift: too high = less or no flow
      const rate = spec.rate * hf / 60;
      const len = SF.linkLength(l);
      const ed = {
        l, from: a, fp: l.from[1], to: b, tp: l.to[1], rate, cap: spec.rate * hf, headFactor: hf,
        q: {}, qt: 0, qmax: Math.max(l.kind === 'pipe' ? len * 0.1 : len / 1.2, rate * DT * 2, 1),
        inLeft: 0, outLeft: 0, moved: {}, jam: 0, len,
      };
      a.out[ed.fp] = ed; a.outs.push(ed);
      b.in[ed.tp] = ed; b.ins.push(ed);
      edges.push(ed);
    }
    const list = [...nodes.values()];
    list.forEach(n => n.init());
    return { nodes: list, edges };
  }

  function step(g, meas, k) {
    for (const ed of g.edges) { ed.inLeft = ed.rate * DT; ed.outLeft = ed.rate * DT; }
    for (const n of g.nodes) n.process(meas, k);
    for (const n of g.nodes) n.push(meas, k);
    for (const n of g.nodes) n.pull(meas, k);
  }

  function finish(g) {
    const T = MEAS * DT;
    const perMin = v => v / T * 60;
    const res = { nodes: new Map(), edges: new Map(), version: g.version };
    const bal = {};  // item -> {prod, cons}
    let powerUse = 0, powerMax = 0, powerGen = 0, sinkPoints = 0;
    const external = { in: {}, out: {} };
    for (const n of g.nodes) {
      const st = n.st;
      const r = { eff: st.frac / MEAS, starve: st.starve / MEAS, block: st.block / MEAS, ins: {}, outs: {}, voided: {} };
      for (const it in st.cons) r.ins[it] = perMin(st.cons[it]);
      for (const it in st.prod) r.outs[it] = perMin(st.prod[it]);
      for (const it in st.voided) r.voided[it] = perMin(st.voided[it]);
      r.power = st.power / MEAS; r.gen = st.gen / MEAS;
      if (n.kind === 'machine' || n.kind === 'extractor' || n.kind === 'pressurizer') {
        powerUse += r.power; powerMax += n.maxPower || 0;
      }
      powerGen += r.gen;
      // status
      if (n.noRecipe) r.status = 'noRecipe';
      else if (n.noFuel) r.status = 'noFuel';
      else if (['machine', 'extractor', 'generator'].includes(n.kind)) {
        if (r.eff > 0.995) r.status = 'ok';
        else if (r.eff < 0.005) r.status = r.block > r.starve ? 'blocked' : 'idle';
        else r.status = r.block > r.starve ? (n.kind === 'extractor' ? 'throttled' : 'blocked') : 'starved';
      } else r.status = 'ok';
      if (n.kind === 'machine') {
        r.maxIn = Object.fromEntries(n.rin.map(([i, a]) => [i, a * n.cps * 60]));
        r.maxOut = Object.fromEntries(n.rout.map(([i, a]) => [i, a * n.cps * 60]));
      }
      if (n.kind === 'extractor') r.maxOut = { [n.item]: n.rate * 60 };
      if (n.kind === 'generator' && !n.geo && !n.noFuel) {
        r.maxIn = { [n.fuel]: n.fuelRate * 60 };
        if (n.supp) r.maxIn[n.supp] = n.suppRate * 60;
        if (n.by) r.maxOut = { [n.by]: n.byRate * 60 };
        r.maxGen = n.P;
      }
      if (n.kind === 'generator' && n.geo) r.maxGen = n.P;
      if (n.kind === 'sink' && n.d.raw.awesome) {
        for (const it in r.ins) sinkPoints += r.ins[it] * (SF.item(it).sink || 0);
      }
      if (['machine', 'extractor', 'generator'].includes(n.kind)) {
        for (const it in r.ins) (bal[it] ||= { prod: 0, cons: 0 }).cons += r.ins[it];
        for (const it in r.outs) (bal[it] ||= { prod: 0, cons: 0 }).prod += r.outs[it];
      }
      if (n.kind === 'source') for (const it in r.outs) add(external.in, it, r.outs[it]);
      if (n.kind === 'vsink' || n.kind === 'sink' || n.kind === 'storage') for (const it in r.ins) add(external.out, it, r.ins[it]);
      for (const it in r.voided) add(external.out, it, r.voided[it]);
      res.nodes.set(n.e.id, r);
    }
    for (const ed of g.edges) {
      const flows = {};
      let total = 0;
      for (const it in ed.moved) { flows[it] = perMin(ed.moved[it]); total += flows[it]; }
      res.edges.set(ed.l.id, {
        flows, total, cap: ed.cap, util: total / ed.cap, jam: ed.jam / MEAS, jamItem: ed.jamItem, len: ed.len,
      });
    }
    res.summary = { powerUse, powerMax, powerGen, sinkPoints, balance: bal, external };
    return res;
  }

  // ------------------------------------------------------------ convergence
  // After the warm-up, measure in windows of MEAS steps and keep going until two windows agree, so deep
  // factories (long chains, slow recipes, big buffers) settle before they are reported.
  const MAX_STEPS = 60000;
  function resetMeas(g) {
    for (const n of g.nodes) n.st = { frac: 0, starve: 0, block: 0, cons: {}, prod: {}, gen: 0, power: 0, voided: {} };
    for (const ed of g.edges) { ed.moved = {}; ed.jam = 0; }
  }
  function fingerprint(g) {
    const v = [];
    for (const n of g.nodes) { v.push(n.st.frac); for (const it in n.st.prod) v.push(n.st.prod[it]); }
    for (const ed of g.edges) { let t = 0; for (const it in ed.moved) t += ed.moved[it]; v.push(t); }
    return v;
  }
  const settled = (a, b) => a && a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) <= Math.max(0.002 * Math.max(Math.abs(x), Math.abs(b[i])), 0.02));
  // one step of the run; returns true when finished
  function advance(j) {
    if (j.phase === 'warm') {
      step(j.g, false, j.k); j.k++;
      if (j.k >= WARM) { j.phase = 'meas'; j.w = 0; resetMeas(j.g); }
      return false;
    }
    step(j.g, true, j.k); j.k++; j.w++;
    if (j.w < MEAS) return false;
    const fp = fingerprint(j.g);
    if (settled(j.prev, fp) || j.k >= MAX_STEPS) { j.windows++; return true; }
    j.prev = fp; j.windows++; j.w = 0; resetMeas(j.g);
    return false;
  }
  const newJob = g => ({ g, k: 0, phase: 'warm', w: 0, prev: null, windows: 0 });

  // ------------------------------------------------------------ chunked runner
  let job = null, timer = 0;
  sim.request = () => { clearTimeout(timer); job = null; if (SF.live && SF.live.active) { sim.running = false; return; } timer = setTimeout(start, 80); };

  function start() {
    if (SF.live && SF.live.active) { sim.running = false; return; }
    const g = build();
    g.version = S.version;
    job = newJob(g);
    sim.running = true; sim.progress = 0;
    tick(job);
  }

  function tick(j) {
    if (j !== job) return;
    const until = performance.now() + 6;           // small slices so dragging / panning stay smooth
    let done = false;
    while (!done && performance.now() < until) for (let i = 0; i < 25 && !done; i++) done = advance(j);
    // progress: warm-up, then each measuring window (most plans settle after the first two)
    sim.progress = Math.min(0.99, j.k / (WARM + MEAS * Math.max(2, j.windows + 1)));
    if (SF.live && SF.live.active) { sim.running = false; job = null; return; }
    if (done) {
      sim.result = finish(j.g);
      sim.result.settleSteps = j.k;
      sim.running = false; job = null;
      sim.listeners.forEach(fn => fn(sim.result));
    } else setTimeout(() => tick(j), 0);
  }

  // headless synchronous run (used for tests)
  sim.runSync = () => {
    const g = build();
    g.version = S.version;
    const j = newJob(g);
    while (!advance(j));
    sim.result = finish(g);
    sim.result.settleSteps = j.k;
    return sim.result;
  };
})(window.SF);
