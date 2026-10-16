// DOM UI: toolbar, palette, inspector, factory summary, issues, tooltips, files.
(function (SF) {
  const S = SF.state, D = SF.D, ed = SF.ed;
  const $ = (s, r = document) => r.querySelector(s);
  const h = SF.esc;
  const fmt = SF.fmt;

  // ------------------------------------------------------------ toasts
  SF.toast = (msg, kind = 'info') => {
    const el = document.createElement('div');
    el.className = 'toast ' + kind; el.textContent = msg;
    $('#toasts').appendChild(el);
    setTimeout(() => el.classList.add('out'), 2600);
    setTimeout(() => el.remove(), 3000);
  };

  const chip = (item, size = 18) => SF.iconHTML(item, size);
  SF.chipHTML = chip;
  const itemCell = it => `<span class="itm">${chip(it, 22)}${h(SF.itemName(it))}</span>`;

  // ------------------------------------------------------------ palette (category rail + icon cards)
  const MAT_ORDER = ['FICSIT', 'Concrete', 'Polished', 'Asphalt', 'Metal', 'Frame', 'Glass', 'Orange', 'Tar'];
  const CATS = [
    { id: 'Production', icon: 'Build_ConstructorMk1_C' },
    { id: 'Extraction', icon: 'Build_MinerMk2_C' },
    { id: 'Power', icon: 'Build_GeneratorCoal_C' },
    { id: 'Logistics', icon: 'Build_ConveyorAttachmentSplitter_C' },
    { id: 'Storage', icon: 'Build_StorageContainerMk1_C' },
    { id: 'Foundations', icon: 'Build_Foundation_Concrete_8x4_C' },
    { id: 'Ramps', icon: 'Build_Ramp_8x4_01_C' },
    { id: 'Walls', svg: 'i-grid' },
    { id: 'Schematic', svg: 'i-schem' },
    { id: 'Blueprints', svg: 'i-star' },
  ];
  const BLURB = {
    Production: 'Machines that craft parts', Extraction: 'Miners, pumps and wells', Power: 'Generators',
    Logistics: 'Splitters, mergers, junctions', Storage: 'Containers, buffers, sinks',
    Foundations: 'Drag to place many', Ramps: 'Drag to place many', Walls: 'Snap to foundation edges',
    Schematic: 'Planning helpers', Blueprints: 'Your saved selections',
  };
  let cat = 'Production', mat = 'FICSIT';
  try { cat = localStorage.getItem('sf-planner-cat') || cat; } catch (_) { /* ignore */ }

  function cardHTML(d) {
    const p = SF.iconPath(d.id);
    const col = d.structure ? d.color : (SF.CAT_COLOR[d.cat] || '#888');
    const thumb = p ? `<img src="${p}" alt="" loading="lazy">` : `<span class="sw" style="--c:${col}"></span>`;
    const size = d.kind === 'label' ? '' : `${d.w}×${d.h}`;
    const lock = d.raw && D.buildings[d.id] ? SF.lockReason(D.buildings[d.id].unlock) : '';
    return `<button class="card pal-item${lock ? ' locked' : ''}" data-def="${d.id}" title="${h(d.name)}${size ? ' · ' + size + ' m' : ''}${lock ? ' — 🔒 ' + h(lock) : ''}">
      <span class="sz">${size}</span><span class="thumb">${thumb}</span><span class="nm">${h(d.name)}</span></button>`;
  }

  function renderRail() {
    $('#rail').innerHTML = CATS.map(c => {
      const p = c.icon && SF.iconPath(c.icon);
      const inner = p ? `<img src="${p}" alt="">` : `<svg><use href="#${c.svg}"/></svg>`;
      return `<button data-cat="${c.id}" data-label="${c.id}" class="${c.id === cat && !$('#search').value ? 'on' : ''}">${inner}</button>`;
    }).join('');
  }

  SF.renderPalette = () => {
    const q = $('#search').value.trim().toLowerCase();
    const groups = SF.paletteGroups();
    renderRail();
    let html = '';
    $('#matbar').innerHTML = '';
    if (q) {
      $('#pal-title').innerHTML = `Results <span>for “${h(q)}”</span>`;
      const recs = Object.entries(D.recipes).filter(([, r]) =>
        r.name.toLowerCase().includes(q) || r.out.some(([i]) => SF.itemName(i).toLowerCase().includes(q))).slice(0, 48);
      if (recs.length) {
        html += `<div class="pal-sec">Recipes — places the machine pre-set</div><div class="pal-grid">`;
        for (const [id, r] of recs) {
          const lk = SF.recipeLockReason(id);
          html += `<button class="card pal-item${lk ? ' locked' : ''}" data-def="${r.machine}" data-recipe="${id}" title="${h(r.name)} — ${h(SF.defs[r.machine].name)}${lk ? ' — 🔒 ' + h(lk) : ''}">
            ${r.alt ? '<span class="tag">ALT</span>' : ''}<span class="thumb">${SF.iconHTML(r.out[0][0], 40)}</span><span class="nm">${h(r.name.replace(/^Alternate: /, ''))}</span><span class="sub">${h(SF.defs[r.machine].name)}</span></button>`;
        }
        html += `</div>`;
      }
      for (const [g, list] of Object.entries(groups)) {
        if (g === 'Blueprints') continue;
        const items = list.filter(d => d.name.toLowerCase().includes(q) || (d.mat || '').toLowerCase().includes(q));
        if (items.length) html += `<div class="pal-sec">${g}</div><div class="pal-grid">${items.slice(0, 60).map(cardHTML).join('')}</div>`;
      }
      if (!html) html = '<div class="empty">Nothing matches.</div>';
    } else if (cat === 'Blueprints') {
      const lib = SF.library.list();
      $('#pal-title').innerHTML = `Blueprints <span>${lib.length} saved</span>`;
      html = lib.length ? `<div class="pal-grid">${lib.map(b => {
        const first = b.group.entities.find(e => SF.iconPath(e.def) && !SF.defs[e.def]?.structure) || b.group.entities[0];
        return `<div class="card bp pal-item" data-bp="${b.id}" role="button" tabindex="0" title="${h(b.name)}"><button class="del" data-bpdel="${b.id}" title="Delete blueprint">×</button>
          <span class="thumb">${first ? SF.iconHTML(first.def, 40) : ''}</span><span class="nm">${h(b.name)}</span><span class="sub">${b.group.entities.length} objects</span></div>`;
      }).join('')}</div>` : '<div class="empty">Select some objects and press <b>Blueprint</b> in the inspector to save them here.</div>';
    } else {
      let items = groups[cat] || [];
      $('#pal-title').innerHTML = `${cat} <span>${BLURB[cat] || ''}</span>`;
      if (['Foundations', 'Ramps', 'Walls'].includes(cat)) {
        const mats = [...new Set(items.map(d => d.mat))].sort((a, b) => MAT_ORDER.indexOf(a) - MAT_ORDER.indexOf(b));
        if (!mats.includes(mat)) mat = mats[0];
        $('#matbar').innerHTML = mats.map(m => {
          const c = (items.find(d => d.mat === m) || {}).color;
          return `<button data-mat="${m}" class="${m === mat ? 'on' : ''}" style="--c:${c}"><i></i>${h(m)}</button>`;
        }).join('');
        items = items.filter(d => d.mat === mat);
      }
      html = `<div class="pal-grid">${items.map(cardHTML).join('')}</div>`;
    }
    $('#palette').innerHTML = html;
    markPalette();
  };

  function markPalette() {
    document.querySelectorAll('.pal-item[data-def]').forEach(b => {
      b.classList.toggle('on', ed.tool === 'place' && !ed.group && b.dataset.def === ed.placeDef &&
        (b.dataset.recipe || null) === ((ed.placeProps && ed.placeProps.recipe && b.dataset.recipe) ? ed.placeProps.recipe : null));
    });
  }

  function initPalette() {
    $('#rail').addEventListener('click', ev => {
      const b = ev.target.closest('[data-cat]'); if (!b) return;
      cat = b.dataset.cat; $('#search').value = '';
      try { localStorage.setItem('sf-planner-cat', cat); } catch (_) { /* ignore */ }
      SF.renderPalette();
    });
    $('#matbar').addEventListener('click', ev => {
      const b = ev.target.closest('[data-mat]'); if (!b) return;
      mat = b.dataset.mat; SF.renderPalette();
    });
    $('#palette').addEventListener('click', ev => {
      const del = ev.target.closest('[data-bpdel]');
      if (del) { ev.stopPropagation(); if (confirm('Delete this blueprint?')) { SF.library.remove(del.dataset.bpdel); SF.renderPalette(); } return; }
      const bp = ev.target.closest('[data-bp]');
      if (bp) { const b = SF.library.list().find(x => x.id === bp.dataset.bp); if (b) SF.placeGroup(b.group); return; }
      const it = ev.target.closest('.pal-item[data-def]');
      if (!it) return;
      ed.rot = 0;
      SF.setTool('place', { def: it.dataset.def, props: it.dataset.recipe ? { recipe: it.dataset.recipe } : null });
      $('#cv').focus();
    });
    $('#search').addEventListener('input', SF.renderPalette);
    $('#search').addEventListener('keydown', ev => { if (ev.key === 'Escape') { ev.target.value = ''; SF.renderPalette(); ev.target.blur(); } });
  }

  // area of the canvas not covered by floating panels (used to fit the view)
  SF.viewInsets = () => {
    const r = id => { const el = document.getElementById(id); return el && getComputedStyle(el).display !== 'none' ? el.getBoundingClientRect() : null; };
    const L = r('left'), R = r('right'), T = r('toolbar');
    return { l: L ? L.right : 0, r: R ? window.innerWidth - R.left : 0, t: T ? T.bottom : 0, b: 52 };
  };

  // ------------------------------------------------------------ toolbar
  function renderTools() {
    document.querySelectorAll('#tools [data-tool]').forEach(b => {
      const on = b.dataset.tool === ed.tool && (!b.dataset.kind || b.dataset.kind === ed.linkKind);
      b.classList.toggle('on', on);
    });
    const kind = ed.linkKind;
    const list = kind === 'pipe' ? D.pipes : D.belts;
    const cur = kind === 'pipe' ? ed.pipeTier : ed.beltTier;
    $('#tiers').innerHTML = `<span class="lbl">${kind === 'pipe' ? 'Pipe' : 'Belt'}</span>` + list.map(b =>
      `<button data-tier="${b.tier}" class="${b.tier === cur ? 'on' : ''}${SF.tierUnlocked(kind, b.tier) ? '' : ' locked'}" title="${h(b.name)} — ${b.rate}/min${SF.tierUnlocked(kind, b.tier) ? '' : ' — 🔒 ' + h(SF.lockReason(b.unlock))}">Mk${b.tier}<small>${b.rate}</small></button>`).join('');
    markPalette();
    updateHint();
  }
  SF.onTool = renderTools;

  SF.onSimMode = () => {
    const on = SF.live.active;
    document.querySelectorAll('#runmode [data-run]').forEach(b => b.classList.toggle('on', (b.dataset.run === 'sim') === on));
    $('#simctl').hidden = !on;
    if (!on) $('#simreport').hidden = true;
    document.body.classList.toggle('simmode', on);
    const pl = $('#sim-play');
    pl.textContent = SF.live.running ? '⏸' : '▶'; pl.classList.toggle('paused', !SF.live.running);
    document.querySelectorAll('#sim-speed [data-sp]').forEach(b => b.classList.toggle('on', +b.dataset.sp === SF.live.speed));
    renderSimBar();
  };
  async function skipTo(T) {
    const L = SF.live, from = L.t < 1.5 ? 0 : L.t;
    $('#simreport').hidden = true;
    const btn = $('#sim-skip');
    btn.classList.add('busy'); btn.textContent = '✕'; btn.title = 'Cancel skip';
    const started = performance.now();
    const ok = await L.skipTo(T, () => renderSimBar());
    btn.classList.remove('busy'); btn.textContent = '⏩'; btn.title = 'Skip ahead: fast-forward the simulation to a time';
    if (ok) L.running = false;          // pause on arrival so the numbers can be inspected
    SF.onSimMode();
    if (!ok) { SF.toast(`Skip cancelled at ${clock(L.t)}`, 'warn'); return; }
    showSimReport(T <= from ? 0 : from, (performance.now() - started) / 1000);
  }
  // what the factory has made: storage contents, everything delivered to sinks / outputs, power
  function showSimReport(from, secs) {
    const L = SF.live, res = SF.sim.result;
    const box = $('#simreport');
    const rows = obj => Object.entries(obj).filter(([, v]) => v > 1e-6).sort((a, b) => b[1] - a[1])
      .map(([it, v]) => `<div class="row"><span class="n">${itemCell(it)}</span><span class="v">${fmt(v, SF.item(it).fluid ? 1 : 0)}${SF.item(it).fluid ? ' m³' : ''}</span></div>`).join('');
    let html = `<h4>⏩ Sim time ${clock(L.t)}<span class="muted small">${from ? 'from ' + clock(from) + ' · ' : ''}computed in ${fmt(secs, 1)} s</span><span class="x" title="Close">✕</span></h4>`;
    const groups = [];
    for (const n of L.nodes.values()) {
      const d = n.d, nm = h(n.e.name ? `${n.e.name} (${d.name})` : d.name);
      if (n.kind === 'storage') {
        const r = res.nodes.get(n.e.id);
        groups.push(`<div class="grp"><b>${nm} <span class="muted">${r && r.live ? r.live.capacity + ' · ' + fmt((r.live.fill || 0) * 100, 0) + '%' : ''}</span></b>${rows(n.st.inv) || '<div class="muted">Empty</div>'}</div>`);
      } else if (['sink', 'vsink'].includes(n.kind)) {
        const got = rows(n.st.cum.cons);
        if (got) groups.push(`<div class="grp"><b>${nm} <span class="muted">received in total</span></b>${got}</div>`);
      }
    }
    // everything produced by machines (whole run), for a quick sanity check of totals
    const made = {};
    for (const n of L.nodes.values()) if (n.kind === 'machine' || n.kind === 'extractor') for (const it in n.st.cum.prod) made[it] = (made[it] || 0) + n.st.cum.prod[it];
    groups.push(`<div class="grp"><b>Produced since 0:00:00</b>${rows(made) || '<div class="muted">Nothing yet</div>'}</div>`);
    const p = res.summary;
    groups.push(`<div class="grp"><b>Power now</b><div class="row"><span class="n">Used / generated</span><span class="v">${fmt(p.powerUse, 1)} / ${fmt(p.powerGen, 1)} MW</span></div></div>`);
    box.innerHTML = html + groups.join('');
    box.hidden = false;
    box.querySelector('.x').onclick = () => { box.hidden = true; };
  }

  const clock = t => { t = Math.floor(t + 1e-6); return `${Math.floor(t / 3600)}:${String(Math.floor(t / 60) % 60).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`; };
  function renderSimBar() {
    const L = SF.live;
    if (!L.active) return;
    const c = $('#sim-clock');
    c.textContent = L.skipping ? `⏩ ${Math.round((L.skipping.progress || 0) * 100)}%` : clock(L.t);
    c.classList.toggle('lag', !!L.lag && L.running);
    c.title = L.skipping ? `Skipping to ${clock(L.skipping.target)} — now at ${clock(L.t)}`
      : L.lag ? 'Your computer cannot keep up with this speed — the clock runs slower than requested' : 'Simulated time since reset';
    $('#sim-items').textContent = `▦ ${L.itemsOnBelts()}`;
    const p = SF.sim.result && SF.sim.result.summary;
    if (p) $('#sim-power').innerHTML = `⚡ <b style="color:#f59e0b">${fmt(p.powerUse, 1)}</b> / <b style="color:#22c55e">${fmt(p.powerGen, 1)}</b> MW`;
    const g = $('#sim-graph'), x = g.getContext('2d'), H = L.powerHist;
    x.clearRect(0, 0, g.width, g.height);
    if (H.length > 1) {
      const max = Math.max(1, ...H.map(h => Math.max(h.gen, h.use))) * 1.1;
      const line = (key, col) => {
        x.strokeStyle = col; x.lineWidth = 1.5; x.beginPath();
        H.forEach((h, i) => { const px = i / (Math.max(H.length, 600) - 1) * g.width, py = g.height - 2 - h[key] / max * (g.height - 4); i ? x.lineTo(px, py) : x.moveTo(px, py); });
        x.stroke();
      };
      line('gen', '#22c55e'); line('use', '#f59e0b');
    }
  }

  SF.onMode = () => {
    const on3 = SF.view3d && SF.view3d.active;
    document.querySelectorAll('#modes [data-mode]').forEach(b => b.classList.toggle('on', (b.dataset.mode === '3d') === !!on3));
    updateHint();
  };
  function updateHint() {
    if (SF.view3d && SF.view3d.active) {
      $('#hint').textContent = ed.tool === 'place'
        ? 'Click to place · R rotate · Esc / right-click to cancel'
        : 'Left-drag empty space or Alt+drag anywhere: orbit · right/middle-drag: pan · wheel: zoom · drag a building to move it (click a foundation first to move it) · Alt+wheel: floors · T: back to 2D';
      return;
    }
    const hints = {
      select: 'Click to select · drag to move · drag empty space to box-select · click a port to draw a belt · R rotate · Q copy building under cursor',
      place: 'Click to place · R rotate · drag to “zoop” foundations · Alt+click to force · Esc / right-click to cancel',
      link: 'Click a port or the ground to start · each click on the ground drops a pole · click a port to finish · ↑/↓ pole height · [ ] or Ctrl+wheel rotate pole · R Default / Straight / Curve style · 1–6 tier · right-click ends',
      delete: 'Click objects or drag a box to delete',
      pan: 'Drag to pan the view',
    };
    let t = hints[ed.tool] || '';
    if (ed.tool === 'place' && ed.group) t = 'Click to paste · R rotate · Shift+click to keep placing · Esc cancel';
    $('#hint').textContent = t;
  }

  function renderLevels() {
    $('#lvl').innerHTML = S.levels.map((l, i) => `<option value="${i}" ${i === S.level ? 'selected' : ''}>${h(l.name)}</option>`).join('');
    const counts = S.levels.map(() => 0);
    for (const e of S.entities.values()) if (counts[e.level] !== undefined && !SF.defs[e.def].structure) counts[e.level]++;
    const eye = on => `<svg viewBox="0 0 24 24"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" fill="none" stroke="currentColor" stroke-width="2"/>${on ? '<circle cx="12" cy="12" r="3" fill="currentColor"/>' : '<path d="M4 20L20 4" stroke="currentColor" stroke-width="2"/>'}</svg>`;
    const list = S.levels.map((l, i) => i).reverse().map(i => {
      const cur = i === S.level, vis = SF.levelVisible(i);
      return `<div class="fl${cur ? ' on' : ''}${counts[i] ? '' : ' empty'}${vis ? '' : ' off'}" data-fl="${i}" title="${h(S.levels[i].name)} — click to work on it, double-click to rename">
        <span class="n">${i + 1}</span><span class="nm">${h(S.levels[i].name)}</span>
        ${cur ? `<input class="fz" data-fz="${i}" type="number" step="1" value="${SF.levelZ(i)}" title="Floor height (m above floor 1). A wall is 4 m.">`
              : `<span class="fzv" title="Floor height">${SF.levelZ(i)} m</span>`}
        <button class="eye${vis ? ' vis' : ''}" data-eye="${i}" ${cur ? 'disabled title="The floor you are working on is always shown"' : 'title="Show / hide this floor (Alt+click: show only this one)"'}>${eye(vis)}</button>
      </div>`;
    }).join('');
    $('#floors').innerHTML = `<div class="fl-h"><span>Floors</span><button data-fladd title="Add a floor one wall (4 m) above the top floor">+</button></div>
      <button class="arrow" data-flmove="1" title="Floor up (PgUp / E / Alt+scroll)" ${S.level >= S.levels.length - 1 ? 'disabled' : ''}>▲</button>
      <div class="fl-list">${list}</div>
      <button class="arrow" data-flmove="-1" title="Floor down (PgDn / C / Alt+scroll)" ${S.level <= 0 ? 'disabled' : ''}>▼</button>
      <div class="fl-hide">
        <label title="Hide all foundations and ramps (2D and 3D)"><input type="checkbox" data-hide="hideFoundations" ${S.settings.hideFoundations ? 'checked' : ''}>Hide foundations</label>
        <label title="Hide all walls (2D and 3D)"><input type="checkbox" data-hide="hideWalls" ${S.settings.hideWalls ? 'checked' : ''}>Hide walls</label>
      </div>`;
  }
  let bannerTimer = 0;
  function floorBanner() {
    const b = $('#floorbanner');
    b.innerHTML = `<div class="k">Floor ${S.level + 1} of ${S.levels.length}</div><div class="v">${h(S.levels[S.level].name)}</div>`;
    b.classList.add('show');
    clearTimeout(bannerTimer);
    bannerTimer = setTimeout(() => b.classList.remove('show'), 900);
  }
  function setLevel(n) {
    if (n === S.level || n < 0 || n >= S.levels.length) return;
    S.level = n;
    renderLevels();
    SF.sel.ents = new Set([...SF.sel.ents].filter(id => { const e = S.entities.get(id); return e && (e.level === S.level || (e.pair && SF.sel.ents.has(e.pair))); }));
    SF.onSelection();
    floorBanner();
  }
  SF.onLevel = () => { renderLevels(); SF.selectOnly(); };
  SF.onLevelsChanged = () => renderLevels();
  // step floors; going above the top floor creates a new one only when `create` is set
  SF.changeLevel = (d, create = true) => {
    const n = S.level + d;
    if (n < 0) return;
    if (n >= S.levels.length) {
      if (!create) return;
      SF.addLevel(); SF.changed();
    }
    setLevel(n);
  };

  function initToolbar() {
    $('#tools').addEventListener('click', ev => {
      const b = ev.target.closest('[data-tool]'); if (!b) return;
      SF.setTool(b.dataset.tool, { kind: b.dataset.kind });
    });
    $('#tiers').addEventListener('click', ev => {
      const b = ev.target.closest('[data-tier]'); if (!b) return;
      const tier = +b.dataset.tier;
      if (ed.linkKind === 'pipe') ed.pipeTier = tier; else ed.beltTier = tier;
      // also apply to selected links of that kind
      let n = 0;
      for (const id of SF.sel.links) { const l = S.links.get(id); if (l.kind === ed.linkKind) { l.tier = tier; n++; } }
      if (n) SF.changed();
      renderTools();
    });
    $('#btn-undo').onclick = () => { SF.undo(); SF.selectOnly(); };
    $('#btn-redo').onclick = () => { SF.redo(); SF.selectOnly(); };
    $('#lvl').onchange = ev => setLevel(+ev.target.value);
    $('#floors').addEventListener('click', ev => {
      const eyeB = ev.target.closest('[data-eye]');
      if (eyeB) {
        const i = +eyeB.dataset.eye;
        if (ev.altKey) S.levels.forEach((l, k) => { l.hidden = k !== i && k !== S.level; });     // solo
        else S.levels[i].hidden = !S.levels[i].hidden;
        SF.changed(false); renderLevels(); return;
      }
      if (ev.target.closest('[data-fz], [data-hide]')) return;
      const f = ev.target.closest('[data-fl]'); if (f) { setLevel(+f.dataset.fl); return; }
      const m = ev.target.closest('[data-flmove]'); if (m) { SF.changeLevel(+m.dataset.flmove, false); return; }
      if (ev.target.closest('[data-fladd]')) { const n = SF.addLevel(); SF.changed(); setLevel(n); }
    });
    $('#floors').addEventListener('change', ev => {
      const z = ev.target.closest('[data-fz]');
      if (z) { const v = parseFloat(z.value); if (isFinite(v)) { S.levels[+z.dataset.fz].z = v; SF.changed(); } renderLevels(); return; }
      const hd = ev.target.closest('[data-hide]');
      if (hd) { S.settings[hd.dataset.hide] = hd.checked; saveSettings(); SF.touch(); }
    });
    $('#floors').addEventListener('keydown', ev => { if (ev.target.closest('[data-fz]')) ev.stopPropagation(); });
    $('#floors').addEventListener('dblclick', ev => {
      const f = ev.target.closest('[data-fl]'); if (!f) return;
      const i = +f.dataset.fl;
      const n = prompt('Floor name', S.levels[i].name);
      if (n) { S.levels[i].name = n; SF.changed(); renderLevels(); }
    });
    $('#floors').addEventListener('wheel', ev => { if (ev.target.closest('[data-fz]')) return; ev.preventDefault(); SF.changeLevel(ev.deltaY < 0 ? 1 : -1, false); }, { passive: false });
    const gop = $('#ghost-op'), gopv = $('#ghost-op-v');
    gop.value = S.settings.ghostOpacity ?? 0.3; gopv.textContent = Math.round(gop.value * 100) + '%';
    gop.oninput = () => { S.settings.ghostOpacity = +gop.value; gopv.textContent = Math.round(gop.value * 100) + '%'; saveSettings(); };
    $('#lvl-up').onclick = () => SF.changeLevel(1, false);
    $('#lvl-down').onclick = () => SF.changeLevel(-1);
    $('#lvl-ren').onclick = () => {
      const n = prompt('Level name', S.levels[S.level].name);
      if (n) { S.levels[S.level].name = n; SF.changed(); renderLevels(); }
    };
    $('#snap').value = String(S.settings.snap);
    $('#snap').onchange = ev => { S.settings.snap = +ev.target.value; saveSettings(); };
    document.querySelectorAll('[data-set]').forEach(cb => {
      cb.checked = !!S.settings[cb.dataset.set];
      cb.onchange = () => {
        S.settings[cb.dataset.set] = cb.checked; saveSettings();
        if (['openOutputsBlock'].includes(cb.dataset.set)) SF.sim.request();
        if (cb.dataset.set === 'ortho') SF.touch();
      };
    });
    const menu = (btn, m) => {
      $(btn).onclick = ev => { const open = !$(m).classList.contains('open'); document.querySelectorAll('.menu').forEach(x => x.classList.remove('open')); $(m).classList.toggle('open', open); ev.stopPropagation(); };
    };
    menu('#btn-view', '#viewmenu'); menu('#btn-file', '#filemenu');
    document.addEventListener('click', ev => {
      if (!ev.target.closest('#viewmenu')) $('#viewmenu').classList.remove('open');
      // picking anything closes it; the submenu heading only opens its submenu (for touch, where there is no hover)
      const sub = ev.target.closest('#filemenu .has-sub');
      if (sub) { sub.parentElement.classList.toggle('open'); return; }
      if (!ev.target.closest('#filemenu') || ev.target.closest('#filemenu button')) { $('#filemenu').classList.remove('open'); document.querySelectorAll('#filemenu .submenu-wrap').forEach(w => w.classList.remove('open')); }
    });
    $('#btn-fit').onclick = () => (SF.view3d && SF.view3d.active ? SF.view3d.fit() : SF.fitView());
    $('#modes').onclick = ev => {
      const b = ev.target.closest('[data-mode]'); if (!b) return;
      if (SF.view3d.unavailable) { SF.toast('3D view needs WebGL (three.js failed to load)', 'warn'); return; }
      SF.view3d.setActive(b.dataset.mode === '3d');
    };
    // run mode: Free run (steady-state calculator) / Sim (real items in real time)
    $('#runmode').onclick = ev => {
      const b = ev.target.closest('[data-run]'); if (!b) return;
      const on = b.dataset.run === 'sim';
      if (on !== SF.live.active) SF.live.setActive(on);
    };
    $('#sim-play').onclick = () => { SF.live.running = !SF.live.running; SF.onSimMode(); };
    $('#sim-step').onclick = () => { SF.live.running = false; SF.live.stepOnce(); SF.onSimMode(); };
    $('#sim-reset').onclick = () => { SF.live.reset(); SF.toast('Simulation reset — everything starts empty'); };
    // skip ahead
    $('#sim-skip').onclick = ev => {
      ev.stopPropagation();
      if (SF.live.skipping) { SF.live.cancelSkip(); return; }
      $('#skipmenu').classList.toggle('open');
    };
    document.addEventListener('click', ev => { if (!ev.target.closest('#skip-wrap')) $('#skipmenu').classList.remove('open'); });
    $('#skipmenu').onclick = ev => {
      const b = ev.target.closest('[data-t]'); if (!b) return;
      $('#skipmenu').classList.remove('open');
      skipTo(+b.dataset.t);
    };
    $('#sim-speed').onclick = ev => {
      const b = ev.target.closest('[data-sp]'); if (!b) return;
      SF.live.speed = +b.dataset.sp; SF.onSimMode();
    };
    const bs = $('#belt-style');
    bs.value = S.settings.beltStyle || 'curve';
    bs.onchange = () => { S.settings.beltStyle = bs.value; saveSettings(); SF.touch(); };

    // every plan is its own saved factory (home.js): new / open / examples make a new one, nothing is overwritten
    $('#btn-home').onclick = () => SF.home.show();
    $('#btn-new').onclick = () => SF.home.newFactory();
    $('#btn-save').onclick = SF.saveFile = () => {
      const blob = new Blob([JSON.stringify(SF.serialize(), null, 1)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = (S.levels[0].name === 'Floor 1' ? 'factory' : S.levels[0].name) + '.sfplan.json';
      a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    };
    $('#btn-open').onclick = () => $('#file-in').click();
    $('#file-in').onchange = async ev => {
      const f = ev.target.files[0]; if (!f) return;
      try { await SF.home.importDoc(JSON.parse(await f.text()), f.name.replace(/(\.sfplan)?\.json$/i, '')); SF.toast('Opened ' + f.name); }
      catch (e) { SF.toast('Could not read that file: ' + e.message, 'warn'); }
      ev.target.value = '';
    };
    $('#btn-share').onclick = () => { SF.openShare(); };
    $('#btn-unlocks').onclick = () => { SF.openUnlocks(); };
    $('#btn-png').onclick = () => {
      const url = SF.exportPNG();
      if (!url) { SF.toast('Nothing to export', 'warn'); return; }
      const a = document.createElement('a'); a.href = url; a.download = 'factory.png'; a.click();
    };
    // stress-test factories (generated, see scenarios.js)
    $('#scenario-list').innerHTML = SF.SCENARIOS.map(sc => `<button data-sc="${sc.id}" title="${h(sc.desc)}">${h(sc.name)}</button>`).join('');
    $('#scenario-list').onclick = ev => {
      const b = ev.target.closest('[data-sc]'); if (!b) return;
      const sc = SF.SCENARIOS.find(x => x.id === b.dataset.sc);
      SF.home.openBuilt(sc.name.replace(/^\d+ · /, ''), () => SF.buildScenario(sc.id))
        .then(() => SF.toast(`${sc.name}: ${S.entities.size} objects, ${S.links.size} belts/pipes`));
    };
    $('#btn-example').onclick = () => SF.home.openBuilt('Example factory', SF.buildExample);
    $('#btn-tower').onclick = () => SF.home.openBuilt('3-storey building', SF.buildTower)
      .then(() => SF.toast('3-storey building: 10 reinforced plates/min. Use the floor list (eye icons) to look at each storey.'));
    $('#btn-help').onclick = () => { SF.selectOnly(); showTab('inspect'); };
  }

  function saveSettings() {
    try { localStorage.setItem('sf-planner-settings', JSON.stringify(S.settings)); } catch (_) { /* ignore */ }
  }
  SF.saveSettings = saveSettings;
  // settings changed elsewhere (home screen): bring the view menu up to date
  SF.syncSettingsUI = () => {
    document.querySelectorAll('[data-set]').forEach(cb => { cb.checked = !!S.settings[cb.dataset.set]; });
    const bs = $('#belt-style'); if (bs) bs.value = S.settings.beltStyle || 'curve';
    const sn = $('#snap'); if (sn) sn.value = String(S.settings.snap);
  };
  // after a whole plan is loaded: fresh undo history, floors, selection, view
  SF.afterLoad = () => { SF.resetHistory(); renderLevels(); SF.selectOnly(); SF.fitView(); renderInspector(); if (tab === 'planner') SF.renderPlanner(); };

  // ------------------------------------------------------------ right panel tabs
  let tab = 'inspect';
  function showTab(t) {
    tab = t;
    document.querySelectorAll('#right .tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === t));
    document.querySelectorAll('#right .tab').forEach(p => p.classList.toggle('on', p.id === 'tab-' + t));
    if (t === 'factory') renderFactory();
    if (t === 'issues') renderIssues();
    if (t === 'planner') SF.renderPlanner();
  }

  // ------------------------------------------------------------ inspector
  SF.onSelection = () => { renderInspector(); if (tab !== 'inspect' && (SF.sel.ents.size || SF.sel.links.size)) showTab('inspect'); };

  function slider(id, label, val, min, max, step, unit, extra = '') {
    return `<div class="row"><label>${label}</label><div class="ctl"><input type="range" id="${id}-r" min="${min}" max="${max}" step="${step}" value="${val}">
      <input type="number" id="${id}" min="${min}" max="${max}" step="any" value="${val}"><span class="u">${unit}</span></div>${extra}</div>`;
  }

  function recipeOptions(defId, cur) {
    const rs = SF.recipesFor(defId);
    const grp = (title, list) => list.length ? `<optgroup label="${title}">${list.map(r =>
      `<option value="${r.id}" ${r.id === cur ? 'selected' : ''}>${SF.recipeLockReason(r.id) ? '🔒 ' : ''}${h(r.name)}</option>`).join('')}</optgroup>` : '';
    return `<option value="">— none —</option>` + grp('Standard', rs.filter(r => !r.alt && !r.event)) + grp('Alternate', rs.filter(r => r.alt && !r.event)) + grp('Event', rs.filter(r => r.event));
  }

  function itemOptions(filter, cur) {
    const list = Object.entries(D.items).filter(([k, v]) => filter(k, v)).sort((a, b) => a[1].name.localeCompare(b[1].name));
    return list.map(([k, v]) => `<option value="${k}" ${k === cur ? 'selected' : ''}>${h(v.name)}</option>`).join('');
  }

  function costHTML(cost, mult = 1) {
    if (!cost || !cost.length) return '<span class="muted">—</span>';
    return cost.map(([i, a]) => `<span class="cost">${chip(i, 20)}<b>${fmt(a * mult, 1)}</b> ${h(SF.itemName(i))}</span>`).join('');
  }

  // folded sections in the inspector: <details> that remember being opened across re-renders
  const openFolds = new Set();
  const fold = (key, title, body, note = '') => `<details class="fold" data-fold="${key}" ${openFolds.has(key) ? 'open' : ''}>
      <summary><span>${title}</span>${note ? `<span class="fs">${note}</span>` : ''}</summary><div class="fold-b">${body}</div></details>`;
  const bindFolds = box => box.querySelectorAll('details.fold').forEach(d => {
    d.ontoggle = () => { if (d.open) openFolds.add(d.dataset.fold); else openFolds.delete(d.dataset.fold); };
  });

  function renderInspector() {
    const box = $('#tab-inspect');
    renderInspectorInner(box);
    bindFolds(box);
  }
  function renderInspectorInner(box) {
    const ents = [...SF.sel.ents].map(id => S.entities.get(id)).filter(Boolean);
    const links = [...SF.sel.links].map(id => S.links.get(id)).filter(Boolean);
    if (!ents.length && !links.length) { box.innerHTML = helpHTML(); return; }
    // a lift's two ends are one object
    if (!links.length && ((ents.length === 2 && ents[0].pair === ents[1].id) || (ents.length === 1 && SF.liftOf(ents[0])))) {
      const b = SF.liftOf(ents[0]).bottom; box.innerHTML = liftHTML(b); bindLift(b); return;
    }
    if (ents.length === 1 && !links.length) { box.innerHTML = entityHTML(ents[0]); bindEntity(ents[0]); renderStats(); return; }
    if (!ents.length && links.length === 1) { box.innerHTML = linkHTML(links[0]); bindLink(links[0]); renderStats(); return; }
    box.innerHTML = multiHTML(ents, links); bindMulti(ents, links);
  }
  SF.renderInspector = renderInspector;

  function helpHTML() {
    const k = (a, b) => `<tr><td><kbd>${a}</kbd></td><td>${b}</td></tr>`;
    return `<div class="help">
      <h3><b>FICSIT</b> Schematic Planner</h3>
      <p>Nothing selected.</p>
      <ol><li>Pick a building on the left, or search a <b>product</b> (e.g. “motor”).</li>
      <li>Click an orange <b>output</b>, then an <b>input</b>, to lay a belt. Blue ports take pipes.</li>
      <li>Click anything to edit it here.</li></ol>
      <p class="muted small">Not sure what to build? The <b>Planner</b> tab works it out and builds it for you.</p>
      ${fold('keys', 'Keyboard shortcuts', `<table class="keys">${k('V', 'Select tool')}${k('B / P', 'Belt / pipe tool: click a port or the ground, each ground click drops a pole')}${k('↑ / ↓ (placing)', 'Next pole height')}${k('[ ] or Ctrl+wheel (placing)', 'Rotate next pole (Shift = 15°)')}${k('[ ] (poles selected)', 'Raise / lower poles')}${k('R (placing)', 'Belt style: Default / Straight / Curve (like the game)')}${k('Splitter over a belt', 'Snaps on and splits it')}${k('1–6', 'Belt tier (or change selected belts)')}${k('X', 'Delete tool')}
      ${k('R / Shift+R', 'Rotate')}${k('Q', 'Pick building under cursor')}${k('Ctrl+C / V / D', 'Copy / paste / duplicate')}${k('Ctrl+Z / Y', 'Undo / redo')}
      ${k('Space+drag, middle or right drag', 'Pan')}${k('Wheel', 'Zoom')}${k('F', 'Fit view')}${k('T', 'Toggle 2D / 3D view')}${k('M', 'Free run / Sim mode')}${k('K', 'Sim: play / pause')}${k('PgUp / PgDn, E / C, Alt+scroll', 'Floor up / down')}${k('Arrows', 'Nudge (Shift = 8 m)')}
      ${k('Double-click belt', 'Add bend point')}${k('Del', 'Delete selection')}</table>`)}</div>`;
  }

  function header(d, e) {
    const col = d.structure ? d.color : SF.CAT_COLOR[d.cat] || '#888';
    return `<div class="ins-h" style="--c:${col}"><div class="big">${SF.iconHTML(d.id, 52)}</div><div><div class="t">${h(d.name)}</div><div class="s">${h(d.structure ? d.mat + ' · ' + d.kind : d.cat)} · ${SF.defW(d, e)}×${SF.defH(d, e)} m · ${h(S.levels[e.level]?.name || '')}</div></div></div>
      ${ACTIONS}`;
  }
  const ACTIONS = `<div class="actions icons"><button data-act="rot" title="Rotate (R)">⟳<span>Rotate</span></button><button data-act="dup" title="Duplicate (Ctrl+D)">⧉<span>Copy</span></button><button data-act="bp" title="Save as blueprint">★<span>Blueprint</span></button><button data-act="del" class="danger" title="Delete (Del)">🗑<span>Delete</span></button></div>`;

  // ------------------------------------------------------------ conveyor lift: one panel for both floors
  const FACE = { 0: '←', 1: '↑', 2: '→', 3: '↓' };                       // bottom connector (faces -x at rot 0)
  const FACE_TOP = { 0: '→', 1: '↓', 2: '←', 3: '↑' };                   // top connector (faces +x at rot 0)
  function liftHTML(bottom) {
    const L = SF.liftOf(bottom);
    const lv = i => h(S.levels[i] ? S.levels[i].name : '?');
    const tops = S.levels.map((x, i) => i).filter(i => SF.levelZ(i) > SF.levelZ(L.bottom.level));
    const pr = SF.linkProblems(L.link);
    const facing = (id, end, map) => `<div class="seg" id="${id}">${[0, 1, 2, 3].map(r => `<button data-v="${r}" class="${end.rot === r ? 'on' : ''}" title="Connector faces ${map[r]}">${map[r]}</button>`).join('')}</div>`;
    return `<div class="ins-h" style="--c:#f59e0b"><div class="big lift-ico">${L.up ? '▲' : '▼'}</div><div><div class="t">Conveyor Lift</div>
        <div class="s">${lv(L.bottom.level)} → ${lv(L.top.level)} · ${fmt(L.height, 1)} m · Mk${L.link.tier}</div></div></div>
      <div class="actions icons"><button data-act="goto-bottom" title="Go to the bottom floor">▼<span>Bottom</span></button><button data-act="goto-top" title="Go to the top floor">▲<span>Top</span></button><button data-act="bp" title="Save as blueprint">★<span>Blueprint</span></button><button data-act="del" class="danger" title="Delete">🗑<span>Delete</span></button></div>
      <div class="row"><label>Direction</label><div class="seg" id="i-lift-dir">
          <button data-v="up" class="${L.up ? 'on' : ''}" ${L.fixed ? 'disabled' : ''}>▲ Up</button><button data-v="down" class="${!L.up ? 'on' : ''}" ${L.fixed ? 'disabled' : ''}>▼ Down</button></div>
        <div class="sub">${L.fixed ? 'Set by the connected belts: a belt into the bottom runs it up, into the top runs it down.' : 'No belts yet: choose which way it will carry items.'}</div></div>
      <div class="row"><label>Height</label><div class="ctl lift-h"><button data-dh="-1" title="1 m lower">−</button><input type="number" id="i-lift-h" min="4" max="48" step="1" value="${L.height}"><span class="u">m</span><button data-dh="1" title="1 m higher">+</button></div>
        <div class="sub">4–48 m in 1 m steps (like the game). Top at ${fmt(SF.levelZ(L.bottom.level) + L.height, 0)} m${L.top.ph != null ? ` — ${fmt(L.top.ph - 1, 0)} m above ${lv(L.top.level)}` : ` — on ${lv(L.top.level)}`}.</div>
        ${tops.length ? `<div class="snaps">Snap to: ${tops.filter(i => SF.levelZ(i) - SF.levelZ(L.bottom.level) <= 48).map(i => `<button data-snap="${i}">${lv(i)}</button>`).join('')}</div>` : ''}</div>
      <div class="row"><label>Mark</label><div class="seg" id="i-lift-tier">${D.belts.map(b => `<button data-v="${b.tier}" class="${b.tier === L.link.tier ? 'on' : ''}" title="${b.rate}/min">Mk${b.tier}</button>`).join('')}</div>
        <div class="sub">${SF.linkSpec(L.link).rate} items/min</div></div>
      ${fold('liftface', 'Connector facing', `<div class="row"><label>Top (${lv(L.top.level)}) · ${L.up ? 'output' : 'input'}</label>${facing('i-lift-face-top', L.top, FACE_TOP)}</div>
        <div class="row"><label>Bottom (${lv(L.bottom.level)}) · ${L.up ? 'input' : 'output'}</label>${facing('i-lift-face-bottom', L.bottom, FACE)}</div>`)}
      ${pr.map(p => `<div class="bad small">⚠ ${h(p.text)}</div>`).join('')}`;
  }
  function bindLift(bottom) {
    const L = SF.liftOf(bottom);
    const seg = (sel, fn) => { const el = $(sel); if (el) el.onclick = ev => { const b = ev.target.closest('button'); if (b && !b.disabled) fn(b.dataset.v); }; };
    const redo = () => { SF.changed(); renderInspector(); };
    const setH = v => { L.bottom.liftH = SF.clamp(Math.round(v), SF.LIFT_MIN, SF.LIFT_MAX); redo(); renderLevels(); };
    $('#i-lift-h').onchange = ev => setH(+ev.target.value || L.height);
    $('#i-lift-h').onkeydown = ev => ev.stopPropagation();
    document.querySelectorAll('#tab-inspect [data-dh]').forEach(b => { b.onclick = () => setH(L.height + +b.dataset.dh); });
    document.querySelectorAll('#tab-inspect [data-snap]').forEach(b => { b.onclick = () => setH(SF.levelZ(+b.dataset.snap) - SF.levelZ(L.bottom.level)); });
    seg('#i-lift-dir', v => { L.bottom.liftDown = v === 'down'; redo(); });
    seg('#i-lift-face-top', v => { L.top.rot = +v; redo(); });
    seg('#i-lift-face-bottom', v => { L.bottom.rot = +v; redo(); });
    seg('#i-lift-tier', v => { L.link.tier = +v; redo(); });
    document.querySelectorAll('#tab-inspect [data-act]').forEach(b => {
      b.onclick = () => {
        const a = b.dataset.act;
        if (a === 'goto-bottom') { setLevel(L.bottom.level); SF.selectOnly([L.bottom.id]); }
        if (a === 'goto-top') { setLevel(L.top.level); SF.selectOnly([L.top.id]); }
        if (a === 'del') { SF.removeEntity(L.bottom.id); SF.changed(); SF.selectOnly(); return; }
        if (a === 'bp') {
          const g = SF.makeGroup([L.bottom.id]);
          const n = prompt('Blueprint name', 'Conveyor Lift');
          if (n && g) { SF.library.add(n, g); SF.renderPalette && SF.renderPalette(); SF.toast('Saved blueprint'); }
        }
        renderInspector();
      };
    });
  }

  function entityHTML(e) {
    const d = SF.defs[e.def];
    const b = d.raw || {};
    let html = header(d, e);
    switch (d.kind) {
      case 'machine': {
        const r = D.recipes[e.recipe];
        html += `<div class="row"><label>Recipe</label><select id="i-recipe">${recipeOptions(d.id, e.recipe)}</select></div>`;
        if (r) html += `<div class="recipe">${r.in.map(([i, a]) => `<span class="ri" title="${h(SF.itemName(i))}">${chip(i, 22)}${fmt(a)}</span>`).join('<span class="muted">+</span>')} <span class="arr">→</span> ${r.out.map(([i, a]) => `<span class="ri" title="${h(SF.itemName(i))}">${chip(i, 22)}${fmt(a)}</span>`).join('<span class="muted">+</span>')} <span class="muted">in ${fmt(r.time)} s</span></div>`;
        let tune = slider('i-clock', 'Clock speed', Math.round((e.clock ?? 1) * 10000) / 100, 1, 250, 0.5, '%', `<div class="sub" id="i-shards"></div>`);
        if (b.sloops) {
          tune += `<div class="row"><label>Somersloops</label><div class="seg" id="i-sloops">${Array.from({ length: b.sloops + 1 }, (_, i) => `<button data-v="${i}" class="${(e.sloops || 0) === i ? 'on' : ''}">${i}</button>`).join('')}</div>
            <div class="sub">Output ×${fmt(1 + (e.sloops || 0) / b.sloops)} · power ×${fmt(Math.pow(1 + (e.sloops || 0) / b.sloops, 2))}</div></div>`;
        }
        html += fold('clock', 'Clock speed' + (b.sloops ? ' & somersloops' : ''), tune, clockNote(e));
        if (r) html += fold('ratio', 'Ratio helper', `<div class="ctl"><input type="number" id="i-target" placeholder="target ${h(SF.itemName(r.out[0][0]))} / min" min="0" step="any"></div><div class="sub" id="i-ratio"></div>`, 'how many machines?');
        break;
      }
      case 'extractor': {
        html += `<div class="row"><label>Resource</label><select id="i-res">${b.resources.map(k => `<option value="${k}" ${k === e.resource ? 'selected' : ''}>${h(SF.itemName(k))}</option>`).join('')}</select></div>`;
        if (b.purity) html += `<div class="row"><label>Node purity</label><div class="seg" id="i-purity">${SF.PURITY.map(p => `<button data-v="${p.v}" class="${(e.purity ?? 1) === p.v ? 'on' : ''}">${p.n}</button>`).join('')}</div></div>`;
        html += fold('clock', 'Clock speed', slider('i-clock', 'Clock speed', Math.round((e.clock ?? 1) * 10000) / 100, 1, 250, 0.5, '%', `<div class="sub" id="i-shards"></div>`), clockNote(e));
        break;
      }
      case 'generator': {
        if (b.geo) {
          html += `<div class="row"><label>Geyser purity</label><div class="seg" id="i-purity">${SF.PURITY.map(p => `<button data-v="${p.v}" class="${(e.purity ?? 1) === p.v ? 'on' : ''}">${p.n}</button>`).join('')}</div><div class="sub">Average output; real output oscillates.</div></div>`;
        } else {
          html += `<div class="row"><label>Fuel</label><select id="i-fuel">${b.fuels.map(f => `<option value="${f.fuel}" ${f.fuel === e.fuel ? 'selected' : ''}>${h(SF.itemName(f.fuel))}${f.supp ? ' + ' + h(SF.itemName(f.supp)) : ''}</option>`).join('')}</select></div>`;
          html += fold('clock', 'Clock speed', slider('i-clock', 'Clock speed', Math.round((e.clock ?? 1) * 10000) / 100, 1, 250, 0.5, '%', `<div class="sub" id="i-shards"></div>`), clockNote(e));
        }
        break;
      }
      case 'splitter': {
        if (b.smart) {
          const opts = cur => `<option value="any" ${cur === 'any' ? 'selected' : ''}>Any</option><option value="none" ${cur === 'none' ? 'selected' : ''}>None</option>
            <option value="anyUndefined" ${cur === 'anyUndefined' ? 'selected' : ''}>Any undefined</option><option value="overflow" ${cur === 'overflow' ? 'selected' : ''}>Overflow</option>
            <optgroup label="Item">${itemOptions((k, v) => !v.fluid, cur)}</optgroup>`;
          const prog = d.id.includes('Programmable');
          ['Left', 'Center', 'Right'].forEach((nm, k) => {
            const rule = (e.rules && e.rules[k]) || ['any'];
            html += `<div class="row"><label>${nm} output</label>`;
            if (prog) {
              html += `<div class="rules" data-k="${k}">${rule.map((t, j) => `<span class="rule">${D.items[t] ? chip(t, 14) : ''}${h(D.items[t] ? SF.itemName(t) : { any: 'Any', none: 'None', anyUndefined: 'Any undefined', overflow: 'Overflow' }[t])}<button data-del="${j}">×</button></span>`).join('')}
                <select class="addrule"><option value="">+ add filter…</option>${opts('')}</select></div>`;
            } else html += `<select class="rule1" data-k="${k}">${opts(rule[0])}</select>`;
            html += `</div>`;
          });
        } else html += `<p class="muted">Splits items evenly between connected outputs. Outputs that back up pass their share to the others.</p>`;
        break;
      }
      case 'merger': {
        if (b.priority) {
          ['Left', 'Center', 'Right'].forEach((nm, k) => {
            const p = (e.prio || [])[k] ?? 2;
            html += `<div class="row"><label>${nm} input</label><div class="seg prio" data-k="${k}">${[[1, 'High'], [2, 'Normal'], [3, 'Low']].map(([v, n]) => `<button data-v="${v}" class="${p === v ? 'on' : ''}">${n}</button>`).join('')}</div></div>`;
          });
        } else html += `<p class="muted">Takes items from all inputs in turn.</p>`;
        break;
      }
      case 'pressurizer':
        html += slider('i-clock', 'Clock speed', Math.round((e.clock ?? 1) * 10000) / 100, 1, 250, 0.5, '%', `<div class="sub" id="i-shards"></div>`);
        html += `<p class="muted">Powers the Resource Well Extractors on its well. Item output comes from the extractors.</p>`;
        break;
      case 'deco':
        html += `<p class="muted">Placed for layout; not part of the throughput or power simulation.</p>`;
        break;
      case 'pole':
        html += `<div class="row"><label>Height</label><div class="ctl"><input type="range" id="i-ph-r" min="0" max="20" step="0.5" value="${e.h ?? 1}"><input type="number" id="i-ph" min="0" max="40" step="0.5" value="${e.h ?? 1}"><span class="u">m</span></div><div class="sub">${(() => {
          if (d.ports[0].fluid) return 'Pipes slope between supports of different heights.';
          const hh = e.h ?? 1;
          // game poles: Conveyor Pole 1–7 m (2 m steps); taller = Stackable Conveyor Poles (3 m base + 2 m each)
          const kind = hh <= 7 ? (hh < 1 ? '<span class="bad">lower than any conveyor pole (1 m minimum)</span>' : 'In game: <b>Conveyor Pole</b> (1–7 m)')
            : `In game: <b>Stackable Conveyor Pole</b> ×${Math.max(1, Math.ceil((hh - 3) / 2) + 1)} (3 m + 2 m per stack)`;
          return kind + ' · belts slope between poles of different heights.';
        })()}</div></div>
          <div class="row"><label>Facing</label><div class="ctl"><input type="range" id="i-pa" min="-180" max="180" step="15" value="${Math.round((e.ang || 0) * 180 / Math.PI)}"><span class="u" id="i-pa-v">${Math.round((e.ang || 0) * 180 / Math.PI)}°</span></div></div>`;
        break;
      case 'pump':
        if (d.id === 'Build_Valve_C') html += `<div class="row"><label>Flow limit</label><div class="ctl"><input type="number" id="i-limit" value="${e.limit ?? 600}" min="0" step="any"><span class="u">m³/min</span></div></div>`;
        else html += `<p class="muted">Head lift ${fmt(b.headLift)} m (still flows up to ${fmt(b.headMax || b.headLift)} m). A pump resets the head: fluid leaving it can rise ${fmt(b.headLift)} m above its outlet. Pipes that go higher than the head reaching them are flagged and carry less (or nothing) in both Free run and Sim.</p>`;
        break;
      case 'source': {
        const fluid = d.id === 'V_SourceF';
        html += `<div class="row"><label>Item</label><select id="i-item">${itemOptions((k, v) => v.fluid === fluid, e.item)}</select></div>
          <div class="row"><label>Rate</label><div class="ctl"><input type="number" id="i-rate" value="${e.rate || 0}" min="0" step="any"><span class="u">/min</span></div><div class="sub">0 = unlimited (limited by the belt or pipe)</div></div>
          <div class="row"><label>Name</label><input type="text" id="i-name" value="${h(e.name || '')}" placeholder="e.g. From main bus"></div>`;
        break;
      }
      case 'vsink':
        html += `<div class="row"><label>Name</label><input type="text" id="i-name" value="${h(e.name || '')}" placeholder="e.g. To storage"></div>
          <div class="row"><label>Max intake</label><div class="ctl"><input type="number" id="i-rate" value="${e.rate || 0}" min="0" step="any"><span class="u">/min</span></div><div class="sub">0 = takes everything</div></div>`;
        break;
      case 'label':
        html += `<div class="row"><label>Text</label><input type="text" id="i-text" value="${h(e.text || '')}"></div>
          <div class="row"><label>Size</label><div class="ctl"><input type="number" id="i-size" value="${e.size || 1.6}" min="0.3" step="0.1"><span class="u">m</span></div></div>
          <div class="row"><label>Colour</label><input type="color" id="i-color" value="${e.color || '#e5e7eb'}"></div>`;
        break;
      case 'zone':
        html += `<div class="row"><label>Title</label><input type="text" id="i-text" value="${h(e.text || '')}"></div>
          <div class="row"><label>Size</label><div class="ctl"><input type="number" id="i-w" value="${e.w}" min="1" step="1"><span class="u">×</span><input type="number" id="i-h" value="${e.h}" min="1" step="1"><span class="u">m</span></div></div>
          <div class="row"><label>Colour</label><input type="color" id="i-color" value="${e.color || '#a78bfa'}"></div>`;
        break;
      case 'designer': {
        const fit = SF.designerFit(e);
        html += `<div class="row"><label>Note</label><input type="text" id="i-text" value="${h(e.text || '')}"></div>
          <p>${fit.inside} object(s) inside${fit.partial ? `, <b class="bad">${fit.partial} sticking out</b>` : ''}.</p>
          <p class="muted">Everything fully inside the frame can be saved as one in-game blueprint.</p>
          <button class="wide" data-act="bpdesigner">★ Save contents as blueprint</button>`;
        break;
      }
      case 'storage':
        html += `<p class="muted">${b.fluidStorage ? 'Fluid buffer' : `${b.slots} slots`}. With outputs connected it passes items through; with no outputs it fills up.</p>`;
        break;
      case 'sink':
        html += `<p class="muted">${b.awesome ? 'Turns items into FICSIT coupons. Points per minute shown below.' : 'Accepts items.'}</p>`;
        break;
    }
    if (d.structure) {
      const variants = D.structures.filter(s => s.name === d.name && s.kind === d.kind);
      if (variants.length > 1) {
        html += `<div class="row"><label>Material</label><div class="seg" id="i-mat">${variants.map(v => `<button data-v="${v.id}" class="${v.id === d.id ? 'on' : ''}">${h(v.mat)}</button>`).join('')}</div></div>`;
      }
      html += `<div class="row"><label>Raised by</label><input type="number" id="i-dz" step="1" value="${e.dz || 0}"><div class="sub">Metres above the floor (stack walls: 0, 4, 8 …). Height ${fmt(d.raw.z)} m.</div></div>`;
    }
    html += `<div id="ins-stats"></div>`;
    const cost = d.raw && d.raw.cost;
    if (cost && cost.length) html += fold('cost', 'Build cost', `<div class="costs">${costHTML(cost)}</div>`);
    return html;
  }
  const clockNote = e => `${fmt((e.clock ?? 1) * 100, 1)} %${e.sloops ? ` · ${e.sloops} sloop${e.sloops > 1 ? 's' : ''}` : ''}`;

  function setProp(e, k, v, rerender = false) {
    e[k] = v;
    SF.changed();
    if (rerender) renderInspector();
  }

  function bindClock(e) {
    const n = $('#i-clock'), r = $('#i-clock-r');
    if (!n) return;
    const shards = () => {
      const c = e.clock ?? 1;
      const s = SF.shardsFor(c);
      const d = SF.defs[e.def];
      const pw = d.kind === 'generator' ? '' : ` · ${fmt(SF.machinePower(e, d), 1)} MW`;
      $('#i-shards').innerHTML = `${s ? `${s} power shard${s > 1 ? 's' : ''}` : 'No power shards'}${pw}`;
    };
    const apply = v => {
      v = SF.clamp(+v || 100, 1, 250);
      e.clock = Math.round(v * 100) / 10000;
      shards();
    };
    r.oninput = () => { n.value = r.value; apply(r.value); SF.touch(); SF.sim.request(); };
    r.onchange = () => SF.changed();
    n.onchange = () => { apply(n.value); r.value = n.value; SF.changed(); };
    shards();
  }

  function bindActions(e) {
    document.querySelectorAll('#tab-inspect [data-act]').forEach(b => {
      b.onclick = () => {
        const a = b.dataset.act;
        if (a === 'rot') SF.rotateSelection(1);
        if (a === 'del') SF.deleteSelection();
        if (a === 'dup') { if (SF.copySelection()) SF.pasteClipboard(); }
        if (a === 'bp') saveBlueprint([...SF.sel.ents]);
        if (a === 'bpdesigner' && e) {
          const r = SF.entRect(e);
          const ids = [...S.entities.values()].filter(o => o.level === e.level && o.id !== e.id && (() => {
            const q = SF.entRect(o); return q.x0 >= r.x0 - 1e-6 && q.x1 <= r.x1 + 1e-6 && q.y0 >= r.y0 - 1e-6 && q.y1 <= r.y1 + 1e-6;
          })()).map(o => o.id);
          saveBlueprint(ids, e.text);
        }
      };
    });
  }

  function saveBlueprint(ids, def) {
    if (!ids.length) { SF.toast('Nothing to save', 'warn'); return; }
    const name = prompt('Blueprint name', def || 'My blueprint');
    if (!name) return;
    SF.library.add(name, SF.makeGroup(ids));
    SF.toast(`Saved blueprint “${name}”`);
    cat = 'Blueprints';
    SF.renderPalette();
  }

  function bindEntity(e) {
    bindActions(e);
    bindClock(e);
    const on = (sel, ev, fn) => { const el = $(sel); if (el) el[ev] = fn; };
    on('#i-recipe', 'onchange', ev => setProp(e, 'recipe', ev.target.value || null, true));
    on('#i-res', 'onchange', ev => setProp(e, 'resource', ev.target.value));
    on('#i-fuel', 'onchange', ev => setProp(e, 'fuel', ev.target.value));
    on('#i-item', 'onchange', ev => setProp(e, 'item', ev.target.value));
    on('#i-rate', 'onchange', ev => setProp(e, 'rate', Math.max(0, +ev.target.value || 0)));
    on('#i-limit', 'onchange', ev => setProp(e, 'limit', Math.max(0, +ev.target.value || 0)));
    on('#i-name', 'oninput', ev => { e.name = ev.target.value; SF.touch(); });
    on('#i-name', 'onchange', () => SF.changed());
    on('#i-text', 'oninput', ev => { e.text = ev.target.value; SF.touch(); });
    on('#i-text', 'onchange', () => SF.changed());
    on('#i-size', 'onchange', ev => setProp(e, 'size', Math.max(0.3, +ev.target.value || 1.6)));
    on('#i-color', 'oninput', ev => { e.color = ev.target.value; SF.touch(); });
    on('#i-color', 'onchange', () => SF.changed());
    on('#i-w', 'onchange', ev => setProp(e, 'w', Math.max(1, +ev.target.value || 1)));
    on('#i-h', 'onchange', ev => setProp(e, 'h', Math.max(1, +ev.target.value || 1)));
    const seg = (sel, fn) => { const el = $(sel); if (el) el.onclick = ev => { const b = ev.target.closest('button'); if (b) fn(b.dataset.v); }; };
    seg('#i-sloops', v => setProp(e, 'sloops', +v, true));
    const ph = $('#i-ph'), phr = $('#i-ph-r');
    if (ph) {
      phr.oninput = () => { ph.value = phr.value; e.h = +phr.value; SF.touch(); };
      phr.onchange = () => SF.changed();
      ph.onchange = () => { e.h = SF.clamp(+ph.value || 0, 0, 40); phr.value = e.h; SF.changed(); };
      const pa = $('#i-pa');
      pa.oninput = () => { e.ang = +pa.value * Math.PI / 180; $('#i-pa-v').textContent = pa.value + '°'; SF.touch(); };
      pa.onchange = () => SF.changed();
    }
    seg('#i-purity', v => setProp(e, 'purity', +v, true));
    seg('#i-mat', v => { e.def = v; SF.changed(); renderInspector(); });
    on('#i-dz', 'onchange', ev => { const v = +ev.target.value || 0; if (v) e.dz = v; else delete e.dz; SF.changed(); });
    on('#i-dz', 'onkeydown', ev => ev.stopPropagation());
    document.querySelectorAll('#tab-inspect .prio').forEach(el => {
      el.onclick = ev => {
        const b = ev.target.closest('button'); if (!b) return;
        e.prio = (e.prio || [2, 2, 2]).slice(); e.prio[+el.dataset.k] = +b.dataset.v; SF.changed(); renderInspector();
      };
    });
    document.querySelectorAll('#tab-inspect .rule1').forEach(el => {
      el.onchange = () => { e.rules = (e.rules || [['any'], ['any'], ['any']]).map(r => r.slice()); e.rules[+el.dataset.k] = [el.value]; SF.changed(); };
    });
    document.querySelectorAll('#tab-inspect .rules').forEach(el => {
      const k = +el.dataset.k;
      const rules = () => { e.rules = (e.rules || [['any'], ['any'], ['any']]).map(r => r.slice()); return e.rules; };
      el.querySelector('.addrule').onchange = ev => {
        const v = ev.target.value; if (!v) return;
        const R = rules(); R[k] = R[k].filter(t => t !== v && !(['any', 'none'].includes(t) && D.items[v])).concat([v]);
        if (!D.items[v]) R[k] = [v];
        SF.changed(); renderInspector();
      };
      el.querySelectorAll('[data-del]').forEach(b => {
        b.onclick = () => { const R = rules(); R[k].splice(+b.dataset.del, 1); if (!R[k].length) R[k] = ['none']; SF.changed(); renderInspector(); };
      });
    });
    const tgt = $('#i-target');
    if (tgt) {
      tgt.oninput = () => {
        const r = D.recipes[e.recipe];
        const d = SF.defs[e.def];
        const mult = d.raw.sloops ? 1 + (e.sloops || 0) / d.raw.sloops : 1;
        const per = r.out[0][1] * mult * 60 / r.time; // per machine at 100%
        const want = +tgt.value;
        if (!want) { $('#i-ratio').innerHTML = ''; return; }
        const n = want / per, whole = Math.ceil(n - 1e-9);
        const clock = want / whole / per;
        const ingredients = r.in.map(([i, a]) => `${chip(i, 12)}${fmt(a * 60 / r.time * n, 2)}`).join(' ');
        $('#i-ratio').innerHTML = `${fmt(n, 3)} machines at 100% → <b>${whole} × ${fmt(clock * 100, 2)}%</b><br>needs ${ingredients} /min
          ${n <= 2.5 ? `<button id="i-ratio-set">Set this machine to ${fmt(n * 100, 2)}%</button>` : ''}`;
        const btn = $('#i-ratio-set');
        if (btn) btn.onclick = () => { setProp(e, 'clock', Math.round(n * 10000) / 10000, true); };
      };
    }
  }

  // Sim mode: what is physically inside a building right now
  function liveHTML(e, d, r) {
    const L = r.live;
    const slot = (it, v, cap) => {
      const fl = SF.item(it).fluid;
      return `<div class="slotrow"><span class="nm">${itemCell(it)}</span><div class="bar"><i style="width:${cap ? SF.clamp(v / cap * 100, 0, 100) : 0}%;background:${SF.item(it).color}"></i></div><span class="v">${fmt(v, fl ? 1 : 0)}${cap ? ' / ' + fmt(cap, 0) : ''}</span></div>`;
    };
    let html = '<div class="livebox">';
    if (d.kind === 'machine' && D.recipes[e.recipe]) {
      const rc = D.recipes[e.recipe];
      const cyc = rc.time / (e.clock ?? 1);
      html += `<div class="sec">Crafting cycle</div><div class="slotrow"><span class="nm">${L.running ? 'Running' : 'Waiting'}</span><div class="bar" style="flex-basis:120px"><i style="width:${L.progress * 100}%;background:#22c55e"></i></div><span class="v">${fmt(L.progress * cyc, 1)} / ${fmt(cyc, 1)} s</span></div>`;
      html += '<div class="sec">Input slots</div>' + rc.in.map(([i]) => slot(i, L.inv[i] || 0, L.capIn && L.capIn(i))).join('');
      html += '<div class="sec">Output slots</div>' + rc.out.map(([i]) => slot(i, L.out[i] || 0, L.capOut && L.capOut(i))).join('');
    } else if (d.kind === 'extractor') {
      for (const it in L.out) html += '<div class="sec">Output buffer</div>' + slot(it, L.out[it], SF.item(it).fluid ? 50 : SF.item(it).stack);
    } else if (d.kind === 'generator') {
      html += '<div class="sec">Fuel inventory</div>' + (Object.keys(L.inv).length ? Object.entries(L.inv).map(([i, v]) => slot(i, v, SF.item(i).fluid ? 50 : SF.item(i).stack)).join('') : '<div class="muted small">Empty</div>');
      const fl = e.fuel && SF.item(e.fuel);
      if (fl && !fl.fluid && L.progress > 0 && L.running) html += `<div class="muted small">Burning — ${fmt(L.progress * 100, 0)}% of the current item used</div>`;
    } else if (d.kind === 'storage') {
      html += `<div class="sec">Contents</div><div class="slotrow"><span class="nm">${L.capacity || ''}</span><div class="bar" style="flex-basis:120px"><i style="width:${(L.fill || 0) * 100}%;background:${L.fill > 0.98 ? '#ef4444' : '#38bdf8'}"></i></div><span class="v">${fmt((L.fill || 0) * 100, 0)}%</span></div>`;
      const ents = Object.entries(L.inv).filter(([, v]) => v > 1e-6);
      html += ents.length ? ents.map(([i, v]) => slot(i, v, 0)).join('') : '<div class="muted small">Empty</div>';
      const inRate = Object.values(r.ins).reduce((a, b) => a + b, 0) - Object.values(r.outs).reduce((a, b) => a + b, 0);
      if (inRate > 0.01 && L.fill < 1) {
        const slots = d.raw.slots || 24, mins = (1 - L.fill) * (d.raw.fluidStorage ? d.raw.capacity : slots * (SF.item(ents[0] ? ents[0][0] : '').stack || 100)) / inRate;
        html += `<div class="muted small">Full in about ${mins > 120 ? fmt(mins / 60, 1) + ' h' : fmt(mins, 1) + ' min'} at the current rate</div>`;
      } else if (L.fill >= 0.999) html += '<div class="bad small">Full — incoming belts are backing up</div>';
    } else if (L.buf) html += '<div class="sec">Holding</div>' + slot(L.buf, 1, 0);
    else return '';
    return html + '</div>';
  }

  // live stats section (re-rendered on each sim result)
  function renderStats() {
    const box = $('#ins-stats');
    if (!box) return;
    const res = SF.sim.result;
    const ents = [...SF.sel.ents], links = [...SF.sel.links];
    if (!res) { box.innerHTML = '<div class="muted">Simulating…</div>'; return; }
    if (ents.length === 1) {
      const e = S.entities.get(ents[0]);
      const d = SF.defs[e.def];
      const r = res.nodes.get(e.id);
      if (!r) { box.innerHTML = ''; return; }
      let html = '';
      if (['machine', 'extractor', 'generator'].includes(d.kind)) {
        html += `<div class="status" style="--c:${SF.STATUS_COLOR[r.status]}"><span class="dot"></span>${SF.STATUS_TEXT[r.status]}<span class="pct">${fmt(r.eff * 100, 1)}%</span></div>
          <div class="bar"><i style="width:${SF.clamp(r.eff * 100, 0, 100)}%;background:${SF.STATUS_COLOR[r.status]}"></i></div>`;
      }
      const rows = (title, act, max) => {
        const keys = [...new Set([...Object.keys(max || {}), ...Object.keys(act || {})])];
        if (!keys.length) return '';
        return `<div class="sec">${title}</div><table class="io"><tr><th>Item</th><th>Actual</th>${max ? '<th>Max</th>' : ''}</tr>` + keys.map(k => {
          const a = (act || {})[k] || 0, m = max ? max[k] || 0 : 0;
          const cls = max && m > 0 && a < m * 0.995 ? 'warn' : '';
          return `<tr><td>${itemCell(k)}</td><td class="${cls}">${fmt(a, 2)}</td>${max ? `<td>${fmt(m, 2)}</td>` : ''}</tr>`;
        }).join('') + `</table>`;
      };
      if (r.live) html += liveHTML(e, d, r);
      html += rows(r.live ? 'Inputs /min (live)' : 'Inputs /min', r.ins, r.maxIn);
      html += rows(r.live ? 'Outputs /min (live)' : 'Outputs /min', r.outs, r.maxOut);
      if (Object.keys(r.voided || {}).length) html += rows('Spilling off an open end /min', r.voided) + '<div class="muted small">Connect this output to keep the items, or turn on “Open ends back up” in the View menu for strict in-game behaviour.</div>';
      if (d.kind === 'machine' || d.kind === 'extractor') html += `<div class="kv"><span>Power</span><b>${fmt(r.power, 2)} MW</b><span class="muted">max ${fmt(SF.machinePower(e, d), 2)}</span></div>`;
      if (d.kind === 'generator') html += `<div class="kv"><span>Generating</span><b>${fmt(r.gen, 1)} MW</b><span class="muted">max ${fmt(r.maxGen || 0, 1)}</span></div>`;
      if (d.kind === 'sink' && d.raw.awesome) {
        let pts = 0; for (const it in r.ins) pts += r.ins[it] * (SF.item(it).sink || 0);
        html += `<div class="kv"><span>Sink points</span><b>${fmt(pts, 0)} /min</b></div>`;
      }
      // unconnected ports
      const free = d.ports.map((p, i) => ({ p, i })).filter(({ i }) => !S.portLinks.has(SF.portKey(e.id, i)));
      if (d.kind === 'machine' && free.length) html += `<div class="muted small">${free.length} unconnected port(s).</div>`;
      box.innerHTML = html;
    } else if (links.length === 1) {
      const r = res.edges.get(links[0]);
      if (!r) { box.innerHTML = ''; return; }
      const col = r.jam > 0.2 ? '#ef4444' : r.util > 0.995 ? '#f97316' : '#22c55e';
      let html = `<div class="status" style="--c:${col}"><span class="dot"></span>${r.jam > 0.2 ? 'Jammed — ' + h(SF.itemName(r.jamItem)) + ' is not accepted downstream' : r.util > 0.995 ? 'At full capacity' : 'Flowing'}<span class="pct">${fmt(r.util * 100, 1)}%</span></div>
        <div class="bar"><i style="width:${SF.clamp(r.util * 100, 0, 100)}%;background:${col}"></i></div>
        <div class="kv"><span>Throughput</span><b>${fmt(r.total, 2)} / ${fmt(r.cap, 0)} per min</b></div>`;
      if (r.count != null) {
        const l = S.links.get(links[0]);
        html += `<div class="kv"><span>${l.kind === 'pipe' ? 'Fluid in pipe' : 'Items on belt'}</span><b>${fmt(r.count, l.kind === 'pipe' ? 1 : 0)}${l.kind === 'pipe' ? ' m³' : ''}</b>${r.full ? '<span class="bad">backed up</span>' : ''}</div>`;
      }
      const keys = Object.keys(r.flows);
      if (keys.length) html += `<table class="io"><tr><th>Item</th><th>/min</th></tr>${keys.map(k => `<tr><td>${itemCell(k)}</td><td>${fmt(r.flows[k], 2)}</td></tr>`).join('')}</table>`;
      box.innerHTML = html;
    }
  }

  function linkHTML(l) {
    const spec = SF.linkSpec(l);
    const list = l.kind === 'pipe' ? D.pipes : D.belts;
    const ea = S.entities.get(l.from[0]), eb = S.entities.get(l.to[0]);
    const len = SF.linkLength(l);
    const lift = ea.level !== eb.level ? `<p>Crosses floors: ${h(S.levels[ea.level].name)} → ${h(S.levels[eb.level].name)} (lift).</p>` : '';
    return `<div class="ins-h" style="--c:${l.kind === 'pipe' ? '#38bdf8' : '#f59e0b'}"><div><div class="t">${h(spec.name)}</div><div class="s">${h(SF.defs[ea.def].name)} → ${h(SF.defs[eb.def].name)} · ${fmt(len, 1)} m</div></div></div>
      <div class="actions icons"><button data-act="lreset" title="Straighten: remove bend points">↺<span>Reset route</span></button><button data-act="ldel" class="danger" title="Delete">🗑<span>Delete</span></button></div>
      <div class="row"><label>Tier</label><div class="seg" id="i-tier">${list.map(b => `<button data-v="${b.tier}" class="${b.tier === l.tier ? 'on' : ''}" title="${b.rate}/min">Mk${b.tier}</button>`).join('')}</div><div class="sub">${spec.rate} ${l.kind === 'pipe' ? 'm³' : 'items'}/min</div></div>
      ${SF.linkProblems(l).map(p => `<div class="bad small">⚠ ${h(p.text)}</div>`).join('')}
      ${lift}<div id="ins-stats"></div>
      ${fold('route', 'Route & shape', `<div class="row"><label>Style</label><div class="seg" id="i-style">${SF.BELT_STYLES.map(([v, n]) => `<button data-v="${v}" class="${SF.linkStyle(l) === v ? 'on' : ''}">${n}</button>`).join('')}</div>
        <div class="sub">${(() => {
          const P3 = SF.linkPath3D(l), probs = SF.linkProblems(l), r = SF.pathMinRadius(P3);
          const facts = `Tightest turn ${r === Infinity ? 'none' : fmt(r, 1) + ' m'} · steepest ${fmt(Math.atan(SF.pathMaxSlope(P3)) * 180 / Math.PI, 0)}°`;
          return facts + (probs.length ? '' : ' · <span class="good">buildable in game</span>');
        })()}</div></div>
      <p class="muted small">${(l.pts || []).length} bend point(s). Double-click the belt to add one; drag the handles to move; double-click a handle to remove it.</p>`, SF.BELT_STYLES.find(([v]) => v === SF.linkStyle(l))?.[1] || '')}
      ${spec.cost && spec.cost.length ? fold('lcost', 'Cost per segment', `<div class="costs">${costHTML(spec.cost)}</div>`) : ''}`;
  }

  function bindLink(l) {
    $('#i-tier').onclick = ev => { const b = ev.target.closest('button'); if (!b) return; l.tier = +b.dataset.v; SF.changed(); renderInspector(); };
    $('#i-style').onclick = ev => { const b = ev.target.closest('button'); if (!b) return; l.route = b.dataset.v; delete l.direct; SF.changed(); renderInspector(); };
    document.querySelectorAll('#tab-inspect [data-act]').forEach(b => {
      b.onclick = () => {
        if (b.dataset.act === 'lreset') { l.pts = []; SF.changed(); renderInspector(); }
        if (b.dataset.act === 'ldel') { S.links.delete(l.id); SF.changed(); SF.selectOnly(); }
      };
    });
  }

  function multiHTML(ents, links) {
    const counts = {};
    ents.forEach(e => { counts[e.def] = (counts[e.def] || 0) + 1; });
    const machines = ents.filter(e => ['machine', 'extractor', 'generator'].includes(SF.defs[e.def].kind) && !SF.defs[e.def].raw.geo);
    const sameMachine = machines.length && machines.length === ents.length && new Set(machines.map(e => e.def)).size === 1 && SF.defs[machines[0].def].kind === 'machine';
    const cost = {};
    ents.forEach(e => (SF.defs[e.def].raw?.cost || []).forEach(([i, a]) => { cost[i] = (cost[i] || 0) + a; }));
    let html = `<div class="ins-h" style="--c:#38bdf8"><div><div class="t">${ents.length} objects${links.length ? `, ${links.length} belts/pipes` : ''}</div><div class="s">Multiple selection</div></div></div>
      ${ACTIONS}
      ${fold('selcount', 'What is selected', `<table class="io">${Object.entries(counts).map(([d, n]) => `<tr><td>${h(SF.defs[d].name)}</td><td>×${n}</td></tr>`).join('')}</table>`, Object.keys(counts).length + ' kinds')}`;
    if (sameMachine) html += `<div class="row"><label>Recipe (all)</label><select id="m-recipe">${recipeOptions(machines[0].def, machines.every(m => m.recipe === machines[0].recipe) ? machines[0].recipe : '')}</select></div>`;
    if (machines.length) html += `<div class="row"><label>Clock (all)</label><div class="ctl"><input type="number" id="m-clock" placeholder="%" min="1" max="250" step="any"><span class="u">%</span><button id="m-clock-set">Apply</button></div></div>`;
    const beltLinks = links.filter(l => l.kind === 'belt'), pipeLinks = links.filter(l => l.kind === 'pipe');
    if (beltLinks.length) html += `<div class="row"><label>Belt tier (${beltLinks.length})</label><div class="seg" id="m-btier">${D.belts.map(b => `<button data-v="${b.tier}">Mk${b.tier}</button>`).join('')}</div></div>`;
    if (pipeLinks.length) html += `<div class="row"><label>Pipe tier (${pipeLinks.length})</label><div class="seg" id="m-ptier">${D.pipes.map(b => `<button data-v="${b.tier}">Mk${b.tier}</button>`).join('')}</div></div>`;
    if (Object.keys(cost).length) html += fold('mcost', 'Total build cost', `<div class="costs">${costHTML(Object.entries(cost))}</div>`);
    return html;
  }

  function bindMulti(ents, links) {
    bindActions(null);
    const mr = $('#m-recipe');
    if (mr) mr.onchange = () => { ents.forEach(e => { e.recipe = mr.value || null; }); SF.changed(); };
    const mc = $('#m-clock-set');
    if (mc) mc.onclick = () => {
      const v = SF.clamp(+$('#m-clock').value || 100, 1, 250) / 100;
      ents.forEach(e => { if (['machine', 'extractor', 'generator'].includes(SF.defs[e.def].kind)) e.clock = v; });
      SF.changed();
    };
    const tierSeg = (sel, kind) => { const el = $(sel); if (el) el.onclick = ev => { const b = ev.target.closest('button'); if (!b) return; links.forEach(l => { if (l.kind === kind) l.tier = +b.dataset.v; }); SF.changed(); }; };
    tierSeg('#m-btier', 'belt'); tierSeg('#m-ptier', 'pipe');
  }

  // ------------------------------------------------------------ factory summary
  // raw resources: what the extractors mine vs what the machines and generators want; shortfalls get node counts
  function rawBudgetHTML() {
    const rows = SF.calc.rawBudget().filter(r => r.want > 1e-6 || r.supply > 1e-6);
    if (!rows.length) return '';
    let out = `<div class="sec">Raw resources /min</div><table class="io bal"><tr><th>Resource</th><th>Mined</th><th>Wanted</th><th>Spare</th></tr>`;
    for (const r of rows) {
      const have = r.supply + r.external, raw = have - r.want, net = Math.abs(raw) < 0.05 ? 0 : raw;
      out += `<tr><td>${itemCell(r.item)}</td><td title="${r.extractors} extractor${r.extractors === 1 ? '' : 's'}${r.external ? ` + ${fmt(r.external, 1)} from inputs` : ''}">${fmt(have, 1)}</td><td>${fmt(r.want, 1)}</td><td class="${net < -0.01 ? 'bad' : net > 0.01 ? 'good' : ''}">${net > 0 ? '+' : ''}${fmt(net, 1)}</td></tr>`;
      if (r.short > 0.01) {
        const ex = SF.calc.extractOptions(r.item, r.short);
        const same = ex.every(o => o.nodes === ex[0].nodes);
        if (ex.length) out += `<tr class="hintrow"><td colspan="4">Short ${fmt(r.short, 1)}/min — add ${same ? `<b>${ex[0].nodes}</b>${ex[0].name ? ' node' + (ex[0].nodes === 1 ? '' : 's') + ' of any purity' : ''}` : ex.map(o => `<b>${o.nodes}</b> ${o.name ? o.name.toLowerCase() : ''}`).join(' or ') + (ex[0].name ? ' nodes' : '')} ${ex[0].name ? 'with a ' : ''}${h(SF.defs[ex[0].def].name)}${ex[0].locked ? ' (🔒)' : ''} at 100 %${ex.some(o => o.nodesOC < o.nodes) ? `, or ${ex.map(o => o.nodesOC).join(' / ')} overclocked to 250 %` : ''}.</td></tr>`;
      }
    }
    return out + '</table>';
  }

  function renderFactory() {
    const box = $('#tab-factory');
    const res = SF.sim.result;
    const counts = {}, cost = {};
    let beltLen = {}, pipeLen = {};
    for (const e of S.entities.values()) {
      const d = SF.defs[e.def];
      if (d.virtual) continue;
      counts[e.def] = (counts[e.def] || 0) + 1;
      (d.raw?.cost || []).forEach(([i, a]) => { cost[i] = (cost[i] || 0) + a; });
    }
    for (const l of S.links.values()) {
      const m = l.kind === 'pipe' ? pipeLen : beltLen;
      m[l.tier] = (m[l.tier] || 0) + SF.linkLength(l);
    }
    let html = '';
    if (res) {
      const s = res.summary;
      const bal = s.powerGen - s.powerUse;
      html += `<div class="cards">
        <div class="kpi"><div class="k"><svg><use href="#i-bolt"/></svg>Power use</div><div class="v">${fmt(s.powerUse, 1)}<small> MW</small></div><div class="muted small">max ${fmt(s.powerMax, 1)} MW</div></div>
        <div class="kpi"><div class="k"><svg><use href="#i-bolt"/></svg>Generation</div><div class="v">${fmt(s.powerGen, 1)}<small> MW</small></div><div class="small ${bal < 0 ? 'bad' : 'good'}">${bal < 0 ? 'deficit ' : 'surplus '}${fmt(Math.abs(bal), 1)} MW</div></div>
        ${s.sinkPoints ? `<div class="kpi"><div class="k">Sink points</div><div class="v">${fmt(s.sinkPoints, 0)}<small>/min</small></div></div>` : ''}
      </div>`;
      const bkeys = Object.keys(s.balance).sort((a, b) => SF.itemName(a).localeCompare(SF.itemName(b)));
      if (bkeys.length) {
        html += `<div class="sec">Production balance /min</div><table class="io bal"><tr><th>Item</th><th>Made</th><th>Used</th><th>Net</th></tr>`;
        html += bkeys.map(k => {
          const b = s.balance[k], net = b.prod - b.cons;
          return `<tr><td>${itemCell(k)}</td><td>${fmt(b.prod, 1)}</td><td>${fmt(b.cons, 1)}</td><td class="${net > 0.01 ? 'good' : net < -0.01 ? 'bad' : ''}">${net > 0 ? '+' : ''}${fmt(net, 1)}</td></tr>`;
        }).join('') + '</table>';
      }
      const ext = (title, m) => {
        const ks = Object.keys(m).filter(k => m[k] > 1e-6);
        return ks.length ? `<div class="sec">${title}</div><table class="io">${ks.map(k => `<tr><td>${itemCell(k)}</td><td>${fmt(m[k], 2)} /min</td></tr>`).join('')}</table>` : '';
      };
      html += rawBudgetHTML();
      html += ext('External inputs', s.external.in);
      html += ext('Leaving the factory (outputs, sinks, storage)', s.external.out);
    } else html += '<div class="muted">Simulating…</div>';
    const ck = Object.keys(counts).sort((a, b) => SF.defs[a].name.localeCompare(SF.defs[b].name));
    if (ck.length) html += `<div class="sec">Buildings</div><table class="io">${ck.map(k => `<tr><td>${h(SF.defs[k].name)}</td><td>×${counts[k]}</td></tr>`).join('')}</table>`;
    const lens = (m, list, kind) => Object.keys(m).map(t => `<tr><td>${h(list.find(b => b.tier === +t)?.name || kind + ' Mk' + t)}</td><td>${fmt(m[t], 1)} m</td></tr>`).join('');
    const lr = lens(beltLen, D.belts, 'Belt') + lens(pipeLen, D.pipes, 'Pipe');
    if (lr) html += `<div class="sec">Belts & pipes</div><table class="io">${lr}</table>`;
    if (Object.keys(cost).length) html += `<div class="sec">Build cost (buildings & structures)</div><div class="costs">${costHTML(Object.entries(cost).sort((a, b) => b[1] - a[1]))}</div>`;
    box.innerHTML = html || '<div class="muted">Empty plan.</div>';
  }

  // ------------------------------------------------------------ issues
  function collectIssues() {
    const res = SF.sim.result;
    const out = [];
    if (!res) return out;
    for (const e of S.entities.values()) {
      const d = SF.defs[e.def];
      const r = res.nodes.get(e.id);
      if (r && ['machine', 'extractor', 'generator'].includes(d.kind) && r.status !== 'ok') {
        out.push({ ent: e.id, sev: r.status === 'starved' || r.status === 'throttled' ? 1 : 2, text: `${d.name}: ${SF.STATUS_TEXT[r.status]} (${fmt(r.eff * 100, 0)}%)`, lvl: e.level });
      }
      if (d.kind === 'machine' && e.recipe) {
        const rc = D.recipes[e.recipe];
        const solidIn = rc.in.filter(([i]) => !SF.item(i).fluid).length, fluidIn = rc.in.length - solidIn;
        const conIn = f => d.ports.filter((p, i) => p.io === 'in' && p.fluid === f && S.portLinks.has(SF.portKey(e.id, i))).length;
        if (conIn(false) < solidIn || conIn(true) < fluidIn) out.push({ ent: e.id, sev: 1, text: `${d.name}: recipe needs ${solidIn} belt + ${fluidIn} pipe input(s), ${conIn(false)} + ${conIn(true)} connected`, lvl: e.level });
      }
      if (r && r.voided && Object.keys(r.voided).length) {
        const what = Object.entries(r.voided).filter(([, v]) => v > 1e-3).map(([k, v]) => `${fmt(v, 1)}/min ${SF.itemName(k)}`).join(', ');
        if (what) out.push({ ent: e.id, sev: 0, text: `${d.name}: open end — ${what} discarded`, lvl: e.level });
      }
      if (d.kind === 'designer') {
        const f = SF.designerFit(e);
        if (f.partial) out.push({ ent: e.id, sev: 1, text: `${d.name}: ${f.partial} object(s) cross the boundary`, lvl: e.level });
      }
    }
    for (const l of S.links.values()) {
      // game placement rules (turn radius, slope, length, climbing in a turn, lift height)
      for (const p of SF.linkProblems(l)) out.push({ link: l.id, sev: 1, text: `${SF.linkSpec(l).name}: ${p.text}` });
      const r = res.edges.get(l.id);
      if (!r) continue;
      if (r.jam > 0.2) out.push({ link: l.id, sev: 2, text: `Belt jammed: ${SF.itemName(r.jamItem)} is not accepted at the end` });
      else if (r.util > 0.995) out.push({ link: l.id, sev: 0, text: `${SF.linkSpec(l).name} at full capacity (${fmt(r.total, 0)}/min)` });
    }
    return out.sort((a, b) => b.sev - a.sev);
  }

  function renderIssues() {
    const list = collectIssues();
    $('#issue-count').textContent = list.filter(i => i.sev > 0).length || '';
    if (tab !== 'issues') return;
    const iconOf = it => {
      if (it.ent) return SF.iconHTML(S.entities.get(it.ent)?.def, 24);
      const l = S.links.get(it.link); return l ? SF.iconHTML(SF.linkSpec(l).id, 24) : '';
    };
    $('#tab-issues').innerHTML = list.length ? list.map((it, k) => `<button class="issue sev${it.sev}" data-k="${k}"><span class="sv"></span>${iconOf(it)}<span>${h(it.text)}</span></button>`).join('')
      : '<div class="empty">No problems found — everything is flowing.</div>';
    $('#tab-issues').onclick = ev => {
      const b = ev.target.closest('.issue'); if (!b) return;
      const it = list[+b.dataset.k];
      if (it.ent) SF.focusEntity(it.ent);
      else if (it.link) {
        const l = S.links.get(it.link);
        const P = SF.linkScreenPath(l);
        const mid = P.pts[Math.floor(P.pts.length / 2)];
        const ea = S.entities.get(l.from[0]);
        if (ea.level !== S.level) { S.level = ea.level; renderLevels(); }
        SF.view.cx = mid[0]; SF.view.cy = mid[1];
        SF.selectOnly([], [l.id]);
      }
    };
  }

  // ------------------------------------------------------------ tooltip
  SF.onHover = (hit, ev) => {
    const tip = $('#tip');
    const res = SF.sim.result;
    if (!hit || ed.drag || ed.tool === 'place' || (!hit.ent && !hit.link && !hit.port)) { tip.style.display = 'none'; return; }
    let html = '';
    if (hit.port) {
      const e = S.entities.get(hit.port[0]); const p = SF.defs[e.def].ports[hit.port[1]];
      html = `<b>${p.io === 'in' ? 'Input' : p.io === 'out' ? 'Output' : 'Port'}</b> ${p.label ? '· ' + h(p.label) : ''} · ${p.fluid ? 'pipe' : 'belt'}${S.portLinks.has(SF.portKey(...hit.port)) ? ' · connected' : ' · click to connect'}`;
    } else if (hit.ent) {
      const e = S.entities.get(hit.ent); const d = SF.defs[e.def];
      if (d.structure || ['label', 'zone'].includes(d.kind)) { tip.style.display = 'none'; return; }
      const r = res && res.nodes.get(e.id);
      const sub = d.kind === 'machine' && e.recipe ? `${h(D.recipes[e.recipe].name)} @ ${fmt((e.clock ?? 1) * 100, 1)}%` : h(d.cat);
      html = `<div class="head">${SF.iconHTML(d.id, 34)}<div><b>${h(d.name)}</b><div class="muted">${sub}</div></div></div>`;
      if (r && r.status && ['machine', 'extractor', 'generator'].includes(d.kind)) html += `<div style="color:${SF.STATUS_COLOR[r.status]}">${SF.STATUS_TEXT[r.status]} · ${fmt(r.eff * 100, 1)}%</div>`;
      if (r) {
        for (const [k, v] of Object.entries(r.ins)) html += `<div>${chip(k, 16)} −${fmt(v, 2)} ${h(SF.itemName(k))}</div>`;
        for (const [k, v] of Object.entries(r.outs)) html += `<div>${chip(k, 16)} +${fmt(v, 2)} ${h(SF.itemName(k))}</div>`;
        if (r.gen) html += `<div>⚡ ${fmt(r.gen, 1)} MW</div>`;
      }
    } else if (hit.link) {
      const l = S.links.get(hit.link);
      const r = res && res.edges.get(l.id);
      html = `<b>${h(SF.linkSpec(l).name)}</b> · ${fmt(SF.linkLength(l), 1)} m`;
      if (r) {
        html += `<div>${fmt(r.total, 2)} / ${fmt(r.cap, 0)} per min (${fmt(r.util * 100, 0)}%)</div>`;
        for (const [k, v] of Object.entries(r.flows)) html += `<div>${chip(k, 16)} ${fmt(v, 2)} ${h(SF.itemName(k))}</div>`;
      }
    }
    tip.innerHTML = html;
    tip.style.display = 'block';
    let x = ev.clientX + 16, y = ev.clientY + 16;
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    if (x + tw > window.innerWidth - 8) x = ev.clientX - tw - 12;
    if (y + th > window.innerHeight - 8) y = ev.clientY - th - 12;
    tip.style.left = x + 'px'; tip.style.top = y + 'px';
  };

  // ------------------------------------------------------------ status bar
  function renderStatus() {
    const m = ed.mouse;
    const sim = SF.sim;
    const res = sim.result;
    $('#st-pos').textContent = `${fmt(m.wx, 1)}, ${fmt(m.wy, 1)} m`;
    $('#st-zoom').textContent = `${Math.round(SF.view.zoom / 12 * 100)}%`;
    $('#st-count').textContent = `${S.entities.size} objects · ${S.links.size} links`;
    const s = $('#st-sim');
    renderSimBar();
    if (SF.live.active && res) {
      const p = res.summary;
      s.innerHTML = `<span style="color:#22c55e">● SIM</span> ${clock(SF.live.t)} · ⚡ ${fmt(p.powerUse, 1)} / ${fmt(p.powerGen, 1)} MW`;
      s.className = '';
    } else if (sim.running) { s.textContent = `Simulating ${Math.round(sim.progress * 100)}%`; s.className = 'busy'; }
    else if (res) {
      const p = res.summary;
      s.innerHTML = `⚡ ${fmt(p.powerUse, 1)} / ${fmt(p.powerGen, 1)} MW`;
      s.className = p.powerGen + 1e-6 < p.powerUse ? 'bad' : 'good';
    }
    $('#btn-undo').disabled = !SF.canUndo();
    $('#btn-redo').disabled = !SF.canRedo();
  }

  // ------------------------------------------------------------ example factory
  SF.loadExample = () => {
    SF.buildExample();
    SF.resetHistory();
    renderLevels();
    SF.selectOnly();
    SF.fitView();
  };

  // ------------------------------------------------------------ init
  SF.initUI = () => {
    try {
      const saved = JSON.parse(localStorage.getItem('sf-planner-settings') || '{}');
      // v2: open ends discard items by default so unfinished lines keep running
      if (!saved.settingsVersion || saved.settingsVersion < 2) { delete saved.openOutputsBlock; saved.settingsVersion = 2; }
      Object.assign(S.settings, saved);
    } catch (_) { /* ignore */ }
    initPalette();
    initToolbar();
    SF.renderPalette();
    renderTools();
    renderLevels();
    renderInspector();
    document.querySelectorAll('#right .tabs button').forEach(b => { b.onclick = () => showTab(b.dataset.tab); });
    SF.progress.onChange.push(() => { SF.renderPalette(); renderTools(); renderInspector(); if (tab === 'factory') renderFactory(); });
    SF.onChange(light => {
      if (light) return;                 // drags: recalculate once when the drag ends (SF.changed)
      SF.sim.request();
      renderLevels();
      // don't rebuild the inspector while the user is typing in it
      if (!$('#tab-inspect').contains(document.activeElement) || document.activeElement.tagName === 'BUTTON') {
        SF.sel.ents = new Set([...SF.sel.ents].filter(id => S.entities.has(id)));
        SF.sel.links = new Set([...SF.sel.links].filter(id => S.links.has(id)));
        renderInspector();
      }
      if (tab === 'factory') renderFactory();
    });
    // Sim mode publishes several times a second: refresh the heavier panels (factory totals, issue list) at most
    // every 2 s so big factories stay smooth; the selected object's stats stay live
    let lastHeavy = 0;
    SF.sim.onResult(res => {
      renderStats();
      const now = performance.now();
      if (res && res.live && now - lastHeavy < 2000) return;
      lastHeavy = now;
      if (tab === 'factory') renderFactory();
      renderIssues();
    });
    setInterval(renderStatus, 150);
  };
})(window.SF);
