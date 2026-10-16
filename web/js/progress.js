// Player progress: which recipes, buildings and belt/pipe tiers are unlocked. Milestones unlock by HUB tier,
// MAM research and alternate recipes (hard drives) are ticked one by one, the AWESOME Shop is one switch.
// "Everything" (the default) unlocks the lot. Stored per browser, not per plan. DOM-free.
(function (SF) {
  const D = SF.D;
  const SCH = D.schematics || {};
  const KEY = 'sf-planner-progress';
  const DEF = { mode: 'all', tier: 9, mam: [], alts: [], shop: true };

  let P = { ...DEF };
  try { P = { ...DEF, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch (_) { /* storage unavailable */ }
  let mamSet = new Set(P.mam), altSet = new Set(P.alts);
  // schematics worth showing: not discontinued, and unlocking something other than FICSMAS event recipes
  const gives = {};
  for (const r of Object.values(D.recipes)) for (const sid of r.unlock || []) (gives[sid] ||= []).push(!r.event);
  for (const b of [...Object.values(D.buildings), ...D.belts, ...D.pipes]) for (const sid of b.unlock || []) (gives[sid] ||= []).push(true);
  const useful = sid => !/^Discontinued/.test(SCH[sid].name) && (gives[sid] || []).some(Boolean);

  SF.progress = {
    get: () => P,
    set(patch) {
      P = { ...P, ...patch };
      mamSet = new Set(P.mam); altSet = new Set(P.alts);
      try { localStorage.setItem(KEY, JSON.stringify(P)); } catch (_) { /* ignore */ }
      SF.progress.version++;
      (SF.progress.onChange || []).forEach(fn => fn());
    },
    version: 0,
    onChange: [],
    // all schematics of one type (for the unlocks dialog), sorted by tier then name
    list: type => Object.entries(SCH).filter(([id, s]) => s.type === type && useful(id))
      .map(([id, s]) => ({ id, ...s })).sort((a, b) => a.tier - b.tier || a.name.localeCompare(b.name)),
  };

  // one schematic
  SF.schematicOk = (sid) => {
    if (P.mode === 'all') return true;
    const s = SCH[sid];
    if (!s) return true;
    switch (s.type) {
      case 'start': return true;
      case 'milestone': return s.tier <= P.tier;
      case 'mam': return mamSet.has(sid);
      case 'alt': return altSet.has(sid);
      case 'shop': return !!P.shop;
    }
    return true;
  };
  // anything with no schematic is available from the start; several schematics = any one of them
  const anyOk = list => !list || !list.length || list.some(SF.schematicOk);
  SF.recipeUnlocked = (rid) => { const r = D.recipes[rid]; return !!r && !r.event && anyOk(r.unlock) && SF.buildingUnlocked(r.machine); };
  SF.buildingUnlocked = (id) => {
    if (P.mode === 'all') return true;
    const b = D.buildings[id];
    return !b || anyOk(b.unlock);                                    // virtual parts, poles, lifts, structures: always
  };
  SF.tierUnlocked = (kind, tier) => {
    if (P.mode === 'all') return true;
    const t = (kind === 'pipe' ? D.pipes : D.belts).find(x => x.tier === tier);
    return !t || anyOk(t.unlock);
  };
  // a short reason it is locked, e.g. "Tier 3 · Coal Power" or "Alternate (hard drive)"
  SF.lockReason = (unlock) => {
    if (!unlock || !unlock.length || anyOk(unlock)) return '';
    const s = SCH[unlock[0]];
    if (!s) return 'Locked';
    return s.type === 'milestone' ? `Tier ${s.tier} · ${s.name}` : s.type === 'mam' ? `MAM · ${s.name}` : s.type === 'alt' ? 'Alternate recipe (hard drive)' : s.type === 'shop' ? 'AWESOME Shop' : s.name;
  };
  SF.recipeLockReason = (rid) => {
    const r = D.recipes[rid]; if (!r) return '';
    return SF.lockReason(r.unlock) || (SF.buildingUnlocked(r.machine) ? '' : 'Needs ' + SF.lockReason(D.buildings[r.machine].unlock));
  };
  // best unlocked belt / pipe tier
  SF.bestTier = (kind) => {
    const list = kind === 'pipe' ? D.pipes : D.belts;
    let best = list[0].tier;
    for (const t of list) if (SF.tierUnlocked(kind, t.tier)) best = Math.max(best, t.tier);
    return best;
  };
  // the alternate-recipe schematic for a recipe (alternates are ticked by recipe in the dialog)
  SF.altSchematicOf = (rid) => ((D.recipes[rid] || {}).unlock || []).find(s => SCH[s] && SCH[s].type === 'alt');
})(window.SF);
