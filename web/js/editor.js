// Mouse/keyboard interaction: tools, selection, placement, belt drawing, clipboard.
(function (SF) {
  const S = SF.state, view = SF.view;
  const ed = SF.ed = {
    tool: 'select', placeDef: null, placeProps: null, group: null, rot: 0,
    beltTier: 1, pipeTier: 1, linkKind: 'belt',
    link: null, drag: null, mouse: { sx: 0, sy: 0, wx: 0, wy: 0, in: false }, space: false,
  };
  SF.sel = { ents: new Set(), links: new Set() };
  SF.hover = null;
  let cv;

  const emitSel = () => SF.onSelection && SF.onSelection();
  const toast = (m, kind) => SF.toast && SF.toast(m, kind);

  SF.setTool = (tool, opts = {}) => {
    ed.tool = tool;
    ed.link = null; ed.drag = null;
    if (tool !== 'place') { ed.placeDef = null; ed.group = null; ed.placeProps = null; }
    if (tool === 'place') { ed.placeDef = opts.def || null; ed.group = opts.group || null; ed.placeProps = opts.props || null; }
    if (tool === 'link') ed.linkKind = opts.kind || ed.linkKind;
    if (opts.tier) { if (ed.linkKind === 'pipe') ed.pipeTier = opts.tier; else ed.beltTier = opts.tier; }
    SF.onTool && SF.onTool();
    updateCursor();
  };

  function updateCursor() {
    if (!cv) return;
    cv.style.cursor = ed.drag && ed.drag.type === 'pan' ? 'grabbing'
      : ed.space || ed.tool === 'pan' ? 'grab'
        : ed.tool === 'place' || ed.tool === 'link' ? 'crosshair'
          : ed.tool === 'delete' ? 'not-allowed'
            : SF.hover && (SF.hover.port) ? 'pointer'
              : SF.hover && (SF.hover.ent || SF.hover.link) ? 'move' : 'default';
  }

  // ------------------------------------------------------------ hit testing
  function distSeg(px, py, a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const L = dx * dx + dy * dy || 1;
    const t = SF.clamp(((px - a[0]) * dx + (py - a[1]) * dy) / L, 0, 1);
    return [Math.hypot(px - a[0] - dx * t, py - a[1] - dy * t), t];
  }

  SF.hitTest = (wx, wy, opts = {}) => {
    const tolPort = Math.max(0.9, 8 / view.zoom);
    const cur = [...S.entities.values()].filter(e => e.level === S.level && !SF.structureHidden(e));
    if (!opts.noPorts) {
      let best = null, bd = tolPort;
      for (const e of cur) {
        const d = SF.defs[e.def];
        if (!d.ports.length) continue;
        const r = SF.entRect(e);                          // ports sit on the footprint edge: skip far buildings
        if (wx < r.x0 - tolPort - 1 || wx > r.x1 + tolPort + 1 || wy < r.y0 - tolPort - 1 || wy > r.y1 + tolPort + 1) continue;
        for (let i = 0; i < d.ports.length; i++) {
          if (d.ports[i].internal) continue;
          const p = SF.portWorld(e, i);
          // ports can share a spot (pole centre): a free port wins ties over a connected one
          const dd = Math.hypot(p.x - wx, p.y - wy) + (S.portLinks.has(SF.portKey(e.id, i)) ? 1e-3 : 0);
          if (dd < bd) { bd = dd; best = { port: [e.id, i] }; }
        }
      }
      if (best) return best;
    }
    // waypoint handles of selected links
    for (const id of SF.sel.links) {
      const l = S.links.get(id);
      if (!l) continue;
      for (let i = 0; i < (l.pts || []).length; i++) {
        if (Math.hypot(l.pts[i][0] - wx, l.pts[i][1] - wy) < Math.max(0.6, 7 / view.zoom)) return { wp: [id, i], link: id };
      }
    }
    const inside = e => { const r = SF.entRect(e); return wx >= r.x0 && wx <= r.x1 && wy >= r.y0 && wy <= r.y1; };
    const kindOf = e => SF.defs[e.def].kind;
    const bg = new Set(['foundation', 'ramp', 'wall', 'zone', 'designer']);
    for (let i = cur.length - 1; i >= 0; i--) {
      const e = cur[i];
      if (!bg.has(kindOf(e)) && inside(e)) return { ent: e.id };
    }
    const tolL = Math.max(0.7, 6 / view.zoom);
    for (const l of S.links.values()) {
      const ea = S.entities.get(l.from[0]), eb = S.entities.get(l.to[0]);
      if (!ea || !eb || (ea.level !== S.level && eb.level !== S.level)) continue;
      if (l.kind === 'lift') continue;
      const P = SF.linkScreenPath(l), bb = P.bb;
      if (wx < bb[0] - tolL || wx > bb[2] + tolL || wy < bb[1] - tolL || wy > bb[3] + tolL) continue;
      const pts = P.pts;
      for (let i = 1; i < pts.length; i++) if (distSeg(wx, wy, pts[i - 1], pts[i])[0] < tolL) return { link: l.id };
    }
    for (const k of ['wall', 'foundation', 'ramp', 'zone']) {
      for (let i = cur.length - 1; i >= 0; i--) if (kindOf(cur[i]) === k && inside(cur[i])) return { ent: cur[i].id };
    }
    for (const e of cur) {
      if (kindOf(e) !== 'designer') continue;
      const r = SF.entRect(e), b = Math.max(1.2, 8 / view.zoom);
      const nearEdge = inside(e) && (wx - r.x0 < b || r.x1 - wx < b || wy - r.y0 < b || r.y1 - wy < b);
      const onLabel = wx >= r.x0 && wx <= r.x0 + 30 && wy < r.y0 && wy > r.y0 - 22 / view.zoom;
      if (nearEdge || onLabel) return { ent: e.id };
    }
    return null;
  };

  // ------------------------------------------------------------ placement helpers
  const BLOCKING = e => { const d = SF.defs[e.def]; return !d.structure && !['zone', 'label', 'designer'].includes(d.kind); };
  function overlaps(e, ignore) {
    const d = SF.defs[e.def];
    if (['zone', 'label', 'designer', 'wall'].includes(d.kind)) return false;
    const r = SF.entRect(e);
    for (const o of S.entities.values()) {
      if (o.level !== e.level || (ignore && ignore.has(o.id)) || o.id === e.id) continue;
      const od = SF.defs[o.def];
      const both = d.structure ? (od.structure && od.kind !== 'wall') : BLOCKING(o);
      if (!both) continue;
      const q = SF.entRect(o);
      if (r.x0 < q.x1 - 1e-3 && r.x1 > q.x0 + 1e-3 && r.y0 < q.y1 - 1e-3 && r.y1 > q.y0 + 1e-3) return true;
    }
    return false;
  }
  SF.overlaps = overlaps;

  function ghostEntity() {
    if (!ed.placeDef) return null;
    const [x, y] = SF.snapPos(ed.placeDef, ed.mouse.wx, ed.mouse.wy, ed.rot);
    return { id: '__ghost', def: ed.placeDef, x, y, rot: ed.rot, level: S.level, ...SF.defaultProps(SF.defs[ed.placeDef]), ...(ed.placeProps || {}) };
  }

  // group placement: anchor the first structure (or first entity) on its natural grid
  function groupPlacement() {
    const g = ed.group;
    if (!g) return null;
    const anchor = g.entities.find(e => SF.defs[e.def].structure) || g.entities[0];
    const [ax, ay] = SF.rot(anchor.x, anchor.y, ed.rot);
    const arot = (anchor.rot + ed.rot) % 4;
    const [sx, sy] = SF.snapPos(anchor.def, ed.mouse.wx + ax, ed.mouse.wy + ay, arot);
    const ox = sx - ax, oy = sy - ay;
    const ents = g.entities.map(src => {
      const [rx, ry] = SF.rot(src.x, src.y, ed.rot);
      const ang = SF.defs[src.def] && SF.defs[src.def].kind === 'pole' ? (src.ang || 0) + ed.rot * Math.PI / 2 : src.ang;
      return { ...src, ang, x: rx + ox, y: ry + oy, rot: (src.rot + ed.rot) % 4, level: S.level + (src.level - (g.baseLevel || 0)) };
    });
    return { ox, oy, ents };
  }

  function zoopTiles(z = ed.drag) {
    const d = SF.defs[ed.placeDef];
    const [w, h] = ed.rot % 2 ? [d.h, d.w] : [d.w, d.h];
    const [ex, ey] = SF.snapPos(ed.placeDef, ed.mouse.wx, ed.mouse.wy, ed.rot);
    let nx = Math.round(Math.abs(ex - z.x) / (d.kind === 'wall' ? Math.max(w, 0.5) : w)) + 1;
    let ny = Math.round(Math.abs(ey - z.y) / (d.kind === 'wall' ? Math.max(h, 0.5) : h)) + 1;
    if (d.kind === 'wall') { if (ed.rot % 2) nx = 1; else ny = 1; }
    const sx = Math.sign(ex - z.x) || 1, sy = Math.sign(ey - z.y) || 1;
    const tiles = [];
    for (let i = 0; i < Math.min(nx, 120); i++) {
      for (let j = 0; j < Math.min(ny, 120); j++) {
        tiles.push({ id: '__z' + i + '_' + j, def: ed.placeDef, x: z.x + i * w * sx, y: z.y + j * h * sy, rot: ed.rot, level: S.level });
      }
    }
    return tiles;
  }

  // ------------------------------------------------------------ belt / pipe placement
  // Works like the game: start at a port (or on open ground, which drops a pole), every click on the
  // ground places a conveyor pole and continues the chain, clicking a port finishes it.
  const MAGNET = 1.8;                         // metres: ports this close pull the belt end in
  const MAX_SLOPE = Math.tan(35 * Math.PI / 180);
  const snapHalf = (x, y) => [Math.round(x * 2) / 2, Math.round(y * 2) / 2];
  const snapPt = (x, y) => {
    const s = Math.max(0.5, Math.min(S.settings.snap || 0.5, 1));
    return [Math.round(x / s) * s, Math.round(y / s) * s];
  };
  const snapAng = (a, free) => (free ? a : Math.round(a / (Math.PI / 12)) * (Math.PI / 12));   // 15 degrees
  const unit = (x, y) => { const l = Math.hypot(x, y) || 1; return [x / l, y / l]; };
  const linkTier = kind => (kind === 'pipe' ? ed.pipeTier : ed.beltTier);
  const styleName = st => (SF.BELT_STYLES.find(x => x[0] === st) || [, st])[1];

  function portInfo(port) {
    const e = S.entities.get(port[0]);
    const P = SF.view3d && SF.view3d.active ? SF.portWorld3(e, port[1]) : SF.portWorld(e, port[1]);
    return { ...P, h: SF.portHeight(e, port[1]) };
  }

  // best free, compatible port near the cursor
  function magnetPort(wx, wy) {
    const L = ed.link;
    let best = null, bd = Math.max(MAGNET, 10 / view.zoom);
    for (const e of S.entities.values()) {
      if (e.level !== S.level) continue;
      const d = SF.defs[e.def];
      for (let i = 0; i < d.ports.length; i++) {
        if (d.ports[i].internal) continue;
        if (L && L.start && e.id === L.start[0]) continue;
        const p = SF.portWorld(e, i);
        const dist = Math.hypot(p.x - wx, p.y - wy);
        if (dist >= bd) continue;
        if (L && L.start) { if (SF.canConnect(L.start, [e.id, i]).error) continue; }
        else if (S.portLinks.has(SF.portKey(e.id, i))) continue;
        bd = dist; best = [e.id, i];
      }
    }
    return best;
  }

  // what the next click would do: { port } or { free: [x, y], ang }
  function linkTarget() {
    const L = ed.link, m = ed.mouse;
    const port = magnetPort(m.wx, m.wy);
    if (port) return { port };
    const [x, y] = snapPt(m.wx, m.wy);
    if (!L || !L.start) return { free: [x, y], ang: 0 };
    const s = portInfo(L.start);
    // natural facing: the end tangent of a circular arc leaving the start along its direction is the
    // start direction mirrored across the chord, so the belt makes one clean curve instead of an S
    const c = unit(x - s.x, y - s.y);
    let d = L.aim ? c : [s.dx, s.dy];                 // outward direction of the start port
    const k = 2 * (d[0] * c[0] + d[1] * c[1]);
    let t = [k * c[0] - d[0], k * c[1] - d[1]];         // arc tangent at the new pole (outward from start)
    // forward chains travel along t; reverse chains (built from an input) travel the other way
    let ang = L.rev ? Math.atan2(-t[1], -t[0]) : Math.atan2(t[1], t[0]);
    ang = snapAng(ang, m.alt) + (L.rotOffset || 0);
    return { free: [x, y], ang };
  }

  // preview path for the segment being placed
  function linkPreview() {
    const L = ed.link;
    if (!L || !L.start) return null;
    const t = linkTarget();
    const st = portInfo(L.start);
    let A, B;
    if (t.port) {
      const c = SF.canConnect(L.start, t.port);
      if (c.error) return { pts: [], ok: false, error: c.error };
      A = portInfo(c.from); B = portInfo(c.to);
      if (L.aim) {   // a fresh start pole turns to face its target
        const a = Math.atan2((c.from[0] === L.aim ? B.y - A.y : A.y - B.y), (c.from[0] === L.aim ? B.x - A.x : A.x - B.x));
        const fake = { ...S.entities.get(L.aim), ang: a };
        const pi = c.from[0] === L.aim ? c.from[1] : c.to[1];
        const P = { ...SF.portWorld(fake, pi), h: fake.h ?? 1 };
        if (c.from[0] === L.aim) A = P; else B = P;
      }
    } else {
      const [x, y] = t.free;
      if (Math.hypot(x - st.x, y - st.y) < 1) return { pts: [], ok: false, tooShort: true };
      const ca = Math.cos(t.ang), sa = Math.sin(t.ang);
      if (!L.rev) {
        if (L.aim) Object.assign(st, aimPort(L.aim, x, y, 1));
        A = st; B = { x, y, dx: -ca, dy: -sa, h: L.h };
      } else {
        if (L.aim) Object.assign(st, aimPort(L.aim, x, y, 0));
        A = { x, y, dx: ca, dy: sa, h: L.h }; B = st;
      }
    }
    const pts = SF.routePath(A, B, [], L.style);
    const problems = SF.beltProblems(pts, L.kind);
    return { pts, ok: !problems.length, problems, steep: problems.some(p => p.code === 'steep'), port: t.port, free: t.free, ang: t.ang };
  }

  // port of a pending start pole once it is turned towards (x, y)
  function aimPort(poleId, x, y, pi) {
    const e = S.entities.get(poleId);
    const ang = pi === 1 ? Math.atan2(y - e.y, x - e.x) : Math.atan2(e.y - y, e.x - x);
    return { ...SF.portWorld({ ...e, ang }, pi), h: e.h ?? 1 };
  }

  function startLink(port) {
    const e = S.entities.get(port[0]);
    const p = SF.defs[e.def].ports[port[1]];
    if (S.portLinks.has(SF.portKey(...port))) { toast('That port is already connected', 'warn'); return; }
    const kind = p.fluid ? 'pipe' : 'belt';
    ed.linkKind = kind;
    ed.link = { start: port, kind, rev: p.io === 'in', h: SF.portHeight(e, port[1]), style: S.settings.beltStyle || 'curve',
      returnTo: ed.tool === 'select' ? 'select' : null, made: 0 };
    if (ed.tool !== 'link') { ed.tool = 'link'; SF.onTool && SF.onTool(); }
  }

  // start a chain on open ground: drop a pole that will turn to face the first target
  function startOnGround() {
    const [x, y] = snapPt(ed.mouse.wx, ed.mouse.wy);
    const kind = ed.linkKind || 'belt';
    const h = ed.link ? ed.link.h : 1;
    const pole = SF.addEntity(kind === 'pipe' ? 'PipePole' : 'Pole', x, y, 0, S.level, { h, ang: 0 });
    SF.rebuildIndex();
    ed.link = { start: [pole.id, 1], aim: pole.id, kind, rev: false, h, style: S.settings.beltStyle || 'curve', returnTo: null, made: 0 };
  }

  function addSegment(from, to) {
    const L = ed.link;
    const l = SF.addLink(from, to, L.kind, linkTier(L.kind), []);
    if (l.error) { toast(l.error, 'warn'); return null; }
    l.route = L.style;
    L.made++;
    return l;
  }

  function placeNext() {
    const L = ed.link;
    const pv = linkPreview();
    if (!pv) return;
    if (pv.tooShort) return;
    if (pv.error) { toast(pv.error, 'warn'); return; }
    if (pv.problems && pv.problems.length) toast(pv.problems[0].text + ' (the game would refuse this belt)', 'warn');
    if (L.aim) {   // fix the start pole's facing now that we know where it goes
      const e = S.entities.get(L.aim);
      const tx = pv.port ? portInfo(pv.port).x : pv.free[0], ty = pv.port ? portInfo(pv.port).y : pv.free[1];
      e.ang = Math.atan2(ty - e.y, tx - e.x);
      L.aim = null;
    }
    if (pv.port) {
      const c = SF.canConnect(L.start, pv.port);
      if (!addSegment(c.from, c.to)) return;
      SF.changed();
      endChain(false);
      return;
    }
    const [x, y] = pv.free;
    const pole = SF.addEntity(L.kind === 'pipe' ? 'PipePole' : 'Pole', x, y, 0, S.level, { h: L.h, ang: pv.ang });
    SF.rebuildIndex();
    const ok = L.rev ? addSegment([pole.id, 1], L.start) : addSegment(L.start, [pole.id, 0]);
    if (!ok) { SF.removeEntity(pole.id); return; }
    L.start = L.rev ? [pole.id, 0] : [pole.id, 1];
    L.rotOffset = 0;
    SF.changed();
  }

  // finish the chain; drop a start pole that never got connected
  function endChain(cancelled = true) {
    const L = ed.link;
    if (!L) return;
    if (L.aim && !L.made) { SF.removeEntity(L.aim); SF.changed(); }
    ed.link = null;
    if (L.returnTo) SF.setTool(L.returnTo);
    void cancelled;
  }
  SF.endChain = endChain;
  // shared with the 3D view, which feeds the same chain logic with ground/port positions
  SF.edApi = {
    linkPreview, placeNext, startLink, startOnGround, magnetPort, endChain, portInfo, attachGhost, attachOnto,
    styleName: st => styleName(st), snapPt: (x, y) => snapPt(x, y), MAX_SLOPE,
  };

  // ------------------------------------------------------------ splitters / mergers / junctions onto belts
  function linkUnderCursor(kind) {
    const m = ed.mouse;
    let best = null, bd = Math.max(1.6, 10 / view.zoom);
    for (const l of S.links.values()) {
      if (l.kind !== kind) continue;
      const ea = S.entities.get(l.from[0]), eb = S.entities.get(l.to[0]);
      if (!ea || ea.level !== S.level || eb.level !== S.level) continue;
      const pts = SF.linkScreenPath(l).pts;
      for (let i = 1; i < pts.length; i++) {
        const [d, t] = distSeg(m.wx, m.wy, pts[i - 1], pts[i]);
        if (d < bd) {
          bd = d;
          const a = pts[i - 1], b = pts[i];
          best = { l, x: a[0] + (b[0] - a[0]) * t, y: a[1] + (b[1] - a[1]) * t, dir: unit(b[0] - a[0], b[1] - a[1]) };
        }
      }
    }
    return best;
  }

  // ghost for placing an attachment onto a belt/pipe (axis-aligned runs only, like the game's snapping)
  function attachGhost() {
    const d = SF.defs[ed.placeDef];
    if (!d || !['splitter', 'merger', 'junction'].includes(d.kind)) return null;
    const hit = linkUnderCursor(d.kind === 'junction' ? 'pipe' : 'belt');
    if (!hit) return null;
    const [dx, dy] = hit.dir;
    if (Math.abs(dx) < 0.97 && Math.abs(dy) < 0.97) return null;
    const rot = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 0 : 2) : (dy > 0 ? 1 : 3);
    // slide along the run in half-metre steps, stay exactly on the belt's line across it
    const x = Math.abs(dx) > Math.abs(dy) ? Math.round(hit.x * 2) / 2 : hit.x;
    const y = Math.abs(dx) > Math.abs(dy) ? hit.y : Math.round(hit.y * 2) / 2;
    return { e: { id: '__ghost', def: ed.placeDef, x, y, rot, level: S.level, ...SF.defaultProps(d), ...(ed.placeProps || {}) }, l: hit.l };
  }

  function attachOnto(g) {
    const d = SF.defs[g.e.def];
    const l = g.l;
    const e = SF.addEntity(g.e.def, g.e.x, g.e.y, g.e.rot, S.level, { ...(ed.placeProps || {}) });
    S.links.delete(l.id);
    SF.rebuildIndex();
    const inP = d.kind === 'merger' ? 1 : 0;
    const outP = d.kind === 'merger' ? 3 : d.kind === 'junction' ? 1 : 2;
    const a = SF.addLink(l.from, [e.id, inP], l.kind, l.tier, []);
    const b = SF.addLink([e.id, outP], l.to, l.kind, l.tier, []);
    [a, b].forEach(x => { if (x && !x.error && l.route) x.route = l.route; });
    SF.changed();
    SF.selectOnly([e.id]);
  }

  // ------------------------------------------------------------ selection ops
  // a conveyor lift is one object across two floors: selecting either end selects both
  const withPairs = ids => { const out = new Set(ids); for (const id of ids) { const e = S.entities.get(id); if (e && e.pair && S.entities.has(e.pair)) out.add(e.pair); } return out; };
  SF.selectOnly = (ents = [], links = []) => {
    SF.sel.ents = withPairs(ents); SF.sel.links = new Set(links); emitSel();
  };
  SF.deleteSelection = () => {
    if (!SF.sel.ents.size && !SF.sel.links.size) return;
    for (const id of SF.sel.links) S.links.delete(id);
    for (const id of SF.sel.ents) SF.removeEntity(id);
    SF.selectOnly();
    SF.changed();
  };
  SF.rotateSelection = (dir = 1) => {
    const ids = [...SF.sel.ents];
    if (!ids.length) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    ids.forEach(id => { const r = SF.entRect(S.entities.get(id)); x0 = Math.min(x0, r.x0); y0 = Math.min(y0, r.y0); x1 = Math.max(x1, r.x1); y1 = Math.max(y1, r.y1); });
    const cx = Math.round((x0 + x1) / 2), cy = Math.round((y0 + y1) / 2);
    const steps = (dir + 4) % 4;
    ids.forEach(id => {
      const e = S.entities.get(id);
      if (SF.defs[e.def].kind === 'pole') e.ang = (e.ang || 0) + (dir > 0 ? 1 : -1) * Math.PI / 2;
      const [rx, ry] = SF.rot(e.x - cx, e.y - cy, steps);
      e.rot = (e.rot + steps) % 4;
      [e.x, e.y] = SF.snapPos(e.def, cx + rx, cy + ry, e.rot, ids.length === 1 ? undefined : 0.5);
    });
    for (const l of S.links.values()) {
      if (SF.sel.ents.has(l.from[0]) && SF.sel.ents.has(l.to[0])) {
        l.pts = (l.pts || []).map(p => { const [rx, ry] = SF.rot(p[0] - cx, p[1] - cy, steps); return [cx + rx, cy + ry]; });
      }
    }
    SF.changed();
  };
  let clipboard = null;
  SF.copySelection = () => {
    const g = SF.makeGroup([...SF.sel.ents]);
    if (g) { clipboard = g; toast(`Copied ${g.entities.length} object(s)`); }
    return g;
  };
  SF.pasteClipboard = () => {
    if (!clipboard) return;
    ed.rot = 0;
    SF.setTool('place', { group: clipboard });
  };
  SF.placeGroup = (g) => { ed.rot = 0; SF.setTool('place', { group: g }); };

  SF.fitView = () => {
    SF.fitPending = !(view.W > 50 && view.H > 50);   // re-fit once the canvas has a real size
    const ents = [...S.entities.values()];
    if (!ents.length) { view.cx = 0; view.cy = 0; view.zoom = 12; return; }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const e of ents) { const r = SF.entRect(e); x0 = Math.min(x0, r.x0); y0 = Math.min(y0, r.y0); x1 = Math.max(x1, r.x1); y1 = Math.max(y1, r.y1); }
    // fit into the area not covered by the floating panels
    const ins = SF.viewInsets ? SF.viewInsets() : { l: 0, r: 0, t: 0, b: 0 };
    const aw = Math.max(100, view.W - ins.l - ins.r), ah = Math.max(100, view.H - ins.t - ins.b);
    view.zoom = SF.clamp(Math.min(aw / (x1 - x0 + 16), ah / (y1 - y0 + 16)), 1, 60);
    view.cx = (x0 + x1) / 2 - ((ins.l - ins.r) / 2) / view.zoom;
    view.cy = (y0 + y1) / 2 - ((ins.t - ins.b) / 2) / view.zoom;
  };
  SF.focusEntity = (id) => {
    const e = S.entities.get(id);
    if (!e) return;
    if (e.level !== S.level) { S.level = e.level; SF.onLevel && SF.onLevel(); }
    view.cx = e.x; view.cy = e.y; view.zoom = Math.max(view.zoom, 10);
    SF.selectOnly([id]);
  };

  // ------------------------------------------------------------ events
  SF.initEditor = (canvas) => {
    cv = canvas;
    cv.addEventListener('contextmenu', e => e.preventDefault());
    cv.addEventListener('mousedown', onDown);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    cv.addEventListener('dblclick', onDbl);
    cv.addEventListener('wheel', onWheel, { passive: false });
    cv.addEventListener('mouseleave', () => { ed.mouse.in = false; });
    cv.addEventListener('mouseenter', () => { ed.mouse.in = true; });
    window.addEventListener('keydown', ev => { if (!SF.homeOpen) onKey(ev); });
    window.addEventListener('keyup', e => { if (e.code === 'Space') { ed.space = false; updateCursor(); } });
  };

  function setMouse(ev) {
    const r = cv.getBoundingClientRect();
    ed.mouse.sx = ev.clientX - r.left; ed.mouse.sy = ev.clientY - r.top;
    [ed.mouse.wx, ed.mouse.wy] = SF.s2w(ed.mouse.sx, ed.mouse.sy);
  }

  function onDown(ev) {
    setMouse(ev);
    cv.focus();
    const m = ed.mouse;
    if (ev.button === 1 || (ev.button === 0 && (ed.space || ed.tool === 'pan'))) {
      ed.drag = { type: 'pan', sx: m.sx, sy: m.sy, cx: view.cx, cy: view.cy };
      updateCursor(); ev.preventDefault(); return;
    }
    if (ev.button === 2) {
      ed.drag = { type: 'rpan', sx: m.sx, sy: m.sy, cx: view.cx, cy: view.cy, moved: false };
      return;
    }
    if (ev.button !== 0) return;
    const hit = SF.hitTest(m.wx, m.wy);

    if (ed.tool === 'place') {
      if (ed.group) {
        const gp = groupPlacement();
        if (gp.ents.some(e => overlaps(e)) && !ev.altKey) { toast('Blocked by existing buildings (hold Alt to force)', 'warn'); return; }
        const created = SF.instantiate(ed.group, gp.ox, gp.oy, ed.rot, S.level);
        SF.changed();
        SF.selectOnly(created.map(e => e.id));
        if (!ev.shiftKey) SF.setTool('select');
        return;
      }
      const d = SF.defs[ed.placeDef];
      const ag = attachGhost();
      if (ag) { attachOnto(ag); return; }
      const g = ghostEntity();
      if (d.structure) { ed.drag = { type: 'zoop', x: g.x, y: g.y }; return; }
      if (overlaps(g) && !ev.altKey) { toast('Overlaps another building (hold Alt to force)', 'warn'); return; }
      const props = { ...(ed.placeProps || {}) };
      const e = SF.addEntity(ed.placeDef, g.x, g.y, ed.rot, S.level, props);
      if (ed.placeDef === 'LiftBottom') { SF.makeLift(e, ed.beltTier || 1); renderLevelsSoon(); }
      SF.changed();
      SF.selectOnly([e.id]);
      return;
    }

    if (ed.tool === 'link') {
      ed.mouse.alt = ev.altKey;
      if (!ed.link || !ed.link.start) {
        const mp = magnetPort(m.wx, m.wy);
        if (mp) startLink(mp); else startOnGround();
        return;
      }
      placeNext();
      return;
    }

    if (ed.tool === 'delete') {
      if (hit && hit.ent) { SF.removeEntity(hit.ent); SF.changed(); SF.selectOnly(); return; }
      if (hit && hit.link) { S.links.delete(hit.link); SF.changed(); SF.selectOnly(); return; }
      ed.drag = { type: 'marquee', x0: m.wx, y0: m.wy, del: true }; return;
    }

    // select tool
    // conveyor poles / pipe supports: dragging moves the pole (and re-routes its belts); a click without moving on
    // a free connector still starts a belt from it
    if (hit && hit.port && SF.defs[S.entities.get(hit.port[0]).def].kind === 'pole') {
      const pid = hit.port[0];
      if (ev.shiftKey || ev.ctrlKey) { SF.sel.ents.has(pid) ? SF.sel.ents.delete(pid) : SF.sel.ents.add(pid); emitSel(); }
      else if (!SF.sel.ents.has(pid)) SF.selectOnly([pid]);
      startMove(m);
      ed.drag.poleClick = S.portLinks.has(SF.portKey(...hit.port)) ? null : hit.port;
      return;
    }
    if (hit && hit.port) { startLink(hit.port); return; }
    if (hit && hit.wp) { ed.drag = { type: 'wp', link: hit.wp[0], idx: hit.wp[1], moved: false }; return; }
    if (hit && hit.ent) {
      if (ev.shiftKey || ev.ctrlKey) {
        const pr = S.entities.get(hit.ent).pair;
        if (SF.sel.ents.has(hit.ent)) { SF.sel.ents.delete(hit.ent); if (pr) SF.sel.ents.delete(pr); emitSel(); return; }
        SF.sel.ents.add(hit.ent); if (pr && S.entities.has(pr)) SF.sel.ents.add(pr); emitSel();
      } else if (!SF.sel.ents.has(hit.ent)) SF.selectOnly([hit.ent]);
      startMove(m);
      return;
    }
    if (hit && hit.link) {
      if (ev.shiftKey || ev.ctrlKey) { SF.sel.links.has(hit.link) ? SF.sel.links.delete(hit.link) : SF.sel.links.add(hit.link); emitSel(); }
      else SF.selectOnly([], [hit.link]);
      return;
    }
    if (!ev.shiftKey && !ev.ctrlKey) SF.selectOnly();
    ed.drag = { type: 'marquee', x0: m.wx, y0: m.wy, add: ev.shiftKey || ev.ctrlKey };
  }

  const renderLevelsSoon = () => setTimeout(() => SF.onLevelsChanged && SF.onLevelsChanged(), 0);
  function startMove(m) {
    const orig = new Map();
    for (const id of SF.sel.ents) { const e = S.entities.get(id); orig.set(id, [e.x, e.y]); }
    for (const id of [...orig.keys()]) { const e = S.entities.get(id); if (e.pair && S.entities.has(e.pair) && !orig.has(e.pair)) { const p = S.entities.get(e.pair); orig.set(p.id, [p.x, p.y]); } }   // lifts move as one
    const linkOrig = new Map();
    for (const l of S.links.values()) {
      if (SF.sel.ents.has(l.from[0]) && SF.sel.ents.has(l.to[0])) linkOrig.set(l.id, (l.pts || []).map(p => [...p]));
    }
    const ents = [...SF.sel.ents].map(id => S.entities.get(id));
    const allStruct = ents.length && ents.every(e => SF.defs[e.def].structure && SF.defs[e.def].kind !== 'wall');
    let snap = S.settings.snap || 0.5;
    if (allStruct) snap = Math.max(snap, Math.min(...ents.map(e => Math.min(SF.defs[e.def].w, SF.defs[e.def].h, 8))));
    ed.drag = { type: 'move', x0: m.wx, y0: m.wy, orig, linkOrig, snap, moved: false };
  }

  let hoverQueued = false, hoverEv = null;
  function onMove(ev) {
    if (!cv) return;
    setMouse(ev);
    ed.mouse.alt = ev.altKey;
    const m = ed.mouse, dr = ed.drag;
    if (dr) {
      if (dr.type === 'pan' || dr.type === 'rpan') {
        if (Math.hypot(m.sx - dr.sx, m.sy - dr.sy) > 4) dr.moved = true;
        view.cx = dr.cx - (m.sx - dr.sx) / view.zoom; view.cy = dr.cy - (m.sy - dr.sy) / view.zoom;
        if (dr.moved) cv.style.cursor = 'grabbing';
      } else if (dr.type === 'move') {
        let dx = m.wx - dr.x0, dy = m.wy - dr.y0;
        dx = Math.round(dx / dr.snap) * dr.snap; dy = Math.round(dy / dr.snap) * dr.snap;
        if (dx || dy) dr.moved = true;
        for (const [id, [x, y]] of dr.orig) { const e = S.entities.get(id); e.x = x + dx; e.y = y + dy; }
        for (const [lid, pts] of dr.linkOrig) { const l = S.links.get(lid); if (l) l.pts = pts.map(p => [p[0] + dx, p[1] + dy]); }
        SF.touch();
      } else if (dr.type === 'wp') {
        const l = S.links.get(dr.link);
        if (l) { l.pts[dr.idx] = snapHalf(m.wx, m.wy); dr.moved = true; SF.touch(); }
      }
    }
    if (ev.target === cv || dr) {
      // hover hit-test at most once per frame (mice report moves faster than the screen refreshes)
      hoverEv = ev;
      if (!hoverQueued) {
        hoverQueued = true;
        requestAnimationFrame(() => {
          hoverQueued = false;
          const d2 = ed.drag;
          const h = (d2 && d2.type !== 'pan' && d2.type !== 'rpan') || (d2 && d2.moved) ? null : SF.hitTest(ed.mouse.wx, ed.mouse.wy, { noPorts: ed.tool === 'place' || ed.tool === 'delete' });
          SF.hover = h;
          updateCursor();
          SF.onHover && SF.onHover(h, hoverEv);
        });
      }
    }
  }

  function onUp(ev) {
    const dr = ed.drag;
    if (!dr) return;
    setMouse(ev);
    ed.drag = null;
    const m = ed.mouse;
    if (dr.type === 'rpan' && !dr.moved) {
      // right click: cancel current action
      if (ed.link && ed.link.start) { endChain(); }
      else if (ed.tool !== 'select') SF.setTool('select');
      else SF.selectOnly();
    } else if (dr.type === 'move') {
      if (dr.moved) SF.changed();
      else if (dr.poleClick) startLink(dr.poleClick);       // clicked (not dragged) a pole's free connector
    } else if (dr.type === 'wp') {
      if (dr.moved) SF.changed();
    } else if (dr.type === 'zoop') {
      const tiles = zoopTiles(dr);
      let n = 0;
      for (const t of tiles) {
        if (overlaps(t)) continue;
        SF.addEntity(t.def, t.x, t.y, t.rot, S.level); n++;
      }
      if (n) SF.changed();
      else toast('Nothing placed — the area is already covered', 'warn');
    } else if (dr.type === 'marquee') {
      const x0 = Math.min(dr.x0, m.wx), x1 = Math.max(dr.x0, m.wx), y0 = Math.min(dr.y0, m.wy), y1 = Math.max(dr.y0, m.wy);
      if (x1 - x0 < 0.2 && y1 - y0 < 0.2) { updateCursor(); return; }
      const ents = [...S.entities.values()].filter(e => {
        if (e.level !== S.level) return false;
        const r = SF.entRect(e);
        return r.x0 >= x0 && r.x1 <= x1 && r.y0 >= y0 && r.y1 <= y1;
      }).map(e => e.id);
      const set = new Set(ents);
      const links = [...S.links.values()].filter(l => set.has(l.from[0]) && set.has(l.to[0])).map(l => l.id);
      if (dr.del) {
        if (ents.length) { ents.forEach(SF.removeEntity); SF.changed(); toast(`Deleted ${ents.length} object(s)`); }
      } else if (dr.add) { ents.forEach(id => SF.sel.ents.add(id)); links.forEach(id => SF.sel.links.add(id)); emitSel(); }
      else SF.selectOnly(ents, links);
    }
    updateCursor();
  }

  function onDbl() {
    const m = ed.mouse;
    if (ed.tool !== 'select') return;
    const hit = SF.hitTest(m.wx, m.wy);
    if (hit && hit.wp) {
      const l = S.links.get(hit.wp[0]); l.pts.splice(hit.wp[1], 1); SF.changed(); return;
    }
    if (hit && hit.link) {
      const l = S.links.get(hit.link);
      const p = snapHalf(m.wx, m.wy);
      // insert the waypoint where it best keeps the order along the current path
      const full = SF.linkScreenPath(l);
      const arc = pt => {
        let best = Infinity, at = 0;
        for (let i = 1; i < full.pts.length; i++) {
          const [d, t] = distSeg(pt[0], pt[1], full.pts[i - 1], full.pts[i]);
          if (d < best) { best = d; at = full.cum[i - 1] + t * (full.cum[i] - full.cum[i - 1]); }
        }
        return at;
      };
      const pts = [...(l.pts || []), p].map(q => ({ q, s: arc(q) })).sort((a, b) => a.s - b.s).map(o => o.q);
      l.pts = pts;
      SF.selectOnly([], [l.id]);
      SF.changed();
    }
  }

  let wheelAcc = 0;
  function rotateNext(deg) {
    if (!ed.link) return;
    ed.link.rotOffset = (((ed.link.rotOffset || 0) + deg * Math.PI / 180) + Math.PI * 3) % (Math.PI * 2) - Math.PI;
  }
  SF.rotateNextPole = rotateNext;
  let rotAcc = 0;
  function onWheel(ev) {
    ev.preventDefault();
    setMouse(ev);
    if (ev.ctrlKey && ed.link) {
      // Ctrl + wheel turns the next pole, like scrolling to rotate in game
      rotAcc += ev.deltaY;
      if (Math.abs(rotAcc) >= 50) { rotateNext(rotAcc < 0 ? 15 : -15); rotAcc = 0; }
      return;
    }
    if (ev.altKey) {
      // Alt + wheel steps through floors
      wheelAcc += ev.deltaY || ev.deltaX;
      if (Math.abs(wheelAcc) >= 60) { SF.changeLevel && SF.changeLevel(wheelAcc < 0 ? 1 : -1, false); wheelAcc = 0; }
      return;
    }
    const before = SF.s2w(ed.mouse.sx, ed.mouse.sy);
    const f = Math.pow(1.0015, -ev.deltaY);
    view.zoom = SF.clamp(view.zoom * f, 0.6, 80);
    const after = SF.s2w(ed.mouse.sx, ed.mouse.sy);
    view.cx += before[0] - after[0]; view.cy += before[1] - after[1];
  }

  function onKey(ev) {
    if (ev.target && /INPUT|SELECT|TEXTAREA/.test(ev.target.tagName)) return;
    const k = ev.key.toLowerCase();
    const ctrl = ev.ctrlKey || ev.metaKey;
    if (ev.code === 'Space') { ed.space = true; updateCursor(); ev.preventDefault(); return; }
    if (ctrl && k === 'z') { ev.shiftKey ? SF.redo() : SF.undo(); SF.selectOnly(); ev.preventDefault(); return; }
    if (ctrl && k === 'y') { SF.redo(); SF.selectOnly(); ev.preventDefault(); return; }
    if (ctrl && k === 'c') { SF.copySelection(); ev.preventDefault(); return; }
    if (ctrl && k === 'x') { if (SF.copySelection()) SF.deleteSelection(); ev.preventDefault(); return; }
    if (ctrl && k === 'v') { SF.pasteClipboard(); ev.preventDefault(); return; }
    if (ctrl && k === 'd') { if (SF.copySelection()) SF.pasteClipboard(); ev.preventDefault(); return; }
    if (ctrl && k === 'a') {
      const ids = [...S.entities.values()].filter(e => e.level === S.level).map(e => e.id);
      const set = new Set(ids);
      SF.selectOnly(ids, [...S.links.values()].filter(l => set.has(l.from[0]) && set.has(l.to[0])).map(l => l.id));
      ev.preventDefault(); return;
    }
    if (ctrl && k === 's') { SF.saveFile && SF.saveFile(); ev.preventDefault(); return; }
    if (ctrl) return;
    switch (k) {
      case 'escape':
        if (ed.drag && ed.drag.type === 'zoop') { ed.drag = null; return; }
        if (ed.link && ed.link.start) { endChain(); return; }
        if (ed.tool !== 'select') SF.setTool('select'); else SF.selectOnly();
        break;
      case 'r':
        if (ed.link) {
          const order = SF.BELT_STYLES.map(x => x[0]);
          ed.link.style = order[(order.indexOf(ed.link.style) + (ev.shiftKey ? order.length - 1 : 1)) % order.length];
          S.settings.beltStyle = ed.link.style;
          toast('Belt style: ' + styleName(ed.link.style));
          break;
        }
        if (ed.tool === 'place') ed.rot = (ed.rot + (ev.shiftKey ? 3 : 1)) % 4;
        else SF.rotateSelection(ev.shiftKey ? -1 : 1);
        break;
      case 'delete': SF.deleteSelection(); break;
      case 'backspace':
        if (ed.link) { SF.undo(); if (ed.link && !S.entities.has(ed.link.start[0])) ed.link = null; } else SF.deleteSelection();
        ev.preventDefault(); break;
      case '[': case ']': {
        if (ed.link) {
          // rotate the next pole while placing (45 degrees, Shift = 15)
          rotateNext((k === ']' ? 1 : -1) * (ev.shiftKey ? 15 : 45));
          break;
        }
        // raise / lower selected conveyor poles
        const poles = [...SF.sel.ents].map(id => S.entities.get(id)).filter(e => e && SF.defs[e.def].kind === 'pole');
        if (!poles.length) break;
        const dh = (k === ']' ? 1 : -1) * (ev.shiftKey ? 0.5 : 1);
        poles.forEach(p => { p.h = SF.clamp((p.h ?? 1) + dh, 0, 40); });
        SF.changed(); SF.renderInspector && SF.renderInspector();
        break;
      }
      case 'v': SF.setTool('select'); break;
      case 'b': SF.setTool('link', { kind: 'belt' }); break;
      case 'p': SF.setTool('link', { kind: 'pipe' }); break;
      case 'x': SF.setTool('delete'); break;
      case 'h': SF.setTool('pan'); break;
      case 'f': if (SF.view3d && SF.view3d.active) SF.view3d.fit(); else SF.fitView(); break;
      case 't': if (SF.view3d && !SF.view3d.unavailable) SF.view3d.toggle(); break;
      case 'm': SF.live && SF.live.setActive(!SF.live.active); break;
      case 'k': if (SF.live && SF.live.active) { SF.live.running = !SF.live.running; SF.onSimMode && SF.onSimMode(); } break;
      case 'q': {
        const h = SF.hover && SF.hover.ent && S.entities.get(SF.hover.ent);
        if (h) {
          const { id, x, y, rot, level, def, ...props } = h;
          ed.rot = rot; SF.setTool('place', { def, props });
        }
        break;
      }
      case 'pageup': case '.': case 'e': SF.changeLevel && SF.changeLevel(1, k !== 'e'); ev.preventDefault(); break;
      case 'pagedown': case ',': case 'c': SF.changeLevel && SF.changeLevel(-1); ev.preventDefault(); break;
      case 'arrowleft': case 'arrowright': case 'arrowup': case 'arrowdown': {
        if (ed.link && (k === 'arrowup' || k === 'arrowdown')) {
          // raise / lower the next pole, like scrolling the pole height in game
          ed.link.h = SF.clamp((ed.link.h ?? 1) + (k === 'arrowup' ? 1 : -1) * (ev.shiftKey ? 0.5 : 1), 0, 40);
          ev.preventDefault(); break;
        }
        if (!SF.sel.ents.size) return;
        const s = ev.shiftKey ? 8 : (S.settings.snap || 1);
        const dx = k === 'arrowleft' ? -s : k === 'arrowright' ? s : 0, dy = k === 'arrowup' ? -s : k === 'arrowdown' ? s : 0;
        for (const id of SF.sel.ents) { const e = S.entities.get(id); e.x += dx; e.y += dy; }
        for (const l of S.links.values()) if (SF.sel.ents.has(l.from[0]) && SF.sel.ents.has(l.to[0])) l.pts = (l.pts || []).map(p => [p[0] + dx, p[1] + dy]);
        SF.changed(); ev.preventDefault(); break;
      }
      default:
        if (/^[1-6]$/.test(k)) {
          const tier = +k;
          if (SF.sel.links.size && ed.tool === 'select') {
            let n = 0;
            for (const id of SF.sel.links) {
              const l = S.links.get(id);
              const max = l.kind === 'pipe' ? SF.D.pipes.length : SF.D.belts.length;
              if (tier <= max) { l.tier = tier; n++; }
            }
            if (n) SF.changed();
          } else if (ed.tool === 'link' || ed.tool === 'select') {
            if (ed.linkKind === 'pipe' && tier <= SF.D.pipes.length) ed.pipeTier = tier;
            else if (ed.linkKind === 'belt') ed.beltTier = tier;
            SF.onTool && SF.onTool();
          }
        }
    }
  }

  // ------------------------------------------------------------ overlays
  SF.drawOverlays = (ctx, t) => {
    const m = ed.mouse;
    if (ed.tool === 'place' && m.in) {
      if (ed.group) {
        const gp = groupPlacement();
        const ok = !gp.ents.some(e => overlaps(e));
        const byId = new Map(gp.ents.map(e => [e.id, e]));
        for (const e of gp.ents) if (SF.defs[e.def].structure) SF.drawEntityGhost(e, ok, t);
        for (const l of ed.group.links || []) {
          const a = byId.get(l.from[0]), b = byId.get(l.to[0]);
          if (!a || !b) continue;
          const wps = (l.pts || []).map(p => { const [x, y] = SF.rot(p[0], p[1], ed.rot); return [x + gp.ox, y + gp.oy]; });
          SF.drawLinkGhost(SF.routePath(SF.portWorld(a, l.from[1]), SF.portWorld(b, l.to[1]), wps, SF.linkStyle(l)), l.kind, ok);
        }
        for (const e of gp.ents) if (!SF.defs[e.def].structure) SF.drawEntityGhost(e, ok, t);
      } else if (ed.drag && ed.drag.type === 'zoop') {
        const tiles = zoopTiles();
        tiles.forEach(e => SF.drawEntityGhost(e, !overlaps(e), t));
        const d = SF.defs[ed.placeDef];
        drawTip(ctx, `${tiles.length} × ${d.name}`, m.sx + 14, m.sy + 18);
      } else {
        const ag = attachGhost();
        if (ag) {
          // highlight the belt it will cut into
          SF.drawLinkGhost(SF.linkScreenPath(ag.l).pts, ag.l.kind, true);
          SF.drawEntityGhost(ag.e, true, t);
          drawTip(ctx, 'Click to insert into this ' + (ag.l.kind === 'pipe' ? 'pipeline' : 'belt'), m.sx + 14, m.sy + 18);
        } else {
          const g = ghostEntity();
          if (g) SF.drawEntityGhost(g, !overlaps(g), t);
        }
      }
    }
    if (ed.tool === 'link' && m.in) {
      const L = ed.link;
      const p = L && L.start ? linkPreview() : null;
      const spec = (L ? L.kind : ed.linkKind) === 'pipe' ? SF.D.pipes[ed.pipeTier - 1] : SF.D.belts[ed.beltTier - 1];
      if (p && p.pts.length) {
        SF.drawLinkGhost(p.pts, L.kind, p.ok);
        // pole that the click would place
        if (p.free) SF.drawPoleGhost(p.free[0], p.free[1], p.ang, L.h, L.kind, p.ok);
      }
      // magnet: ring the port the belt would snap to
      const mp = magnetPort(m.wx, m.wy);
      if (mp) {
        const P = portInfo(mp);
        const [px, py] = SF.w2s(P.x, P.y);
        ctx.strokeStyle = '#22c55e'; ctx.lineWidth = 2.5;
        ctx.beginPath(); ctx.arc(px, py, Math.max(9, view.zoom * 0.9), 0, Math.PI * 2); ctx.stroke();
      } else if (!L) {
        const [fx, fy] = snapPt(m.wx, m.wy);
        SF.drawPoleGhost(fx, fy, 0, 1, ed.linkKind, true);
      }
      let tip;
      if (!L) tip = `${spec.name} · click a port or the ground to start`;
      else if (p && p.error) tip = p.error;
      else if (p && p.tooShort) tip = 'Move further away';
      else {
        const len = p ? SF.pathLength(p.pts) : 0;
        const rot = Math.round((L.rotOffset || 0) * 180 / Math.PI);
        tip = `${spec.name} · ${SF.fmt(len, 1)} m · height ${SF.fmt(L.h, 1)} m · ${styleName(L.style)}` + (rot ? ` · turned ${rot > 0 ? '+' : ''}${rot}°` : '') + (p && p.problems && p.problems.length ? ' · ' + p.problems.map(x => x.code === 'steep' ? 'too steep' : x.code === 'tight' ? 'turn too tight' : x.code === 'long' ? 'too long' : x.code === 'climbturn' ? 'climbs in a turn' : x.code).join(', ') : '');
      }
      drawTip(ctx, tip, m.sx + 14, m.sy + 18, p && !p.ok && !p.tooShort);
      if (L) drawTip(ctx, '↑/↓ height · [ ] or Ctrl+wheel rotate pole · R style · right-click to finish', m.sx + 14, m.sy + 42);
    }
    if (ed.drag && ed.drag.type === 'marquee') {
      const [x0, y0] = SF.w2s(ed.drag.x0, ed.drag.y0);
      ctx.fillStyle = ed.drag.del ? 'rgba(239,68,68,.12)' : 'rgba(56,189,248,.12)';
      ctx.strokeStyle = ed.drag.del ? '#ef4444' : '#38bdf8'; ctx.lineWidth = 1; ctx.setLineDash([5, 4]);
      ctx.fillRect(x0, y0, m.sx - x0, m.sy - y0); ctx.strokeRect(x0, y0, m.sx - x0, m.sy - y0); ctx.setLineDash([]);
    }
    if (ed.drag && ed.drag.type === 'move' && ed.drag.moved) {
      const ents = [...SF.sel.ents].map(id => S.entities.get(id));
      const bad = ents.some(e => overlaps(e, SF.sel.ents));
      if (bad) drawTip(ctx, 'Overlapping', m.sx + 14, m.sy + 18, true);
    }
  };

  function drawTip(ctx, text, x, y, bad) {
    ctx.font = '600 12px Inter, Segoe UI, sans-serif';
    const w = ctx.measureText(text).width;
    ctx.fillStyle = bad ? 'rgba(127,29,29,.95)' : 'rgba(15,17,21,.92)';
    SF.rrect(ctx, x, y, w + 12, 20, 5); ctx.fill();
    ctx.fillStyle = '#f3f4f6'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(text, x + 6, y + 10);
  }
})(window.SF);
