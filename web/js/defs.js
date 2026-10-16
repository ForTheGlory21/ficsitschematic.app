// Shared helpers + normalised building definitions with port layouts.
window.SF = window.SF || {};
(function (SF) {
  const D = window.SF_DATA;
  SF.D = D;

  // ------------------------------------------------------------ helpers
  SF.uid = () => Math.random().toString(36).slice(2, 10);
  SF.clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  SF.fmt = (n, d = 2) => {
    if (n == null || !isFinite(n)) return '–';
    const a = Math.abs(n);
    if (a >= 10000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
    const s = n.toFixed(a >= 100 ? Math.min(d, 1) : d);
    return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
  };
  SF.esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  SF.item = cls => D.items[cls] || { name: cls || '?', color: '#888', fluid: false };
  SF.itemName = cls => SF.item(cls).name;
  SF.itemAbbr = cls => {
    const w = SF.itemName(cls).replace(/[^A-Za-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
    if (w.length === 1) return w[0].slice(0, 2);
    return (w[0][0] + w[1][0] + (w[2] ? w[2][0] : '')).slice(0, 3);
  };
  SF.unit = cls => (SF.item(cls).fluid ? 'm³' : '');
  // rotate a local vector by rot*90° clockwise (screen coordinates, y down)
  SF.rot = (x, y, r) => {
    switch (((r % 4) + 4) % 4) {
      case 1: return [-y, x];
      case 2: return [-x, -y];
      case 3: return [y, -x];
      default: return [x, y];
    }
  };

  // ------------------------------------------------------------ definitions
  const CAT_COLOR = {
    Production: '#f59e0b', Extraction: '#d97706', Power: '#facc15', Logistics: '#94a3b8',
    Storage: '#38bdf8', Schematic: '#a78bfa', Structures: '#a8a29e',
  };
  SF.CAT_COLOR = CAT_COLOR;
  const defs = {};
  SF.defs = defs;

  // distribute n ports on one side; side: 'L','R','T','B'
  function side(list, sideName, w, h, specs) {
    const n = specs.length;
    specs.forEach((sp, i) => {
      const t = (i + 1) / (n + 1);
      let x, y, dx, dy;
      if (sideName === 'L' || sideName === 'R') {
        y = Math.round((-h / 2 + h * t) * 2) / 2; x = sideName === 'L' ? -w / 2 : w / 2;
        dx = sideName === 'L' ? -1 : 1; dy = 0;
      } else {
        x = Math.round((-w / 2 + w * t) * 2) / 2; y = sideName === 'T' ? -h / 2 : h / 2;
        dx = 0; dy = sideName === 'T' ? -1 : 1;
      }
      list.push({ x, y, dx, dy, io: sp.io, fluid: sp.fluid, label: sp.label || '' });
    });
  }
  const rep = (n, o) => Array.from({ length: n }, () => ({ ...o }));

  function machinePorts(w, h, p) {
    const ports = [];
    side(ports, 'L', w, h, [...rep(p.inS || 0, { io: 'in', fluid: false }), ...rep(p.inF || 0, { io: 'in', fluid: true })]);
    side(ports, 'R', w, h, [...rep(p.outS || 0, { io: 'out', fluid: false }), ...rep(p.outF || 0, { io: 'out', fluid: true })]);
    return ports;
  }

  for (const [id, b] of Object.entries(D.buildings)) {
    const d = { id, name: b.name, cat: b.cat, kind: b.kind, w: b.w, h: b.h, raw: b, ports: [] };
    switch (b.kind) {
      case 'machine':
      case 'storage':
        d.ports = machinePorts(d.w, d.h, b.ports); break;
      case 'extractor':
        d.ports = machinePorts(d.w, d.h, b.fluidOut ? { outF: 1 } : { outS: 1 }); break;
      case 'generator': {
        const anySolid = b.fuels.some(f => !SF.item(f.fuel).fluid);
        const anyFluid = b.fuels.some(f => SF.item(f.fuel).fluid || f.supp);
        const anyBy = b.fuels.some(f => f.by);
        d.ports = machinePorts(d.w, d.h, { inS: anySolid ? 1 : 0, inF: anyFluid ? 1 : 0, outS: anyBy ? 1 : 0 });
        break;
      }
      case 'splitter':
        // real in-game size is 4 x 4 m, connectors on each face
        d.w = d.h = 4;
        d.ports = [{ x: -2, y: 0, dx: -1, dy: 0, io: 'in', fluid: false, label: 'In' },
          { x: 0, y: -2, dx: 0, dy: -1, io: 'out', fluid: false, label: 'Left' },
          { x: 2, y: 0, dx: 1, dy: 0, io: 'out', fluid: false, label: 'Center' },
          { x: 0, y: 2, dx: 0, dy: 1, io: 'out', fluid: false, label: 'Right' }];
        break;
      case 'merger':
        d.w = d.h = 4;
        d.ports = [{ x: 0, y: -2, dx: 0, dy: -1, io: 'in', fluid: false, label: 'Left' },
          { x: -2, y: 0, dx: -1, dy: 0, io: 'in', fluid: false, label: 'Center' },
          { x: 0, y: 2, dx: 0, dy: 1, io: 'in', fluid: false, label: 'Right' },
          { x: 2, y: 0, dx: 1, dy: 0, io: 'out', fluid: false, label: 'Out' }];
        break;
      case 'junction':
        d.w = d.h = 2;
        d.ports = [{ x: -1, y: 0, dx: -1, dy: 0 }, { x: 1, y: 0, dx: 1, dy: 0 }, { x: 0, y: 1, dx: 0, dy: 1 }, { x: 0, y: -1, dx: 0, dy: -1 }]
          .slice(0, b.ports).map(p => ({ ...p, io: 'any', fluid: true, label: '' }));
        break;
      case 'pump':
        d.w = Math.max(d.w, 2); d.h = Math.max(d.h, 1);
        if (d.w < d.h) [d.w, d.h] = [d.h, d.w];
        d.ports = machinePorts(d.w, d.h, { inF: 1, outF: 1 });
        break;
      case 'sink':
        d.ports = machinePorts(d.w, d.h, { inS: b.awesome || b.upload ? 1 : 3 });
        break;
      default:
        d.ports = [];
    }
    defs[id] = d;
  }

  // move belt/pipe ports in from the footprint edge to where the 3D model actually is at belt height,
  // so belts physically touch the building (profiles come from tools/convert_models.py)
  const CENTER_ON_MESH = new Set(['Build_HadronCollider_C', 'Build_QuantumEncoder_C', 'Build_SpaceElevator_C']);
  const MAX_INSET = 2.5;
  for (const d of Object.values(defs)) {
    const M = (window.SF_MODELS || {})[d.id];
    if (!M || !M.p || !['machine', 'extractor', 'generator', 'storage', 'sink'].includes(d.kind)) continue;
    const b = M.b, prof = M.p;
    const off = CENTER_ON_MESH.has(d.id) || !d.raw ? [(b[0] + b[3]) / 2, (b[2] + b[5]) / 2] : [d.raw.ox || 0, d.raw.oy || 0];
    for (const port of d.ports) {
      if (port.dy !== 0 || port.dx === 0) continue;               // only ports on the left/right faces
      const side = port.dx > 0 ? prof.R : prof.L;
      const zm = port.y + off[1];                                // port position in model space
      let edge = null;
      for (let z = zm - 0.75; z <= zm + 0.75; z += 0.25) {        // the belt is ~1.5 m wide
        const v = side[Math.floor((z - prof.z0) / prof.step)];
        if (v == null) continue;
        edge = edge == null ? v : (port.dx > 0 ? Math.max(edge, v) : Math.min(edge, v));
      }
      if (edge == null) continue;
      // tuck the belt a little into the connector so no seam shows
      const TUCK = 0.25;
      const local = Math.round((edge - off[0] - Math.sign(port.dx) * TUCK) * 10) / 10;
      port.x = port.dx > 0 ? SF.clamp(local, port.x - MAX_INSET, port.x) : SF.clamp(local, port.x, port.x + MAX_INSET);
    }
  }

  // In 3D some buildings have their connectors stacked instead of side by side. The Industrial Storage Container is
  // two containers on top of each other: each end has one centred socket at ground level and one 4 m up.
  // 2D keeps them side by side (readable); y3 / h3 are the 3D-only lateral offset and height.
  const STACKED = { Build_StorageContainerMk2_C: 4 };
  for (const [id, dz] of Object.entries(STACKED)) {
    const d = defs[id]; if (!d) continue;
    for (const io of ['in', 'out']) {
      d.ports.filter(p => p.io === io).sort((a, b) => a.y - b.y).forEach((p, k) => { p.y3 = 0; p.h3 = 1 + k * dz; });
    }
  }

  // conveyor poles / pipe supports: free-angle pass-through supports placed while drawing belts
  defs.Pole = { id: 'Pole', name: 'Conveyor Pole', cat: 'Logistics', kind: 'pole', w: 1, h: 1, raw: { cost: [] },
    // both connectors sit at the pole centre (like in game) so consecutive belts meet without a gap
    ports: [{ x: 0, y: 0, dx: -1, dy: 0, io: 'in', fluid: false, label: 'In' }, { x: 0, y: 0, dx: 1, dy: 0, io: 'out', fluid: false, label: 'Out' }] };
  defs.PipePole = { id: 'PipePole', name: 'Pipeline Support', cat: 'Logistics', kind: 'pole', w: 1, h: 1, raw: { cost: [] },
    ports: [{ x: 0, y: 0, dx: -1, dy: 0, io: 'in', fluid: true, label: 'In' }, { x: 0, y: 0, dx: 1, dy: 0, io: 'out', fluid: true, label: 'Out' }] };

  // Conveyor Lift (like the game): a bottom on one floor and a top on a floor above, joined by a vertical 'lift'
  // link. Each end has one belt connector (either direction: the lift runs up or down depending on how belts
  // are connected) and a hidden internal connector for the vertical part.
  const LIFT_COST = (D.buildings.Build_ConveyorLiftMk1_C || {}).cost || [];
  defs.LiftBottom = { id: 'LiftBottom', name: 'Conveyor Lift', cat: 'Logistics', kind: 'liftend', w: 2, h: 2, raw: { cost: LIFT_COST }, end: 'bottom',
    ports: [{ x: -1, y: 0, dx: -1, dy: 0, io: 'any', fluid: false, label: 'Belt' }, { x: 0, y: 0, dx: 1, dy: 0, io: 'any', fluid: false, label: 'Lift', internal: true }] };
  defs.LiftTop = { id: 'LiftTop', name: 'Conveyor Lift (top)', cat: 'Logistics', kind: 'liftend', w: 2, h: 2, raw: { cost: [] }, end: 'top', hidden: true,
    ports: [{ x: 0, y: 0, dx: -1, dy: 0, io: 'any', fluid: false, label: 'Lift', internal: true }, { x: 1, y: 0, dx: 1, dy: 0, io: 'any', fluid: false, label: 'Belt' }] };

  // virtual schematic nodes
  defs.V_Source = { id: 'V_Source', name: 'Input (external)', cat: 'Schematic', kind: 'source', w: 3, h: 3, virtual: true,
    ports: [{ x: 1.5, y: 0, dx: 1, dy: 0, io: 'out', fluid: false, label: 'Out' }] };
  defs.V_SourceF = { id: 'V_SourceF', name: 'Fluid Input (external)', cat: 'Schematic', kind: 'source', w: 3, h: 3, virtual: true,
    ports: [{ x: 1.5, y: 0, dx: 1, dy: 0, io: 'out', fluid: true, label: 'Out' }] };
  defs.V_Sink = { id: 'V_Sink', name: 'Output (external)', cat: 'Schematic', kind: 'vsink', w: 3, h: 3, virtual: true,
    ports: [{ x: -1.5, y: 0, dx: -1, dy: 0, io: 'in', fluid: false, label: 'In' }] };
  defs.V_SinkF = { id: 'V_SinkF', name: 'Fluid Output (external)', cat: 'Schematic', kind: 'vsink', w: 3, h: 3, virtual: true,
    ports: [{ x: -1.5, y: 0, dx: -1, dy: 0, io: 'in', fluid: true, label: 'In' }] };
  defs.V_Label = { id: 'V_Label', name: 'Text Label', cat: 'Schematic', kind: 'label', w: 8, h: 2, virtual: true, ports: [] };
  defs.V_Zone = { id: 'V_Zone', name: 'Zone / Area', cat: 'Schematic', kind: 'zone', w: 16, h: 16, virtual: true, ports: [], resizable: true };

  // structures
  for (const s of D.structures) {
    defs[s.id] = { id: s.id, name: s.name, cat: 'Structures', kind: s.kind, structure: true, mat: s.mat, color: s.color,
      w: s.w, h: s.kind === 'wall' ? 0.5 : s.h, ports: [], raw: s };
  }

  SF.defW = (d, e) => (e && d.resizable && e.w) || d.w;
  SF.defH = (d, e) => (e && d.resizable && e.h) || d.h;

  // palette organisation
  SF.paletteGroups = () => {
    const g = { Production: [], Extraction: [], Power: [], Logistics: [], Storage: [], Schematic: [], Foundations: [], Ramps: [], Walls: [], Blueprints: [] };
    for (const d of Object.values(defs)) {
      if (d.hidden) continue;
      if (d.structure) {
        (d.kind === 'foundation' ? g.Foundations : d.kind === 'ramp' ? g.Ramps : g.Walls).push(d);
      } else if (d.kind === 'designer') g.Schematic.push(d);
      else (g[d.cat] || (g[d.cat] = [])).push(d);
    }
    return g;
  };

  // recipes per machine
  SF.recipesFor = machineId => Object.entries(D.recipes).filter(([, r]) => r.machine === machineId)
    .map(([id, r]) => ({ id, ...r })).sort((a, b) => (a.event - b.event) || (a.alt - b.alt) || a.name.localeCompare(b.name));

  SF.recipeLabel = r => r.name + (r.event ? ' (event)' : '');

  // building power at a given clock
  SF.machinePower = (e, d) => {
    const b = d.raw;
    if (!b) return 0;
    const clock = e.clock ?? 1;
    let base = b.power;
    if (b.variablePower) {
      const r = D.recipes[e.recipe];
      base = r ? r.pc + r.pf / 2 : (b.powerMin + b.powerMax) / 2;
    }
    const mult = b.sloops ? 1 + (e.sloops || 0) / b.sloops : 1;
    return base * Math.pow(clock, b.powerExp || 1.321929) * mult * mult;
  };

  SF.shardsFor = clock => (clock > 1 ? Math.ceil((clock - 1) / 0.5 - 1e-9) : 0);
  SF.PURITY = [{ v: 0.5, n: 'Impure' }, { v: 1, n: 'Normal' }, { v: 2, n: 'Pure' }];
})(window.SF);

// ------------------------------------------------------------ icons (scraped from the wiki, see tools/scrape_icons.py)
(function (SF) {
  const ICONS = window.SF_ICONS || {};
  const D = SF.D;
  // structures without their own icon borrow one from a sibling of the same material/kind
  SF.iconPath = (key) => {
    if (ICONS[key]) return ICONS[key];
    const s = D.structures.find(x => x.id === key);
    if (s) {
      const sib = D.structures.find(x => x.mat === s.mat && x.kind === s.kind && ICONS[x.id])
        || D.structures.find(x => x.kind === s.kind && ICONS[x.id]);
      if (sib) return ICONS[sib.id];
    }
    if (key === 'V_SourceF' || key === 'V_SinkF') return ICONS.Build_PipeStorageTank_C || null;
    return null;
  };
  const cache = new Map();
  // returns a loaded HTMLImageElement or null (starts loading on first request)
  SF.img = (key) => {
    let c = cache.get(key);
    if (!c) {
      const p = SF.iconPath(key);
      c = { ok: false, im: null };
      if (p) {
        c.im = new Image();
        c.im.onload = () => { c.ok = true; SF.dirty = true; };
        c.im.src = p;
      }
      cache.set(key, c);
    }
    return c.ok ? c.im : null;
  };
  // small pre-scaled bitmaps for drawing many belt items quickly
  const small = new Map();
  SF.imgSmall = (key, px) => {
    const k = key + '@' + px;
    let c = small.get(k);
    if (c) return c;
    const im = SF.img(key);
    if (!im) return null;
    c = document.createElement('canvas');
    c.width = c.height = px;
    const g = c.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(im, 0, 0, px, px);
    small.set(k, c);
    return c;
  };
  SF.iconHTML = (key, size = 18, cls = '') => {
    const p = SF.iconPath(key);
    if (p) return `<img class="ico ${cls}" src="${p}" width="${size}" height="${size}" alt="" loading="lazy">`;
    const it = D.items[key];
    return `<span class="chip${it && it.fluid ? ' fluid' : ''} ${cls}" style="--c:${it ? it.color : '#64748b'};width:${size}px;height:${size}px"></span>`;
  };
})(window.SF);
