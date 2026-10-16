// Document model: entities, links (belts/pipes), levels, history, persistence.
(function (SF) {
  const D = SF.D;
  const S = SF.state = {
    entities: new Map(),
    links: new Map(),
    levels: [{ name: 'Floor 1' }],
    level: 0,
    version: 0,          // bumps on every structural/property change
    portLinks: new Map(),
    settings: {
      snap: 1, grid: true, anim: true, labels: true, ghostLevels: true,
      openOutputsBlock: false, settingsVersion: 2, levelHeight: 4, showRates: true, ghostOpacity: 0.3, ghostAbove: false, floorHeight3d: 16, models3d: true, beltStyle: 'curve',
    },
  };

  // ------------------------------------------------------------ entities
  SF.defaultProps = (def) => {
    const p = {};
    const b = def.raw || {};
    switch (def.kind) {
      case 'machine': {
        // sensible starting recipe per machine; otherwise the most-used standard product
        const PREFERRED = {
          Build_ConstructorMk1_C: 'Recipe_IronPlate_C', Build_SmelterMk1_C: 'Recipe_IngotIron_C',
          Build_FoundryMk1_C: 'Recipe_IngotSteel_C', Build_OilRefinery_C: 'Recipe_Plastic_C',
          Build_Packager_C: 'Recipe_PackagedWater_C', Build_ManufacturerMk1_C: 'Recipe_Computer_C',
          Build_AssemblerMk1_C: 'Recipe_IronPlateReinforced_C', Build_Blender_C: 'Recipe_CoolingSystem_C',
          Build_HadronCollider_C: 'Recipe_Diamond_C', Build_Converter_C: 'Recipe_FicsiteIngot_Iron_C',
          Build_QuantumEncoder_C: 'Recipe_SuperpositionOscillator_C',
        };
        if (PREFERRED[def.id] && SF.D.recipes[PREFERRED[def.id]]) { p.recipe = PREFERRED[def.id]; p.clock = 1; p.sloops = 0; break; }
        const rs = SF.recipesFor(def.id);
        const std = rs.filter(r => !r.alt && !r.event);
        if (!SF._uses) {
          SF._uses = {};
          for (const r of Object.values(SF.D.recipes)) for (const [i] of r.in) SF._uses[i] = (SF._uses[i] || 0) + 1;
        }
        const uses = r => SF._uses[r.out[0][0]] || 0;
        const pick = (std.length ? std : rs).slice().sort((a, b) => uses(b) - uses(a))[0];
        p.recipe = pick ? pick.id : null; p.clock = 1; p.sloops = 0; break;
      }
      case 'extractor':
        p.resource = b.resources.includes('Desc_OreIron_C') ? 'Desc_OreIron_C' : b.resources[0];
        p.purity = 1; p.clock = 1; break;
      case 'generator':
        p.fuel = b.fuels.length ? b.fuels[0].fuel : null; p.clock = 1; p.purity = 1; break;
      case 'splitter':
        p.rules = [['any'], ['any'], ['any']]; break;
      case 'merger':
        if (b.priority) p.prio = [2, 1, 2]; break;
      case 'pump':
        p.limit = 600; break;
      case 'pole':
        p.h = 1; p.ang = 0; break;
      case 'pressurizer':
        p.clock = 1; break;
      case 'source':
        p.item = def.id === 'V_SourceF' ? 'Desc_Water_C' : 'Desc_OreIron_C'; p.rate = 60; p.name = ''; break;
      case 'vsink':
        p.name = ''; break;
      case 'label':
        p.text = 'Label'; p.size = 1.6; p.color = '#e5e7eb'; break;
      case 'zone':
        p.text = 'Zone'; p.color = '#a78bfa'; p.w = 16; p.h = 16; break;
      case 'designer':
        p.text = ''; break;
    }
    return p;
  };

  SF.addEntity = (defId, x, y, rot = 0, level = S.level, props) => {
    const def = SF.defs[defId];
    if (!def) return null;
    const e = { id: SF.uid(), def: defId, x, y, rot, level, ...SF.defaultProps(def), ...(props || {}) };
    S.entities.set(e.id, e);
    return e;
  };

  SF.removeEntity = (id) => {
    const e = S.entities.get(id);
    for (const l of [...S.links.values()]) if (l.from[0] === id || l.to[0] === id) S.links.delete(l.id);
    S.entities.delete(id);
    if (e && e.pair && S.entities.has(e.pair)) SF.removeEntity(e.pair);   // a lift's two ends go together
  };

  // ------------------------------------------------------------ conveyor lifts
  // A placed lift bottom gets its top on the next floor up (a floor is added if there is none) and the vertical
  // lift link between them. The link runs up or down depending on how belts connect to the ends (fixLifts).
  SF.makeLift = (bottom, tier = 1) => {
    let lv = bottom.level + 1;
    if (lv >= S.levels.length) lv = SF.addLevel();
    const top = SF.addEntity('LiftTop', bottom.x, bottom.y, bottom.rot, lv, {});
    bottom.pair = top.id; top.pair = bottom.id;
    bottom.liftH = SF.clamp(Math.round(SF.levelZ(lv) - SF.levelZ(bottom.level)), SF.LIFT_MIN, SF.LIFT_MAX);
    const l = { id: SF.uid(), kind: 'lift', tier, from: [bottom.id, 1], to: [top.id, 0], pts: [] };
    S.links.set(l.id, l);
    S.portLinks.set(SF.portKey(bottom.id, 1), l); S.portLinks.set(SF.portKey(top.id, 0), l);
    return top;
  };
  // Lift height, like the game: 4–48 m in 1 m steps, independent of the floors. The top sits on the highest floor at
  // or below the top of the lift; if that floor is lower, the top connector is raised above it (port height).
  SF.LIFT_MIN = 4; SF.LIFT_MAX = 48;
  SF.liftHeight = (bottom, top) => (bottom.liftH != null ? bottom.liftH : Math.max(SF.LIFT_MIN, SF.levelZ(top.level) - SF.levelZ(bottom.level)));
  SF.liftTopLevel = (bottom, H) => {
    const zTop = SF.levelZ(bottom.level) + H;
    let best = bottom.level;
    S.levels.forEach((l, i) => { if (SF.levelZ(i) <= zTop + 1e-6 && SF.levelZ(i) > SF.levelZ(best)) best = i; });
    return best;
  };
  SF.liftOf = (e) => {
    if (!e || SF.defs[e.def].kind !== 'liftend') return null;
    const other = S.entities.get(e.pair);
    const bottom = SF.defs[e.def].end === 'bottom' ? e : other, top = bottom === e ? other : e;
    if (!bottom || !top) return null;
    const link = S.portLinks.get(SF.portKey(bottom.id, 1));
    const up = !link || link.from[0] === bottom.id;
    // direction is fixed by the belts when either end has one
    const fixed = S.portLinks.has(SF.portKey(bottom.id, 0)) || S.portLinks.has(SF.portKey(top.id, 1));
    return { bottom, top, link, up, fixed, height: SF.liftHeight(bottom, top) };
  };
  // direction from the belts: a belt INTO the bottom (or OUT OF the top) means the lift runs up, the reverse down
  function fixLifts() {
    for (const l of S.links.values()) {
      if (l.kind !== 'lift') continue;
      const a = S.entities.get(l.from[0]), b = S.entities.get(l.to[0]);
      if (!a || !b) continue;
      const bottom = SF.defs[a.def].end === 'bottom' ? a : b, top = bottom === a ? b : a;
      const kb = S.portLinks.get(SF.portKey(bottom.id, 0)), kt = S.portLinks.get(SF.portKey(top.id, 1));
      // the belts decide; with no belt on either end the lift keeps the direction chosen in the inspector
      let up = !bottom.liftDown;
      if (kb) up = kb.to[0] === bottom.id;
      else if (kt) up = kt.from[0] === top.id;
      const want = up ? [[bottom.id, 1], [top.id, 0]] : [[top.id, 0], [bottom.id, 1]];
      if (l.from[0] !== want[0][0]) { l.from = want[0]; l.to = want[1]; }
      // keep the top over the bottom (each end's connector can face its own way)
      if (top.x !== bottom.x || top.y !== bottom.y) { top.x = bottom.x; top.y = bottom.y; }
      // height: the top goes on the floor at or below the top of the lift, its connector raised to the right height
      const H = SF.liftHeight(bottom, top);
      top.level = SF.liftTopLevel(bottom, H);
      const ph = SF.levelZ(bottom.level) + H - SF.levelZ(top.level) + 1;
      if (Math.abs(ph - 1) < 1e-6) delete top.ph; else top.ph = ph;
    }
  }
  SF.fixLifts = fixLifts;

  SF.entSize = (e) => {
    const d = SF.defs[e.def];
    const w = SF.defW(d, e), h = SF.defH(d, e);
    return e.rot % 2 ? [h, w] : [w, h];
  };

  SF.entRect = (e) => {
    const [w, h] = SF.entSize(e);
    return { x0: e.x - w / 2, y0: e.y - h / 2, x1: e.x + w / 2, y1: e.y + h / 2 };
  };

  // world-space port {x,y,dx,dy,io,fluid}
  SF.portWorld = (e, i) => {
    const d = SF.defs[e.def];
    const p = d.ports[i];
    if (!p) return null;
    let x, y, dx, dy;
    if (d.kind === 'pole') {
      // conveyor poles point along the belt at any angle
      const c = Math.cos(e.ang || 0), s = Math.sin(e.ang || 0);
      x = p.x * c - p.y * s; y = p.x * s + p.y * c;
      dx = p.dx * c - p.dy * s; dy = p.dx * s + p.dy * c;
    } else {
      [x, y] = SF.rot(p.x, p.y, e.rot);
      [dx, dy] = SF.rot(p.dx, p.dy, e.rot);
    }
    return { x: e.x + x, y: e.y + y, dx, dy, io: p.io, fluid: p.fluid, label: p.label, e, i };
  };

  SF.ports = (e) => SF.defs[e.def].ports.map((_, i) => SF.portWorld(e, i));
  // 3D position of a port: same as 2D unless the building stacks its connectors (see defs: y3 / h3)
  SF.portWorld3 = (e, i) => {
    const P = SF.portWorld(e, i);
    const p = P && SF.defs[e.def].ports[i];
    if (!p || p.y3 == null || SF.defs[e.def].kind === 'pole') return P;
    const [x, y] = SF.rot(p.x, p.y3, e.rot);
    return { ...P, x: e.x + x, y: e.y + y };
  };

  // snap entity centre so that its footprint edges sit on the grid
  SF.snapPos = (defId, x, y, rot, snapOverride) => {
    const d = SF.defs[defId];
    let snap = snapOverride ?? S.settings.snap;
    let w = d.w, h = d.h;
    if (rot % 2) [w, h] = [h, w];
    if (d.structure && d.kind !== 'wall') snap = Math.max(snap, Math.min(d.w, d.h, 8));
    if (d.kind === 'wall') {
      // walls sit on foundation edges: long axis centred in a cell, thin axis on a grid line
      const g = Math.max(snap, 4);
      if (rot % 2 === 0) return [Math.round((x - w / 2) / g) * g + w / 2, Math.round(y / 8) * 8];
      return [Math.round(x / 8) * 8, Math.round((y - h / 2) / g) * g + h / 2];
    }
    if (!snap) return [x, y];
    return [Math.round((x - w / 2) / snap) * snap + w / 2, Math.round((y - h / 2) / snap) * snap + h / 2];
  };

  // ------------------------------------------------------------ links
  SF.portKey = (eid, pi) => eid + ':' + pi;

  SF.rebuildIndex = () => {
    S.portLinks.clear();
    for (const l of S.links.values()) {
      S.portLinks.set(SF.portKey(l.from[0], l.from[1]), l);
      S.portLinks.set(SF.portKey(l.to[0], l.to[1]), l);
    }
  };

  // returns {from:[eid,pi], to:[eid,pi]} oriented output->input, or {error}
  SF.canConnect = (a, b) => {
    if (!a || !b) return { error: 'Missing port' };
    if (a[0] === b[0]) return { error: 'Same building' };
    const ea = S.entities.get(a[0]), eb = S.entities.get(b[0]);
    const pa = SF.defs[ea.def].ports[a[1]], pb = SF.defs[eb.def].ports[b[1]];
    if (pa.fluid !== pb.fluid) return { error: 'Cannot connect a belt port to a pipe port' };
    if (S.portLinks.has(SF.portKey(...a)) || S.portLinks.has(SF.portKey(...b))) return { error: 'Port already connected' };
    const canOut = p => p.io === 'out' || p.io === 'any';
    const canIn = p => p.io === 'in' || p.io === 'any';
    if (canOut(pa) && canIn(pb)) return { from: a, to: b };
    if (canOut(pb) && canIn(pa)) return { from: b, to: a };
    return { error: pa.io === 'in' ? 'Both ports are inputs' : 'Both ports are outputs' };
  };

  SF.addLink = (a, b, kind, tier, pts = []) => {
    const c = SF.canConnect(a, b);
    if (c.error) return c;
    const l = { id: SF.uid(), kind, tier, from: c.from, to: c.to, pts };
    if (c.from !== a) l.pts = [...pts].reverse();
    S.links.set(l.id, l);
    // index just this link's two ports (rebuilding the whole index per belt was quadratic on big factories)
    S.portLinks.set(SF.portKey(l.from[0], l.from[1]), l);
    S.portLinks.set(SF.portKey(l.to[0], l.to[1]), l);
    return l;
  };

  SF.linkSpec = (l) => (l.kind === 'pipe' ? D.pipes : D.belts).find(x => x.tier === l.tier) || (l.kind === 'pipe' ? D.pipes[0] : D.belts[0]);

  // ------------------------------------------------------------ belt / pipe paths
  // Paths are dense polylines of [x, y, h] (h = height above the floor). Three styles, like the game's
  // build modes: 'curve' (smooth spline), 'straight' (straight runs, small rounded corners) and
  // 'ortho' (right angles with rounded corners).
  // names match the game's build modes: Default (smooth), Straight (straight lines + 90° turns), Curve (railway-like arcs)
  SF.BELT_STYLES = [['curve', 'Default'], ['ortho', 'Straight'], ['straight', 'Curve']];
  const STUB = 0.6;            // straight connector length out of a port, like the game's snap stubs
  SF.linkStyle = l => l.route || (l.direct ? 'straight' : S.settings.beltStyle || 'curve');

  // height (above its floor) at which a belt/pipe meets a port
  SF.portHeight = (e, i) => {
    const d = SF.defs[e.def];
    if (d.kind === 'pole') return e.h ?? 1;
    if (d.kind === 'liftend' && e.ph != null) return e.ph;     // a lift top between floors (set by fixLifts)
    const p = d.ports[i];
    return p && p.h3 != null ? p.h3 : 1;
  };

  // Right-angle (game "Straight" mode) route from P (leaving along ds) to Q (arriving travelling along de; null =
  // any direction). Tries L, Z, step-out-first and sideways-detour shapes and keeps the shortest one that never
  // doubles back, leaves P forwards, enters Q the right way round, and has room for every corner to be a full
  // 2 m radius turn (sA / sB = straight length available before P and after Q, e.g. the 0.6 m connector stub).
  const axisOf = v => (Math.abs(v[0]) >= Math.abs(v[1]) ? [Math.sign(v[0]) || 1, 0] : [0, Math.sign(v[1]) || 1]);
  function orthoLeg(out, P, Q, ds, de, sA = STUB, sB = STUB) {
    const dsa = ds ? axisOf(ds) : null, dea = de ? axisOf(de) : null;
    const cands = [];
    for (const e of [0, 2, 2.6, 4, 7]) {
      const P2 = e && dsa ? [P[0] + dsa[0] * e, P[1] + dsa[1] * e] : P;
      for (const f of de ? [0, 2, 2.6, 4, 7] : [0]) {
        const Q2 = f ? [Q[0] - dea[0] * f, Q[1] - dea[1] * f] : Q;
        const mx = (P2[0] + Q2[0]) / 2, my = (P2[1] + Q2[1]) / 2;
        const mids = [[[Q2[0], P2[1]]], [[P2[0], Q2[1]]], [[mx, P2[1]], [mx, Q2[1]]], [[P2[0], my], [Q2[0], my]]];
        // sideways detours, needed when both ends are on one line but the belt has to come back
        for (const o of [4, -4, 6, -6, 8, -8]) {
          mids.push([[P2[0], P2[1] + o], [Q2[0], P2[1] + o]], [[P2[0] + o, P2[1]], [P2[0] + o, Q2[1]]]);
        }
        for (const m of mids) cands.push([...(P2 !== P ? [P2] : []), ...m, ...(Q2 !== Q ? [Q2] : []), Q]);
      }
    }
    let best = null, bestScore = Infinity;
    for (const c of cands) {
      // straight runs, including the approach before P and the exit after Q
      const runs = ds ? [{ u: norm(ds), l: sA }] : [];
      let ok = true, len = 0;
      const pts = [P, ...c];
      for (let i = 1; i < pts.length; i++) {
        const dx = pts[i][0] - pts[i - 1][0], dy = pts[i][1] - pts[i - 1][1], l = Math.hypot(dx, dy);
        if (l < 1e-6) continue;
        if (Math.abs(dx) > 1e-6 && Math.abs(dy) > 1e-6) { ok = false; break; }    // must be axis-aligned
        const u = [dx / l, dy / l];
        const last = runs[runs.length - 1];
        if (last && Math.abs(u[0] * last.u[0] + u[1] * last.u[1] - 1) < 1e-6) last.l += l;
        else runs.push({ u, l });
        len += l;
      }
      if (!ok) continue;
      if (de) {
        const last = runs[runs.length - 1], u = norm(de);
        if (last && Math.abs(u[0] * last.u[0] + u[1] * last.u[1] - 1) < 1e-6) last.l += sB; else runs.push({ u, l: sB });
      }
      // corners: never double back; each needs t = R·tan(θ/2) of straight run on both sides
      const tC = [];
      for (let k = 1; k < runs.length; k++) {
        const dot = SF.clamp(runs[k].u[0] * runs[k - 1].u[0] + runs[k].u[1] * runs[k - 1].u[1], -1, 1);
        if (dot < -1e-6) { ok = false; break; }
        tC.push(R_MIN * Math.tan(Math.acos(dot) / 2));
      }
      if (!ok) continue;
      let deficit = 0;
      runs.forEach((r, k) => { deficit += Math.max(0, (k > 0 ? tC[k - 1] : 0) + (k < runs.length - 1 ? tC[k] : 0) - r.l - 1e-6); });
      const score = len + tC.length * 2.5 + deficit * 100;
      if (score < bestScore) { bestScore = score; best = c; }
    }
    if (!best) best = [[Q[0], P[1]], Q];
    out.push(...best);
  }

  function dedupe(pts) {
    const out = [];
    for (const p of pts) {
      const n = out.length;
      if (n && Math.hypot(p[0] - out[n - 1][0], p[1] - out[n - 1][1]) < 1e-4) continue;
      if (n >= 2) {
        const a = out[n - 2], b = out[n - 1];
        const cross = (b[0] - a[0]) * (p[1] - b[1]) - (b[1] - a[1]) * (p[0] - b[0]);
        const dot = (b[0] - a[0]) * (p[0] - b[0]) + (b[1] - a[1]) * (p[1] - b[1]);
        if (Math.abs(cross) < 1e-6 && dot > 0) { out[n - 1] = p; continue; }
      }
      out.push(p);
    }
    return out;
  }

  // round every interior corner with an arc of radius r (shrunk to fit short legs)
  function fillet(pts, r) {
    if (pts.length < 3 || r <= 0) return pts;
    const out = [pts[0]];
    for (let i = 1; i < pts.length - 1; i++) {
      const p = pts[i], a = out[out.length - 1], b = pts[i + 1];
      const v1 = [p[0] - a[0], p[1] - a[1]], v2 = [b[0] - p[0], b[1] - p[1]];
      const l1 = Math.hypot(...v1), l2 = Math.hypot(...v2);
      if (l1 < 1e-6 || l2 < 1e-6) { out.push(p); continue; }
      const u1 = [v1[0] / l1, v1[1] / l1], u2 = [v2[0] / l2, v2[1] / l2];
      const cos = SF.clamp(u1[0] * u2[0] + u1[1] * u2[1], -1, 1);
      const theta = Math.acos(cos);                 // turning angle
      if (theta < 1e-3) { out.push(p); continue; }
      let t = r * Math.tan(theta / 2);
      // l1 is what is left of the previous leg after the previous corner took its share; the next leg is
      // shared with the next corner, so take at most what this corner needs out of half of it
      const nextNeed = (() => {
        if (i + 2 >= pts.length) return 0;
        const n1 = [pts[i + 2][0] - b[0], pts[i + 2][1] - b[1]], ln = Math.hypot(...n1);
        if (ln < 1e-6) return 0;
        const c2 = SF.clamp((u2[0] * n1[0] + u2[1] * n1[1]) / ln, -1, 1);
        return r * Math.tan(Math.acos(c2) / 2);
      })();
      t = Math.min(t, l1, i === pts.length - 2 ? l2 : Math.max(l2 - nextNeed, l2 * 0.5));
      const rr = t / Math.tan(theta / 2);
      const s = [p[0] - u1[0] * t, p[1] - u1[1] * t], e = [p[0] + u2[0] * t, p[1] + u2[1] * t];
      const side = u1[0] * u2[1] - u1[1] * u2[0] > 0 ? 1 : -1;
      const c = [s[0] - u1[1] * rr * side, s[1] + u1[0] * rr * side];
      const a0 = Math.atan2(s[1] - c[1], s[0] - c[0]);
      const steps = Math.max(2, Math.ceil(theta / (Math.PI / 16)));
      for (let k = 0; k <= steps; k++) {
        const ang = a0 + side * theta * (k / steps);
        out.push([c[0] + Math.cos(ang) * rr, c[1] + Math.sin(ang) * rr]);
      }
      void e;
    }
    out.push(pts[pts.length - 1]);
    return out;
  }

  // cubic Hermite through nodes with given end tangents (smooth, game-like default belts)
  function hermiteChain(nodes, tStart, tEnd, scale = 1) {
    const n = nodes.length;
    const tan = nodes.map((p, i) => {
      if (i === 0) return tStart;
      if (i === n - 1) return tEnd || norm([p[0] - nodes[i - 1][0], p[1] - nodes[i - 1][1]]);
      return norm([nodes[i + 1][0] - nodes[i - 1][0], nodes[i + 1][1] - nodes[i - 1][1]]);
    });
    const out = [nodes[0]];
    for (let i = 0; i < n - 1; i++) {
      const P0 = nodes[i], P1 = nodes[i + 1];
      const c = Math.hypot(P1[0] - P0[0], P1[1] - P0[1]);
      if (c < 1e-6) continue;
      // tangent length grows when the ends point away from each other (U-turns need room)
      const T0 = tan[i], T1 = tan[i + 1];
      const align = (T0[0] * T1[0] + T0[1] * T1[1]);
      const m = c * (1.0 + 0.35 * (1 - align)) * scale;
      const steps = Math.max(6, Math.ceil(c / 0.4));
      for (let k = 1; k <= steps; k++) {
        const t = k / steps, t2 = t * t, t3 = t2 * t;
        const h00 = 2 * t3 - 3 * t2 + 1, h10 = t3 - 2 * t2 + t, h01 = -2 * t3 + 3 * t2, h11 = t3 - t2;
        out.push([h00 * P0[0] + h10 * m * T0[0] + h01 * P1[0] + h11 * m * T1[0],
          h00 * P0[1] + h10 * m * T0[1] + h01 * P1[1] + h11 * m * T1[1]]);
      }
    }
    return out;
  }
  function hasCusp(pts) {
    for (let i = 2; i < pts.length; i++) {
      const ax = pts[i - 1][0] - pts[i - 2][0], ay = pts[i - 1][1] - pts[i - 2][1], bx = pts[i][0] - pts[i - 1][0], by = pts[i][1] - pts[i - 1][1];
      const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
      if (la > 1e-4 && lb > 1e-4 && (ax * bx + ay * by) / (la * lb) < -0.2) return true;
    }
    return false;
  }
  function norm(v) { const l = Math.hypot(v[0], v[1]) || 1; return [v[0] / l, v[1] / l]; }

  // ------------------------------------------------------------ game belt rules
  // From the game: belts turn no tighter than a 2 m radius, climb at most 35°, never climb while turning
  // (they turn, then climb), and one belt spans 0.5–56 m between connections.
  const R_MIN = 2.0;
  SF.BELT_RULES = { minRadius: R_MIN, maxSlopeDeg: 35, maxLength: 56, minLength: 0.5 };
  const TAU = Math.PI * 2;
  const mod2pi = a => ((a % TAU) + TAU) % TAU;

  // Dubins path: shortest route from (p0, heading th0) to (p1, heading th1) made of arcs of radius R and
  // straight lines. Returns { len, words: [[type, amount]...] } (arcs in radians, straights in metres).
  function dubins(p0, th0, p1, th1, R) {
    const dx = p1[0] - p0[0], dy = p1[1] - p0[1], D = Math.hypot(dx, dy), d = D / R;
    const th = mod2pi(Math.atan2(dy, dx)), a = mod2pi(th0 - th), b = mod2pi(th1 - th);
    const sa = Math.sin(a), sb = Math.sin(b), ca = Math.cos(a), cb = Math.cos(b), cab = Math.cos(a - b);
    const out = [];
    let ps = 2 + d * d - 2 * cab + 2 * d * (sa - sb);                                   // LSL
    if (ps >= 0) { const t1 = Math.atan2(cb - ca, d + sa - sb); out.push([['L', mod2pi(-a + t1)], ['S', Math.sqrt(ps)], ['L', mod2pi(b - t1)]]); }
    ps = 2 + d * d - 2 * cab + 2 * d * (sb - sa);                                       // RSR
    if (ps >= 0) { const t1 = Math.atan2(ca - cb, d - sa + sb); out.push([['R', mod2pi(a - t1)], ['S', Math.sqrt(ps)], ['R', mod2pi(-b + t1)]]); }
    ps = -2 + d * d + 2 * cab + 2 * d * (sa + sb);                                      // LSR
    if (ps >= 0) { const p = Math.sqrt(ps), t2 = Math.atan2(-ca - cb, d + sa + sb) - Math.atan2(-2, p); out.push([['L', mod2pi(-a + t2)], ['S', p], ['R', mod2pi(-mod2pi(b) + t2)]]); }
    ps = d * d - 2 + 2 * cab - 2 * d * (sa + sb);                                       // RSL
    if (ps >= 0) { const p = Math.sqrt(ps), t2 = Math.atan2(ca + cb, d - sa - sb) - Math.atan2(2, p); out.push([['R', mod2pi(a - t2)], ['S', p], ['L', mod2pi(b - t2)]]); }
    let tt = (6 - d * d + 2 * cab + 2 * d * (sa - sb)) / 8;                              // RLR
    if (Math.abs(tt) <= 1) { const p = mod2pi(TAU - Math.acos(tt)), t = mod2pi(a - Math.atan2(ca - cb, d - sa + sb) + p / 2); out.push([['R', t], ['L', p], ['R', mod2pi(a - b - t + p)]]); }
    tt = (6 - d * d + 2 * cab + 2 * d * (sb - sa)) / 8;                                  // LRL
    if (Math.abs(tt) <= 1) { const p = mod2pi(TAU - Math.acos(tt)), t = mod2pi(-a - Math.atan2(ca - cb, d + sa - sb) + p / 2); out.push([['L', t], ['R', p], ['L', mod2pi(mod2pi(b) - a - t + p)]]); }
    let best = null;
    for (const w of out) {
      const words = w.map(([k, v]) => [k, k === 'S' ? v * R : v]);
      const len = words.reduce((s2, [k, v]) => s2 + (k === 'S' ? v : v * R), 0);
      if (!best || len < best.len) best = { len, words };
    }
    return best;
  }
  // arc-then-straight to a free point (no required end direction)
  function arcLine(p0, th0, q, R) {
    let best = null;
    for (const side of ['L', 'R']) {
      const sg = side === 'L' ? 1 : -1;
      const c = [p0[0] - sg * R * Math.sin(th0), p0[1] + sg * R * Math.cos(th0)];
      const v = [q[0] - c[0], q[1] - c[1]], dv = Math.hypot(v[0], v[1]);
      if (dv < R) continue;
      const g = Math.atan2(v[1], v[0]), th = g + sg * Math.asin(R / dv);
      const phi = mod2pi(sg * (th - th0));
      const sLen = Math.sqrt(Math.max(0, dv * dv - R * R));
      const len = phi * R + sLen;
      if (!best || len < best.len) best = { len, words: [[side, phi], ['S', sLen]] };
    }
    return best;
  }
  function sampleWords(p0, th0, words, R, step = 0.35) {
    let x = p0[0], y = p0[1], th = th0;
    const out = [];
    for (const [k, v] of words) {
      if (k === 'S') {
        const n = Math.max(1, Math.ceil(v / 4));
        for (let i = 1; i <= n; i++) out.push([x + Math.cos(th) * v * i / n, y + Math.sin(th) * v * i / n]);
        x += Math.cos(th) * v; y += Math.sin(th) * v;
      } else {
        const sg = k === 'L' ? 1 : -1;
        const c = [x - sg * R * Math.sin(th), y + sg * R * Math.cos(th)];
        const n = Math.max(1, Math.ceil(v * R / step));
        for (let i = 1; i <= n; i++) {
          const t2 = th + sg * v * i / n;
          out.push([c[0] + sg * R * Math.sin(t2), c[1] - sg * R * Math.cos(t2)]);
        }
        th += sg * v; x = c[0] + sg * R * Math.sin(th); y = c[1] - sg * R * Math.cos(th);
      }
    }
    return out;
  }
  // smallest horizontal turning radius along a dense path (Infinity if it never turns)
  SF.pathMinRadius = (pts) => {
    let minR = Infinity, prev = null;
    for (let i = 1; i < pts.length; i++) {
      const dx = pts[i][0] - pts[i - 1][0], dy = pts[i][1] - pts[i - 1][1], l = Math.hypot(dx, dy);
      if (l < 1e-3) continue;
      const u = [dx / l, dy / l, l];
      if (prev) {
        const th = Math.acos(SF.clamp(u[0] * prev[0] + u[1] * prev[1], -1, 1));
        if (th > 1e-3) minR = Math.min(minR, ((l + prev[2]) / 2) / th);
      }
      prev = u;
    }
    return minR;
  };

  // A: start port {x,y,dx,dy,h} (dx,dy = outward direction = travel direction)
  // B: end port {x,y,dx,dy,h} (dx,dy = outward, travel arrives along -d) or a free point {x,y,h}
  // wps: waypoints [x,y,(h)]. Returns dense [x,y,h] points.
  // Styles (as in game): 'curve' = Default (smooth), 'ortho' = Straight (straight lines + 90° turns),
  // 'straight' = Curve (railway-like arcs and straights). All keep turns at or above the game's 2 m radius.
  SF.routePath = (A, B, wps = [], mode = 'curve') => {
    const hasB = B.dx !== undefined;
    const axisAligned = (dx, dy) => Math.abs(dx) < 1e-6 || Math.abs(dy) < 1e-6;
    // angled connectors (free-angle poles) need a longer stub in Straight mode to turn onto the grid
    const stA = mode === 'ortho' && !axisAligned(A.dx, A.dy) ? STUB + 1 : STUB;
    const stB = mode === 'ortho' && hasB && !axisAligned(B.dx, B.dy) ? STUB + 1 : STUB;
    const a0 = [A.x, A.y], a1 = [A.x + A.dx * stA, A.y + A.dy * stA];
    const b0 = [B.x, B.y], b1 = hasB ? [B.x + B.dx * stB, B.y + B.dy * stB] : b0;
    const mids = wps.map(p => [p[0], p[1]]);
    let pts;
    const orthoRoute = (radius) => {
      const o = [a0, a1];
      let dir = [A.dx, A.dy];
      const seq = [...mids, b1];
      seq.forEach((q, i) => {
        const last = o[o.length - 1];
        orthoLeg(o, last, q, dir, i === seq.length - 1 && hasB ? [-B.dx, -B.dy] : null, i === 0 ? stA : 4, stB);
        const k = o.length;
        const ddx = o[k - 1][0] - o[k - 2][0], ddy = o[k - 1][1] - o[k - 2][1];
        dir = Math.abs(ddx) > Math.abs(ddy) ? [Math.sign(ddx), 0] : [0, Math.sign(ddy)];
      });
      if (hasB) o.push(b0);
      return fillet(dedupe(o), radius);
    };
    // arcs + straights through the nodes; prefers wide railway-like arcs when there is room
    const arcRoute = (wide) => {
      const nodes = [a1, ...mids, b1];
      const heads = nodes.map((p, i) => {
        if (i === 0) return Math.atan2(A.dy, A.dx);
        if (i === nodes.length - 1) return hasB ? Math.atan2(-B.dy, -B.dx) : null;
        const v = norm([nodes[i + 1][0] - nodes[i - 1][0], nodes[i + 1][1] - nodes[i - 1][1]]);
        return Math.atan2(v[1], v[0]);
      });
      const out = [a0, a1];
      for (let i = 0; i < nodes.length - 1; i++) {
        const P = nodes[i], Q = nodes[i + 1];
        const solve = R => (heads[i + 1] == null ? arcLine(P, heads[i], Q, R) : dubins(P, heads[i], Q, heads[i + 1], R));
        let pick = solve(R_MIN), Rp = R_MIN;
        if (wide && pick) for (const R of [12, 9, 7, 5, 4, 3]) { const c = solve(R); if (c && c.len <= pick.len * 1.12 + 0.5) { pick = c; Rp = R; break; } }
        if (!pick) { out.push(Q); continue; }
        out.push(...sampleWords(P, heads[i], pick.words, Rp));
      }
      if (hasB) out.push(b0);
      return dedupe(out);
    };
    if (mode === 'ortho') {
      pts = orthoRoute(R_MIN);
    } else if (mode === 'straight') {
      pts = arcRoute(true);
    } else {
      // Default: smooth spline; loosened until no turn is tighter than the game allows, else arcs
      for (const k of [1, 1.4, 1.9, 2.6]) {
        const inner = hermiteChain([a1, ...mids, b1], [A.dx, A.dy], hasB ? [-B.dx, -B.dy] : null, k);
        pts = [a0, ...inner];
        if (hasB) pts.push(b0);
        pts = dedupe(pts);
        if (!hasCusp(pts) && SF.pathMinRadius(pts) >= R_MIN - 0.02) break;
        pts = null;
      }
      if (!pts) pts = arcRoute(true);
    }
    // heights: climb only on straight stretches (in game a belt turns, then climbs), easing between
    // the start, waypoint and end heights
    const hA = A.h ?? 1, hB = B.h ?? hA;
    const straightLen = q => {
      let L2 = 0;
      for (let i = 1; i < q.length; i++) {
        const l = Math.hypot(q[i][0] - q[i - 1][0], q[i][1] - q[i - 1][1]);
        if (l > 0.9) L2 += l;
      }
      return L2;
    };
    const rise = Math.max(Math.abs(hB - hA), ...wps.filter(w => w[2] != null).map(w => Math.abs(w[2] - hA)));
    const needStraight = rise / Math.tan(35 * Math.PI / 180);
    // a smooth Default belt that has to climb but has no straight part: use arcs + straights instead
    if (mode === 'curve' && rise > 0.05 && straightLen(pts) < needStraight) {
      for (const mk of [() => arcRoute(true), () => arcRoute(false), () => orthoRoute(R_MIN)]) { const alt = mk(); if (straightLen(alt) >= needStraight && SF.pathMinRadius(alt) >= R_MIN * 0.95) { pts = alt; break; } }
    }
    const n = pts.length;
    const turn = new Array(n).fill(0);
    for (let i = 1; i < n - 1; i++) {
      const ux = pts[i][0] - pts[i - 1][0], uy = pts[i][1] - pts[i - 1][1], vx = pts[i + 1][0] - pts[i][0], vy = pts[i + 1][1] - pts[i][1];
      const lu = Math.hypot(ux, uy), lv = Math.hypot(vx, vy);
      if (lu > 1e-6 && lv > 1e-6) turn[i] = Math.acos(SF.clamp((ux * vx + uy * vy) / (lu * lv), -1, 1));   // bend angle at the point
    }
    const cum = [0], climb = [0];
    for (let i = 1; i < n; i++) {
      const l = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      cum.push(cum[i - 1] + l);
      // curves are sampled in short pieces (< 0.5 m), so a long piece is a straight; short pieces count as
      // straight only when they barely bend at either end
      const straight = l > 0.9 || (turn[i - 1] < 0.012 && turn[i] < 0.012);
      climb.push(climb[i - 1] + (straight ? l : 0));
    }
    const C = climb[n - 1] > 0.5 ? climb : cum;          // no straight part at all: climb along the whole belt
    const L = C[n - 1] || 1;
    const keys = [[0, hA]];
    for (const w of wps) {
      if (w[2] == null) continue;
      let best = 0, bd = Infinity;
      pts.forEach((p, i) => { const d = Math.hypot(p[0] - w[0], p[1] - w[1]); if (d < bd) { bd = d; best = i; } });
      keys.push([C[best], w[2]]);
    }
    keys.push([L, hB]);
    keys.sort((x, y) => x[0] - y[0]);
    const hAt = s2 => {
      for (let k = 1; k < keys.length; k++) {
        if (s2 <= keys[k][0] || k === keys.length - 1) {
          const [s0, h0] = keys[k - 1], [s1, h1] = keys[k];
          const t = s1 > s0 ? SF.clamp((s2 - s0) / (s1 - s0), 0, 1) : 1;
          return h0 + (h1 - h0) * t;
        }
      }
      return hB;
    };
    return pts.map((p, i) => [p[0], p[1], hAt(C[i])]);
  };

  const pathCache = new Map();
  // dense [x, y, h] path of a link; heights are relative to the start's floor (lifts between
  // floors are added by the 3D view)
  // A link's path only depends on its two end buildings, its bend points and its style, so it is cached
  // against a fingerprint of those: moving one building re-routes only the belts attached to it.
  const endSig = e => e.x + ',' + e.y + ',' + e.rot + ',' + e.level + ',' + (e.ang || 0) + ',' + (e.h ?? '') + ',' + (e.ph ?? '') + ',' + e.def;
  // ------------------------------------------------------------ floors
  // Each floor has a height z (m) above the first floor. A new floor goes one wall height (4 m) above the top
  // floor so you can build up wall by wall; heights can be edited per floor.
  SF.WALL_H = 4;
  SF.levelZ = L => { const lv = S.levels[L]; return lv && lv.z != null ? lv.z : L * SF.WALL_H; };
  SF.addLevel = (name) => {
    const top = S.levels.reduce((m, l, i) => Math.max(m, SF.levelZ(i)), -SF.WALL_H);
    S.levels.push({ name: name || 'Floor ' + (S.levels.length + 1), z: top + SF.WALL_H });
    return S.levels.length - 1;
  };
  SF.levelVisible = L => L === S.level || !(S.levels[L] && S.levels[L].hidden);
  // "Hide foundations" / "Hide walls" (floors panel): hidden structures are not drawn and can't be clicked
  SF.structureHidden = e => {
    const d = SF.defs[e.def];
    if (!d || !d.structure) return false;
    return d.kind === 'wall' ? !!S.settings.hideWalls : !!S.settings.hideFoundations;    // foundations + ramps
  };

  SF.linkSig = (l) => {
    const ea = S.entities.get(l.from[0]), eb = S.entities.get(l.to[0]);
    if (!ea || !eb) return '';
    let p = '';
    for (const q of l.pts || []) p += q[0] + ',' + q[1] + ',' + (q[2] ?? '') + ';';
    return endSig(ea) + '|' + endSig(eb) + '|' + l.from[1] + '|' + l.to[1] + '|' + p + '|' + SF.linkStyle(l) + '|' + SF.levelZ(ea.level) + '|' + SF.levelZ(eb.level);
  };
  SF.linkPath3 = (l) => {
    if (l.kind === 'lift') {
      const ea = S.entities.get(l.from[0]);
      if (!ea) return [];
      const P = SF.portWorld(ea, l.from[1]);
      return [[P.x, P.y, 1], [P.x, P.y, 1]];
    }
    const c = pathCache.get(l.id);
    const sig = SF.linkSig(l);
    if (c && c.sig === sig) return c.pts;
    const ea = S.entities.get(l.from[0]), eb = S.entities.get(l.to[0]);
    if (!ea || !eb) return [];
    const A = { ...SF.portWorld(ea, l.from[1]), h: SF.portHeight(ea, l.from[1]) };
    const B = { ...SF.portWorld(eb, l.to[1]), h: ea.level === eb.level ? SF.portHeight(eb, l.to[1]) : SF.portHeight(ea, l.from[1]) };
    const pts = SF.routePath(A, B, l.pts || [], SF.linkStyle(l));
    pathCache.set(l.id, { sig, pts });
    return pts;
  };
  const flatCache = new WeakMap();
  SF.linkPath = (l) => {
    const p3 = SF.linkPath3(l);
    let f = flatCache.get(p3);
    if (!f) flatCache.set(p3, f = p3.map(p => [p[0], p[1]]));
    return f;
  };
  // the path the 3D view draws: like linkPath3, but ends at the 3D connector positions
  const path3dCache = new Map();
  SF.linkPath3D = (l) => {
    const ea = S.entities.get(l.from[0]), eb = S.entities.get(l.to[0]);
    if (!ea || !eb) return [];
    const pa = SF.defs[ea.def].ports[l.from[1]], pb = SF.defs[eb.def].ports[l.to[1]];
    if (!(pa && pa.y3 != null) && !(pb && pb.y3 != null)) return SF.linkPath3(l);
    const c = path3dCache.get(l.id);
    const sig = SF.linkSig(l);
    if (c && c.sig === sig) return c.pts;
    const A = { ...SF.portWorld3(ea, l.from[1]), h: SF.portHeight(ea, l.from[1]) };
    const B = { ...SF.portWorld3(eb, l.to[1]), h: ea.level === eb.level ? SF.portHeight(eb, l.to[1]) : SF.portHeight(ea, l.from[1]) };
    const pts = SF.routePath(A, B, l.pts || [], SF.linkStyle(l));
    path3dCache.set(l.id, { sig, pts });
    return pts;
  };

  SF.pathLength = (pts) => {
    let L = 0;
    for (let i = 1; i < pts.length; i++) {
      L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1], (pts[i][2] || 0) - (pts[i - 1][2] || 0));
    }
    return L;
  };

  SF.linkLength = (l) => {
    const ea = S.entities.get(l.from[0]), eb = S.entities.get(l.to[0]);
    if (l.kind === 'lift' && ea) { const L = SF.liftOf(ea); if (L) return L.height; }
    const lift = ea && eb ? Math.abs(SF.levelZ(eb.level) - SF.levelZ(ea.level)) : 0;
    return SF.pathLength(SF.linkPath3(l)) + lift;
  };

  // Check a belt path against the game's placement rules. Returns [{code, text}] (empty = buildable).
  SF.beltProblems = (pts, kind = 'belt') => {
    const out = [];
    if (pts.length < 2) return out;
    const R = SF.BELT_RULES;
    const len = SF.pathLength(pts);
    if (len > R.maxLength + 0.05) out.push({ code: 'long', text: `${SF.fmt(len, 1)} m long — one ${kind === 'pipe' ? 'pipe' : 'belt'} can span at most ${R.maxLength} m; add a ${kind === 'pipe' ? 'support' : 'pole'} in between` });
    if (len < R.minLength - 0.01) out.push({ code: 'short', text: `Shorter than ${R.minLength} m` });
    if (kind === 'pipe') return out;
    const r = SF.pathMinRadius(pts);
    if (r < R.minRadius * 0.95) out.push({ code: 'tight', text: `Turns tighter than the game's ${R.minRadius} m radius (${SF.fmt(r, 1)} m)` });
    const slope = Math.atan(SF.pathMaxSlope(pts)) * 180 / Math.PI;
    if (slope > R.maxSlopeDeg + 0.5) out.push({ code: 'steep', text: `${SF.fmt(slope, 0)}° slope — the game allows at most ${R.maxSlopeDeg}°` });
    // climbing while turning: a real bend (radius under 20 m) with the belt rising on both sides of it
    for (let i = 1; i < pts.length - 1; i++) {
      const a = pts[i - 1], b = pts[i], c = pts[i + 1];
      const l1 = Math.hypot(b[0] - a[0], b[1] - a[1]), l2 = Math.hypot(c[0] - b[0], c[1] - b[1]);
      if (l1 < 1e-3 || l2 < 1e-3) continue;
      const th = Math.acos(SF.clamp(((b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1])) / (l1 * l2), -1, 1));
      if (th < 0.01 || ((l1 + l2) / 2) / th > 20) continue;
      if (Math.abs((b[2] || 0) - (a[2] || 0)) / l1 > 0.02 && Math.abs((c[2] || 0) - (b[2] || 0)) / l2 > 0.02) {
        out.push({ code: 'climbturn', text: 'Climbs while turning — in game a belt turns, then climbs; give it a straight stretch for the rise' });
        break;
      }
    }
    return out;
  };
  // rule check for a placed link, including the conveyor lift for links between floors
  const problemCache = new WeakMap();                 // per path array: recomputed only when the belt changes
  SF.linkProblems = (l) => {
    const ea = S.entities.get(l.from[0]), eb = S.entities.get(l.to[0]);
    if (!ea || !eb) return [];
    if (l.kind === 'lift') {
      const H = SF.liftOf(ea) ? SF.liftOf(ea).height : Math.abs(SF.levelZ(eb.level) - SF.levelZ(ea.level));
      if (H < 4 - 1e-6) return [{ code: 'lift', text: `Conveyor lift of ${SF.fmt(H, 1)} m — lifts are 4–48 m` }];
      if (H > 48 + 1e-6) return [{ code: 'lift', text: `Conveyor lift of ${SF.fmt(H, 1)} m — one lift reaches 48 m; use another lift from a floor in between` }];
      return [];
    }
    const P = SF.linkPath3D(l);
    let base = problemCache.get(P);
    if (!base || base.kind !== l.kind) problemCache.set(P, base = { kind: l.kind, list: SF.beltProblems(P, l.kind) });
    const out = base.list.slice();
    if (ea.level !== eb.level && l.kind !== 'pipe') {
      const h = SF.levelZ(eb.level) - SF.levelZ(ea.level) + SF.portHeight(eb, l.to[1]) - SF.portHeight(ea, l.from[1]);
      const H = Math.abs(h);
      if (H < 4) out.push({ code: 'lift', text: `Lift of ${SF.fmt(H, 1)} m — conveyor lifts are 4–48 m` });
      if (H > 48) out.push({ code: 'lift', text: `Lift of ${SF.fmt(H, 1)} m — one conveyor lift reaches 48 m; chain lifts or use lift floor holes` });
    }
    if (l.kind === 'pipe') {
      const ph = SF.pipeHead(l);
      if (ph && ph.short) {
        const rise = ph.need - (ph.head.rec - (SF.HEAD_LIFT[Object.keys(SF.HEAD_LIFT).find(k => SF.defs[k] && SF.defs[k].name === ph.head.src)] || HEAD_OTHER)[0]);
        out.push({ code: 'head', text: `Head lift: fluid has to reach ${SF.fmt(ph.over, 1)} m above what the ${ph.head.src} lifts (${SF.fmt(rise, 1)} m rise)`
          + (ph.factor <= 0 ? ' — no fluid gets through; add a Pipeline Pump lower down' : ph.factor < 1 ? ` — only ${SF.fmt(ph.factor * 100, 0)} % flows; add a Pipeline Pump` : ' — it still flows but is past the safe height; a pump would make it reliable') });
      }
    }
    return out;
  };

  // ------------------------------------------------------------ fluids: head lift
  // How high a building can push fluid above its own outlet (game wiki: recommended / actual / maximum, metres).
  // Up to "recommended" flows freely, flow falls away past "actual" and stops at "maximum". A powered pump resets
  // the head to its own; junctions and supports pass on the highest head reaching them; fluid buffers relay at most
  // 8 m (12 m industrial). Heights are absolute (floor height + port height), so this works across floors.
  SF.HEAD_LIFT = {
    Build_PipelinePump_C: [20, 22, 23], Build_PipelinePumpMk2_C: [50, 55, 57],
    Build_WaterPump_C: [10, 12, 13], Build_OilPump_C: [10, 12, 13],
  };
  const HEAD_OTHER = [10, 11, 13];                                   // refinery, packager, blender, well extractor
  const RELAY = { Build_PipeStorageTank_C: 8, Build_IndustrialTank_C: 12 };
  const portZ = (e, i) => SF.levelZ(e.level) + SF.portHeight(e, i);
  let heads = { v: -1, map: null };
  SF.fluidHeads = () => {
    if (heads.v === S.version && heads.map) return heads.map;
    const map = new Map();                       // entity id -> { rec, act, max (absolute m), src (def name) }
    const pipesIn = new Map();
    for (const l of S.links.values()) if (l.kind === 'pipe') { const k = l.to[0]; if (!pipesIn.has(k)) pipesIn.set(k, []); pipesIn.get(k).push(l); }
    const mk = (z, v, src) => ({ rec: z + v[0], act: z + v[1], max: z + v[2], src });
    const INF = { rec: Infinity, act: Infinity, max: Infinity, src: 'an external input' };
    const pass = [];
    for (const e of S.entities.values()) {
      const d = SF.defs[e.def];
      const fo = d.ports.findIndex(p => p.fluid && p.io === 'out');
      if (d.kind === 'source' && d.ports.some(p => p.fluid)) map.set(e.id, INF);
      else if (['extractor', 'machine'].includes(d.kind) && fo >= 0) map.set(e.id, mk(portZ(e, fo), SF.HEAD_LIFT[e.def] || HEAD_OTHER, d.name));
      else if (['junction', 'pump', 'pole', 'storage'].includes(d.kind) && d.ports.some(p => p.fluid) || e.def === 'PipePole') pass.push(e);
    }
    // pass-through parts: relax until nothing changes (loops are fine, heads only grow)
    for (let it = 0; it < pass.length + 2; it++) {
      let changed = false;
      for (const e of pass) {
        let best = null;
        for (const l of pipesIn.get(e.id) || []) {
          const h = map.get(l.from[0]);
          if (!h || portZ(e, l.to[1]) >= h.max) continue;              // nothing gets this far up
          if (!best) best = { ...h }; else for (const k of ['rec', 'act', 'max']) if (h[k] > best[k]) { best[k] = h[k]; if (k === 'rec') best.src = h.src; }
        }
        if (!best) continue;
        const pump = SF.HEAD_LIFT[e.def];
        if (pump) { const fo = SF.defs[e.def].ports.findIndex(p => p.io === 'out'); best = mk(portZ(e, Math.max(0, fo)), pump, SF.defs[e.def].name); }
        else if (RELAY[e.def]) { const z = SF.levelZ(e.level) + RELAY[e.def]; for (const k of ['rec', 'act', 'max']) best[k] = Math.min(best[k], z); }
        const cur = map.get(e.id);
        if (!cur || cur.rec !== best.rec || cur.act !== best.act || cur.max !== best.max) { map.set(e.id, best); changed = true; }
      }
      if (!changed) break;
    }
    heads = { v: S.version, map };
    return map;
  };
  // one pipe: how high it has to lift, what reaches it, and the share of its flow that gets through (0..1)
  SF.pipeHead = (l) => {
    if (l.kind !== 'pipe') return null;
    const ea = S.entities.get(l.from[0]), eb = S.entities.get(l.to[0]);
    if (!ea || !eb) return null;
    const h = SF.fluidHeads().get(ea.id);
    if (!h || h.rec === Infinity) return null;
    let need = portZ(eb, l.to[1]);
    if (ea.level === eb.level) for (const p of SF.linkPath3D(l)) if (p.h != null) need = Math.max(need, SF.levelZ(ea.level) + p.h);
    const factor = need <= h.act + 1e-6 ? 1 : need >= h.max - 1e-6 ? 0 : (h.max - need) / (h.max - h.act);
    return { need, head: h, factor, short: need > h.rec + 1e-6, over: need - h.rec };
  };
  SF.pipeFactor = (l) => { const p = SF.pipeHead(l); return p ? p.factor : 1; };

  // steepest slope along a path (rise / run); the game tops out around 35 degrees for belts
  SF.pathMaxSlope = (pts) => {
    let m = 0;
    for (let i = 1; i < pts.length; i++) {
      const run = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      if (run > 0.05) m = Math.max(m, Math.abs((pts[i][2] || 0) - (pts[i - 1][2] || 0)) / run);
    }
    return m;
  };

  // ------------------------------------------------------------ history & persistence
  const hist = { stack: [], idx: -1 };
  const listeners = [];
  SF.onChange = fn => listeners.push(fn);

  SF.serialize = (onlyIds) => {
    const ents = [...S.entities.values()].filter(e => !onlyIds || onlyIds.has(e.id));
    const ids = new Set(ents.map(e => e.id));
    const links = [...S.links.values()].filter(l => ids.has(l.from[0]) && ids.has(l.to[0]));
    return { v: 1, levels: S.levels, entities: ents, links };
  };

  SF.load = (doc, keepHistory) => {
    S.entities.clear(); S.links.clear();
    S.levels = doc.levels && doc.levels.length ? doc.levels.map(l => ({ ...l })) : [{ name: 'Floor 1' }];
    // older plans have no floor heights: one wall height (4 m) per floor
    S.levels.forEach((l, i) => { if (l.z == null) l.z = i * SF.WALL_H; });
    for (const e of doc.entities || []) if (SF.defs[e.def]) S.entities.set(e.id, JSON.parse(JSON.stringify(e)));
    for (const l of doc.links || []) {
      if (S.entities.has(l.from[0]) && S.entities.has(l.to[0])) S.links.set(l.id, JSON.parse(JSON.stringify(l)));
    }
    S.level = Math.min(S.level, S.levels.length - 1);
    SF.rebuildIndex();
    if (!keepHistory) { hist.stack = []; hist.idx = -1; }
    SF.changed(!keepHistory);
  };

  let saveTimer = 0;
  // call after every completed edit
  SF.changed = (record = true) => {
    SF.rebuildIndex();
    fixLifts();
    S.version++;
    if (record) {
      const snap = JSON.stringify(SF.serialize());
      if (hist.stack[hist.idx] !== snap) {
        hist.stack = hist.stack.slice(0, hist.idx + 1);
        hist.stack.push(snap);
        if (hist.stack.length > 150) hist.stack.shift();
        hist.idx = hist.stack.length - 1;
      }
    }
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      // the open factory saves to its own record (home.js); older single-slot save as a fallback
      if (SF.autosave) SF.autosave();
      else try { localStorage.setItem('sf-planner-doc', JSON.stringify(SF.serialize())); } catch (_) { /* storage unavailable */ }
    }, 400);
    listeners.forEach(fn => fn());
  };
  // lightweight update during drags (no history)
  SF.touch = () => { S.version++; listeners.forEach(fn => fn(true)); };

  SF.undo = () => {
    if (hist.idx <= 0) return;
    hist.idx--;
    SF.load(JSON.parse(hist.stack[hist.idx]), true);
  };
  SF.redo = () => {
    if (hist.idx >= hist.stack.length - 1) return;
    hist.idx++;
    SF.load(JSON.parse(hist.stack[hist.idx]), true);
  };
  // make the current document the bottom of the undo stack (after loading an example / file)
  SF.resetHistory = () => { hist.stack = [JSON.stringify(SF.serialize())]; hist.idx = 0; };
  SF.canUndo = () => hist.idx > 0;
  SF.canRedo = () => hist.idx < hist.stack.length - 1;

  // clone a group (entities + internal links) with new ids, offset, optional rotation steps about (cx,cy)
  SF.instantiate = (group, ox, oy, rotSteps = 0, level = S.level) => {
    const idMap = {};
    const created = [];
    for (const src of group.entities) {
      const e = JSON.parse(JSON.stringify(src));
      const [rx, ry] = SF.rot(e.x, e.y, rotSteps);
      e.id = SF.uid(); idMap[src.id] = e.id;
      e.x = rx + ox; e.y = ry + oy; e.rot = (e.rot + rotSteps) % 4;
      if (SF.defs[e.def] && SF.defs[e.def].kind === 'pole') e.ang = (e.ang || 0) + rotSteps * Math.PI / 2;
      if (e.pair) e.pairSrc = e.pair;
      e.level = level + (src.level - (group.baseLevel || 0));
      while (e.level >= S.levels.length) SF.addLevel();
      S.entities.set(e.id, e); created.push(e);
    }
    for (const src of group.links || []) {
      if (!idMap[src.from[0]] || !idMap[src.to[0]]) continue;
      const l = JSON.parse(JSON.stringify(src));
      l.id = SF.uid();
      l.from = [idMap[src.from[0]], src.from[1]]; l.to = [idMap[src.to[0]], src.to[1]];
      l.pts = (l.pts || []).map(p => { const [x, y] = SF.rot(p[0], p[1], rotSteps); return [x + ox, y + oy]; });
      S.links.set(l.id, l);
    }
    SF.rebuildIndex();
    // lift ends keep their partner (a bottom copied without its top gets a new top)
    for (const e of [...created]) {
      if (e.pairSrc == null) continue;
      e.pair = idMap[e.pairSrc]; delete e.pairSrc;
      if (!e.pair || !S.entities.has(e.pair)) {
        delete e.pair;
        if (SF.defs[e.def].end === 'bottom') created.push(SF.makeLift(e));
        else { S.entities.delete(e.id); created.splice(created.indexOf(e), 1); }
      }
    }
    return created;
  };

  // build a relocatable group (positions relative to the group's centre)
  SF.makeGroup = (ids) => {
    ids = [...ids];
    for (const id of [...ids]) { const e = S.entities.get(id); if (e && e.pair && !ids.includes(e.pair)) ids.push(e.pair); }   // whole lifts
    // deep copy: serialize() returns the live objects, and the group is re-centred below
    const doc = JSON.parse(JSON.stringify(SF.serialize(new Set(ids))));
    if (!doc.entities.length) return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const e of doc.entities) {
      const r = SF.entRect(e);
      x0 = Math.min(x0, r.x0); y0 = Math.min(y0, r.y0); x1 = Math.max(x1, r.x1); y1 = Math.max(y1, r.y1);
    }
    // keep the centre on a whole-metre grid so pasted groups stay grid-aligned
    const cx = Math.round((x0 + x1) / 2), cy = Math.round((y0 + y1) / 2);
    const baseLevel = Math.min(...doc.entities.map(e => e.level));
    doc.entities.forEach(e => { e.x -= cx; e.y -= cy; });
    doc.links.forEach(l => { l.pts = (l.pts || []).map(p => [p[0] - cx, p[1] - cy]); });
    return { entities: doc.entities, links: doc.links, baseLevel, w: x1 - x0, h: y1 - y0 };
  };

  // ------------------------------------------------------------ blueprint library (localStorage)
  SF.library = {
    list() { try { return JSON.parse(localStorage.getItem('sf-planner-lib') || '[]'); } catch (_) { return []; } },
    save(list) { try { localStorage.setItem('sf-planner-lib', JSON.stringify(list)); } catch (_) { /* ignore */ } },
    add(name, group) { const l = this.list(); l.push({ id: SF.uid(), name, group }); this.save(l); },
    remove(id) { this.save(this.list().filter(x => x.id !== id)); },
  };

  // ------------------------------------------------------------ share links (deflate + base64url in the hash)
  SF.encodeShare = async () => {
    const json = JSON.stringify(SF.serialize());
    const cs = new CompressionStream('deflate-raw');
    const buf = await new Response(new Blob([json]).stream().pipeThrough(cs)).arrayBuffer();
    let bin = '';
    new Uint8Array(buf).forEach(b => { bin += String.fromCharCode(b); });
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };
  SF.decodeShare = async (s) => {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
    const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
    const ds = new DecompressionStream('deflate-raw');
    const text = await new Response(new Blob([bytes]).stream().pipeThrough(ds)).text();
    return JSON.parse(text);
  };
})(window.SF);
