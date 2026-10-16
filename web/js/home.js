// Home: the start screen. New factory, your saved factories (open, rename, duplicate, export, delete), the example
// and test factories, importing a file or a shared link, and settings. The open factory autosaves to its record.
(function (SF) {
  const S = SF.state, D = SF.D;
  const $ = (s, r = document) => r.querySelector(s);
  const h = SF.esc, fmt = SF.fmt;
  const LAST = 'sf-planner-last';

  let current = null;            // { id, name, created } of the open factory
  let loading = false;
  let lastThumb = 0;

  // ------------------------------------------------------------ thumbnails: a top-down sketch of every floor
  function thumbnail(W = 480, H = 300) {
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const g = c.getContext('2d');
    g.fillStyle = '#12151b'; g.fillRect(0, 0, W, H);
    const ents = [...S.entities.values()].filter(e => !['label', 'zone'].includes(SF.defs[e.def].kind));
    if (!ents.length) return c.toDataURL('image/jpeg', 0.8);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const e of ents) { const r = SF.entRect(e); x0 = Math.min(x0, r.x0); y0 = Math.min(y0, r.y0); x1 = Math.max(x1, r.x1); y1 = Math.max(y1, r.y1); }
    const pad = 14, sc = Math.min((W - pad * 2) / Math.max(8, x1 - x0), (H - pad * 2) / Math.max(8, y1 - y0));
    const ox = (W - (x1 - x0) * sc) / 2 - x0 * sc, oy = (H - (y1 - y0) * sc) / 2 - y0 * sc;
    const box = (e, col, a) => { const r = SF.entRect(e); g.globalAlpha = a; g.fillStyle = col; g.fillRect(ox + r.x0 * sc, oy + r.y0 * sc, Math.max(1, (r.x1 - r.x0) * sc), Math.max(1, (r.y1 - r.y0) * sc)); };
    for (const e of ents) { const d = SF.defs[e.def]; if (d.structure && d.kind !== 'wall') box(e, d.color, 0.35); }
    for (const e of ents) { const d = SF.defs[e.def]; if (d.structure && d.kind === 'wall') box(e, d.color, 0.6); }
    g.lineWidth = Math.max(1, Math.min(2.5, sc * 0.9)); g.lineCap = 'round';
    for (const l of S.links.values()) {
      if (l.kind === 'lift') continue;
      const a = S.entities.get(l.from[0]), b = S.entities.get(l.to[0]);
      if (!a || !b) continue;
      const A = SF.portWorld(a, l.from[1]), B = SF.portWorld(b, l.to[1]);
      if (!A || !B) continue;
      g.globalAlpha = 0.75; g.strokeStyle = l.kind === 'pipe' ? '#38bdf8' : '#f5a524';
      g.beginPath(); g.moveTo(ox + A.x * sc, oy + A.y * sc); g.lineTo(ox + B.x * sc, oy + B.y * sc); g.stroke();
    }
    for (const e of ents) { const d = SF.defs[e.def]; if (!d.structure) box(e, SF.CAT_COLOR[d.cat] || '#888', 0.95); }
    g.globalAlpha = 1;
    return c.toDataURL('image/jpeg', 0.8);
  }

  // ------------------------------------------------------------ records
  const stats = () => {
    let machines = 0;
    for (const e of S.entities.values()) if (['machine', 'extractor', 'generator'].includes(SF.defs[e.def].kind)) machines++;
    return { objects: S.entities.size, machines, floors: S.levels.length };
  };
  async function saveNow(withThumb) {
    if (!current) return;
    const rec = { ...current, updated: Date.now(), ...stats(), doc: SF.serialize() };
    if (withThumb || !current.thumb || Date.now() - lastThumb > 20000) { current.thumb = thumbnail(); lastThumb = Date.now(); }
    rec.thumb = current.thumb;
    try { await SF.store.put(rec); } catch (e) { SF.toast('Could not save: ' + e.message, 'warn'); }
  }
  let timer = 0;
  SF.autosave = () => {
    if (loading || !current) return;
    clearTimeout(timer);
    timer = setTimeout(() => saveNow(false), 800);
  };
  window.addEventListener('beforeunload', () => { if (current) { clearTimeout(timer); saveNow(false); } });

  function setTitle() {
    const t = $('#brand .title span');
    if (t) { t.textContent = current ? current.name : 'Factory planner'; t.title = current ? 'Click to rename' : ''; }
    document.title = current ? current.name + ' — FICSIT Schematic Planner' : 'FICSIT Schematic Planner';
  }
  // load a plan into the editor as the given record
  function enter(doc, rec) {
    loading = true;
    if (SF.live && SF.live.active) SF.live.setActive(false);
    SF.load(doc);
    S.level = 0;
    current = { id: rec.id, name: rec.name, created: rec.created || Date.now(), thumb: rec.thumb };
    lastThumb = rec.thumb ? Date.now() : 0;
    try { localStorage.setItem(LAST, rec.id); } catch (_) { /* ignore */ }
    SF.afterLoad();
    loading = false;
    setTitle();
    hide();
  }
  const uniqueName = async (base) => {
    const names = new Set((await SF.store.list()).map(r => r.name));
    if (!names.has(base)) return base;
    for (let i = 2; ; i++) if (!names.has(`${base} ${i}`)) return `${base} ${i}`;
  };
  async function createFrom(doc, name) {
    const rec = { id: SF.uid(), name: await uniqueName(name), created: Date.now() };
    enter(doc, rec);
    await saveNow(true);
  }
  async function openRecord(id) {
    const rec = await SF.store.get(id);
    if (!rec) { SF.toast('That factory is gone', 'warn'); render(); return; }
    enter(rec.doc, rec);
  }
  // a built-in factory (example / test): built fresh, then saved as a new factory of yours
  async function openBuilt(name, build) {
    if (SF.live && SF.live.active) SF.live.setActive(false);
    loading = true;
    try { build(); } finally { loading = false; }
    await createFrom(SF.serialize(), name);
  }
  const blank = () => ({ entities: [], links: [], levels: [{ name: 'Floor 1', z: 0 }] });

  // ------------------------------------------------------------ the screen
  let sortBy = 'recent', query = '';
  const ago = t => {
    const s = (Date.now() - t) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    if (s < 86400) return Math.round(s / 3600) + ' h ago';
    if (s < 86400 * 30) return Math.round(s / 86400) + ' days ago';
    return new Date(t).toLocaleDateString();
  };
  const EXAMPLES = () => [
    { name: 'Example factory', desc: 'Reinforced iron plates on one floor, every machine at 100 %, with a coal power floor.', icon: 'Desc_IronPlateReinforced_C', build: SF.buildExample },
    { name: '3-storey building', desc: 'Foundations, stacked walls and conveyor lifts up and down three floors.', icon: 'Build_Foundation_Concrete_8x1_C', build: SF.buildTower },
    ...(SF.SCENARIOS || []).map(sc => ({ name: sc.name.replace(/^\d+ · /, ''), desc: sc.desc, icon: sc.targets[0].item, build: () => SF.buildScenario(sc.id), big: sc.id === 'mega' })),
  ];

  async function render() {
    let el = $('#home');
    if (!el) { el = document.createElement('div'); el.id = 'home'; document.body.appendChild(el); bindStatic(el); }
    const all = await SF.store.list();
    let list = all.filter(r => !query || r.name.toLowerCase().includes(query.toLowerCase()));
    if (sortBy === 'name') list.sort((a, b) => a.name.localeCompare(b.name));
    if (sortBy === 'size') list.sort((a, b) => (b.objects || 0) - (a.objects || 0));
    let lastId = null; try { lastId = localStorage.getItem(LAST); } catch (_) { /* ignore */ }
    const last = all.find(r => r.id === lastId) || all[0];
    const card = r => `<div class="h-card" data-open="${r.id}" tabindex="0">
        <div class="h-thumb">${r.thumb ? `<img src="${r.thumb}" alt="">` : '<span class="h-empty">Empty</span>'}</div>
        <div class="h-info"><b title="${h(r.name)}">${h(r.name)}</b><span>${ago(r.updated)} · ${fmt(r.objects || 0, 0)} objects${r.floors > 1 ? ` · ${r.floors} floors` : ''}</span></div>
        <div class="h-acts"><button data-ren="${r.id}" title="Rename">✎</button><button data-dup="${r.id}" title="Duplicate">⧉</button><button data-exp="${r.id}" title="Export as a file">⤓</button><button data-del="${r.id}" title="Delete" class="danger">🗑</button></div>
      </div>`;
    el.querySelector('.h-body').innerHTML = `
      <section class="h-hero">
        <button class="h-big new" id="h-new"><span class="plus">+</span><b>New factory</b><span>Start from an empty floor</span></button>
        ${last ? `<button class="h-big cont" data-open="${last.id}"><span class="h-mini">${last.thumb ? `<img src="${last.thumb}" alt="">` : ''}</span><b>Continue</b><span>${h(last.name)} · ${ago(last.updated)}</span></button>` : ''}
        <button class="h-big" id="h-import"><span class="ico">⤒</span><b>Import a file</b><span>A .sfplan.json you saved before</span></button>
        <button class="h-big" id="h-link"><span class="ico">🔗</span><b>Open a shared link</b><span>Paste a planner link</span></button>
      </section>
      <section>
        <div class="h-sec"><h2>Your factories <small>${all.length}</small></h2>
          <input type="search" id="h-q" placeholder="Search…" value="${h(query)}">
          <select id="h-sort"><option value="recent" ${sortBy === 'recent' ? 'selected' : ''}>Recently edited</option><option value="name" ${sortBy === 'name' ? 'selected' : ''}>Name</option><option value="size" ${sortBy === 'size' ? 'selected' : ''}>Biggest</option></select></div>
        ${list.length ? `<div class="h-grid">${list.map(card).join('')}</div>`
          : `<div class="h-none">${all.length ? 'Nothing matches your search.' : 'No factories yet. Start a new one, or open an example below — your changes save automatically.'}</div>`}
      </section>
      <section>
        <div class="h-sec"><h2>Examples & test factories</h2><span class="muted small">Opens a copy you can change freely</span></div>
        <div class="h-grid ex">${EXAMPLES().map((x, i) => `<button class="h-ex" data-ex="${i}">${SF.iconHTML(x.icon, 44)}<div><b>${h(x.name)}</b><span>${h(x.desc)}</span>${x.big ? '<em>Large: takes a few seconds</em>' : ''}</div></button>`).join('')}</div>
      </section>
      <footer class="h-foot">Factories are saved in this browser${SF.store.persistent() ? '' : ' (small storage: export big plans as files)'}. Use ⤓ to keep a file copy or move a factory to another computer.
        <p class="h-legal">Unofficial fan-made tool, not affiliated with or endorsed by Coffee Stain Studios. Satisfactory and its game assets belong to Coffee Stain Studios.</p></footer>`;
    bindDynamic(el, all);
  }

  function bindStatic(el) {
    el.innerHTML = `<header class="h-top"><div class="logo"></div><div class="h-title"><div><b>FICSIT</b> Schematic</div><span>Unofficial Satisfactory factory planner</span></div>
        <div class="h-actions"><button id="h-unlocks">🎮 Game progress</button><button id="h-settings">⚙ Settings</button>${current ? '<button id="h-back" class="primary">Back to factory</button>' : ''}</div></header>
      <div class="h-body"></div>`;
    el.addEventListener('keydown', ev => ev.stopPropagation());
  }

  function bindDynamic(el, all) {
    const top = el.querySelector('.h-actions');
    top.innerHTML = `<button id="h-unlocks">🎮 Game progress</button><button id="h-settings">⚙ Settings</button>${current ? `<button id="h-back" class="primary">Back to ${h(current.name)}</button>` : ''}`;
    $('#h-unlocks').onclick = () => SF.openUnlocks();
    $('#h-settings').onclick = openSettings;
    if ($('#h-back')) $('#h-back').onclick = hide;
    $('#h-new').onclick = newFactory;
    $('#h-import').onclick = () => $('#file-in').click();
    $('#h-link').onclick = () => SF.openShare(true);
    const q = $('#h-q');
    q.oninput = () => { query = q.value; render().then(() => { const n = $('#h-q'); n.focus(); n.setSelectionRange(n.value.length, n.value.length); }); };
    $('#h-sort').onchange = ev => { sortBy = ev.target.value; render(); };
    el.querySelectorAll('[data-open]').forEach(c => {
      c.onclick = ev => { if (ev.target.closest('.h-acts')) return; openRecord(c.dataset.open); };
      c.onkeydown = ev => { if (ev.key === 'Enter') openRecord(c.dataset.open); };
    });
    el.querySelectorAll('[data-ex]').forEach(b => {
      b.onclick = async () => {
        const x = EXAMPLES()[+b.dataset.ex];
        b.classList.add('busy');
        await new Promise(r => setTimeout(r, 30));      // let the button show it's working
        try { await openBuilt(x.name, x.build); } finally { b.classList.remove('busy'); }
      };
    });
    el.querySelectorAll('[data-ren]').forEach(b => { b.onclick = async () => {
      const rec = await SF.store.get(b.dataset.ren);
      const n = prompt('Factory name', rec.name);
      if (n && n.trim()) { rec.name = n.trim(); await SF.store.put(rec); if (current && current.id === rec.id) { current.name = rec.name; setTitle(); } render(); }
    }; });
    el.querySelectorAll('[data-dup]').forEach(b => { b.onclick = async () => {
      const rec = await SF.store.get(b.dataset.dup);
      await SF.store.put({ ...rec, id: SF.uid(), name: await uniqueName(rec.name + ' (copy)'), created: Date.now(), updated: Date.now() });
      render();
    }; });
    el.querySelectorAll('[data-exp]').forEach(b => { b.onclick = async () => {
      const rec = await SF.store.get(b.dataset.exp);
      download(rec.name + '.sfplan.json', JSON.stringify(rec.doc, null, 1));
    }; });
    el.querySelectorAll('[data-del]').forEach(b => { b.onclick = async () => {
      const rec = all.find(r => r.id === b.dataset.del);
      if (!confirm(`Delete “${rec.name}”? This can't be undone (export it first to keep a copy).`)) return;
      await SF.store.del(rec.id);
      if (current && current.id === rec.id) { current = null; setTitle(); }
      render();
    }; });
  }

  const download = (name, text) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    a.download = name.replace(/[\\/:*?"<>|]/g, '_'); a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  // ------------------------------------------------------------ settings
  const TOGGLES = [
    ['grid', 'Grid'], ['anim', 'Animations'], ['labels', 'Labels'], ['showRates', 'Belt rates'],
    ['models3d', '3D building models (cubes; off = plain boxes)'],
    ['openOutputsBlock', 'Open belt ends back up in Free run'],
  ];
  function openSettings() {
    let m = $('#h-setbox');
    if (!m) { m = document.createElement('div'); m.id = 'h-setbox'; m.className = 'modal'; document.body.appendChild(m); }
    m.hidden = false;
    const st = S.settings;
    m.innerHTML = `<div class="modal-card glass small-card">
      <div class="modal-h"><b>Settings</b><span class="muted small">Saved in this browser, for every factory.</span><button class="x" data-close>×</button></div>
      <div class="sec">Display</div>
      ${TOGGLES.map(([k, n]) => `<label class="tog"><input type="checkbox" data-hset="${k}" ${st[k] ? 'checked' : ''}><i></i>${h(n)}</label>`).join('')}
      <div class="sec">Building</div>
      <label class="slide">New belt style<select id="hs-belt"><option value="curve">Default (smooth)</option><option value="ortho">Straight (90° turns)</option><option value="straight">Curve (arcs)</option></select></label>
      <label class="slide">Grid snap<select id="hs-snap">${[0, 0.5, 1, 2, 4, 8].map(v => `<option value="${v}">${v ? v + ' m' : 'Free'}</option>`).join('')}</select></label>
      <div class="sec">Game progress</div>
      <button id="hs-unlocks" class="wide">Game progress — what you have unlocked in your game…</button>
      <div class="sec">Saved factories</div>
      <div class="hs-row"><button id="hs-export">Export all as one file</button><button id="hs-wipe" class="danger">Delete all…</button></div>
    </div>`;
    $('#hs-belt', m).value = st.beltStyle || 'curve';
    $('#hs-snap', m).value = String(st.snap ?? 1);
    const changed = () => { SF.saveSettings(); SF.syncSettingsUI(); SF.touch(); SF.sim.request(); };
    m.querySelectorAll('[data-hset]').forEach(c => { c.onchange = () => { st[c.dataset.hset] = c.checked; changed(); }; });
    $('#hs-belt', m).onchange = ev => { st.beltStyle = ev.target.value; changed(); };
    $('#hs-snap', m).onchange = ev => { st.snap = +ev.target.value; changed(); };
    $('#hs-unlocks', m).onclick = () => { m.hidden = true; SF.openUnlocks(); };
    $('#hs-export', m).onclick = async () => {
      const recs = await Promise.all((await SF.store.list()).map(r => SF.store.get(r.id)));
      download('satisfactory-factories.json', JSON.stringify({ factories: recs.map(r => ({ name: r.name, doc: r.doc })) }));
    };
    $('#hs-wipe', m).onclick = async () => {
      const n = (await SF.store.list()).length;
      if (!n || !confirm(`Delete all ${n} saved factories from this browser? This can't be undone.`)) return;
      for (const r of await SF.store.list()) await SF.store.del(r.id);
      current = null; setTitle(); render(); m.hidden = true;
    };
    m.onclick = ev => { if (ev.target === m || ev.target.closest('[data-close]')) m.hidden = true; };
    m.onkeydown = ev => { ev.stopPropagation(); if (ev.key === 'Escape') m.hidden = true; };
  }

  // ------------------------------------------------------------ show / hide
  async function show() {
    if (current) { clearTimeout(timer); await saveNow(true); }
    SF.homeOpen = true;
    document.body.classList.add('at-home');
    await render();
    $('#home').hidden = false;
  }
  function hide() {
    SF.homeOpen = false;
    document.body.classList.remove('at-home');
    const el = $('#home'); if (el) el.hidden = true;
  }

  // a file or a shared plan becomes a new factory
  async function importDoc(doc, name) {
    if (doc && Array.isArray(doc.factories)) {         // "export all" bundle
      for (const f of doc.factories) await SF.store.put({ id: SF.uid(), name: await uniqueName(f.name), created: Date.now(), updated: Date.now(), objects: (f.doc.entities || []).length, floors: (f.doc.levels || []).length, doc: f.doc });
      SF.toast(`Imported ${doc.factories.length} factories`);
      if (SF.homeOpen) render();
      return;
    }
    await createFrom(doc, name || 'Imported factory');
  }

  const newFactory = async () => { await createFrom(blank(), 'New factory'); SF.view.cx = 0; SF.view.cy = 0; SF.view.zoom = 12; };
  SF.home = { show, hide, render, importDoc, newFactory, openBuilt, current: () => current };

  // rename from the title in the top-left
  document.addEventListener('click', async ev => {
    const t = ev.target.closest('#brand .title span');
    if (!t || !current) return;
    const n = prompt('Factory name', current.name);
    if (n && n.trim()) { current.name = n.trim(); setTitle(); saveNow(false); }
  });

  // first run with the old single autosave: keep it as a factory
  SF.home.migrate = async () => {
    if ((await SF.store.list()).length) return;
    try {
      const old = JSON.parse(localStorage.getItem('sf-planner-doc') || 'null');
      if (old && old.entities && old.entities.length) {
        loading = true; SF.load(old); loading = false;
        await SF.store.put({ id: SF.uid(), name: 'My factory', created: Date.now(), updated: Date.now(), ...stats(), thumb: thumbnail(), doc: old });
        SF.load(blank());
      }
    } catch (_) { loading = false; }
  };
})(window.SF);
