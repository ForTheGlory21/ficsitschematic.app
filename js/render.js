// Canvas renderer: grid, structures, belts/pipes with animated flow, buildings, overlays.
(function (SF) {
  const S = SF.state, D = SF.D;
  const view = SF.view = { cx: 0, cy: 0, zoom: 12, W: 0, H: 0, dpr: 1 };
  const TIER_COLORS = ['#d6b23a', '#d6b23a', '#c98a2c', '#59a14f', '#3b82c4', '#8b5cf6', '#d946a6'];
  const PIPE_TIER = ['#60a5fa', '#60a5fa', '#a78bfa'];
  const STATUS_COLOR = { ok: '#22c55e', starved: '#f59e0b', throttled: '#f59e0b', blocked: '#ef4444', idle: '#ef4444', noRecipe: '#ef4444', noFuel: '#ef4444' };
  SF.STATUS_COLOR = STATUS_COLOR;
  SF.STATUS_TEXT = { ok: 'Running', starved: 'Input-starved', throttled: 'Limited by belt / demand', blocked: 'Output blocked', idle: 'Not running', noRecipe: 'No recipe set', noFuel: 'No fuel selected' };

  let cv, ctx;
  let ghostCv = null, ghostPass = false;
  SF.initRender = (canvas) => {
    cv = canvas; ctx = cv.getContext('2d');
    const ro = new ResizeObserver(resize);
    ro.observe(cv.parentElement);
    resize();
  };
  function resize() {
    const r = cv.parentElement.getBoundingClientRect();
    view.dpr = window.devicePixelRatio || 1;
    view.W = r.width; view.H = r.height;
    cv.width = Math.round(r.width * view.dpr); cv.height = Math.round(r.height * view.dpr);
    cv.style.width = r.width + 'px'; cv.style.height = r.height + 'px';
    if (SF.fitPending && view.W > 50 && view.H > 50 && SF.fitView) SF.fitView();
    SF.dirty = true;
  }

  SF.w2s = (x, y) => [(x - view.cx) * view.zoom + view.W / 2, (y - view.cy) * view.zoom + view.H / 2];
  SF.s2w = (x, y) => [(x - view.W / 2) / view.zoom + view.cx, (y - view.H / 2) / view.zoom + view.cy];

  // ------------------------------------------------------------ primitives
  function rrect(c, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    c.beginPath();
    c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath();
  }
  SF.rrect = rrect;

  function polyPath(c, pts, radius) {
    c.beginPath();
    c.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length - 1; i++) c.arcTo(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], radius);
    c.lineTo(pts[pts.length - 1][0], pts[pts.length - 1][1]);
  }

  function gear(c, x, y, r, teeth, ang) {
    c.save(); c.translate(x, y); c.rotate(ang);
    c.beginPath();
    for (let i = 0; i < teeth * 2; i++) {
      const a0 = (i / (teeth * 2)) * Math.PI * 2, a1 = ((i + 1) / (teeth * 2)) * Math.PI * 2;
      const rr = i % 2 ? r * 0.78 : r;
      c.lineTo(Math.cos(a0) * rr, Math.sin(a0) * rr); c.lineTo(Math.cos(a1) * rr, Math.sin(a1) * rr);
    }
    c.closePath();
    c.moveTo(r * 0.35, 0); c.arc(0, 0, r * 0.35, 0, Math.PI * 2, true);
    c.fill('evenodd');
    c.restore();
  }

  function bolt(c, x, y, s) {
    c.beginPath();
    c.moveTo(x + 0.15 * s, y - 0.5 * s); c.lineTo(x - 0.3 * s, y + 0.08 * s); c.lineTo(x - 0.02 * s, y + 0.08 * s);
    c.lineTo(x - 0.15 * s, y + 0.5 * s); c.lineTo(x + 0.3 * s, y - 0.1 * s); c.lineTo(x + 0.02 * s, y - 0.1 * s);
    c.closePath(); c.fill();
  }

  SF.drawItemChip = (c, item, x, y, r, withText = true) => {
    const im = SF.img(item);
    if (im) {
      const px = Math.max(8, Math.ceil(r * 2 * (view.dpr || 1) / 8) * 8);
      c.drawImage(px <= 64 ? SF.imgSmall(item, px) : im, x - r, y - r, r * 2, r * 2);
      return;
    }
    const it = SF.item(item);
    c.fillStyle = it.color;
    if (it.fluid) {
      c.beginPath(); c.moveTo(x, y - r); c.bezierCurveTo(x + r * 1.1, y + r * 0.1, x + r * 0.8, y + r, x, y + r);
      c.bezierCurveTo(x - r * 0.8, y + r, x - r * 1.1, y + r * 0.1, x, y - r); c.fill();
    } else {
      rrect(c, x - r, y - r, r * 2, r * 2, r * 0.35); c.fill();
    }
    c.strokeStyle = 'rgba(0,0,0,.45)'; c.lineWidth = Math.max(1, r * 0.08); c.stroke();
    if (withText && r > 6) {
      c.fillStyle = luminance(it.color) > 0.55 ? '#111' : '#fff';
      c.font = `700 ${Math.round(r * 0.8)}px Inter, Segoe UI, sans-serif`;
      c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillText(SF.itemAbbr(item), x, y + r * 0.05);
    }
  };
  function luminance(hex) {
    const n = parseInt(hex.slice(1), 16);
    return (0.299 * (n >> 16 & 255) + 0.587 * (n >> 8 & 255) + 0.114 * (n & 255)) / 255;
  }

  // ------------------------------------------------------------ grid
  function drawGrid() {
    const z = view.zoom;
    const [x0, y0] = SF.s2w(0, 0), [x1, y1] = SF.s2w(view.W, view.H);
    const lines = (step, color, width) => {
      if (step * z < 5) return;
      ctx.strokeStyle = color; ctx.lineWidth = width;
      ctx.beginPath();
      for (let x = Math.floor(x0 / step) * step; x <= x1; x += step) { const sx = Math.round(SF.w2s(x, 0)[0]) + 0.5; ctx.moveTo(sx, 0); ctx.lineTo(sx, view.H); }
      for (let y = Math.floor(y0 / step) * step; y <= y1; y += step) { const sy = Math.round(SF.w2s(0, y)[1]) + 0.5; ctx.moveTo(0, sy); ctx.lineTo(view.W, sy); }
      ctx.stroke();
    };
    lines(1, 'rgba(148,163,184,0.035)', 1);
    lines(8, 'rgba(148,163,184,0.075)', 1);
    lines(64, 'rgba(148,163,184,0.13)', 1);
    // origin
    const [ox, oy] = SF.w2s(0, 0);
    ctx.strokeStyle = 'rgba(245,158,11,0.25)'; ctx.beginPath();
    ctx.moveTo(ox, 0); ctx.lineTo(ox, view.H); ctx.moveTo(0, oy); ctx.lineTo(view.W, oy); ctx.stroke();
  }

  // ------------------------------------------------------------ structures
  function drawStructure(e, d) {
    const r = SF.entRect(e);
    const [sx, sy] = SF.w2s(r.x0, r.y0);
    const w = (r.x1 - r.x0) * view.zoom, h = (r.y1 - r.y0) * view.zoom;
    if (d.kind === 'wall') {
      ctx.fillStyle = shade(d.color, -0.2);
      ctx.fillRect(sx, sy, w, h);
      ctx.strokeStyle = 'rgba(0,0,0,.5)'; ctx.lineWidth = 1; ctx.strokeRect(sx, sy, w, h);
      return;
    }
    ctx.fillStyle = d.color;
    ctx.fillRect(sx, sy, w, h);
    // tile pattern: lighter inner, 1m texture lines when zoomed
    ctx.strokeStyle = 'rgba(255,255,255,0.07)'; ctx.lineWidth = 1;
    if (view.zoom > 10 && d.mat !== 'Glass') {
      ctx.beginPath();
      const step = view.zoom * 2;
      for (let x = sx + step; x < sx + w - 1; x += step) { ctx.moveTo(x, sy); ctx.lineTo(x, sy + h); }
      for (let y = sy + step; y < sy + h - 1; y += step) { ctx.moveTo(sx, y); ctx.lineTo(sx + w, y); }
      ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(0,0,0,0.45)'; ctx.lineWidth = Math.max(1, view.zoom * 0.08);
    ctx.strokeRect(sx + 0.5, sy + 0.5, w - 1, h - 1);
    if (d.kind === 'ramp') {
      // arrow pointing "up" the ramp (local -x)
      const [ax, ay] = SF.rot(-1, 0, e.rot);
      const [cx, cy] = SF.w2s(e.x, e.y);
      const L = Math.min(w, h) * 0.3;
      ctx.strokeStyle = 'rgba(255,255,255,.45)'; ctx.lineWidth = Math.max(1.5, view.zoom * 0.25);
      ctx.beginPath(); ctx.moveTo(cx - ax * L, cy - ay * L); ctx.lineTo(cx + ax * L, cy + ay * L);
      ctx.lineTo(cx + ax * L * 0.4 - ay * L * 0.5, cy + ay * L * 0.4 + ax * L * 0.5);
      ctx.moveTo(cx + ax * L, cy + ay * L); ctx.lineTo(cx + ax * L * 0.4 + ay * L * 0.5, cy + ay * L * 0.4 - ax * L * 0.5);
      ctx.stroke();
    }
  }

  function shade(hex, amt) {
    const n = parseInt(hex.slice(1), 16);
    const f = v => Math.max(0, Math.min(255, Math.round(amt < 0 ? v * (1 + amt) : v + (255 - v) * amt)));
    return '#' + [n >> 16 & 255, n >> 8 & 255, n & 255].map(f).map(v => v.toString(16).padStart(2, '0')).join('');
  }
  SF.shade = shade;

  // ------------------------------------------------------------ links
  const pathCache = new Map();
  function linkScreenPath(l) {
    const key = l.id;
    const pts = SF.linkPath(l);                      // cached per link; same array while the link is unchanged
    const c = pathCache.get(key);
    if (c && c.pts === pts) return c;
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of pts) { if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0]; if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1]; }
    const v = { pts, cum, L: cum[cum.length - 1], bb: [x0 - 2, y0 - 2, x1 + 2, y1 + 2] };
    pathCache.set(key, v);
    return v;
  }
  SF.linkScreenPath = linkScreenPath;

  function pointAt(p, s) {
    const { pts, cum } = p;
    let lo = 0, hi = cum.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cum[m] <= s) lo = m; else hi = m; }
    const seg = cum[hi] - cum[lo] || 1;
    const t = (s - cum[lo]) / seg;
    return [pts[lo][0] + (pts[hi][0] - pts[lo][0]) * t, pts[lo][1] + (pts[hi][1] - pts[lo][1]) * t,
      pts[hi][0] - pts[lo][0], pts[hi][1] - pts[lo][1]];
  }

  function hash(n) { n = (n ^ 61) ^ (n >>> 16); n = n + (n << 3); n = n ^ (n >>> 4); n = Math.imul(n, 0x27d4eb2d); n = n ^ (n >>> 15); return (n >>> 0) / 4294967296; }

  function drawLink(l, t, alpha, selected) {
    const P = linkScreenPath(l);
    if (P.pts.length < 2) return;
    const res = SF.sim.result && SF.sim.result.edges.get(l.id);
    const z = view.zoom;
    // far zoomed out a belt is a few pixels wide: one line in its tier colour (busy belts brighter)
    if (z < 3 && !selected) {
      ctx.save(); ctx.globalAlpha = alpha * (res && res.total > 0.01 ? 0.95 : 0.5);
      ctx.strokeStyle = l.kind === 'pipe' ? (PIPE_TIER[l.tier] || '#60a5fa') : (TIER_COLORS[l.tier] || '#999');
      ctx.lineWidth = Math.max(1, z * 1.2);
      ctx.beginPath();
      P.pts.forEach((p, i) => { const sx = (p[0] - view.cx) * z + view.W / 2, sy = (p[1] - view.cy) * z + view.H / 2; i ? ctx.lineTo(sx, sy) : ctx.moveTo(sx, sy); });
      ctx.stroke(); ctx.restore();
      return;
    }
    const spts = P.pts.map(p => SF.w2s(p[0], p[1]));
    const ea = S.entities.get(l.from[0]), eb = S.entities.get(l.to[0]);
    const crossLevel = ea.level !== eb.level;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.lineJoin = 'round'; ctx.lineCap = 'butt';
    const isPipe = l.kind === 'pipe';
    // real widths: belts ~1.8 m including the frame, pipes ~1 m
    const width = Math.max(isPipe ? 2.5 : 3.5, z * (isPipe ? 1.0 : 1.6));
    if (selected) {
      ctx.strokeStyle = 'rgba(56,189,248,.55)'; ctx.lineWidth = width + 8;
      polyPath(ctx, spts, 0); ctx.stroke();
    }
    const util = res ? res.util : 0;
    const jam = res && res.jam > 0.2;
    if (res && !jam && util > 0.995 && S.settings.showRates) {
      ctx.strokeStyle = 'rgba(249,115,22,.35)'; ctx.lineWidth = width + 5;
      polyPath(ctx, spts, 0); ctx.stroke();
    }
    if (jam) {
      ctx.strokeStyle = 'rgba(239,68,68,' + (0.4 + 0.3 * Math.sin(t * 6)) + ')'; ctx.lineWidth = width + 6;
      polyPath(ctx, spts, 0); ctx.stroke();
    }
    if (crossLevel) ctx.setLineDash([z * 1.5, z * 0.6]);
    if (isPipe) {
      // pipe body
      const flows = res ? res.flows : {};
      const main = Object.keys(flows).sort((a, b) => flows[b] - flows[a])[0];
      const fluidCol = main ? SF.item(main).color : '#3b4b5e';
      ctx.strokeStyle = '#1c242e'; ctx.lineWidth = width + 2; polyPath(ctx, spts, 0); ctx.stroke();
      ctx.strokeStyle = main ? shade(fluidCol, -0.35) : '#334155'; ctx.lineWidth = width; polyPath(ctx, spts, 0); ctx.stroke();
      ctx.setLineDash([]);
      if (main && res.total > 0.01) {
        ctx.strokeStyle = shade(fluidCol, 0.25);
        ctx.lineWidth = width * 0.45;
        const dash = Math.max(6, z * 1.2);
        ctx.setLineDash([dash, dash * 0.8]);
        ctx.lineDashOffset = S.settings.anim ? -t * z * (1 + 3 * util) : 0;
        ctx.globalAlpha = alpha * (0.45 + 0.55 * util);
        polyPath(ctx, spts, 0); ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = PIPE_TIER[l.tier] || '#60a5fa';
      ctx.lineWidth = 1;
      polyPath(ctx, spts, 0); ctx.globalAlpha = alpha * 0.35; ctx.stroke();
    } else {
      // belt body: frame, side rails, rubber surface, tier stripe
      ctx.lineCap = 'butt';
      ctx.strokeStyle = 'rgba(0,0,0,.35)'; ctx.lineWidth = width + 4; polyPath(ctx, spts, 0); ctx.stroke();
      ctx.strokeStyle = '#3b424d'; ctx.lineWidth = width; polyPath(ctx, spts, 0); ctx.stroke();
      ctx.strokeStyle = '#1f2329'; ctx.lineWidth = width * 0.74; polyPath(ctx, spts, 0); ctx.stroke();
      ctx.setLineDash([]);
      ctx.strokeStyle = TIER_COLORS[l.tier] || '#999'; ctx.lineWidth = Math.max(1, width * 0.07);
      ctx.globalAlpha = alpha * 0.55;
      polyPath(ctx, spts, 0); ctx.stroke();
      ctx.globalAlpha = alpha;
      // moving items
      const liveItems = SF.live && SF.live.active && !ghostPass ? SF.live.beltItems(l.id) : null;
      if (liveItems) {
        // Sim mode: draw the real items where they actually are
        const L = P.L, sz = Math.max(2, Math.min(z * 0.65, 18));
        for (const x of liveItems) {
          const [wx, wy] = pointAt(P, x.f * L);
          const [px, py] = SF.w2s(wx, wy);
          if (px < -20 || py < -20 || px > view.W + 20 || py > view.H + 20) continue;
          if (sz > 7) SF.drawItemChip(ctx, x.it, px, py, sz * 0.62, false);
          else { ctx.fillStyle = SF.item(x.it).color; ctx.fillRect(px - sz / 2, py - sz / 2, sz, sz); }
        }
      } else if (res && res.total > 0.01 && !ghostPass) {
        const spec = SF.linkSpec(l);
        const speed = (D.belts.find(b => b.tier === l.tier) || D.belts[0]).speed;  // m/s
        const sp = speed / (res.total / 60);                                       // metres between items
        const items = Object.keys(res.flows).filter(k => res.flows[k] > 1e-6);
        const cum = []; let acc = 0;
        for (const it of items) { acc += res.flows[it] / res.total; cum.push([acc, it]); }
        const shift = S.settings.anim ? t * speed : 0;
        const phase = ((shift % sp) + sp) % sp;
        const base = Math.floor(shift / sp);
        const L = P.L;
        if (sp * z >= 4) {
          const sz = Math.max(2, Math.min(z * 0.65, 18));
          const n = Math.min(4000, Math.floor(L / sp) + 1);
          for (let k = 0; k <= n; k++) {
            const s = phase + k * sp;
            if (s > L) break;
            const id = k - base;
            const h = hash(id * 2654435761 >>> 0);
            const it = (cum.find(c => h <= c[0]) || cum[cum.length - 1])[1];
            const [x, y] = pointAt(P, s);
            const [px, py] = SF.w2s(x, y);
            if (px < -20 || py < -20 || px > view.W + 20 || py > view.H + 20) continue;
            if (sz > 7) SF.drawItemChip(ctx, it, px, py, sz * 0.62, false);
            else { ctx.fillStyle = SF.item(it).color; ctx.fillRect(px - sz / 2, py - sz / 2, sz, sz); }
          }
        } else {
          // too dense to draw individually: moving dashes in the main item colour
          const main = items.sort((a, b) => res.flows[b] - res.flows[a])[0];
          ctx.strokeStyle = SF.item(main).color;
          ctx.lineWidth = width * 0.5;
          ctx.setLineDash([3, 3]);
          ctx.lineDashOffset = -shift * z;
          ctx.globalAlpha = alpha * Math.min(1, 0.3 + util);
          polyPath(ctx, spts, 0); ctx.stroke();
          ctx.setLineDash([]);
          ctx.globalAlpha = alpha;
        }
        void spec;
      } else if (z > 6) {
        // direction chevrons on idle belts
        const P2 = P;
        ctx.strokeStyle = 'rgba(255,255,255,.18)'; ctx.lineWidth = Math.max(1, z * 0.12);
        for (let s = 2; s < P2.L - 1; s += 4) {
          const [x, y, dx, dy] = pointAt(P2, s);
          const d = Math.hypot(dx, dy) || 1, ux = dx / d, uy = dy / d;
          const [px, py] = SF.w2s(x, y), a = z * 0.35;
          ctx.beginPath(); ctx.moveTo(px - ux * a - uy * a, py - uy * a + ux * a); ctx.lineTo(px, py);
          ctx.lineTo(px - ux * a + uy * a, py - uy * a - ux * a); ctx.stroke();
        }
      }
    }
    ctx.setLineDash([]);
    // lift markers for cross-level links
    if (crossLevel && !ghostPass) {
      const other = ea.level === S.level ? eb : ea;
      const end = ea.level === S.level ? spts[spts.length - 1] : spts[0];
      const up = other.level > S.level;
      const r = Math.max(7, z * 0.9);
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#0f172a'; ctx.strokeStyle = '#f59e0b'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(end[0], end[1], r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#f59e0b'; ctx.font = `700 ${Math.round(r * 1.1)}px Inter, sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(up ? '▲' : '▼', end[0], end[1] + 1);
    }
    // rate label
    if (res && !ghostPass && S.settings.showRates && S.settings.labels && z > 5 && P.L > 3) {
      const [x, y] = pointAt(P, P.L / 2);
      const [px, py] = SF.w2s(x, y);
      const txt = SF.fmt(res.total, 1) + ' / ' + SF.fmt(res.cap, 0);
      ctx.font = `600 ${Math.round(SF.clamp(z * 0.75, 9, 13))}px Inter, Segoe UI, sans-serif`;
      const tw = ctx.measureText(txt).width;
      ctx.fillStyle = 'rgba(15,17,21,.85)';
      rrect(ctx, px - tw / 2 - 4, py - 15 - width / 2, tw + 8, 14, 4); ctx.fill();
      ctx.fillStyle = jam ? '#f87171' : util > 0.995 ? '#fb923c' : util < 0.001 ? '#64748b' : '#e5e7eb';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(txt, px, py - 8 - width / 2);
    }
    ctx.restore();
  }

  // ------------------------------------------------------------ splitters, mergers, poles (top-down)
  const ATTACH_RIM = { splitter: '#f59e0b', smart: '#38bdf8', programmable: '#a78bfa', merger: '#f59e0b', priority: '#f472b6' };
  function chevron(c, x, y, ux, uy, s) {
    c.beginPath();
    c.moveTo(x - ux * s - uy * s, y - uy * s + ux * s);
    c.lineTo(x, y);
    c.lineTo(x - ux * s + uy * s, y - uy * s - ux * s);
    c.stroke();
  }

  function drawAttachment(e, d, t, alpha, res) {
    const z = view.zoom;
    const [cx, cy] = SF.w2s(e.x, e.y);
    const flowing = res && Object.keys(res.ins || {}).length;
    if (d.kind === 'pole') {
      // a conveyor pole / pipe support: post + holder pointing along the belt
      const r = Math.max(3, z * 0.45);
      const a = e.ang || 0, ux = Math.cos(a), uy = Math.sin(a);
      ctx.fillStyle = 'rgba(0,0,0,.4)';
      ctx.beginPath(); ctx.arc(cx + 1.5, cy + 2, r * 1.15, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#3b424d'; ctx.strokeStyle = d.ports[0].fluid ? '#38bdf8' : '#f59e0b'; ctx.lineWidth = Math.max(1.2, z * 0.1);
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.lineWidth = Math.max(1.4, z * 0.14); ctx.strokeStyle = '#e5e7eb';
      chevron(ctx, cx + ux * r * 0.45, cy + uy * r * 0.45, ux, uy, r * 0.5);
      if (z > 6 && S.settings.labels) {
        const txt = SF.fmt(e.h ?? 1, 1) + ' m';
        ctx.font = `600 ${SF.clamp(z * 0.6, 9, 12)}px Inter, Segoe UI, sans-serif`;
        const tw = ctx.measureText(txt).width;
        ctx.fillStyle = 'rgba(13,15,19,.85)';
        rrect(ctx, cx - tw / 2 - 4, cy + r + 3, tw + 8, 14, 4); ctx.fill();
        ctx.fillStyle = '#cbd5e1'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(txt, cx, cy + r + 10);
      }
      return;
    }
    const r = SF.entRect(e);
    const [sx, sy] = SF.w2s(r.x0, r.y0);
    const w = (r.x1 - r.x0) * z, h = (r.y1 - r.y0) * z;
    const sub = d.raw && d.raw.smart ? (d.id.includes('Programmable') ? 'programmable' : 'smart') : d.raw && d.raw.priority ? 'priority' : d.kind;
    const rim = ATTACH_RIM[sub] || '#f59e0b';
    // housing
    ctx.shadowColor = 'rgba(0,0,0,.5)'; ctx.shadowBlur = Math.min(14, z); ctx.shadowOffsetY = Math.min(4, z * 0.2);
    ctx.fillStyle = '#1b1f26';
    rrect(ctx, sx + w * 0.08, sy + h * 0.08, w * 0.84, h * 0.84, Math.min(w, h) * 0.16); ctx.fill();
    ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
    // belt channels from each connector to the hub
    const bw = Math.max(3, z * 1.25);
    d.ports.forEach((p, i) => {
      const P = SF.portWorld(e, i);
      const [px, py] = SF.w2s(P.x, P.y);
      const connected = S.portLinks.has(SF.portKey(e.id, i));
      ctx.lineCap = 'butt';
      ctx.strokeStyle = '#3b424d'; ctx.lineWidth = bw; ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(px, py); ctx.stroke();
      ctx.strokeStyle = '#1f2329'; ctx.lineWidth = bw * 0.74; ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(px, py); ctx.stroke();
      // chevrons show the flow direction (towards the hub for inputs, outwards for outputs)
      const len = Math.hypot(px - cx, py - cy) || 1;
      let ux = (px - cx) / len, uy = (py - cy) / len;
      if (p.io === 'in') { ux = -ux; uy = -uy; }
      ctx.strokeStyle = connected ? (flowing ? rim : '#6b7280') : '#4b5563';
      ctx.lineWidth = Math.max(1.2, z * 0.12);
      const n = 2, spacing = len / (n + 1);
      for (let k = 1; k <= n; k++) {
        let off = spacing * k;
        if (flowing && S.settings.anim) off = (off + t * z * 1.6) % len;
        const fx = p.io === 'in' ? px + ux * off : cx + ux * off;
        const fy = p.io === 'in' ? py + uy * off : cy + uy * off;
        chevron(ctx, fx, fy, ux, uy, bw * 0.28);
      }
    });
    // hub
    const hr = Math.min(w, h) * 0.2;
    ctx.fillStyle = '#2a3039'; ctx.strokeStyle = rim; ctx.lineWidth = Math.max(1.5, z * 0.16);
    ctx.beginPath(); ctx.arc(cx, cy, hr, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.fillStyle = rim;
    ctx.beginPath(); ctx.arc(cx, cy, hr * 0.38, 0, Math.PI * 2); ctx.fill();
    // smart / programmable: show each output's filter as a tiny item chip
    if (d.raw && d.raw.smart && e.rules && z > 6) {
      [1, 2, 3].forEach((pi, k) => {
        const rule = (e.rules[k] || ['any'])[0];
        if (!SF.D.items[rule]) return;
        const P = SF.portWorld(e, pi);
        const [px, py] = SF.w2s(e.x + (P.x - e.x) * 0.55, e.y + (P.y - e.y) * 0.55);
        SF.drawItemChip(ctx, rule, px, py, Math.max(4, z * 0.32), false);
      });
    }
    // rim
    ctx.strokeStyle = rim; ctx.globalAlpha = alpha * 0.55; ctx.lineWidth = Math.max(1, z * 0.08);
    rrect(ctx, sx + w * 0.08, sy + h * 0.08, w * 0.84, h * 0.84, Math.min(w, h) * 0.16); ctx.stroke();
    ctx.globalAlpha = alpha;
  }

  SF.drawPoleGhost = (x, y, ang, h, kind, ok) => {
    const [cx, cy] = SF.w2s(x, y);
    const r = Math.max(4, view.zoom * 0.45);
    ctx.save();
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = ok ? 'rgba(34,197,94,.25)' : 'rgba(239,68,68,.25)';
    ctx.strokeStyle = ok ? '#22c55e' : '#ef4444'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.strokeStyle = '#e5e7eb'; ctx.lineWidth = 2;
    chevron(ctx, cx + Math.cos(ang) * r * 0.45, cy + Math.sin(ang) * r * 0.45, Math.cos(ang), Math.sin(ang), r * 0.5);
    ctx.restore();
    void h; void kind;
  };

  // ------------------------------------------------------------ buildings
  function drawBuilding(e, d, t, alpha) {
    const r = SF.entRect(e);
    const [sx, sy] = SF.w2s(r.x0, r.y0);
    const w = (r.x1 - r.x0) * view.zoom, h = (r.y1 - r.y0) * view.zoom;
    const [cx, cy] = SF.w2s(e.x, e.y);
    const z = view.zoom;
    const res = SF.sim.result && SF.sim.result.nodes.get(e.id);
    const catCol = SF.CAT_COLOR[d.cat] || '#888';
    ctx.save();
    ctx.globalAlpha = alpha;

    if (d.kind === 'label') {
      ctx.fillStyle = e.color || '#e5e7eb';
      ctx.font = `700 ${Math.max(6, (e.size || 1.6) * z)}px Inter, Segoe UI, sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(e.text || '', cx, cy);
      ctx.restore(); return;
    }
    if (d.kind === 'zone') {
      ctx.fillStyle = (e.color || '#a78bfa') + '18'; ctx.fillRect(sx, sy, w, h);
      ctx.strokeStyle = (e.color || '#a78bfa') + 'aa'; ctx.setLineDash([8, 5]); ctx.lineWidth = 1.5;
      ctx.strokeRect(sx + 0.5, sy + 0.5, w - 1, h - 1); ctx.setLineDash([]);
      if (e.text) {
        ctx.fillStyle = e.color || '#a78bfa';
        ctx.font = `700 ${SF.clamp(z * 1.2, 10, 22)}px Inter, Segoe UI, sans-serif`;
        ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillText(e.text, sx + 6, sy + 5);
      }
      ctx.restore(); return;
    }
    if (d.kind === 'designer') {
      const fit = designerFit(e);
      ctx.fillStyle = 'rgba(245,158,11,0.04)'; ctx.fillRect(sx, sy, w, h);
      ctx.strokeStyle = fit.partial ? '#ef4444' : '#f59e0b'; ctx.lineWidth = 2; ctx.setLineDash([12, 6]);
      ctx.strokeRect(sx, sy, w, h); ctx.setLineDash([]);
      // 8m guide grid inside the designer
      ctx.strokeStyle = 'rgba(245,158,11,0.10)'; ctx.lineWidth = 1; ctx.beginPath();
      for (let x = 8; x < d.w; x += 8) { const X = sx + x * z; ctx.moveTo(X, sy); ctx.lineTo(X, sy + h); }
      for (let y = 8; y < d.h; y += 8) { const Y = sy + y * z; ctx.moveTo(sx, Y); ctx.lineTo(sx + w, Y); }
      ctx.stroke();
      ctx.fillStyle = fit.partial ? '#ef4444' : '#f59e0b';
      ctx.font = `700 ${SF.clamp(z * 1.1, 10, 18)}px Inter, Segoe UI, sans-serif`;
      ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
      ctx.fillText(`${d.name} · ${d.w}×${d.w} m${fit.partial ? ` · ${fit.partial} sticking out` : ''}${e.text ? ' · ' + e.text : ''}`, sx + 2, sy - 4);
      ctx.restore(); return;
    }

    if (d.kind === 'liftend') { drawLiftEnd(e, d, sx, sy, w, h, alpha); ctx.restore(); return; }
    if (['splitter', 'merger', 'pole'].includes(d.kind)) {
      drawAttachment(e, d, t, alpha, res);
      ctx.restore(); return;
    }

    // far zoomed out: a plain block in the category colour (status shown as an outline)
    if (Math.min(w, h) < 12) {
      ctx.fillStyle = d.virtual ? '#2a2342' : '#232933';
      ctx.fillRect(sx, sy, w, h);
      ctx.fillStyle = catCol; ctx.fillRect(sx, sy, w, Math.max(1, h * 0.18));
      const st = res && res.status;
      if (st && st !== 'ok' && ['machine', 'extractor', 'generator'].includes(d.kind)) { ctx.strokeStyle = STATUS_COLOR[st]; ctx.lineWidth = 1.5; ctx.strokeRect(sx + 0.5, sy + 0.5, w - 1, h - 1); }
      ctx.restore();
      return;
    }
    // body: dark glassy card with a soft category-tinted gradient
    const rad = Math.min(w, h) * 0.1;
    const small = Math.min(w, h) < 26;
    ctx.shadowColor = 'rgba(0,0,0,.55)'; ctx.shadowBlur = Math.min(18, z * 1.0); ctx.shadowOffsetY = Math.min(5, z * 0.25);
    const grad = ctx.createLinearGradient(sx, sy, sx, sy + h);
    grad.addColorStop(0, d.virtual ? '#211c33' : '#1c2129');
    grad.addColorStop(1, d.virtual ? '#17142a' : '#13161c');
    ctx.fillStyle = grad;
    rrect(ctx, sx, sy, w, h, rad); ctx.fill();
    ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
    ctx.save(); rrect(ctx, sx, sy, w, h, rad); ctx.clip();
    const glow = ctx.createRadialGradient(cx, sy, 0, cx, sy, Math.max(w, h) * 0.9);
    glow.addColorStop(0, catCol + '30'); glow.addColorStop(1, catCol + '00');
    ctx.fillStyle = glow; ctx.fillRect(sx, sy, w, h);
    ctx.fillStyle = catCol; ctx.globalAlpha = alpha * 0.85;
    ctx.fillRect(sx, sy, w, Math.max(2, Math.min(h * 0.06, z * 0.35)));
    ctx.restore();
    ctx.globalAlpha = alpha;
    const status = res && res.status;
    let border = 'rgba(255,255,255,.09)';
    if (status && status !== 'ok' && ['machine', 'extractor', 'generator'].includes(d.kind)) {
      border = STATUS_COLOR[status];
      if (status !== 'starved' && status !== 'throttled') ctx.globalAlpha = alpha * (0.6 + 0.4 * Math.sin(t * 4));
    }
    ctx.strokeStyle = border; ctx.lineWidth = Math.max(1, z * 0.1);
    rrect(ctx, sx + 0.5, sy + 0.5, w - 1, h - 1, rad); ctx.stroke();
    ctx.globalAlpha = alpha;

    // icon
    const eff = res ? res.eff : 0;
    const anim = S.settings.anim ? t : 0;
    const iconR = Math.min(w, h) * 0.22;
    const showText = !ghostPass && S.settings.labels && z * Math.min(d.w, d.h) > 40;
    const land = showText && w > h * 1.45;
    const iy = land || !showText ? cy : cy - Math.min(h * 0.07, iconR * 0.35);
    let S2 = 0, ix = cx;
    ctx.fillStyle = 'rgba(255,255,255,.10)';
    const im = !['splitter', 'merger', 'junction', 'source', 'vsink'].includes(d.kind) && SF.img(d.id);
    let drewIcon = false;
    const liveStore = d.kind === 'storage' && res && res.live && !ghostPass && w > 34 && h > 22;
    if (liveStore) { drawStorageContents(e, d, res, sx, sy, w, h, z); drewIcon = true; }
    else if (im && !small || (im && Math.min(w, h) > 18)) {
      drewIcon = true;
      S2 = land ? h * 0.7 : Math.min(w * 0.62, h * (showText ? 0.5 : 0.72));
      ix = land ? sx + Math.max(h * 0.14, 5) + S2 / 2 : cx;
      const running = ['machine', 'extractor', 'generator'].includes(d.kind) ? eff : 0;
      // activity ring: rotates while producing, arc length = efficiency
      if (['machine', 'extractor', 'generator', 'sink'].includes(d.kind) && S2 > 14) {
        const R = S2 * 0.58;
        ctx.lineWidth = Math.max(1.5, S2 * 0.035);
        ctx.strokeStyle = 'rgba(255,255,255,.06)';
        ctx.beginPath(); ctx.arc(ix, iy, R, 0, Math.PI * 2); ctx.stroke();
        const col = d.kind === 'sink' ? catCol : (STATUS_COLOR[status] || catCol);
        const busy = d.kind === 'sink' ? (res && Object.keys(res.ins).length ? 1 : 0) : running;
        if (busy > 0.001) {
          const a0 = anim * (1 + 2 * busy);
          ctx.strokeStyle = col; ctx.lineCap = 'round';
          ctx.shadowColor = col; ctx.shadowBlur = 8 * busy;
          ctx.beginPath(); ctx.arc(ix, iy, R, a0, a0 + Math.PI * 2 * Math.max(0.08, Math.min(busy, 0.999)) * 0.85); ctx.stroke();
          ctx.shadowBlur = 0; ctx.shadowColor = 'transparent'; ctx.lineCap = 'butt';
        }
      }
      if (d.kind === 'generator' && running > 0.01) {
        const pulse = 0.5 + 0.5 * Math.sin(anim * 4);
        const gg = ctx.createRadialGradient(ix, iy, 0, ix, iy, S2 * 0.7);
        gg.addColorStop(0, `rgba(250,204,21,${0.28 * running * (0.6 + 0.4 * pulse)})`); gg.addColorStop(1, 'rgba(250,204,21,0)');
        ctx.fillStyle = gg; ctx.fillRect(ix - S2, iy - S2, S2 * 2, S2 * 2);
      }
      const bob = d.kind === 'extractor' ? Math.sin(anim * 9) * S2 * 0.015 * running : 0;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(im, ix - S2 / 2, iy - S2 / 2 + bob, S2, S2);
      // product / resource badge
      const badge = d.kind === 'machine' ? (e.recipe && D.recipes[e.recipe] && D.recipes[e.recipe].out[0][0])
        : d.kind === 'extractor' ? e.resource : d.kind === 'generator' ? e.fuel : null;
      if (badge && S2 > 22) {
        const br = S2 * 0.2, bx = ix + S2 * 0.36, by = iy + S2 * 0.3;
        ctx.fillStyle = '#0d1014'; ctx.strokeStyle = 'rgba(255,255,255,.18)'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(bx, by, br * 1.15, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        SF.drawItemChip(ctx, badge, bx, by, br * 0.85, false);
      }
    }
    if (!drewIcon) switch (d.kind) {
      case 'machine': {
        ctx.fillStyle = shade(catCol, -0.45);
        gear(ctx, cx, iy, iconR, 10, anim * 1.2 * eff);
        ctx.fillStyle = shade(catCol, -0.25);
        gear(ctx, cx + iconR * 0.95, iy - iconR * 0.7, iconR * 0.5, 8, -anim * 2.4 * eff + 0.3);
        const r = e.recipe && D.recipes[e.recipe];
        if (r && iconR > 5) SF.drawItemChip(ctx, r.out[0][0], cx, iy, iconR * 0.55);
        break;
      }
      case 'extractor': {
        ctx.fillStyle = shade(catCol, -0.4);
        const bob = Math.sin(anim * 8 * (eff || 0)) * iconR * 0.08;
        ctx.beginPath(); ctx.moveTo(cx - iconR * 0.6, iy - iconR * 0.6 + bob); ctx.lineTo(cx + iconR * 0.6, iy - iconR * 0.6 + bob);
        ctx.lineTo(cx, iy + iconR + bob); ctx.closePath(); ctx.fill();
        if (e.resource && iconR > 5) SF.drawItemChip(ctx, e.resource, cx, iy - iconR * 0.15 + bob, iconR * 0.45);
        break;
      }
      case 'generator': {
        const glow = res ? res.eff : 0;
        ctx.fillStyle = `rgba(250,204,21,${0.25 + 0.6 * glow * (0.75 + 0.25 * Math.sin(anim * 5))})`;
        if (glow > 0.01) { ctx.shadowColor = '#facc15'; ctx.shadowBlur = iconR * glow; }
        bolt(ctx, cx, iy, iconR * 1.6); ctx.shadowBlur = 0; ctx.shadowColor = 'transparent';
        break;
      }
      case 'splitter': case 'merger': {
        const a = Math.min(w, h) * 0.32;
        ctx.strokeStyle = catCol; ctx.lineWidth = Math.max(1.2, z * 0.18); ctx.beginPath();
        const dir = (dx, dy) => SF.rot(dx, dy, e.rot);
        const [fx, fy] = dir(1, 0), [lx, ly] = dir(0, -1);
        if (d.kind === 'splitter') {
          ctx.moveTo(cx - fx * a, cy - fy * a); ctx.lineTo(cx, cy); ctx.lineTo(cx + fx * a, cy + fy * a);
          ctx.moveTo(cx, cy); ctx.lineTo(cx + lx * a, cy + ly * a); ctx.moveTo(cx, cy); ctx.lineTo(cx - lx * a, cy - ly * a);
        } else {
          ctx.moveTo(cx + lx * a, cy + ly * a); ctx.lineTo(cx, cy); ctx.lineTo(cx - lx * a, cy - ly * a);
          ctx.moveTo(cx - fx * a, cy - fy * a); ctx.lineTo(cx + fx * a, cy + fy * a);
        }
        ctx.stroke();
        if (d.raw.smart || d.raw.priority) { ctx.fillStyle = catCol; ctx.beginPath(); ctx.arc(cx, cy, a * 0.3, 0, 7); ctx.fill(); }
        break;
      }
      case 'junction': case 'pump': {
        ctx.fillStyle = '#60a5fa'; ctx.beginPath(); ctx.arc(cx, cy, Math.min(w, h) * 0.22, 0, 7); ctx.fill(); break;
      }
      case 'storage': {
        ctx.strokeStyle = catCol; ctx.lineWidth = Math.max(1, z * 0.15);
        ctx.strokeRect(cx - iconR, iy - iconR * 0.7, iconR * 2, iconR * 1.4);
        ctx.beginPath(); ctx.moveTo(cx - iconR, iy); ctx.lineTo(cx + iconR, iy); ctx.stroke();
        break;
      }
      case 'sink': {
        ctx.strokeStyle = catCol; ctx.lineWidth = Math.max(1.2, z * 0.2);
        const busy = res && Object.keys(res.ins).length ? 1 : 0.15;
        for (let k = 0; k < 3; k++) {
          ctx.beginPath(); ctx.arc(cx, iy, iconR * (0.4 + k * 0.3), anim * 2 * busy + k, anim * 2 * busy + k + 3.6); ctx.stroke();
        }
        break;
      }
      case 'source': case 'vsink': {
        const it = e.item;
        if (d.kind === 'source' && it) SF.drawItemChip(ctx, it, cx, cy, Math.min(w, h) * 0.3);
        else {
          ctx.strokeStyle = catCol; ctx.lineWidth = 2; ctx.beginPath();
          const a = Math.min(w, h) * 0.25;
          ctx.moveTo(cx - a, cy); ctx.lineTo(cx + a, cy); ctx.lineTo(cx + a * 0.4, cy - a * 0.6); ctx.moveTo(cx + a, cy); ctx.lineTo(cx + a * 0.4, cy + a * 0.6); ctx.stroke();
        }
        break;
      }
    }

    // text
    if (showText && !liveStore) {
      const fs = SF.clamp(z * 0.85, 8, 15);
      const sideText = land && drewIcon;
      const tx = sideText ? ix + S2 / 2 + Math.max(6, S2 * 0.14) : cx, tw = sideText ? sx + w - tx - 8 : w - 6;
      ctx.fillStyle = '#e8eaee'; ctx.textAlign = sideText ? 'left' : 'center'; ctx.textBaseline = sideText ? 'bottom' : 'top';
      ctx.font = `600 ${fs}px Inter, Segoe UI, sans-serif`;
      let title = d.name;
      if (d.kind === 'source' || d.kind === 'vsink') title = e.name || (d.kind === 'source' ? SF.itemName(e.item) : 'Output');
      fitText(title, tx, sideText ? cy - 1 : sy + Math.max(4, Math.min(h * 0.12, z * 0.7)) + 3, tw);
      ctx.textBaseline = sideText ? 'top' : 'bottom';
      ctx.font = `500 ${fs * 0.9}px Inter, Segoe UI, sans-serif`;
      ctx.fillStyle = '#9ca3af';
      let sub = '', subShort = '';
      if (d.kind === 'machine') {
        const r = e.recipe && D.recipes[e.recipe];
        if (r) {
          const mult = d.raw.sloops ? 1 + (e.sloops || 0) / d.raw.sloops : 1;
          const rate = r.out[0][1] * mult * 60 / r.time * (e.clock ?? 1);
          const act = res && res.outs[r.out[0][0]];
          subShort = `${res ? SF.fmt(act || 0, 1) + ' / ' : ''}${SF.fmt(rate, 1)}${SF.unit(r.out[0][0])} /min`;
          sub = `${r.name.replace(/^Alternate: /, '★ ')} · ${subShort}`;
        } else sub = 'No recipe';
      } else if (d.kind === 'extractor') {
        const rate = d.raw.rate * (d.raw.purity ? e.purity ?? 1 : 1) * (e.clock ?? 1);
        sub = `${d.raw.purity ? SF.PURITY.find(p => p.v === (e.purity ?? 1)).n + ' · ' : ''}${SF.fmt(rate, 1)}/m`;
      } else if (d.kind === 'generator') {
        sub = res ? `${SF.fmt(res.gen, 1)} / ${SF.fmt(res.maxGen || 0, 1)} MW` : (e.fuel ? SF.itemName(e.fuel) : '');
      } else if (d.kind === 'source') {
        sub = e.rate ? `${SF.fmt(e.rate, 1)}/m` : 'unlimited';
      } else if (d.kind === 'sink' && res && d.raw.awesome) {
        let pts = 0; for (const it in res.ins) pts += res.ins[it] * (SF.item(it).sink || 0);
        sub = `${SF.fmt(pts, 0)} pts/m`;
      } else if (res && (d.kind === 'vsink' || d.kind === 'sink' || d.kind === 'storage')) {
        const tot = Object.values(res.ins).reduce((a, b) => a + b, 0);
        if (tot) sub = `${SF.fmt(tot, 1)}/m in`;
      }
      if (subShort && ctx.measureText(sub).width > tw) sub = subShort;
      if (sub) fitText(sub, tx, sideText ? cy + 2 : sy + h - Math.max(5, h * 0.1), tw);
    }

    // clock / somersloop badges
    if (!ghostPass && z > 4 && (e.clock ?? 1) !== 1) {
      const txt = Math.round((e.clock ?? 1) * 1000) / 10 + '%';
      const fs = SF.clamp(z * 0.7, 8, 12);
      ctx.font = `700 ${fs}px Inter, sans-serif`;
      const tw = ctx.measureText(txt).width;
      ctx.fillStyle = (e.clock > 1) ? '#7c3aed' : '#334155';
      rrect(ctx, sx + w - tw - 8, sy + 3, tw + 6, fs + 4, 3); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillText(txt, sx + w - tw - 5, sy + 5);
    }
    if (e.sloops) {
      for (let k = 0; k < e.sloops; k++) {
        ctx.fillStyle = '#d946ef'; ctx.beginPath(); ctx.arc(sx + 6 + k * 8, sy + h - 6, Math.max(2.5, z * 0.25), 0, 7); ctx.fill();
      }
    }
    // efficiency bar
    if (res && ['machine', 'extractor', 'generator'].includes(d.kind) && z * d.w > 30) {
      const bw = w * 0.7, bh = Math.max(2, Math.min(5, z * 0.3));
      const bx = cx - bw / 2, by = sy + h - bh - Math.max(2, h * 0.03);
      ctx.fillStyle = 'rgba(0,0,0,.5)'; ctx.fillRect(bx, by, bw, bh);
      ctx.fillStyle = STATUS_COLOR[res.status] || '#22c55e'; ctx.fillRect(bx, by, bw * SF.clamp(res.eff, 0, 1), bh);
    }
    ctx.restore();
  }

  // Sim mode: the container's inventory drawn on the building, like the in-game slot grid
  function drawStorageContents(e, d, res, sx, sy, w, h, z) {
    const L = res.live, inv = Object.entries(L.inv || {}).filter(([, v]) => v > 1e-6);
    const pad = Math.max(3, Math.min(w, h) * 0.06);
    const fs = SF.clamp(z * 0.7, 7, 13);
    // header: container type on its own line; custom name + slots / fill % on the line below (when there is room)
    const twoLines = h > 64;
    const head = h > 44 ? (fs + 6) * (twoLines ? 2 : 1) : 0;
    if (head) {
      const pct = Math.round((L.fill || 0) * 100);
      const stats = `${L.capacity || ''} · ${pct}%`;
      const statCol = (L.fill || 0) >= 0.999 ? '#f87171' : '#9ca3af';
      ctx.textBaseline = 'top';
      if (twoLines) {
        ctx.font = `600 ${fs}px Inter, Segoe UI, sans-serif`; ctx.textAlign = 'left'; ctx.fillStyle = '#e8eaee';
        fitText(d.name, sx + pad, sy + pad, w - pad * 2);
        const y2 = sy + pad + fs + 5;
        ctx.font = `500 ${fs * 0.92}px Inter, Segoe UI, sans-serif`;
        ctx.textAlign = 'right'; ctx.fillStyle = statCol; ctx.fillText(stats, sx + w - pad, y2);
        const rw = ctx.measureText(stats).width;
        if (e.name) { ctx.textAlign = 'left'; ctx.fillStyle = '#9ca3af'; fitText(e.name, sx + pad, y2, w - pad * 3 - rw); }
      } else {
        ctx.font = `600 ${fs}px Inter, Segoe UI, sans-serif`;
        ctx.textAlign = 'right'; ctx.fillStyle = statCol; ctx.fillText(stats, sx + w - pad, sy + pad);
        const rw = ctx.measureText(stats).width;
        ctx.textAlign = 'left'; ctx.fillStyle = '#e8eaee';
        fitText(d.name, sx + pad, sy + pad, w - pad * 3 - rw);
      }
    }
    const gx = sx + pad, gy = sy + pad + head, gw = w - pad * 2, gh = h - pad * 2 - head;
    if (gw < 10 || gh < 6) return;
    if (d.raw.fluidStorage) {
      // tank: liquid level
      const cap = d.raw.capacity || 400, vol = inv.reduce((a, [, v]) => a + v, 0);
      const main = inv.sort((a, b) => b[1] - a[1])[0];
      ctx.fillStyle = 'rgba(0,0,0,.35)'; rrect(ctx, gx, gy, gw, gh, 4); ctx.fill();
      if (main) {
        const lh = gh * SF.clamp(vol / cap, 0, 1);
        ctx.fillStyle = SF.item(main[0]).color; ctx.globalAlpha *= 0.75;
        rrect(ctx, gx, gy + gh - lh, gw, lh, 4); ctx.fill(); ctx.globalAlpha /= 0.75;
        if (gh > 16) {
          ctx.fillStyle = '#fff'; ctx.font = `700 ${fs}px Inter, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.fillText(`${SF.fmt(vol, 0)} / ${SF.fmt(cap, 0)} m³`, gx + gw / 2, gy + gh / 2);
        }
      }
      return;
    }
    // slots, filled in order: full stacks then the partial one, per item
    const slots = d.raw.slots || 24, list = [];
    for (const [it, n] of inv) {
      const st = SF.item(it).stack || 100;
      let left = Math.round(n);
      while (left > 0 && list.length < slots) { const k = Math.min(st, left); list.push({ it, n: k, f: k / st }); left -= k; }
    }
    // grid shape that best fits the building
    let best = null;
    for (let rows = 1; rows <= slots; rows++) {
      const cols = Math.ceil(slots / rows), c = Math.min(gw / cols, gh / rows);
      if (!best || c > best.c) best = { rows, cols, c };
    }
    const { cols, c } = best, rows = Math.ceil(slots / cols);
    const ox = gx + (gw - cols * c) / 2, oy = gy + (gh - rows * c) / 2;
    const gap = c > 10 ? Math.max(1, c * 0.08) : c > 4 ? 1 : 0;
    for (let k = 0; k < slots; k++) {
      const x = ox + (k % cols) * c, y = oy + Math.floor(k / cols) * c, sz = c - gap;
      const sl = list[k];
      ctx.fillStyle = sl ? 'rgba(255,255,255,.07)' : 'rgba(0,0,0,.35)';
      if (sz > 6) { rrect(ctx, x, y, sz, sz, Math.min(3, sz * 0.15)); ctx.fill(); } else ctx.fillRect(x, y, sz, sz);
      if (!sl) continue;
      if (sz >= 12) {
        // icon, with a fill bar on the left edge for partial stacks
        SF.drawItemChip(ctx, sl.it, x + sz / 2, y + sz / 2, sz * 0.36, false);
        if (sl.f < 0.999) {
          ctx.fillStyle = 'rgba(0,0,0,.55)'; ctx.fillRect(x + 1, y + 1, Math.max(2, sz * 0.1), sz - 2);
          ctx.fillStyle = '#38bdf8'; const bh = (sz - 2) * sl.f; ctx.fillRect(x + 1, y + sz - 1 - bh, Math.max(2, sz * 0.1), bh);
        }
        if (sz >= 26) {
          ctx.font = `700 ${Math.round(sz * 0.26)}px Inter, sans-serif`; ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
          ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,.8)'; ctx.strokeText(sl.n, x + sz - 2, y + sz - 1);
          ctx.fillStyle = '#fff'; ctx.fillText(sl.n, x + sz - 2, y + sz - 1);
        }
      } else {
        // too small for icons: item colour, height = how full the stack is
        ctx.fillStyle = SF.item(sl.it).color;
        ctx.fillRect(x, y + sz * (1 - sl.f), sz, sz * sl.f);
      }
    }
    // full container: red outline
    if ((L.fill || 0) >= 0.999) { ctx.strokeStyle = '#ef4444'; ctx.lineWidth = 2; rrect(ctx, sx + 1, sy + 1, w - 2, h - 2, Math.min(w, h) * 0.1); ctx.stroke(); }
  }

  // conveyor lift end: a 2x2 m block with the direction and the other floor
  function drawLiftEnd(e, d, sx, sy, w, h, alpha) {
    const info = SF.liftOf(e), z = view.zoom;
    const isBottom = d.end === 'bottom';
    const up = info ? info.up : true;
    const r = Math.min(w, h) * 0.18;
    ctx.globalAlpha = alpha;
    ctx.fillStyle = '#1b2230'; ctx.strokeStyle = '#f59e0b'; ctx.lineWidth = Math.max(1.5, z * 0.12);
    rrect(ctx, sx, sy, w, h, r); ctx.fill(); ctx.stroke();
    // arrow: items leave this floor (bottom of an up lift, top of a down lift) or arrive on it
    const leaving = isBottom ? up : !up;
    const cx = sx + w / 2, cy = sy + h / 2, a = Math.min(w, h) * 0.28;
    ctx.fillStyle = leaving ? '#fbbf24' : '#38bdf8';
    ctx.beginPath();
    const dirUp = isBottom ? 1 : -1;                // the other end is above (bottom) or below (top)
    ctx.moveTo(cx, cy - a * dirUp); ctx.lineTo(cx + a * 0.8, cy + a * 0.5 * dirUp); ctx.lineTo(cx - a * 0.8, cy + a * 0.5 * dirUp); ctx.closePath();
    ctx.fill();
    if (z > 7 && S.settings.labels && !ghostPass && info) {
      const other = isBottom ? info.top : info.bottom;
      const fs = SF.clamp(z * 0.6, 8, 12);
      ctx.font = `600 ${fs}px Inter, Segoe UI, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      ctx.fillStyle = '#e5e7eb';
      ctx.fillText(`Lift ${up ? '▲' : '▼'} ${SF.fmt(Math.abs(info.height), 0)} m → ${S.levels[other.level] ? S.levels[other.level].name : ''}`, cx, sy + h + 3);
    }
  }

  function fitText(s, x, y, maxW) {
    if (ctx.measureText(s).width <= maxW) { ctx.fillText(s, x, y); return; }
    let lo = 0, hi = s.length;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (ctx.measureText(s.slice(0, m) + '…').width <= maxW) lo = m; else hi = m - 1; }
    if (lo > 0) ctx.fillText(s.slice(0, lo) + '…', x, y);
  }

  function designerFit(e) {
    const r = SF.entRect(e);
    let inside = 0, partial = 0;
    for (const o of S.entities.values()) {
      if (o === e || o.level !== e.level) continue;
      const od = SF.defs[o.def];
      if (od.kind === 'designer' || od.kind === 'zone' || od.kind === 'label') continue;
      const q = SF.entRect(o);
      const overlap = q.x0 < r.x1 && q.x1 > r.x0 && q.y0 < r.y1 && q.y1 > r.y0;
      if (!overlap) continue;
      if (q.x0 >= r.x0 - 1e-6 && q.x1 <= r.x1 + 1e-6 && q.y0 >= r.y0 - 1e-6 && q.y1 <= r.y1 + 1e-6) inside++; else partial++;
    }
    return { inside, partial };
  }
  SF.designerFit = designerFit;

  // ------------------------------------------------------------ ports
  function drawPorts(e, d, highlightFor) {
    const z = view.zoom;
    if (z < 3) return;
    d.ports.forEach((p, i) => {
      if (p.internal) return;                          // a lift's vertical connector
      const P = SF.portWorld(e, i);
      const [x, y] = SF.w2s(P.x, P.y);
      const connected = S.portLinks.has(SF.portKey(e.id, i));
      // connected ports are obvious from their belt: only show them while drawing belts
      if (connected && !highlightFor && (SF.ed || {}).tool !== 'link') return;
      const s = Math.max(4, z * 0.55);
      // open output that is spilling items: pulse a ring so it is obvious where things go
      const nres = !connected && p.io !== 'in' && SF.sim.result && SF.sim.result.nodes.get(e.id);
      if (nres && nres.voided && Object.values(nres.voided).some(v => v > 1e-3)) {
        const ph = (performance.now() / 900) % 1;
        ctx.strokeStyle = `rgba(251,146,60,${1 - ph})`; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(x, y, s * (1.2 + ph * 1.6), 0, 7); ctx.stroke();
      }
      let col = p.fluid ? '#38bdf8' : '#f59e0b';
      let a = connected ? 0.55 : 1;
      if (highlightFor) {
        const ok = !SF.canConnect(highlightFor, [e.id, i]).error;
        if (ok) { a = 1; ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.globalAlpha = 0.5 + 0.5 * Math.sin(performance.now() / 150); ctx.beginPath(); ctx.arc(x, y, s * 1.6, 0, 7); ctx.stroke(); }
        else a = 0.25;
      }
      ctx.globalAlpha = a;
      ctx.fillStyle = '#0f1115'; ctx.strokeStyle = col; ctx.lineWidth = Math.max(1, z * 0.1);
      ctx.beginPath(); ctx.arc(x, y, s, 0, 7); ctx.fill(); ctx.stroke();
      // arrow: inputs point inward, outputs outward
      const dir = p.io === 'in' ? -1 : 1;
      const ux = P.dx * dir, uy = P.dy * dir;
      ctx.fillStyle = col; ctx.beginPath();
      if (p.io === 'any') ctx.arc(x, y, s * 0.4, 0, 7);
      else {
        ctx.moveTo(x + ux * s * 0.6, y + uy * s * 0.6);
        ctx.lineTo(x - ux * s * 0.4 - uy * s * 0.5, y - uy * s * 0.4 + ux * s * 0.5);
        ctx.lineTo(x - ux * s * 0.4 + uy * s * 0.5, y - uy * s * 0.4 - ux * s * 0.5);
      }
      ctx.fill();
      ctx.globalAlpha = 1;
    });
  }

  // ------------------------------------------------------------ frame
  SF.dirty = true;
  SF.render = (t) => {
    if (!ctx) return;
    ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
    const bgG = ctx.createRadialGradient(view.W * 0.5, view.H * 0.35, 0, view.W * 0.5, view.H * 0.35, Math.max(view.W, view.H) * 0.8);
    bgG.addColorStop(0, '#11141a'); bgG.addColorStop(1, '#090a0d');
    ctx.fillStyle = bgG; ctx.fillRect(0, 0, view.W, view.H);
    if (S.settings.grid) drawGrid();

    const [vx0, vy0] = SF.s2w(-50, -50), [vx1, vy1] = SF.s2w(view.W + 50, view.H + 50);
    const visible = e => { const r = SF.entRect(e); return r.x1 >= vx0 && r.x0 <= vx1 && r.y1 >= vy0 && r.y0 <= vy1; };
    const ed = SF.ed || {};
    const sel = SF.sel || { ents: new Set(), links: new Set() };

    const ents = [...S.entities.values()];
    const order = { zone: 0, foundation: 1, ramp: 1, wall: 2, designer: 3 };
    const lodPaths = new Map();
    const drawLevel = (L, alpha) => {
      const here = ents.filter(e => e.level === L && visible(e) && !SF.structureHidden(e));
      const back = here.filter(e => order[SF.defs[e.def].kind] !== undefined)
        .sort((a, b) => order[SF.defs[a.def].kind] - order[SF.defs[b.def].kind]);
      for (const e of back) {
        const d = SF.defs[e.def];
        if (d.structure) { ctx.save(); ctx.globalAlpha = alpha; drawStructure(e, d); ctx.restore(); }
        else drawBuilding(e, d, t, alpha);
      }
      for (const l of S.links.values()) {
        const ea = S.entities.get(l.from[0]), eb = S.entities.get(l.to[0]);
        if (!ea || !eb) continue;
        const lv = L === S.level ? (ea.level === L || eb.level === L) : (ea.level === L && eb.level === L);
        if (!lv) continue;
        if (l.kind === 'lift') continue;
        const P = linkScreenPath(l), bb = P.bb;                 // off screen: skip
        if (bb[2] < vx0 || bb[0] > vx1 || bb[3] < vy0 || bb[1] > vy1) continue;
        // far zoomed out: one path per colour for all belts instead of one stroke each
        if (view.zoom < 3 && !sel.links.has(l.id) && P.pts.length > 1) {
          const res = SF.sim.result && SF.sim.result.edges.get(l.id);
          const col = (l.kind === 'pipe' ? (PIPE_TIER[l.tier] || '#60a5fa') : (TIER_COLORS[l.tier] || '#999')) + (res && res.total > 0.01 ? '' : '|dim');
          let path = lodPaths.get(col);
          if (!path) lodPaths.set(col, path = new Path2D());
          const z = view.zoom, hw = view.W / 2, hh = view.H / 2;
          P.pts.forEach((p, i) => { const x = (p[0] - view.cx) * z + hw, y = (p[1] - view.cy) * z + hh; i ? path.lineTo(x, y) : path.moveTo(x, y); });
          continue;
        }
        drawLink(l, t, alpha, !ghostPass && sel.links.has(l.id));
      }
      if (lodPaths.size) {
        ctx.save(); ctx.lineWidth = Math.max(1, view.zoom * 1.2);
        for (const [col, path] of lodPaths) {
          const [c, dim] = col.split('|');
          ctx.strokeStyle = c; ctx.globalAlpha = alpha * (dim ? 0.5 : 0.95);
          ctx.stroke(path);
        }
        ctx.restore();
        lodPaths.clear();
      }
      for (const e of here) {
        const d = SF.defs[e.def];
        if (order[d.kind] !== undefined) continue;
        drawBuilding(e, d, t, alpha);
      }
      if (L === S.level && !ghostPass) {
        const hl = ed.link && ed.link.start;
        for (const e of here) {
          const d = SF.defs[e.def];
          if (d.ports.length && (view.zoom > 5 || hl || ed.tool === 'link')) drawPorts(e, d, hl);
        }
      }
    };

    // other floors: drawn to an offscreen layer without labels/animation, then composited
    // faded and desaturated so they read as background
    {
      // other floors whose eye is on, faded behind the current one (floors above even fainter)
      const below = [], above = [];
      for (let L = 0; L < S.levels.length; L++) if (L !== S.level && SF.levelVisible(L)) (L < S.level ? below : above).push(L);
      const op = S.settings.ghostOpacity ?? 0.3;
      const pass = (levels, opacity, filter) => {
        if (!levels.length || opacity <= 0) return;
        if (!ghostCv) ghostCv = document.createElement('canvas');
        if (ghostCv.width !== cv.width || ghostCv.height !== cv.height) { ghostCv.width = cv.width; ghostCv.height = cv.height; }
        const g = ghostCv.getContext('2d');
        g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, ghostCv.width, ghostCv.height);
        g.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
        const main = ctx;
        ctx = g; ghostPass = true;
        try { levels.forEach(L => drawLevel(L, 1)); }
        finally { ctx = main; ghostPass = false; }
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalAlpha = opacity; ctx.filter = filter;
        ctx.drawImage(ghostCv, 0, 0);
        ctx.restore();
      };
      pass(below, op, 'grayscale(0.85) brightness(0.8)');
      pass(above, op * 0.5, 'grayscale(1) brightness(0.7) blur(1px)');
    }
    drawLevel(S.level, 1);

    // selection outlines
    ctx.lineWidth = 2; ctx.strokeStyle = '#38bdf8';
    for (const id of sel.ents) {
      const e = S.entities.get(id); if (!e) continue;
      const r = SF.entRect(e);
      const [x0, y0] = SF.w2s(r.x0, r.y0), [x1, y1] = SF.w2s(r.x1, r.y1);
      ctx.setLineDash([]); ctx.strokeStyle = e.level === S.level ? '#38bdf8' : 'rgba(56,189,248,.4)';
      rrect(ctx, x0 - 3, y0 - 3, x1 - x0 + 6, y1 - y0 + 6, 5); ctx.stroke();
    }
    // waypoint handles on selected links
    for (const id of sel.links) {
      const l = S.links.get(id); if (!l) continue;
      for (const p of l.pts || []) {
        const [x, y] = SF.w2s(p[0], p[1]);
        ctx.fillStyle = '#0f1115'; ctx.strokeStyle = '#38bdf8'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.rect(x - 5, y - 5, 10, 10); ctx.fill(); ctx.stroke();
      }
    }
    // hover outline
    if (SF.hover && SF.hover.ent && !sel.ents.has(SF.hover.ent)) {
      const e = S.entities.get(SF.hover.ent);
      if (e) {
        const r = SF.entRect(e);
        const [x0, y0] = SF.w2s(r.x0, r.y0), [x1, y1] = SF.w2s(r.x1, r.y1);
        ctx.strokeStyle = ed.tool === 'delete' ? 'rgba(239,68,68,.8)' : 'rgba(255,255,255,.35)'; ctx.lineWidth = 1.5;
        rrect(ctx, x0 - 2, y0 - 2, x1 - x0 + 4, y1 - y0 + 4, 4); ctx.stroke();
      }
    }

    // editor overlays
    if (SF.drawOverlays) SF.drawOverlays(ctx, t);
  };

  // exposed so the editor can draw ghosts using the same code
  SF.drawEntityGhost = (e, ok, t) => {
    const d = SF.defs[e.def];
    ctx.save();
    if (d.structure) { ctx.globalAlpha = 0.6; drawStructure(e, d); }
    else drawBuilding(e, d, t, 0.6);
    ctx.restore();
    const r = SF.entRect(e);
    const [x0, y0] = SF.w2s(r.x0, r.y0), [x1, y1] = SF.w2s(r.x1, r.y1);
    ctx.strokeStyle = ok ? 'rgba(34,197,94,.9)' : 'rgba(239,68,68,.9)'; ctx.lineWidth = 2;
    ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
    if (!d.structure && d.ports.length) {
      d.ports.forEach((p, i) => {
        const P = SF.portWorld(e, i);
        const [x, y] = SF.w2s(P.x, P.y);
        ctx.fillStyle = p.fluid ? '#38bdf8' : '#f59e0b';
        ctx.beginPath(); ctx.arc(x, y, Math.max(3, view.zoom * 0.4), 0, 7); ctx.fill();
      });
    }
  };
  SF.drawLinkGhost = (pts, kind, ok) => {
    if (pts.length < 2) return;
    const spts = pts.map(p => SF.w2s(p[0], p[1]));
    ctx.save();
    ctx.lineJoin = 'round';
    ctx.strokeStyle = ok ? (kind === 'pipe' ? 'rgba(56,189,248,.8)' : 'rgba(245,158,11,.8)') : 'rgba(239,68,68,.8)';
    ctx.lineWidth = Math.max(3, view.zoom * (kind === 'pipe' ? 1.0 : 1.6));
    ctx.setLineDash([10, 6]); ctx.lineDashOffset = -performance.now() / 40;
    polyPath(ctx, spts, 0); ctx.stroke();
    ctx.restore();
  };

  // render the whole plan (current level) to a PNG data URL
  SF.exportPNG = () => {
    const ents = [...S.entities.values()].filter(e => SF.levelVisible(e.level) && !SF.structureHidden(e));
    if (!ents.length) return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const e of ents) { const r = SF.entRect(e); x0 = Math.min(x0, r.x0); y0 = Math.min(y0, r.y0); x1 = Math.max(x1, r.x1); y1 = Math.max(y1, r.y1); }
    const pad = 6;
    const zoom = Math.min(20, 8000 / (x1 - x0 + pad * 2), 8000 / (y1 - y0 + pad * 2));
    const saved = { cv, ctx, view: { ...view }, sel: SF.sel, hover: SF.hover, ov: SF.drawOverlays };
    const off = document.createElement('canvas');
    off.width = Math.ceil((x1 - x0 + pad * 2) * zoom); off.height = Math.ceil((y1 - y0 + pad * 2) * zoom);
    cv = off; ctx = off.getContext('2d');
    Object.assign(view, { W: off.width, H: off.height, dpr: 1, zoom, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 });
    SF.sel = { ents: new Set(), links: new Set() }; SF.hover = null; SF.drawOverlays = null;
    try { SF.render(performance.now() / 1000); }
    finally {
      cv = saved.cv; ctx = saved.ctx; Object.assign(view, saved.view);
      SF.sel = saved.sel; SF.hover = saved.hover; SF.drawOverlays = saved.ov;
    }
    return off.toDataURL('image/png');
  };

  // ------------------------------------------------------------ minimap
  SF.renderMinimap = (mc) => {
    const c = mc.getContext('2d');
    const W = mc.width, H = mc.height;
    c.clearRect(0, 0, W, H); c.fillStyle = 'rgba(12,14,18,.55)'; c.fillRect(0, 0, W, H);
    const ents = [...S.entities.values()].filter(e => e.level === S.level || SF.defs[e.def].structure);
    let x0 = -32, y0 = -32, x1 = 32, y1 = 32;
    for (const e of S.entities.values()) {
      const r = SF.entRect(e); x0 = Math.min(x0, r.x0); y0 = Math.min(y0, r.y0); x1 = Math.max(x1, r.x1); y1 = Math.max(y1, r.y1);
    }
    const [vx0, vy0] = SF.s2w(0, 0), [vx1, vy1] = SF.s2w(view.W, view.H);
    x0 = Math.min(x0, vx0); y0 = Math.min(y0, vy0); x1 = Math.max(x1, vx1); y1 = Math.max(y1, vy1);
    const pad = 8;
    const sc = Math.min((W - pad * 2) / (x1 - x0), (H - pad * 2) / (y1 - y0));
    const ox = pad + ((W - pad * 2) - (x1 - x0) * sc) / 2 - x0 * sc, oy = pad + ((H - pad * 2) - (y1 - y0) * sc) / 2 - y0 * sc;
    for (const e of ents) {
      const d = SF.defs[e.def];
      if (d.kind === 'label') continue;
      const r = SF.entRect(e);
      c.globalAlpha = e.level === S.level ? 1 : 0.35;
      c.fillStyle = d.structure ? d.color : d.kind === 'designer' || d.kind === 'zone' ? 'rgba(245,158,11,.15)' : (SF.CAT_COLOR[d.cat] || '#888');
      c.fillRect(ox + r.x0 * sc, oy + r.y0 * sc, Math.max(1, (r.x1 - r.x0) * sc), Math.max(1, (r.y1 - r.y0) * sc));
    }
    c.globalAlpha = 1;
    c.strokeStyle = '#f5a524'; c.lineWidth = 1.5;
    c.strokeRect(ox + vx0 * sc, oy + vy0 * sc, (vx1 - vx0) * sc, (vy1 - vy0) * sc);
    mc._map = { sc, ox, oy };
  };
})(window.SF);
