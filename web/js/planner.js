// Planner tab (production calculator), the unlocks dialog and the share-link box.
(function (SF) {
  const S = SF.state, D = SF.D;
  const $ = (s, r = document) => r.querySelector(s);
  const h = SF.esc, fmt = SF.fmt;
  const chip = (it, n = 20) => SF.chipHTML(it, n);
  const pct = c => fmt(c * 100, c * 100 % 1 ? 2 : 0) + '%';

  // ------------------------------------------------------------ planner state (kept per browser)
  const KEY = 'sf-planner-calc';
  let P = { targets: [{ item: 'Desc_IronPlateReinforced_C', rate: 10 }], recipes: {}, inputs: [], miner: 'auto', purity: 1 };
  try { P = { ...P, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch (_) { /* ignore */ }
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(P)); } catch (_) { /* ignore */ } };

  // items worth asking for: anything a recipe makes (by name, for the search box)
  const products = [...new Set(Object.values(D.recipes).filter(r => !r.event).flatMap(r => r.out.map(o => o[0])))]
    .filter(it => D.items[it]).sort((a, b) => SF.itemName(a).localeCompare(SF.itemName(b)));
  const byName = new Map(products.map(it => [SF.itemName(it).toLowerCase(), it]));

  const progressText = () => {
    const p = SF.progress.get();
    if (p.mode === 'all') return 'Everything unlocked';
    const alts = SF.progress.list('alt').filter(s => SF.schematicOk(s.id)).length;
    const mam = SF.progress.list('mam').filter(s => SF.schematicOk(s.id)).length;
    return `Tier ${p.tier} · ${mam} MAM · ${alts} alternate${alts === 1 ? '' : 's'}`;
  };
  const bestMiner = () => ['Build_MinerMk3_C', 'Build_MinerMk2_C', 'Build_MinerMk1_C'].find(SF.buildingUnlocked) || 'Build_MinerMk1_C';
  const minerDef = () => (P.miner === 'auto' ? bestMiner() : P.miner);

  // ------------------------------------------------------------ the tab
  // Kept deliberately short: what to make -> one summary line + Build button -> one line per step (click a step
  // for its recipe / "supplied from elsewhere") -> raw resources -> everything else folded under "More details".
  let last = null;
  const openSteps = new Set();                   // steps expanded by the user (kept across re-renders)
  let moreOpen = false;
  SF.renderPlanner = () => {
    const box = $('#tab-planner'); if (!box) return;
    const res = SF.calc.solve(P.targets, { recipes: P.recipes, inputs: P.inputs });
    last = res;
    const T = res.totals;
    let html = `<div class="sec">What do you want to make?</div><datalist id="pl-items">${products.map(it => `<option value="${h(SF.itemName(it))}">`).join('')}</datalist>`;
    html += P.targets.map((t, i) => `<div class="pl-target" data-i="${i}">${t.item ? chip(t.item, 26) : '<span class="sw0"></span>'}
        <input type="text" class="pl-item" list="pl-items" value="${t.item ? h(SF.itemName(t.item)) : ''}" placeholder="Type a product…">
        <input class="pl-rate" type="number" min="0" step="any" value="${t.rate}" title="Items per minute"><span class="u">/min</span>
        ${P.targets.length > 1 ? '<button class="pl-del" title="Remove">×</button>' : ''}</div>`).join('');
    html += `<button id="pl-add" class="pl-addbtn">+ Another product</button>`;
    if (!res.steps.length) {
      box.innerHTML = html + `<p class="muted small pl-help">Type what you want and how many per minute. You'll see every machine it takes, and one click builds the whole line.</p>` + footer();
      bind(); return;
    }
    const raw = Object.entries(res.raw);
    // the answer in one line, then the button
    html += `<div class="pl-sum">
        <span><b>${T.count}</b> machines</span><span><b>${fmt(T.power, 1)}</b> MW</span>
        ${raw.map(([it, v]) => `<span title="${h(SF.itemName(it))}">${chip(it, 16)}<b>${fmt(v, 1)}</b>/min</span>`).join('')}</div>
      ${res.steps.some(s => s.locked) ? `<div class="lockmsg">🔒 Some steps use things you haven't unlocked yet (see below).</div>` : ''}
      ${!res.converged ? `<div class="bad small">⚠ The recipe loop doesn't settle — check the recipes you picked.</div>` : ''}
      <button id="pl-place" class="primary wide">Build it on ${h(S.levels[S.level] ? S.levels[S.level].name : 'this floor')}</button>`;

    // the chain: one line per step, click for options
    html += `<div class="sec">Production chain <span class="hint">click a step to change it</span></div><div class="pl-chain">`;
    for (const s of res.steps) {
      const open = openSteps.has(s.item);
      const opts = SF.calc.recipesFor(s.item);
      html += `<div class="pl-row ${s.locked ? 'locked' : ''} ${open ? 'open' : ''}" data-step="${s.item}">
        <div class="pl-line">${chip(s.item, 22)}<span class="nm">${h(SF.itemName(s.item))}${s.locked ? ' 🔒' : ''}</span>
          <span class="rt">${fmt(s.rate, 1)}/min</span><span class="mc" title="${s.n} × ${h(SF.defs[s.def].name)} at ${pct(s.clock)}">${SF.iconHTML(s.def, 18)}×${s.n}</span></div>
        ${open ? `<div class="pl-more">
          <div class="pl-kv"><span>Machines</span><b>${s.n} × ${h(SF.defs[s.def].name)} at ${pct(s.clock)}</b></div>
          <div class="pl-kv"><span>Uses</span><b>${s.ins.map(([i, a]) => `${chip(i, 15)}${fmt(a, 1)}`).join(' ')}</b></div>
          ${s.outs.length > 1 ? `<div class="pl-kv"><span>Also makes</span><b>${s.outs.filter(([i]) => i !== s.item).map(([i, a]) => `${chip(i, 15)}${fmt(a, 1)}`).join(' ')}</b></div>` : ''}
          ${opts.length > 1 ? `<label class="pl-kv"><span>Recipe</span><select class="pl-rec" data-item="${s.item}">${opts.map(rid => {
            const r = D.recipes[rid], lk = SF.recipeLockReason(rid);
            return `<option value="${rid}" ${rid === s.rid ? 'selected' : ''}>${lk ? '🔒 ' : ''}${h(r.name.replace(/^Alternate: /, 'Alt: '))}</option>`;
          }).join('')}</select></label>` : ''}
          ${s.locked ? `<div class="lockmsg">🔒 Needs ${h(SF.recipeLockReason(s.rid))}</div>` : ''}
          <button class="pl-imp" data-item="${s.item}">I'll bring this in from elsewhere</button></div>` : ''}
      </div>`;
    }
    html += `</div>`;
    const imp = Object.entries(res.imports);
    if (imp.length) {
      html += `<div class="sec">Brought in from elsewhere</div><div class="pl-chain">${imp.map(([it, v]) => `<div class="pl-row"><div class="pl-line">${chip(it, 22)}<span class="nm">${h(SF.itemName(it))}</span><span class="rt">${fmt(v, 1)}/min</span>
        ${P.inputs.includes(it) ? `<button class="pl-make" data-item="${it}" title="Make it here instead">Make here</button>` : ''}</div></div>`).join('')}</div>`;
    }

    // the rest, folded away
    const sur = Object.entries(res.surplus);
    const cost = Object.entries(T.cost).sort((a, b) => b[1] - a[1]);
    const miners = ['Build_MinerMk1_C', 'Build_MinerMk2_C', 'Build_MinerMk3_C'];
    const md = minerDef();
    html += `<details class="pl-details" ${moreOpen ? 'open' : ''}><summary>More details</summary>
      ${raw.length ? `<div class="sec">Ore nodes needed</div>${raw.map(([it, v]) => {
        const ex = SF.calc.extractOptions(it, v);
        const isMine = ex.length && /Miner/.test(ex[0].def);
        const opt = isMine ? ex.map(o => ({ ...o, nodes: Math.ceil(v / (D.buildings[md].rate * o.purity) - 1e-9) })) : ex;
        return `<div class="pl-kv">${chip(it, 16)}<span>${h(SF.itemName(it))}</span><b>${opt.map(o => `${o.nodes} ${o.name ? o.name.toLowerCase() : '× ' + h(SF.defs[o.def].name)}`).join(' / ')}</b></div>`;
      }).join('')}<div class="muted small">With ${h(SF.defs[md].name)}s at 100 %.</div>` : ''}
      ${sur.length ? `<div class="sec">Left over</div>${sur.map(([it, v]) => `<div class="pl-kv">${chip(it, 16)}<span>${h(SF.itemName(it))}</span><b>${fmt(v, 1)}/min</b></div>`).join('')}` : ''}
      <div class="sec">Buildings</div>${Object.entries(T.machines).sort((a, b) => b[1] - a[1]).map(([d, n]) => `<div class="pl-kv">${SF.iconHTML(d, 16)}<span>${h(SF.defs[d].name)}</span><b>×${n}</b></div>`).join('')}
      ${cost.length ? `<div class="sec">Build cost</div><div class="costs">${cost.map(([i, a]) => `<span class="cost" title="${h(SF.itemName(i))}">${chip(i, 18)}${fmt(a, 0)}</span>`).join('')}</div>` : ''}
      <div class="sec">When building</div>
      <div class="pl-place"><select id="pl-miner" title="Miner type"><option value="auto" ${P.miner === 'auto' ? 'selected' : ''}>Best miner (${h(SF.defs[bestMiner()].name)})</option>${miners.map(m => `<option value="${m}" ${P.miner === m ? 'selected' : ''}>${SF.buildingUnlocked(m) ? '' : '🔒 '}${h(SF.defs[m].name)}</option>`).join('')}</select>
        <select id="pl-purity" title="Node purity">${[[0.5, 'Impure'], [1, 'Normal'], [2, 'Pure']].map(([k, n]) => `<option value="${k}" ${P.purity === k ? 'selected' : ''}>${n} nodes</option>`).join('')}</select></div>
      <p class="muted small">Build it lays the line out next to what's already on this floor. Each ingredient gets its own supply line, so it can use a few more machines than the totals.</p>
    </details>`;
    box.innerHTML = html + footer();
    bind();
  };
  const footer = () => `<div class="pl-foot">Using: ${h(progressText())} · <button id="pl-unlocks" class="linkbtn">change game progress</button></div>`;

  function bind() {
    const box = $('#tab-planner');
    const redo = () => { save(); SF.renderPlanner(); };
    $('#pl-unlocks').onclick = openUnlocks;
    box.querySelectorAll('.pl-target').forEach(row => {
      const i = +row.dataset.i;
      const it = $('.pl-item', row), rt = $('.pl-rate', row);
      it.onchange = () => {
        const v = it.value.trim().toLowerCase();
        const id = byName.get(v) || products.find(p => SF.itemName(p).toLowerCase().includes(v));
        if (id) { P.targets[i].item = id; redo(); } else SF.toast('No product called “' + it.value + '”', 'warn');
      };
      rt.onchange = () => { P.targets[i].rate = Math.max(0, +rt.value || 0); redo(); };
      [it, rt].forEach(el => { el.onkeydown = ev => ev.stopPropagation(); });
      const del = $('.pl-del', row); if (del) del.onclick = () => { P.targets.splice(i, 1); redo(); };
    });
    $('#pl-add').onclick = () => { P.targets.push({ item: null, rate: 10 }); save(); SF.renderPlanner(); const ins = box.querySelectorAll('.pl-item'); ins[ins.length - 1].focus(); };
    box.querySelectorAll('.pl-row[data-step] .pl-line').forEach(line => {
      line.onclick = () => { const k = line.parentElement.dataset.step; openSteps.has(k) ? openSteps.delete(k) : openSteps.add(k); SF.renderPlanner(); };
    });
    box.querySelectorAll('.pl-rec').forEach(sel => { sel.onchange = () => { P.recipes[sel.dataset.item] = sel.value; redo(); }; });
    box.querySelectorAll('.pl-imp').forEach(b => { b.onclick = () => { P.inputs = [...new Set([...P.inputs, b.dataset.item])]; openSteps.delete(b.dataset.item); redo(); }; });
    box.querySelectorAll('.pl-make').forEach(b => { b.onclick = ev => { ev.stopPropagation(); P.inputs = P.inputs.filter(x => x !== b.dataset.item); redo(); }; });
    const det = $('.pl-details', box); if (det) det.ontoggle = () => { moreOpen = det.open; };
    const mi = $('#pl-miner'); if (mi) mi.onchange = () => { P.miner = mi.value; redo(); };
    const pu = $('#pl-purity'); if (pu) pu.onchange = () => { P.purity = +pu.value; redo(); };
    const pl = $('#pl-place'); if (pl) pl.onclick = place;
  }

  function place() {
    const targets = P.targets.filter(t => t.item && t.rate > 0);
    if (!targets.length) return;
    if (SF.live.active) SF.live.setActive(false);
    const choose = it => last.choose(it);
    const name = targets.map(t => `${fmt(t.rate, 2)} ${SF.itemName(t.item)}/min`).join(' + ');
    try {
      const res = SF.placePlan(name, targets, { choose, inputs: P.inputs, miner: { def: minerDef(), purity: P.purity } });
      SF.selectOnly(res.ids);
      SF.frameBounds ? SF.frameBounds(res.bounds) : SF.fitView();
      SF.toast(`Placed ${res.stats.machines} machines, ${res.stats.extractors} extractors and ${res.stats.logistics} splitters/mergers`);
    } catch (e) { SF.toast('Could not lay this out: ' + e.message, 'warn'); }
  }

  // ------------------------------------------------------------ unlocks dialog
  let uq = '';
  function openUnlocks() {
    let m = $('#unlocks');
    if (!m) { m = document.createElement('div'); m.id = 'unlocks'; m.className = 'modal'; document.body.appendChild(m); }
    m.hidden = false;
    renderUnlocks();
  }
  function renderUnlocks() {
    const m = $('#unlocks'); if (!m || m.hidden) return;
    const p = SF.progress.get();
    const all = p.mode === 'all';
    const tiers = [...Array(10).keys()];
    const ms = SF.progress.list('milestone');
    const mam = SF.progress.list('mam');
    const alts = SF.progress.list('alt');
    const altRecipes = sid => Object.entries(D.recipes).filter(([, r]) => (r.unlock || []).includes(sid)).map(([rid]) => rid);
    const q = uq.toLowerCase();
    const altsShown = alts.filter(s => !q || s.name.toLowerCase().includes(q) || altRecipes(s.id).some(r => D.recipes[r].out.some(([i]) => SF.itemName(i).toLowerCase().includes(q))));
    const onCount = l => l.filter(s => SF.schematicOk(s.id)).length;
    m.innerHTML = `<div class="modal-card glass">
      <div class="modal-h"><b>Game progress</b><span class="muted small">What you have unlocked in your game. Used by the calculator, the build menu and recipe lists.</span><button class="x" data-close>×</button></div>
      <div class="seg" id="ul-mode"><button data-v="all" class="${all ? 'on' : ''}">Everything unlocked</button><button data-v="custom" class="${!all ? 'on' : ''}">My progress</button></div>
      <div class="${all ? 'dim' : ''}">
        <div class="sec">HUB tier (milestones up to and including)</div>
        <div class="seg tiers10" id="ul-tier">${tiers.map(t => `<button data-v="${t}" class="${p.tier === t ? 'on' : ''}" title="${h(ms.filter(s => s.tier === t).map(s => s.name).join(', '))}">${t}</button>`).join('')}</div>
        <div class="muted small ul-ms">${h(ms.filter(s => s.tier <= p.tier).map(s => s.name).join(' · ') || 'Onboarding only')}</div>
        <div class="sec">MAM research <span class="cnt">${onCount(mam)}/${mam.length}</span><button data-all="mam">All</button><button data-none="mam">None</button></div>
        <div class="ul-list">${mam.map(s => `<label class="ul-it"><input type="checkbox" data-mam="${s.id}" ${p.mam.includes(s.id) ? 'checked' : ''}>${h(s.name)}</label>`).join('')}</div>
        <div class="sec">Alternate recipes <span class="cnt">${onCount(alts)}/${alts.length}</span><button data-all="alt">All</button><button data-none="alt">None</button></div>
        <input type="search" id="ul-q" placeholder="Search alternates…" value="${h(uq)}">
        <div class="ul-list alts">${altsShown.map(s => {
          const rs = altRecipes(s.id);
          return `<label class="ul-it"><input type="checkbox" data-alt="${s.id}" ${p.alts.includes(s.id) ? 'checked' : ''}>${rs.length ? chip(D.recipes[rs[0]].out[0][0], 18) : ''}${h(s.name.replace(/^Alternate: /, ''))}${rs.length ? `<small>${h(SF.defs[D.recipes[rs[0]].machine]?.name || '')}</small>` : ''}</label>`;
        }).join('')}</div>
      </div></div>`;
    const set = patch => { SF.progress.set(patch); renderUnlocks(); };
    m.onclick = ev => { if (ev.target === m || ev.target.closest('[data-close]')) m.hidden = true; };
    $('#ul-mode', m).onclick = ev => { const b = ev.target.closest('button'); if (b) set({ mode: b.dataset.v }); };
    $('#ul-tier', m).onclick = ev => { const b = ev.target.closest('button'); if (b) set({ tier: +b.dataset.v, mode: 'custom' }); };
    m.querySelectorAll('[data-mam]').forEach(c => { c.onchange = () => set({ mode: 'custom', mam: c.checked ? [...p.mam, c.dataset.mam] : p.mam.filter(x => x !== c.dataset.mam) }); });
    m.querySelectorAll('[data-alt]').forEach(c => { c.onchange = () => set({ mode: 'custom', alts: c.checked ? [...p.alts, c.dataset.alt] : p.alts.filter(x => x !== c.dataset.alt) }); });
    m.querySelectorAll('[data-all],[data-none]').forEach(b => {
      b.onclick = () => {
        const t = b.dataset.all || b.dataset.none, ids = b.dataset.all ? SF.progress.list(t).map(s => s.id) : [];
        set(t === 'mam' ? { mode: 'custom', mam: ids } : { mode: 'custom', alts: ids });
      };
    });
    const qi = $('#ul-q', m);
    qi.oninput = () => { uq = qi.value; renderUnlocks(); const n = $('#ul-q'); n.focus(); n.setSelectionRange(n.value.length, n.value.length); };
    m.onkeydown = ev => { ev.stopPropagation(); if (ev.key === 'Escape') m.hidden = true; };
  }
  SF.openUnlocks = openUnlocks;

  // ------------------------------------------------------------ share box: the link to copy, and a place to paste one
  SF.openShare = async (pasteOnly) => {
    let m = $('#sharebox');
    if (!m) { m = document.createElement('div'); m.id = 'sharebox'; m.className = 'modal'; document.body.appendChild(m); }
    m.hidden = false;
    m.innerHTML = `<div class="modal-card glass small-card"><div class="modal-h"><b>Share link</b><button class="x" data-close>×</button></div><p class="muted small">Making the link…</p></div>`;
    let url = '', kb = 0;
    if (!pasteOnly) try {
      const code = await SF.encodeShare();
      url = location.href.split('#')[0] + '#plan=' + code; kb = code.length / 1024;
    } catch (e) { SF.toast('Sharing failed: ' + e.message, 'warn'); }
    m.innerHTML = `<div class="modal-card glass small-card">
      ${pasteOnly ? `<div class="modal-h"><b>Open a shared link</b><span class="muted small">It opens as a new factory of yours.</span><button class="x" data-close>×</button></div>` : `
      <div class="modal-h"><b>Share link</b><span class="muted small">The whole plan is inside the link (${fmt(kb, 1)} KB) — nothing is uploaded.</span><button class="x" data-close>×</button></div>
      <div class="share-row"><input type="text" id="sh-url" readonly value="${h(url)}"><button id="sh-copy" class="primary">Copy</button></div>
      ${kb > 60 ? `<p class="warn small">Big plan: some chat apps cut links this long. Use File → Save and send the file instead.</p>` : ''}
      <div class="sec">Open a shared link</div>`}
      <div class="share-row"><input type="text" id="sh-paste" placeholder="Paste a planner link…"><button id="sh-open">Open</button></div></div>`;
    const inp = $('#sh-url', m);
    if (inp) inp.onfocus = () => inp.select();
    if (inp) $('#sh-copy', m).onclick = async () => {
      inp.select();
      let ok = false;
      try { await navigator.clipboard.writeText(url); ok = true; } catch (_) { ok = document.execCommand && document.execCommand('copy'); }
      SF.toast(ok ? 'Link copied' : 'Select the link and press Ctrl+C', ok ? 'info' : 'warn');
    };
    $('#sh-open', m).onclick = async () => {
      const v = $('#sh-paste', m).value.trim();
      const mm = v.match(/plan=([A-Za-z0-9_-]+)/);
      if (!mm) { SF.toast('That is not a planner link', 'warn'); return; }
      let doc;
      try { doc = await SF.decodeShare(mm[1]); } catch (e) { SF.toast('Could not read that link', 'warn'); return; }
      m.hidden = true;
      await SF.home.importDoc(doc, 'Shared factory');
      SF.toast('Opened the shared plan as a new factory');
    };
    m.onclick = ev => { if (ev.target === m || ev.target.closest('[data-close]')) m.hidden = true; };
    m.onkeydown = ev => { ev.stopPropagation(); if (ev.key === 'Escape') m.hidden = true; };
    (inp || $('#sh-paste', m)).focus();
  };

  SF.progress.onChange.push(() => { SF.renderPlanner(); });
})(window.SF);
