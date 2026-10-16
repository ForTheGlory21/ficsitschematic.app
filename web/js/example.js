// Example factory (DOM-free so headless tests can build it too).
(function (SF) {
  const S = SF.state, D = SF.D;
  SF.buildExample = () => {
    SF.load({ entities: [], links: [], levels: [{ name: 'Production' }, { name: 'Power' }] });
    S.level = 0;
    const add = (def, x, y, rot = 0, props, level = 0) => SF.addEntity(def, x, y, rot, level, props);
    const link = (a, ap, b, bp, tier = 1, kind = 'belt') => SF.addLink([a.id, ap], [b.id, bp], kind, tier);
    const fnd = (D.structures.find(s => s.mat === 'Concrete' && /^Foundation \(1/.test(s.name)) || D.structures[0]).id;
    for (let x = -16; x < 168; x += 8) for (let y = -32; y < 88; y += 8) add(fnd, x + 4, y + 4);

    // Balanced reinforced-plate factory: every machine runs at exactly 100 %.
    // 120 ore -> 4 smelters (120 ingots) -> 3 plate (60 plates) + 2 rod (30 rods) constructors
    // -> 3 screw constructors (120 screws) -> 2 assemblers (10 reinforced plates/min) -> industrial storage.
    const miner = add('Build_MinerMk2_C', 0, -24, 0, { resource: 'Desc_OreIron_C', purity: 1, name: 'Iron node (normal)' });
    // smelting: splitter manifold down x=18, smelters at x=28, merger column x=40
    const ys = [-24, -16, -8, 0];
    const sSp = ys.slice(0, 3).map(y => add('Build_ConveyorAttachmentSplitter_C', 18, y, 1));
    const sm = ys.map(y => add('Build_SmelterMk1_C', 28, y, 0, { recipe: 'Recipe_IngotIron_C' }));
    const sMg = ys.map(y => add('Build_ConveyorAttachmentMerger_C', 40, y, 1));
    link(miner, 0, sSp[0], 0, 2);
    sSp.forEach((s, i) => { link(s, 1, sm[i], 0, 1); link(s, 2, i < 2 ? sSp[i + 1] : sm[3], 0, 2); });
    sm.forEach((s, i) => link(s, 1, sMg[i], 2, 1));
    for (let i = 0; i < 3; i++) link(sMg[i], 3, sMg[i + 1], 1, 3);
    // ingot manifold down x=52: 3 plate + 2 rod constructors at x=62
    const cy = [10, 20, 30, 40, 50];
    const iSp = cy.slice(0, 4).map(y => add('Build_ConveyorAttachmentSplitter_C', 52, y, 1));
    const con = cy.map((y, i) => add('Build_ConstructorMk1_C', 62, y, 0, { recipe: i < 3 ? 'Recipe_IronPlate_C' : 'Recipe_IronRod_C' }));
    link(sMg[3], 3, iSp[0], 0, 3);
    iSp.forEach((s, i) => { link(s, 1, con[i], 0, 1); link(s, 2, i < 3 ? iSp[i + 1] : con[4], 0, 3); });
    // plates merge down x=74
    const pMg = cy.slice(0, 3).map(y => add('Build_ConveyorAttachmentMerger_C', 74, y, 1));
    for (let i = 0; i < 3; i++) link(con[i], 1, pMg[i], 2, 1);
    for (let i = 0; i < 2; i++) link(pMg[i], 3, pMg[i + 1], 1, 2);
    // rods merge down x=74, then a screw manifold down x=86 with screw constructors at x=96
    const rMg = [40, 50].map(y => add('Build_ConveyorAttachmentMerger_C', 74, y, 1));
    link(con[3], 1, rMg[0], 2, 1); link(con[4], 1, rMg[1], 2, 1); link(rMg[0], 3, rMg[1], 1, 1);
    const sy = [60, 70, 80];
    const rSp = sy.slice(0, 2).map(y => add('Build_ConveyorAttachmentSplitter_C', 86, y, 1));
    const scr = sy.map(y => add('Build_ConstructorMk1_C', 96, y, 0, { recipe: 'Recipe_Screw_C' }));
    link(rMg[1], 3, rSp[0], 0, 1);
    rSp.forEach((s, i) => { link(s, 1, scr[i], 0, 1); link(s, 2, i < 1 ? rSp[i + 1] : scr[2], 0, 1); });
    // screws merge UP x=108 (rot 3: out on top)
    const wMg = [80, 70, 60].map(y => add('Build_ConveyorAttachmentMerger_C', 108, y, 3));
    [2, 1, 0].forEach((si, i) => link(scr[si], 1, wMg[i], 0, 1));
    for (let i = 0; i < 2; i++) link(wMg[i], 3, wMg[i + 1], 1, 3);
    // assemblers: plates and screws split 50/50
    const asm = [24, 44].map(y => add('Build_AssemblerMk1_C', 132, y, 0, { recipe: 'Recipe_IronPlateReinforced_C' }));
    const pSp = add('Build_ConveyorAttachmentSplitter_C', 112, 22.5, 0);
    const wSp = add('Build_ConveyorAttachmentSplitter_C', 116, 46, 0);
    link(pMg[2], 3, pSp, 0, 2);
    link(pSp, 2, asm[0], 0, 1); link(pSp, 3, asm[1], 0, 1);
    link(wMg[2], 3, wSp, 0, 3);
    link(wSp, 1, asm[0], 1, 2); link(wSp, 2, asm[1], 1, 2);
    // finished goods into an industrial storage container (48 slots x 100 = 4800 plates)
    const box = add('Build_StorageContainerMk2_C', 156, 34, 0, { name: 'Finished goods' });
    link(asm[0], 2, box, 0, 1); link(asm[1], 2, box, 1, 1);
    add('V_Label', 70, -36, 0, { text: 'Reinforced Iron Plate factory — 120 ore → 10 plates / min', size: 2, color: '#fbbf24' });
    // Floor 2: power
    const coal = add('V_Source', 2, -1.5, 0, { item: 'Desc_Coal_C', rate: 30, name: 'Coal from train' }, 1);
    const csp = add('Build_ConveyorAttachmentSplitter_C', 12, -1.5, 0, null, 1);
    const g1 = add('Build_GeneratorCoal_C', 40, 0, 0, { fuel: 'Desc_Coal_C' }, 1);
    const g2 = add('Build_GeneratorCoal_C', 40, 14, 0, { fuel: 'Desc_Coal_C' }, 1);
    const wp = add('Build_WaterPump_C', 10, 34, 0, { clock: 0.75 }, 1);
    const jn = add('Build_PipelineJunction_Cross_C', 23, 34, 0, null, 1);
    link(coal, 0, csp, 0, 1); link(csp, 2, g1, 0, 1); link(csp, 3, g2, 0, 1);
    link(wp, 0, jn, 0, 1, 'pipe'); link(jn, 3, g1, 1, 1, 'pipe'); link(jn, 1, g2, 1, 1, 'pipe');
    add('V_Zone', 26, 16, 0, { text: 'Coal power — 150 MW', color: '#facc15', w: 64, h: 52 }, 1);
    SF.changed();
  };
  // 3-storey reinforced-plate building: concrete foundations on every floor, walls stacked 3 high per storey
  // (conveyor-hole, window and gate walls), conveyor lifts up between floors and one long lift back down.
  //   Ground (0 m):   iron miner outside -> through the wall -> 4 smelters -> ingots lift up
  //   Floor 2 (12 m): 3 plate + 2 rod constructors -> plates and rods lift up
  //   Floor 3 (24 m): 3 screw constructors + 2 assemblers -> 10 reinforced plates/min lift DOWN 24 m
  //   back on the ground into an industrial storage container.   Roof (36 m, hidden): foundations only.
  SF.buildTower = () => {
    SF.load({ entities: [], links: [], levels: [
      { name: 'Ground — smelting', z: 0 }, { name: 'Floor 2 — plates & rods', z: 12 },
      { name: 'Floor 3 — assembly', z: 24 }, { name: 'Roof', z: 36, hidden: true }] });
    S.level = 0;
    const add = (def, x, y, rot = 0, props, level = 0) => SF.addEntity(def, x, y, rot, level, props);
    const link = (a, ap, b, bp, tier = 1, kind = 'belt') => SF.addLink([a.id, ap], [b.id, bp], kind, tier);
    const FND = 'Build_Foundation_Concrete_8x1_C', WALL = 'Build_Wall_Concrete_8x4_C';
    const X0 = 8, X1 = 168, Y0 = -36, Y1 = 76;                          // building footprint (20 x 14 foundations)

    // ---- the production line (placed first so the floors can leave holes for the lifts)
    // Ground: miner outside the west wall, splitter manifold x=18, smelters x=28, merger column x=40
    const miner = add('Build_MinerMk2_C', -2, -24, 0, { resource: 'Desc_OreIron_C', purity: 1, name: 'Iron node (normal)' });
    const ys = [-24, -16, -8, 0];
    const sSp = ys.slice(0, 3).map(y => add('Build_ConveyorAttachmentSplitter_C', 18, y, 1));
    const sm = ys.map(y => add('Build_SmelterMk1_C', 28, y, 0, { recipe: 'Recipe_IngotIron_C' }));
    const sMg = ys.map(y => add('Build_ConveyorAttachmentMerger_C', 40, y, 1));
    link(miner, 0, sSp[0], 0, 2);
    sSp.forEach((s, i) => { link(s, 1, sm[i], 0, 1); link(s, 2, i < 2 ? sSp[i + 1] : sm[3], 0, 2); });
    sm.forEach((s, i) => link(s, 1, sMg[i], 2, 1));
    for (let i = 0; i < 3; i++) link(sMg[i], 3, sMg[i + 1], 1, 3);
    const ingLift = add('LiftBottom', 40, 10, 1);                          // input faces up the merger column
    const ingTop = SF.makeLift(ingLift, 3);                               // -> floor 2
    link(sMg[3], 3, ingLift, 0, 3);

    // Floor 2: ingot manifold x=52, constructors x=62, plate mergers x=76 (upwards), rod mergers x=84 (upwards)
    const cy = [16, 26, 36, 46, 56];
    const iSp = cy.slice(0, 4).map(y => add('Build_ConveyorAttachmentSplitter_C', 52, y, 1, null, 1));
    const con = cy.map((y, i) => add('Build_ConstructorMk1_C', 62, y, 0, { recipe: i < 3 ? 'Recipe_IronPlate_C' : 'Recipe_IronRod_C' }, 1));
    link(ingTop, 1, iSp[0], 0, 3);
    iSp.forEach((s, i) => { link(s, 1, con[i], 0, 1); link(s, 2, i < 3 ? iSp[i + 1] : con[4], 0, 3); });
    const pMg = [36, 26, 16].map(y => add('Build_ConveyorAttachmentMerger_C', 76, y, 3, null, 1));
    [2, 1, 0].forEach((ci, i) => link(con[ci], 1, pMg[i], 0, 1));
    for (let i = 0; i < 2; i++) link(pMg[i], 3, pMg[i + 1], 1, 2);
    const plateLift = add('LiftBottom', 76, 8, 3, null, 1);
    const plateTop = SF.makeLift(plateLift, 2);                           // -> floor 3
    link(pMg[2], 3, plateLift, 0, 2);
    const rMg = [56, 46].map(y => add('Build_ConveyorAttachmentMerger_C', 84, y, 3, null, 1));
    link(con[4], 1, rMg[0], 0, 1); link(con[3], 1, rMg[1], 0, 1); link(rMg[0], 3, rMg[1], 1, 1);
    const rodLift = add('LiftBottom', 84, 36, 3, null, 1);
    const rodTop = SF.makeLift(rodLift, 1);                               // -> floor 3
    link(rMg[1], 3, rodLift, 0, 1);

    // Floor 3: screw manifold x=94, screw constructors x=104, screw mergers x=116, assemblers x=140
    const sy = [46, 56, 66];
    const rSp = sy.slice(0, 2).map(y => add('Build_ConveyorAttachmentSplitter_C', 94, y, 1, null, 2));
    const scr = sy.map(y => add('Build_ConstructorMk1_C', 104, y, 0, { recipe: 'Recipe_Screw_C' }, 2));
    link(rodTop, 1, rSp[0], 0, 1);
    rSp.forEach((s, i) => { link(s, 1, scr[i], 0, 1); link(s, 2, i < 1 ? rSp[i + 1] : scr[2], 0, 1); });
    const wMg = [66, 56, 46].map(y => add('Build_ConveyorAttachmentMerger_C', 116, y, 3, null, 2));
    [2, 1, 0].forEach((si, i) => link(scr[si], 1, wMg[i], 0, 1));
    for (let i = 0; i < 2; i++) link(wMg[i], 3, wMg[i + 1], 1, 3);
    const asm = [14, 34].map(y => add('Build_AssemblerMk1_C', 140, y, 0, { recipe: 'Recipe_IronPlateReinforced_C' }, 2));
    const pSp = add('Build_ConveyorAttachmentSplitter_C', 120, 12.5, 0, null, 2);
    const wSp = add('Build_ConveyorAttachmentSplitter_C', 124, 36, 0, null, 2);
    link(plateTop, 1, pSp, 0, 2);
    link(pSp, 2, asm[0], 0, 1); link(pSp, 3, asm[1], 0, 1);
    link(wMg[2], 3, wSp, 0, 3);
    link(wSp, 1, asm[0], 1, 2); link(wSp, 2, asm[1], 1, 2);
    const ripMg = add('Build_ConveyorAttachmentMerger_C', 156, 22, 1, null, 2);
    link(asm[0], 2, ripMg, 1, 1); link(asm[1], 2, ripMg, 2, 1);
    // finished plates go DOWN 24 m (floor 3 -> ground) into industrial storage
    const ripLift = add('LiftBottom', 156, 32, 0, null, 0);               // output faces west
    const ripTop = SF.makeLift(ripLift, 1);
    ripLift.liftH = 24; ripLift.liftDown = true;
    SF.changed();                                                          // the top moves up to floor 3
    ripTop.rot = 3;                                                        // its input faces up, to the merger
    link(ripMg, 3, ripTop, 1, 1);
    const box = add('Build_StorageContainerMk2_C', 136, 32, 2, { name: 'Finished goods' });
    link(ripLift, 0, box, 0, 1);
    [ingTop, plateTop, rodTop].forEach(t => { t.rot = 0; });

    // ---- the building
    const lifts = [ingLift, plateLift, rodLift, ripLift].map(b => ({ bottom: b, top: S.entities.get(b.pair) }));
    // a slab needs a hole where a lift passes through it (above its bottom, up to and including its top floor)
    const hole = (L, cx, cy2) => lifts.some(({ bottom, top }) => L > bottom.level && L <= top.level
      && Math.abs(cx - bottom.x) < 5 && Math.abs(cy2 - bottom.y) < 5);
    for (let L = 0; L < 4; L++)
      for (let x = X0; x < X1; x += 8) for (let y = Y0; y < Y1; y += 8)
        if (!hole(L, x + 4, y + 4)) add(FND, x + 4, y + 4, 0, null, L);
    for (let L = 0; L < 3; L++) for (let r = 0; r < 3; r++) {
      const dz = r * SF.WALL_H;
      const pick = (side, k) => {
        if (L === 0 && r === 0 && side === 'W' && k === 1) return 'Build_Wall_Concrete_8x4_ConveyorHole_01_C';  // miner belt
        if (L === 0 && r === 0 && side === 'S' && (k === 9 || k === 10)) return 'Build_Wall_Concrete_Gate_8x4_C';
        if (L > 0 && r === 1 && k % 2 === 1) return 'Build_Wall_Concrete_8x4_Window_02_C';
        return WALL;
      };
      const wall = (side, k, x, y, rot) => add(pick(side, k), x, y, rot, dz ? { dz } : null, L);
      let k = 0;
      for (let x = X0 + 4; x < X1; x += 8, k++) { wall('N', k, x, Y0, 0); wall('S', k, x, Y1, 0); }
      k = 0;
      for (let y = Y0 + 4; y < Y1; y += 8, k++) { wall('W', k, X0, y, 1); wall('E', k, X1, y, 1); }
    }
    add('V_Label', 88, -30, 0, { text: 'Ground — 120 iron ore → 4 smelters → 120 ingots ▲ lift', size: 2, color: '#fbbf24' }, 0);
    add('V_Label', 88, -30, 0, { text: 'Floor 2 — 60 plates + 30 rods ▲ lifts', size: 2, color: '#fbbf24' }, 1);
    add('V_Label', 88, -30, 0, { text: 'Floor 3 — 120 screws → 10 reinforced plates/min ▼ lift to ground storage', size: 2, color: '#fbbf24' }, 2);
    SF.changed();
    return { miner, sm, con, scr, asm, box, lifts: lifts.map(l => l.bottom) };
  };
})(window.SF);
