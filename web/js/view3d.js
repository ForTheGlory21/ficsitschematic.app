// 3D view: placeholder boxes for buildings and structures, belts/pipes/lifts, moving items.
// Shares the document, selection, inspector and simulator with the 2D editor.
(function (SF) {
  const S = SF.state, D = SF.D;
  const v3 = SF.view3d = { active: false, ready: false };
  if (!window.THREE) { v3.unavailable = true; return; }
  const T = window.THREE;
  if (T.ColorManagement) T.ColorManagement.legacyMode = false;   // treat hex colours as sRGB

  let renderer, scene, camera, cv3, grid, sun;
  let gEnts, gLinks, gOver, itemMesh;
  const cam = { tx: 0, ty: 0, tz: 0, dist: 140, yaw: -0.75, pitch: 0.85 };
  const unitBox = new T.BoxGeometry(1, 1, 1);
  const unitEdges = new T.EdgesGeometry(unitBox);
  const unitCyl = new T.CylinderGeometry(0.45, 0.45, 1, 12, 1);
  const matCache = new Map();
  const capCache = new Map();
  const canIcon = location.protocol !== 'file:';   // WebGL can't use file:// images (tainted)
  let pickables = [], portMeshes = [], linkPaths = [], runners = [];
  let builtVersion = -1, builtLevel = -1, builtKey = '';
  let drag = null, ghost = null, ghostKey = '';
  const mouse = { x: 0, y: 0, cx: 0, cy: 0 };
  const floorH = () => S.settings.floorHeight3d || 16;
  const elev = L => SF.levelZ(L);                       // real floor heights (floors panel)

  function mat(color, opacity = 1, extra = {}) {
    const key = color + '|' + opacity + '|' + JSON.stringify(extra);
    let m = matCache.get(key);
    if (!m) {
      m = new T.MeshStandardMaterial({ color, roughness: 0.75, metalness: 0.08, transparent: opacity < 1, opacity, depthWrite: opacity >= 1, ...extra });
      matCache.set(key, m);
    }
    return m;
  }
  const lineMat = (color, opacity = 1) => {
    const key = 'L' + color + opacity;
    let m = matCache.get(key);
    if (!m) { m = new T.LineBasicMaterial({ color, transparent: opacity < 1, opacity }); matCache.set(key, m); }
    return m;
  };

  // ------------------------------------------------------------ 3D models: cube rebuilds only (web/models_cubes)
  const models = new Map();          // 'cube:'+key -> { geo, b } once loaded
  const loading = new Set();
  // footprints overridden by hand in the extractor: centre these on the mesh bounds instead of the pivot
  const CENTER_ON_MESH = new Set(['Build_HadronCollider_C', 'Build_QuantumEncoder_C', 'Build_SpaceElevator_C']);
  // bigger versions drawn as their smaller sibling's cube model, stretched to their own footprint
  const CUBE_ALIAS = { Build_StorageContainerMk2_C: 'Build_StorageContainerMk1_C', Build_IndustrialTank_C: 'Build_PipeStorageTank_C' };
  // Cube models: the boxy rebuilds from tools/cubify.py (Custom/ folder), loaded straight from .glb
  const CUBES = window.SF_CUBES || {};
  // loaded through a <script> tag (works from file:// too); the script calls SF.cubeData(key, base64 glb)
  function loadCube(key) {
    const id = 'cube:' + key;
    loading.add(id);
    const sc = document.createElement('script');
    sc.src = CUBES[key].f + '?h=' + CUBES[key].h;
    sc.onerror = () => { loading.delete(id); CUBES[key] = null; builtKey = ''; };
    document.head.appendChild(sc);
  }
  SF.cubeData = (key, b64) => {
    const id = 'cube:' + key;
    const bin = atob(b64), buf = new ArrayBuffer(bin.length), u8 = new Uint8Array(buf);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    try {
      const dv = new DataView(buf);
      const jl = dv.getUint32(12, true);
      const js = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 20, jl)));
      const binOff = 20 + jl + 8;
      const acc = i => {
        const a = js.accessors[i], v = js.bufferViews[a.bufferView];
        const n = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[a.type] * a.count;
        const off = binOff + (v.byteOffset || 0) + (a.byteOffset || 0);
        const C = { 5126: Float32Array, 5125: Uint32Array, 5123: Uint16Array, 5121: Uint8Array }[a.componentType];
        const arr = new C(buf.slice(off, off + n * C.BYTES_PER_ELEMENT));
        return { arr, size: { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[a.type], norm: !!a.normalized };
      };
      // several primitives are merged into one geometry
      const P = [], N = [], Cc = [], I = [];
      let base = 0;
      for (const m of js.meshes) for (const pr of m.primitives) {
        const pos = acc(pr.attributes.POSITION).arr, nor = acc(pr.attributes.NORMAL).arr;
        const col = pr.attributes.COLOR_0 != null ? acc(pr.attributes.COLOR_0) : null;
        const nv = pos.length / 3;
        // file axes (FModel glTF: UE X, UE Z, UE Y) -> planner 3D axes (UE Y, UE Z, -UE X)
        for (let v = 0; v < nv; v++) {
          P.push(pos[v * 3 + 2], pos[v * 3 + 1], -pos[v * 3]);
          N.push(nor[v * 3 + 2], nor[v * 3 + 1], -nor[v * 3]);
          if (col) {
            const k = col.size, sc = col.arr instanceof Float32Array ? 1 : col.arr instanceof Uint16Array ? 1 / 65535 : 1 / 255;
            Cc.push(col.arr[v * k] * sc, col.arr[v * k + 1] * sc, col.arr[v * k + 2] * sc);
          } else Cc.push(0.5, 0.5, 0.5);
        }
        const ix = acc(pr.indices).arr;
        for (let i = 0; i < ix.length; i++) I.push(ix[i] + base);
        base += nv;
      }
      const geo = new T.BufferGeometry();
      geo.setAttribute('position', new T.Float32BufferAttribute(P, 3));
      geo.setAttribute('normal', new T.Float32BufferAttribute(N, 3));
      geo.setAttribute('color', new T.Float32BufferAttribute(Cc, 3));
      geo.setIndex(base > 65535 ? new T.Uint32BufferAttribute(I, 1) : new T.Uint16BufferAttribute(I, 1));
      geo.addGroup(0, I.length, 0);
      geo.computeBoundingBox(); geo.computeBoundingSphere();
      const bb = geo.boundingBox;
      models.set(id, { key: id, geo, b: [bb.min.x, bb.min.y, bb.min.z, bb.max.x, bb.max.y, bb.max.z], maps: [], painted: false, cube: true });
    } catch (err) { console.warn('cube model', key, err); CUBES[key] = null; }
    loading.delete(id);
    builtKey = '';
  };
  function getModel(key) {
    if (S.settings.models3d === false || !CUBES[key]) return null;
    const c = models.get('cube:' + key);
    if (c) return c;
    if (!loading.has('cube:' + key)) loadCube(key);
    return null;
  }
  v3.modelsLoading = () => loading.size;

  const modelMatCache = new Map();
  function modelMaterials(d, op, selected, status, model) {
    const bad = status && ['blocked', 'idle', 'noRecipe', 'noFuel'].includes(status);
    const key = model.key + '|' + op + '|' + selected + '|' + bad;
    let m = modelMatCache.get(key);
    if (m) return m;
    if (model.cube) {
      const emissive = selected ? new T.Color('#1d6fb0') : bad ? new T.Color('#8a1c1c') : new T.Color('#000000');
      const tr = op < 1;
      m = [new T.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, metalness: 0.1, emissive, emissiveIntensity: selected || bad ? 0.45 : 0, transparent: tr, opacity: op, depthWrite: !tr })];
      modelMatCache.set(key, m);
      return m;
    }
    const cat = new T.Color(SF.CAT_COLOR[d.cat] || '#888');
    // unpainted models (no textures in the export) use the FICSIT secondary slate so they sit with painted ones
    const body = new T.Color('#6f7586').lerp(cat, 0.08);
    const emissive = selected ? new T.Color('#1d6fb0') : bad ? new T.Color('#8a1c1c') : new T.Color('#000000');
    const ei = selected || bad ? 0.45 : 0;
    const tr = op < 1;
    m = [
      new T.MeshStandardMaterial({ color: body, roughness: 0.62, metalness: 0.22, emissive, emissiveIntensity: ei, transparent: tr, opacity: op, depthWrite: !tr }),
      new T.MeshStandardMaterial({ color: '#9fd3ff', roughness: 0.1, metalness: 0.1, transparent: true, opacity: 0.35 * op, depthWrite: false }),
      new T.MeshStandardMaterial({ color: cat, emissive: cat, emissiveIntensity: 0.8, transparent: tr, opacity: op }),
      ...model.maps.map(map => new T.MeshStandardMaterial({ map, roughness: 0.55, metalness: 0.15, emissive, emissiveIntensity: ei, transparent: tr, opacity: op, depthWrite: !tr })),
    ];
    modelMatCache.set(key, m);
    return m;
  }

  // ------------------------------------------------------------ setup
  function init() {
    cv3 = document.createElement('canvas');
    cv3.id = 'cv3'; cv3.tabIndex = 0;
    cv3.style.display = 'none';
    document.getElementById('stage').appendChild(cv3);
    renderer = new T.WebGLRenderer({ canvas: cv3, antialias: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = T.PCFSoftShadowMap;
    renderer.outputEncoding = T.sRGBEncoding;
    scene = new T.Scene();
    scene.background = new T.Color(0x0a0c10);
    scene.fog = new T.Fog(0x0a0c10, 500, 2200);
    camera = new T.PerspectiveCamera(45, 1, 0.5, 6000);
    scene.add(new T.HemisphereLight(0xcfe0ff, 0x1b1712, 0.55));
    sun = new T.DirectionalLight(0xfff1dc, 0.95);
    sun.position.set(160, 260, 110);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const sc = sun.shadow.camera; sc.left = -260; sc.right = 260; sc.top = 260; sc.bottom = -260; sc.far = 1200;
    sun.shadow.bias = -0.0008;
    scene.add(sun, sun.target);
    grid = new T.GridHelper(2048, 256, 0x33404f, 0x1a2029);
    grid.material.transparent = true; grid.material.opacity = 0.55;
    scene.add(grid);
    gEnts = new T.Group(); gLinks = new T.Group(); gOver = new T.Group();
    scene.add(gEnts, gLinks, gOver);
    itemMesh = new T.InstancedMesh(new T.BoxGeometry(0.62, 0.62, 0.62), new T.MeshStandardMaterial({ roughness: 0.5 }), 6000);
    itemMesh.count = 0;
    itemMesh.instanceMatrix.setUsage(T.DynamicDrawUsage);
    scene.add(itemMesh);
    new ResizeObserver(resize).observe(document.getElementById('stage'));
    resize();
    bindInput();
    v3.ready = true;
  }

  function resize() {
    if (!renderer) return;
    const r = document.getElementById('stage').getBoundingClientRect();
    renderer.setSize(r.width, r.height, false);
    cv3.style.width = r.width + 'px'; cv3.style.height = r.height + 'px';
    camera.aspect = r.width / Math.max(1, r.height);
    camera.updateProjectionMatrix();
  }

  function updateCamera() {
    cam.pitch = SF.clamp(cam.pitch, 0.12, 1.53);
    cam.dist = SF.clamp(cam.dist, 8, 2500);
    const cp = Math.cos(cam.pitch);
    camera.position.set(cam.tx + cam.dist * cp * Math.sin(cam.yaw), cam.ty + cam.dist * Math.sin(cam.pitch), cam.tz + cam.dist * cp * Math.cos(cam.yaw));
    camera.lookAt(cam.tx, cam.ty, cam.tz);
    sun.position.set(cam.tx + 160, cam.ty + 260, cam.tz + 110);
    sun.target.position.set(cam.tx, cam.ty, cam.tz);
  }

  v3.fit = () => {
    const ents = [...S.entities.values()].filter(e => e.level <= S.level);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const e of ents) { const r = SF.entRect(e); x0 = Math.min(x0, r.x0); y0 = Math.min(y0, r.y0); x1 = Math.max(x1, r.x1); y1 = Math.max(y1, r.y1); }
    if (!isFinite(x0)) { x0 = y0 = -32; x1 = y1 = 32; }
    cam.tx = (x0 + x1) / 2; cam.tz = (y0 + y1) / 2; cam.ty = elev(S.level);
    cam.dist = Math.max(40, Math.max(x1 - x0, y1 - y0) * 1.25);
  };

  // ------------------------------------------------------------ cap textures (names + icons on roofs)
  function capTexture(d, e) {
    const recipe = d.kind === 'machine' && e.recipe ? e.recipe : '';
    const iconKey = d.kind === 'machine' && recipe ? D.recipes[recipe]?.out[0][0] : d.kind === 'extractor' ? e.resource : d.id;
    const key = d.id + '|' + recipe + '|' + (e.resource || '') + '|' + (e.text || e.name || '');
    let c = capCache.get(key);
    if (c && (c.done || !canIcon)) return c.tex;
    const W = 256, H = Math.round(256 * Math.min(2, Math.max(0.5, d.h / d.w)));
    const cv = c ? c.cv : document.createElement('canvas');
    cv.width = W; cv.height = H;
    const g = cv.getContext('2d');
    const col = d.structure ? d.color : (SF.CAT_COLOR[d.cat] || '#888');
    g.fillStyle = '#1b2028'; g.fillRect(0, 0, W, H);
    g.fillStyle = col; g.fillRect(0, 0, W, 10);
    g.strokeStyle = 'rgba(255,255,255,.12)'; g.lineWidth = 6; g.strokeRect(3, 3, W - 6, H - 6);
    const im = canIcon && iconKey ? SF.img(iconKey) : null;
    const isz = Math.min(W, H) * 0.5;
    if (im) g.drawImage(im, (W - isz) / 2, H * 0.42 - isz / 2, isz, isz);
    g.fillStyle = '#e8eaee'; g.textAlign = 'center'; g.textBaseline = 'bottom';
    g.font = `700 ${Math.round(W / 11)}px Inter, Segoe UI, sans-serif`;
    let name = d.kind === 'source' || d.kind === 'vsink' ? (e.name || (e.item ? SF.itemName(e.item) : d.name)) : d.name;
    if (d.kind === 'label' || d.kind === 'zone') name = e.text || '';
    g.fillText(name.length > 22 ? name.slice(0, 21) + '…' : name, W / 2, H - 14);
    if (recipe) {
      g.font = `500 ${Math.round(W / 15)}px Inter, Segoe UI, sans-serif`; g.fillStyle = '#a4abb8';
      g.textBaseline = 'top'; g.fillText(D.recipes[recipe].name.replace(/^Alternate: /, '★ ').slice(0, 26), W / 2, 18);
    }
    const tex = c ? c.tex : new T.CanvasTexture(cv);
    tex.encoding = T.sRGBEncoding;
    tex.anisotropy = 4;
    tex.needsUpdate = true;
    const tries = (c ? c.tries : 0) + 1;
    capCache.set(key, { cv, tex, tries, done: !!im || !iconKey || !SF.iconPath(iconKey) || tries > 8 });
    return tex;
  }

  // ------------------------------------------------------------ scene build
  // floors with their eye on are shown as built (so several floors read as one building); hidden ones not at all
  function levelOpacity(L) {
    return SF.levelVisible(L) ? 1 : 0;
  }

  function clearGroup(g) {
    for (let i = g.children.length - 1; i >= 0; i--) {
      const o = g.children[i];
      g.remove(o);
      if (o.userData.ownGeo && o.geometry) o.geometry.dispose();
      if (o.isInstancedMesh) { if (!o.userData.sharedMat) [].concat(o.material).forEach(x => x.dispose()); o.dispose(); }
    }
  }

  function entityHeight(d) {
    if (d.structure) return d.raw.z || 1;
    if (d.kind === 'source' || d.kind === 'vsink') return 3;
    return (d.raw && d.raw.z) || 3;
  }

  function addBox(group, x, y, z, sx, sy, sz, material, opts = {}) {
    const m = new T.Mesh(unitBox, material);
    m.position.set(x, y, z); m.scale.set(sx, sy, sz);
    m.castShadow = opts.shadow !== false && material.opacity >= 1;
    m.receiveShadow = true;
    Object.assign(m.userData, opts.data || {});
    group.add(m);
    return m;
  }

  // one InstancedMesh per (model, materials): thousands of buildings in a handful of draw calls; picking maps
  // the instance back to its building
  let instBuckets = new Map();
  const stM = new T.Matrix4(), WHITE = new T.Color(1, 1, 1), tint = new T.Color();
  const STRUCT = window.SF_STRUCT || {};             // structure id -> [model key, colour tint]
  function flushInstances(pickables) {
    for (const b of instBuckets.values()) {
      const im = new T.InstancedMesh(b.geo, b.material, b.list.length);
      b.list.forEach((x, i) => im.setMatrixAt(i, x.matrix));
      // per-instance tint (Asphalt / Polished share the Concrete models)
      if (b.list.some(x => x.color)) b.list.forEach((x, i) => im.setColorAt(i, x.color ? tint.setRGB(x.color[0], x.color[1], x.color[2]) : WHITE));
      im.castShadow = b.cast; im.receiveShadow = true;
      im.userData = { eids: b.list.map(x => x.eid), sharedMat: true, structure: !!b.structure };
      im.computeBoundingSphere && im.computeBoundingSphere();
      gEnts.add(im);
      if (b.current) pickables.push(im);
    }
    instBuckets = new Map();
  }

  // foundation outlines: one line mesh for all of them
  let edgeBoxes = [];
  function flushEdges() {
    if (!edgeBoxes.length) return;
    const src = unitEdges.attributes.position.array, n = src.length, out = new Float32Array(n * edgeBoxes.length / 6);
    for (let b = 0, o = 0; b < edgeBoxes.length; b += 6) {
      const [x, y, z, sx, sy, sz] = edgeBoxes.slice(b, b + 6);
      for (let i = 0; i < n; i += 3, o += 3) { out[o] = x + src[i] * sx; out[o + 1] = y + src[i + 1] * sy; out[o + 2] = z + src[i + 2] * sz; }
    }
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.BufferAttribute(out, 3));
    const ls = new T.LineSegments(g, lineMat(0x000000, 0.35));
    ls.userData.ownGeo = true;
    gEnts.add(ls);
    edgeBoxes = [];
  }

  function buildEntities() {
    clearGroup(gEnts);
    instBuckets = new Map(); edgeBoxes = [];
    pickables = []; portMeshes = []; runners = [];
    const sel = SF.sel.ents;
    const res = SF.sim.result;
    for (const e of S.entities.values()) {
      const op = levelOpacity(e.level);
      if (op <= 0) continue;
      const d = SF.defs[e.def];
      const [w, h] = SF.entSize(e);
      const base = elev(e.level);
      const current = e.level === S.level;
      if (d.kind === 'label') continue;
      if (d.kind === 'zone' || d.kind === 'designer') {
        const col = d.kind === 'zone' ? (e.color || '#a78bfa') : '#f5a524';
        const box = new T.LineSegments(unitEdges, lineMat(col, op));
        box.position.set(e.x, base + 2, e.y); box.scale.set(w, 4, h);
        gEnts.add(box);
        const floor = addBox(gEnts, e.x, base + 0.03, e.y, w, 0.04, h, mat(col, 0.06 * op), { shadow: false, data: { eid: e.id } });
        if (current) pickables.push(floor);
        continue;
      }
      if (d.structure && SF.structureHidden(e)) continue;
      if (d.structure) {
        const z = entityHeight(d);
        const isWall = d.kind === 'wall';
        const y = (isWall ? base + z / 2 : base - z / 2) + (e.dz || 0);      // dz: stacked above the floor (walls 4 m apart)
        // a real (or cube) model when there is one: converted into the structure's own box frame (centred on the
        // footprint; foundations and ramps hang below the floor, walls stand on it), tinted per material set
        const st = STRUCT[e.def];
        const sModel = st && getModel(st[0]);
        if (sModel) {
          const smat = modelMaterials(d, op, sel.has(e.id), null, sModel);
          const cast = isWall && op >= 1;
          const ik = sModel.geo.uuid + '|' + smat.map(m2 => m2.uuid).join(',') + '|' + cast + '|' + current;
          let bk = instBuckets.get(ik);
          if (!bk) instBuckets.set(ik, bk = { geo: sModel.geo, material: smat, cast, current, structure: true, list: [] });
          stM.makeRotationY(-e.rot * Math.PI / 2).setPosition(e.x, base + (e.dz || 0), e.y);
          bk.list.push({ matrix: stM.clone(), eid: e.id, color: st[1] });
          continue;
        }
        // walls and foundations are drawn instanced too (a building can have thousands of them)
        const sm = mat(SF.shade(d.color, sel.has(e.id) ? 0.25 : 0), op), cast = isWall && op >= 1;
        const ik = 'S|' + sm.uuid + '|' + cast + '|' + current;
        let bk = instBuckets.get(ik);
        if (!bk) instBuckets.set(ik, bk = { geo: unitBox, material: sm, cast, current, structure: true, list: [] });
        bk.list.push({ matrix: new T.Matrix4().makeScale(w, z, h).setPosition(e.x, y, e.y), eid: e.id });
        if (op >= 1 && !isWall) edgeBoxes.push(e.x, y, e.y, w, z, h);
        continue;
      }
      if (d.kind === 'pole') {
        // conveyor pole / pipe support: stem up to the belt, real holder model on top facing the belt
        const isPipePole = d.id === 'PipePole';
        const hm = getModel(isPipePole ? 'pipepole' : 'pole');
        const hgt = e.h ?? 1;
        const top = base + hgt - (isPipePole ? 0.75 : 0.2);
        const holderH = hm ? hm.b[4] - hm.b[1] : 0.9;
        const stemTop = Math.max(base + 0.05, top - (isPipePole ? 0 : holderH));
        if (stemTop - base > 0.05) {
          const st = new T.Mesh(unitCyl, mat('#4b5563', op));
          st.scale.set(0.3, stemTop - base, 0.3); st.position.set(e.x, (base + stemTop) / 2, e.y);
          st.castShadow = op >= 1; st.userData.eid = e.id;
          gEnts.add(st); if (current) pickables.push(st);
        }
        if (hm) {
          const hmesh = new T.Mesh(hm.geo, sweepMaterials(hm, sel.has(e.id) ? '#38bdf8' : null, op));
          hmesh.rotation.y = -(e.ang || 0) - Math.PI / 2;     // model's belt axis is its local -Z
          hmesh.position.set(e.x, isPipePole ? top - hm.b[4] + 0.75 + 0.75 : top - hm.b[4], e.y);
          hmesh.castShadow = op >= 1; hmesh.userData.eid = e.id;
          gEnts.add(hmesh); if (current) pickables.push(hmesh);
        } else {
          const b = addBox(gEnts, e.x, top - 0.3, e.y, 1.8, 0.6, 0.9, mat('#6b7280', op), { data: { eid: e.id } });
          if (current) pickables.push(b);
        }
        if (current) addPorts(e, d, base + hgt - 1);
        continue;
      }
      // conveyor lift ends: the lift itself is drawn along its vertical link; here only a clickable base + ports
      if (d.kind === 'liftend') {
        // a solid 2 m housing at each end (selected: blue), with an orange band where the belt connects
        const sel1 = sel.has(e.id);
        const lift = SF.portHeight(e, d.end === 'top' ? 1 : 0) - 1;      // a top between floors is raised
        const cube = addBox(gEnts, e.x, base + lift + 1.1, e.y, 2.2, 2.2, 2.2, mat(sel1 ? '#2b6f99' : '#454d5b', op, sel1 ? { emissive: '#1d6fb0', emissiveIntensity: 0.45 } : {}), { data: { eid: e.id } });
        addBox(gEnts, e.x, base + lift + 1.0, e.y, 2.26, 0.35, 2.26, mat(sel1 ? '#38bdf8' : '#f59e0b', op), { shadow: false, data: { eid: e.id } });
        if (current) { pickables.push(cube); addPorts(e, d, base); }
        continue;
      }
      // real model when available (falls back to a placeholder box while it loads)
      let model = getModel(d.id), stretch = null;
      if (!model && CUBE_ALIAS[d.id] && (model = getModel(CUBE_ALIAS[d.id]))) {
        const bb = model.b;
        stretch = [d.w / (bb[3] - bb[0]), (d.raw.z || 4) / (bb[4] - bb[1]), d.h / (bb[5] - bb[2])];
      }
      if (model) {
        const r = res && res.nodes.get(e.id);
        const status = r && r.status;
        const selected = sel.has(e.id);
        const mesh = new T.Mesh(model.geo, modelMaterials(d, op, selected, status, model));
        const b = model.b;
        const off = stretch ? [(b[0] + b[3]) / 2 * stretch[0], (b[2] + b[5]) / 2 * stretch[2]]
          : CENTER_ON_MESH.has(d.id) || !d.raw ? [(b[0] + b[3]) / 2, (b[2] + b[5]) / 2] : [d.raw.ox || 0, d.raw.oy || 0];
        const [rx, ry] = SF.rot(off[0], off[1], e.rot);
        if (stretch) mesh.scale.set(stretch[0], stretch[1], stretch[2]);
        // belt attachments (splitters, mergers, pipe junctions, pumps, valves) have their origin at the
        // connection height, everything else sits on the floor
        const onBelt = ['splitter', 'merger', 'junction', 'pump'].includes(d.kind);
        // splitter/merger tunnel floors sit ~0.2 m above their origin; drop them so the floor is flush with the belt
        const flush = d.kind === 'splitter' || d.kind === 'merger' ? -0.2 : 0;
        mesh.position.set(e.x - rx, base + (onBelt ? SF.portHeight(e, 0) + flush : 0), e.y - ry);
        // splitter/merger meshes run along the game's forward axis; the planner's flow runs along +x
        mesh.rotation.y = -e.rot * Math.PI / 2 - (d.kind === 'splitter' || d.kind === 'merger' ? Math.PI / 2 : 0);
        mesh.castShadow = op >= 1; mesh.receiveShadow = true;
        mesh.userData.eid = e.id;
        // identical buildings are drawn together as one instanced mesh (see flushInstances)
        const ik = model.geo.uuid + '|' + mesh.material.map(m2 => m2.uuid).join(',') + '|' + mesh.castShadow + '|' + current;
        let bk = instBuckets.get(ik);
        if (!bk) instBuckets.set(ik, bk = { geo: model.geo, material: mesh.material, cast: mesh.castShadow, current, list: [] });
        mesh.updateMatrix();
        bk.list.push({ matrix: mesh.matrix.clone(), eid: e.id });
        if (selected) addBox(gEnts, e.x, base + 0.05, e.y, w + 1.2, 0.1, h + 1.2, mat('#38bdf8', 0.35), { shadow: false }).renderOrder = 2;
        // real models: only flag problems (working machines speak for themselves)
        if (current && r && status !== 'ok' && ['machine', 'extractor', 'generator'].includes(d.kind)) {
          const s = Math.max(0.6, Math.min(w, h) * 0.07);
          const top = base + b[4] + s * 1.6;
          const spin = new T.Mesh(unitBox, mat(SF.STATUS_COLOR[status] || '#22c55e', 1, { emissive: SF.STATUS_COLOR[status] || '#22c55e', emissiveIntensity: 0.5 }));
          spin.scale.set(s, s, s); spin.position.set(e.x, top, e.y);
          gEnts.add(spin);
          runners.push({ mesh: spin, eff: r.eff, gen: d.kind === 'generator', y: top });
        }
        if (current) addPorts(e, d, base);
        continue;
      }
      // building placeholder
      const hz = entityHeight(d);
      const col = d.virtual ? '#7c6bd6' : (SF.CAT_COLOR[d.cat] || '#888');
      const r = res && res.nodes.get(e.id);
      const status = r && r.status;
      const selected = sel.has(e.id);
      const bodyCol = SF.shade(col, -0.55);
      const body = addBox(gEnts, e.x, base + hz / 2, e.y, w * 0.98, hz, h * 0.98, mat(bodyCol, op), { data: { eid: e.id } });
      if (current) pickables.push(body);
      // coloured band near the base and roof cap with name/icon
      addBox(gEnts, e.x, base + Math.min(1, hz * 0.2) / 2, e.y, w, Math.min(1, hz * 0.2), h, mat(col, op), { shadow: false });
      if (op >= 0.5 && Math.min(w, h) >= 3) {
        const cap = new T.Mesh(new T.PlaneGeometry(w * 0.9, h * 0.9), new T.MeshBasicMaterial({ map: capTexture(d, e), transparent: op < 1, opacity: op }));
        cap.userData.ownGeo = true;
        cap.rotation.x = -Math.PI / 2;
        cap.position.set(e.x, base + hz + 0.02, e.y);
        gEnts.add(cap);
      }
      const edgeCol = selected ? 0x38bdf8 : status && ['blocked', 'idle', 'noRecipe', 'noFuel'].includes(status) ? 0xef4444 : status === 'starved' || status === 'throttled' ? 0xf59e0b : 0x000000;
      const edges = new T.LineSegments(unitEdges, lineMat(edgeCol, selected || edgeCol ? 1 : 0.5 * op));
      edges.position.copy(body.position); edges.scale.set(w, hz, h);
      gEnts.add(edges);
      if (selected) {
        const halo = addBox(gEnts, e.x, base + 0.05, e.y, w + 1.2, 0.1, h + 1.2, mat('#38bdf8', 0.35), { shadow: false });
        halo.renderOrder = 2;
      }
      // spinning indicator on running machines (speed ~ efficiency)
      if (current && r && ['machine', 'extractor', 'generator'].includes(d.kind)) {
        const s = Math.max(1, Math.min(w, h) * 0.18);
        const spin = new T.Mesh(unitBox, mat(SF.STATUS_COLOR[status] || '#22c55e', 1, { emissive: SF.STATUS_COLOR[status] || '#22c55e', emissiveIntensity: 0.35 }));
        spin.scale.set(s, s, s);
        spin.position.set(e.x, base + hz + s * 0.9, e.y);
        gEnts.add(spin);
        runners.push({ mesh: spin, eff: r.eff, gen: d.kind === 'generator', y: base + hz + s * 0.9 });
      }
      // ports (current floor only)
      if (current) addPorts(e, d, base);
    }
    flushInstances(pickables); flushEdges();
  }

  function addPorts(e, d, base) {
    d.ports.forEach((p, i) => {
      if (p.internal) return;
      const P = SF.portWorld3(e, i);
      const connected = S.portLinks.has(SF.portKey(e.id, i));
      // connected ports are hidden behind their belt; free ports get a small marker
      if (connected && SF.ed.tool !== 'link') return;
      const s = 0.5;
      const pm = addBox(gEnts, P.x, base + SF.portHeight(e, i), P.y, s, s, s,
        mat(p.fluid ? '#38bdf8' : '#f5a524', 1, { emissive: p.fluid ? '#0c4a6e' : '#7c2d12', emissiveIntensity: connected ? 0.2 : 0.9 }), { shadow: false, data: { port: [e.id, i] } });
      portMeshes.push(pm);
    });
  }

  // 3D points of a link: planner heights on top of the start floor, plus a lift when it changes floor
  function path3(l) {
    const ea = S.entities.get(l.from[0]), eb = S.entities.get(l.to[0]);
    const pts = SF.linkPath3D(l);
    const ya = elev(ea.level);
    const out = pts.map(p => new T.Vector3(p[0], ya + p[2], p[1]));
    if (ea.level !== eb.level && out.length >= 2) {
      const yb = elev(eb.level) + SF.portHeight(eb, l.to[1]);
      const k = out.length - 2;
      const lift = out[k].clone(); lift.y = yb;
      out.splice(k + 1, 0, lift);
      for (let i = k + 2; i < out.length; i++) out[i].y = yb;
    }
    return out;
  }

  // ---- spline meshes: bend a straight segment model along a 3D polyline (like UE spline mesh components)
  const UP = new T.Vector3(0, 1, 0);
  function pathFrames(pts) {
    const n = pts.length, cum = [0], Tn = [], R = [], U = [];
    for (let i = 1; i < n; i++) cum.push(cum[i - 1] + pts[i].distanceTo(pts[i - 1]));
    let lastR = new T.Vector3(1, 0, 0);
    for (let i = 0; i < n; i++) {
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
      const t = b.clone().sub(a).normalize();
      const r = t.clone().cross(UP);
      if (r.lengthSq() < 1e-6) r.copy(lastR); else r.normalize();
      lastR = r;
      Tn.push(t); R.push(r); U.push(r.clone().cross(t).normalize());
    }
    return { cum, T: Tn, R, U, L: cum[n - 1] };
  }

  function sweep(model, pts, yOff) {
    const F = pathFrames(pts);
    if (F.L < 0.05) return null;
    const g = model.geo, b = model.b;
    const z0 = b[2], z1 = b[5], unit = Math.max(0.2, z1 - z0);
    const tiles = Math.max(1, Math.round(F.L / unit)), seg = F.L / tiles;
    const P = g.attributes.position.array, N = g.attributes.normal.array, UVa = g.attributes.uv && g.attributes.uv.array;
    const nv = g.attributes.position.count;
    const pos = new Float32Array(nv * tiles * 3), nrm = new Float32Array(nv * tiles * 3);
    const uv = UVa ? new Float32Array(nv * tiles * 2) : null;
    const CA = g.attributes.color && g.attributes.color.array, col = CA ? new Float32Array(nv * tiles * 3) : null;
    const nScale = g.attributes.normal.normalized ? 1 / 127 : 1;
    const p = new T.Vector3(), t = new T.Vector3(), r = new T.Vector3(), u = new T.Vector3();
    for (let k = 0; k < tiles; k++) {
      let i = 1;
      // vertices are visited in arbitrary order, so search per vertex
      for (let v = 0; v < nv; v++) {
        const lx = P[v * 3], ly = P[v * 3 + 1], lz = P[v * 3 + 2];
        const s = SF.clamp((k + (z1 - lz) / unit) * seg, 0, F.L);
        let lo = 0, hi = F.cum.length - 1;
        while (hi - lo > 1) { const m = (lo + hi) >> 1; if (F.cum[m] <= s) lo = m; else hi = m; }
        i = hi;
        const f = (s - F.cum[lo]) / ((F.cum[hi] - F.cum[lo]) || 1);
        p.copy(pts[lo]).lerp(pts[hi], f);
        t.copy(F.T[lo]).lerp(F.T[hi], f).normalize();
        r.copy(F.R[lo]).lerp(F.R[hi], f).normalize();
        u.copy(F.U[lo]).lerp(F.U[hi], f).normalize();
        const o = (k * nv + v) * 3;
        pos[o] = p.x + r.x * lx + u.x * (ly + yOff);
        pos[o + 1] = p.y + r.y * lx + u.y * (ly + yOff);
        pos[o + 2] = p.z + r.z * lx + u.z * (ly + yOff);
        const nx = N[v * 3] * nScale, ny = N[v * 3 + 1] * nScale, nz = N[v * 3 + 2] * nScale;
        nrm[o] = r.x * nx + u.x * ny - t.x * nz;
        nrm[o + 1] = r.y * nx + u.y * ny - t.y * nz;
        nrm[o + 2] = r.z * nx + u.z * ny - t.z * nz;
        if (uv) { uv[(k * nv + v) * 2] = UVa[v * 2]; uv[(k * nv + v) * 2 + 1] = UVa[v * 2 + 1]; }
        if (col) { col[o] = CA[v * 3]; col[o + 1] = CA[v * 3 + 1]; col[o + 2] = CA[v * 3 + 2]; }
      }
      void i;
    }
    // indices grouped by material so the result keeps the model's material slots
    const idx = g.index.array, groups = g.groups.length ? g.groups : [{ start: 0, count: idx.length, materialIndex: 0 }];
    const total = idx.length * tiles;
    const out = total > 65535 * 3 || nv * tiles > 65535 ? new Uint32Array(total) : new Uint16Array(total);
    const geo = new T.BufferGeometry();
    let w = 0;
    for (const gr of groups) {
      const start = w;
      for (let k = 0; k < tiles; k++) {
        const base = k * nv;
        for (let j = gr.start; j < gr.start + gr.count; j++) out[w++] = idx[j] + base;
      }
      geo.addGroup(start, w - start, gr.materialIndex);
    }
    geo.setAttribute('position', new T.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new T.BufferAttribute(nrm, 3));
    if (uv) geo.setAttribute('uv', new T.BufferAttribute(uv, 2));
    if (col) geo.setAttribute('color', new T.BufferAttribute(col, 3));
    geo.setIndex(new T.BufferAttribute(out, 1));
    geo.computeBoundingSphere();
    return geo;
  }

  // materials for swept belts/pipes: textured slots from the model, optional tint (selection / jam / fluid)
  const sweepMatCache = new Map();
  function sweepMaterials(model, tint, op) {
    const key = model.key + '|' + tint + '|' + op;
    let m = sweepMatCache.get(key);
    if (m) return m;
    if (model.cube) {
      const tr = op < 1;
      const emissive = tint ? new T.Color(tint) : new T.Color('#000000');
      m = [new T.MeshStandardMaterial({ vertexColors: true, roughness: 0.65, metalness: 0.15, emissive, emissiveIntensity: tint ? 0.35 : 0, transparent: tr, opacity: op, depthWrite: !tr })];
      sweepMatCache.set(key, m);
      return m;
    }
    const tr = op < 1;
    const emissive = tint ? new T.Color(tint) : new T.Color('#000000');
    const ei = tint ? 0.35 : 0;
    const plain = new T.MeshStandardMaterial({ color: model.painted ? '#ffffff' : (tint || '#8e949c'), roughness: 0.55, metalness: 0.25, emissive, emissiveIntensity: ei, transparent: tr, opacity: op, depthWrite: !tr });
    m = [plain, plain, plain, ...model.maps.map(map => new T.MeshStandardMaterial({ map, roughness: 0.55, metalness: 0.2, emissive, emissiveIntensity: ei, transparent: tr, opacity: op, depthWrite: !tr }))];
    sweepMatCache.set(key, m);
    return m;
  }

  // split a path into sloped/flat runs and vertical (lift) runs
  function splitRuns(pts) {
    const runs = [];
    let cur = [pts[0]], vertical = false;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      const v = Math.hypot(b.x - a.x, b.z - a.z) < 0.05 && Math.abs(b.y - a.y) > 0.05;
      if (v !== vertical && cur.length > 1) { runs.push({ vertical, pts: cur }); cur = [a]; }
      vertical = v;
      cur.push(b);
    }
    if (cur.length > 1) runs.push({ vertical, pts: cur });
    return runs;
  }

  const sweepCache = new Map();   // link id -> { sig, geos }
  function linkGeometries(l, pts, isPipe) {
    const sig = l.kind + l.tier + '|' + pts.map(p => p.x.toFixed(2) + ',' + p.y.toFixed(2) + ',' + p.z.toFixed(2)).join(';');
    const c = sweepCache.get(l.id);
    if (c && c.sig === sig) return c.geos;
    if (c) c.geos.forEach(x => x.geo && x.geo.dispose());
    const segModel = getModel(isPipe ? 'pipe' : 'belt' + l.tier);
    if (!segModel) return null;
    const geos = [];
    const runs = isPipe ? [{ vertical: false, pts }] : splitRuns(pts);
    for (const run of runs) {
      if (run.vertical) { geos.push({ lift: run.pts }); continue; }
      // belts: segment surface sits on the path; pipes: centred on it
      const yOff = isPipe ? -(segModel.b[1] + segModel.b[4]) / 2 : 0;
      const geo = sweep(segModel, run.pts, yOff);
      if (geo) geos.push({ geo, model: segModel });
    }
    sweepCache.set(l.id, { sig, geos });
    return geos;
  }

  // conveyor lift: stack the real lift mid-sections up a vertical run
  function addLift(group, lid, a, b, tier, dirHint, op) {
    const mid = getModel('lift' + tier) || getModel('lift1');
    const y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
    if (!mid) {
      addBox(group, a.x, (y0 + y1) / 2, a.z, 1.6, y1 - y0, 1.6, mat('#3a414b', op), { data: { lid } });
      return;
    }
    const bb = mid.b, hseg = Math.max(0.5, bb[4] - bb[1]);
    const n = Math.max(1, Math.round((y1 - y0) / hseg));
    const sy = (y1 - y0) / (n * hseg);
    const d0 = dirHint && dirHint.lengthSq() > 1e-6 && isFinite(dirHint.x) ? dirHint : new T.Vector3(0, 0, -1);
    const yaw = Math.atan2(-d0.x, -d0.z);
    const mats = sweepMaterials(mid, null, op);
    for (let k = 0; k < n; k++) {
      const m = new T.Mesh(mid.geo, mats);
      m.rotation.y = yaw;
      m.scale.set(1, sy, 1);
      const off = new T.Vector3(-(bb[0] + bb[3]) / 2, 0, -(bb[2] + bb[5]) / 2).applyAxisAngle(UP, yaw);
      m.position.set(a.x + off.x, y0 + k * hseg * sy - bb[1] * sy, a.z + off.z);
      m.castShadow = op >= 1; m.userData.lid = lid;
      group.add(m);
    }
  }

  // Merge the swept belt/pipe meshes into one mesh per material per 80 m cell: a big factory has tens of thousands
  // of belt parts, and one draw call each made 3D unusable. Each merged mesh keeps which triangles belong to which
  // belt so clicking still selects the right one.
  const CELL = 80;
  let remap = new Int32Array(1 << 16), stamp = new Uint32Array(1 << 16), gen = 0;
  function batchLinks() {
    const buckets = new Map(), keep = [];
    for (const m of gLinks.children) {
      const g = m.geometry;
      const plain = m.isMesh && !m.isInstancedMesh && m.userData.lid && g.index && g.attributes.position && g.attributes.normal
        && m.position.lengthSq() === 0 && m.quaternion.w === 1 && m.scale.x === 1 && m.scale.y === 1 && m.scale.z === 1;
      if (!plain) { keep.push(m); continue; }
      if (!g.boundingSphere) g.computeBoundingSphere();
      const c = g.boundingSphere.center, cell = Math.floor(c.x / CELL) + ',' + Math.floor(c.z / CELL);
      const groups = g.groups.length ? g.groups : [{ start: 0, count: g.index.count, materialIndex: 0 }];
      for (const gr of groups) {
        const material = Array.isArray(m.material) ? m.material[gr.materialIndex] : m.material;
        if (!material) continue;
        const key = material.uuid + '|' + cell + '|' + (m.castShadow ? 1 : 0);
        let b = buckets.get(key);
        if (!b) buckets.set(key, b = { material, cast: m.castShadow, parts: [], verts: 0, idx: 0 });
        b.parts.push({ g, start: gr.start, count: gr.count, lid: m.userData.lid });
        b.idx += gr.count;
      }
    }
    if (!buckets.size) return;
    for (let i = gLinks.children.length - 1; i >= 0; i--) gLinks.remove(gLinks.children[i]);
    keep.forEach(m => gLinks.add(m));
    for (const b of buckets.values()) {
      // copy only the vertices each part uses (old index -> new index through a reusable typed array)
      let nv = 0;
      const maps = b.parts.map(pt => {
        const idx = pt.g.index.array, vc = pt.g.attributes.position.count;
        if (remap.length < vc) { remap = new Int32Array(vc * 2); stamp = new Uint32Array(vc * 2); }
        gen++;
        const used = [];
        for (let j = pt.start; j < pt.start + pt.count; j++) {
          const o = idx[j];
          if (stamp[o] !== gen) { stamp[o] = gen; remap[o] = nv++; used.push(o); }
        }
        const local = new Int32Array(used.length * 2);
        used.forEach((o, k) => { local[k * 2] = o; local[k * 2 + 1] = remap[o]; });
        return { pairs: local, gen };
      });
      const pos = new Float32Array(nv * 3), nrm = new Float32Array(nv * 3), uv = new Float32Array(nv * 2);
      const hasCol = b.parts.some(pt => pt.g.attributes.color), cols = hasCol ? new Float32Array(nv * 3).fill(1) : null;
      const index = nv > 65535 ? new Uint32Array(b.idx) : new Uint16Array(b.idx);
      const ranges = [];                                   // [first triangle, lid]
      let w = 0;
      b.parts.forEach((pt, k) => {
        const P = pt.g.attributes.position.array, N = pt.g.attributes.normal.array, U = pt.g.attributes.uv ? pt.g.attributes.uv.array : null;
        const Cc = cols && pt.g.attributes.color ? pt.g.attributes.color.array : null;
        const pr = maps[k].pairs;
        for (let q = 0; q < pr.length; q += 2) {
          const o = pr[q], n = pr[q + 1];
          pos[n * 3] = P[o * 3]; pos[n * 3 + 1] = P[o * 3 + 1]; pos[n * 3 + 2] = P[o * 3 + 2];
          nrm[n * 3] = N[o * 3]; nrm[n * 3 + 1] = N[o * 3 + 1]; nrm[n * 3 + 2] = N[o * 3 + 2];
          if (U) { uv[n * 2] = U[o * 2]; uv[n * 2 + 1] = U[o * 2 + 1]; }
          if (Cc) { cols[n * 3] = Cc[o * 3]; cols[n * 3 + 1] = Cc[o * 3 + 1]; cols[n * 3 + 2] = Cc[o * 3 + 2]; }
          remap[o] = n; stamp[o] = maps[k].gen;           // restore this part's mapping for the index copy
        }
        ranges.push([w / 3, pt.lid]);
        const idx = pt.g.index.array;
        for (let j = pt.start; j < pt.start + pt.count; j++) index[w++] = remap[idx[j]];
      });
      const geo = new T.BufferGeometry();
      geo.setAttribute('position', new T.BufferAttribute(pos, 3));
      geo.setAttribute('normal', new T.BufferAttribute(nrm, 3));
      geo.setAttribute('uv', new T.BufferAttribute(uv, 2));
      if (cols) geo.setAttribute('color', new T.BufferAttribute(cols, 3));
      geo.setIndex(new T.BufferAttribute(index, 1));
      geo.computeBoundingSphere();
      const mesh = new T.Mesh(geo, b.material);
      mesh.castShadow = b.cast; mesh.receiveShadow = true;
      mesh.userData = { ownGeo: true, ranges };
      gLinks.add(mesh);
    }
  }
  const lidAt = (ranges, tri) => { let lo = 0, hi = ranges.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (ranges[m][0] <= tri) lo = m; else hi = m - 1; } return ranges[lo][1]; };

  // Simple belts (fast): every belt / pipe segment is one box, all drawn as a single instanced mesh
  const SIMPLE_TIER = ['#9aa3ad', '#f59e0b', '#a3e635', '#38bdf8', '#c084fc', '#f472b6', '#fb7185'];
  const boxGeo = new T.BoxGeometry(1, 1, 1);
  const dummy = new T.Object3D();
  function buildSimpleLinks(segs) {
    if (!segs.length) return;
    const mesh = new T.InstancedMesh(boxGeo, new T.MeshStandardMaterial({ roughness: 0.6, metalness: 0.1 }), segs.length);
    const lids = new Array(segs.length), col = new T.Color();
    segs.forEach((sg, i) => {
      const { a, b, w, h, color, lid } = sg;
      const len = a.distanceTo(b);
      dummy.position.copy(a).add(b).multiplyScalar(0.5);
      dummy.position.y += sg.yOff;
      dummy.up.set(0, 1, 0);
      if (Math.hypot(b.x - a.x, b.z - a.z) < 0.05) dummy.up.set(1, 0, 0);       // vertical (lift) segment
      dummy.lookAt(b.x, b.y + sg.yOff, b.z);
      dummy.scale.set(w, h, len + 0.02);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      mesh.setColorAt(i, col.set(color));
      lids[i] = lid;
    });
    mesh.castShadow = true; mesh.receiveShadow = true;
    mesh.userData = { lids };
    gLinks.add(mesh);
  }

  function buildLinks(geom = true) {
    if (geom) clearGroup(gLinks);
    linkPaths = [];
    const simple = geom;            // belts and pipes are colour-coded boxes (no game meshes)
    const segs = [];
    const res = SF.sim.result;
    const live = new Set();
    for (const l of S.links.values()) {
      const ea = S.entities.get(l.from[0]), eb = S.entities.get(l.to[0]);
      if (!ea || !eb) continue;
      const op = Math.max(levelOpacity(ea.level), levelOpacity(eb.level));
      if (op <= 0) continue;
      live.add(l.id);
      const pts = path3(l);
      if (pts.length < 2) continue;
      const r = res && res.edges.get(l.id);
      const selected = SF.sel.links.has(l.id);
      const isPipe = l.kind === 'pipe';
      let fluid = null;
      if (isPipe) {
        const main = r && Object.keys(r.flows).sort((a, b) => r.flows[b] - r.flows[a])[0];
        fluid = main ? SF.item(main).color : null;
      }
      const tint = selected ? '#38bdf8' : r && r.jam > 0.2 ? '#ef4444' : fluid;
      const geos = geom && !simple ? linkGeometries(l, pts, isPipe) : null;
      if (!geom) { /* item paths only */ } else if (simple) {
        const color = tint || (isPipe ? '#475569' : SIMPLE_TIER[l.tier] || '#9aa3ad');
        for (let i = 1; i < pts.length; i++) {
          if (pts[i].distanceTo(pts[i - 1]) < 1e-3) continue;
          segs.push(isPipe ? { a: pts[i - 1], b: pts[i], w: 0.9, h: 0.9, yOff: 0, color, lid: l.id } : { a: pts[i - 1], b: pts[i], w: 1.6, h: 0.25, yOff: -0.12, color, lid: l.id });
        }
      } else if (geos) {
        for (const g of geos) {
          if (g.lift) { addLift(gLinks, l.id, g.lift[0], g.lift[g.lift.length - 1], l.tier, pts[Math.max(0, pts.indexOf(g.lift[0]) - 1)].clone().sub(g.lift[0]).setY(0).normalize().negate(), op); continue; }
          const m = new T.Mesh(g.geo, sweepMaterials(g.model, tint, op));
          m.castShadow = op >= 1; m.receiveShadow = true; m.userData.lid = l.id;
          gLinks.add(m);
        }
      } else {
        // models still loading: simple tube
        for (let i = 1; i < pts.length; i++) {
          const a = pts[i - 1], b = pts[i], len = a.distanceTo(b);
          if (len < 1e-3) continue;
          const m = new T.Mesh(unitCyl, mat(isPipe ? (fluid || '#475569') : '#2a2f37', op));
          m.position.copy(a).add(b).multiplyScalar(0.5);
          m.scale.set(isPipe ? 1 : 1.6, len, isPipe ? 1 : 0.4);
          m.quaternion.setFromUnitVectors(UP, b.clone().sub(a).normalize());
          m.userData.lid = l.id;
          gLinks.add(m);
        }
      }
      if (SF.live && SF.live.active && !isPipe && op >= 1) {
        const cum = [0];
        for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + pts[i].distanceTo(pts[i - 1]));
        linkPaths.push({ pts, cum, L: cum[cum.length - 1], lid: l.id, live: true });
      } else if (r && r.total > 0.01 && !isPipe && op >= 1) {
        const cum = [0];
        for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + pts[i].distanceTo(pts[i - 1]));
        const speed = (D.belts.find(b => b.tier === l.tier) || D.belts[0]).speed;
        const items = Object.keys(r.flows).filter(k => r.flows[k] > 1e-6);
        let acc = 0;
        const dist = items.map(it => { acc += r.flows[it] / r.total; return [acc, new T.Color(SF.item(it).color)]; });
        linkPaths.push({ pts, cum, L: cum[cum.length - 1], speed, sp: speed / (r.total / 60), dist, real: true });
      }
    }
    if (!geom) return;
    if (simple) { buildSimpleLinks(segs); return; }
    for (const [id, c] of sweepCache) if (!live.has(id)) { c.geos.forEach(x => x.geo && x.geo.dispose()); sweepCache.delete(id); }
    batchLinks();
  }

  function hash(n) { n = (n ^ 61) ^ (n >>> 16); n = n + (n << 3); n = n ^ (n >>> 4); n = Math.imul(n, 0x27d4eb2d); n = n ^ (n >>> 15); return (n >>> 0) / 4294967296; }
  const tmpM = new T.Matrix4(), tmpV = new T.Vector3();

  function updateItems(t) {
    // grow the item mesh if the factory carries more items than it holds (big Sim factories)
    if (SF.live && SF.live.active) {
      const need = SF.live.itemsOnBelts() + 100;
      if (need > itemMesh.instanceMatrix.count) {
        const bigger = new T.InstancedMesh(itemMesh.geometry, itemMesh.material, Math.ceil(need * 1.5));
        bigger.castShadow = itemMesh.castShadow; bigger.frustumCulled = itemMesh.frustumCulled;
        itemMesh.parent.add(bigger); itemMesh.parent.remove(itemMesh); itemMesh.dispose(); itemMesh = bigger;
      }
    }
    let n = 0;
    const max = itemMesh.instanceMatrix.count;
    const colCache = new Map();
    const colOf = it => { let c = colCache.get(it); if (!c) colCache.set(it, c = new T.Color(SF.item(it).color)); return c; };
    for (const p of linkPaths) {
      if (p.live) {
        // Sim mode: the real items, at their real positions
        const list = SF.live.beltItems(p.lid) || [];
        let seg = 1;
        for (let k = list.length - 1; k >= 0 && n < max; k--) {          // tail first -> increasing distance
          const s = list[k].f * p.L;
          while (seg < p.cum.length - 1 && p.cum[seg] < s) seg++;
          const a = p.pts[seg - 1], b = p.pts[seg];
          const segL = p.cum[seg] - p.cum[seg - 1] || 1;
          tmpV.copy(a).lerp(b, SF.clamp((s - p.cum[seg - 1]) / segL, 0, 1));
          tmpV.y += 0.33;
          tmpM.makeTranslation(tmpV.x, tmpV.y, tmpV.z);
          itemMesh.setMatrixAt(n, tmpM);
          itemMesh.setColorAt(n, colOf(list[k].it));
          n++;
        }
        continue;
      }
      const shift = S.settings.anim ? t * p.speed : 0;
      const phase = ((shift % p.sp) + p.sp) % p.sp, base = Math.floor(shift / p.sp);
      let seg = 1;
      for (let k = 0; ; k++) {
        const s = phase + k * p.sp;
        if (s > p.L || n >= max) break;
        while (seg < p.cum.length - 1 && p.cum[seg] < s) seg++;
        const a = p.pts[seg - 1], b = p.pts[seg];
        const segL = p.cum[seg] - p.cum[seg - 1] || 1;
        tmpV.copy(a).lerp(b, (s - p.cum[seg - 1]) / segL);
        tmpV.y += 0.33;
        tmpM.makeTranslation(tmpV.x, tmpV.y, tmpV.z);
        itemMesh.setMatrixAt(n, tmpM);
        const h = hash((k - base) * 2654435761 >>> 0);
        itemMesh.setColorAt(n, (p.dist.find(c => h <= c[0]) || p.dist[p.dist.length - 1])[1]);
        n++;
      }
    }
    itemMesh.count = n;
    itemMesh.instanceMatrix.needsUpdate = true;
    if (itemMesh.instanceColor) itemMesh.instanceColor.needsUpdate = true;
  }

  // ------------------------------------------------------------ ghost / overlays
  let tip3d = null;
  function showTip(lines, bad) {
    if (!tip3d) {
      tip3d = document.createElement('div');
      tip3d.id = 'tip3d';
      document.body.appendChild(tip3d);
    }
    if (!lines) { tip3d.style.display = 'none'; return; }
    const r = cv3.getBoundingClientRect();
    tip3d.innerHTML = lines.map((l, i) => `<div class="${i ? 'sub' : ''}">${l}</div>`).join('');
    tip3d.className = bad ? 'bad' : '';
    tip3d.style.display = 'block';
    tip3d.style.left = (r.left + mouse.x + 16) + 'px';
    tip3d.style.top = (r.top + mouse.y + 18) + 'px';
  }

  // feed the shared (2D editor) belt tool with the 3D cursor: snap to a hovered port, else the ground
  function syncEditorMouse(hit, alt) {
    const ed = SF.ed;
    if (hit && hit.port) {
      const P = SF.portWorld(S.entities.get(hit.port[0]), hit.port[1]);
      ed.mouse.wx = P.x; ed.mouse.wy = P.y;
    } else if (mouse.ground) {
      ed.mouse.wx = mouse.ground.x; ed.mouse.wy = mouse.ground.z;
    }
    ed.mouse.alt = !!alt;
  }

  const ghostMat = ok => new T.MeshStandardMaterial({ color: ok ? '#22c55e' : '#ef4444', transparent: true, opacity: 0.45, depthWrite: false, emissive: ok ? '#14532d' : '#7f1d1d', emissiveIntensity: 0.6 });
  // hologram of the pole that the next click places: real pole model at its height and facing + arrow
  const coneGeo = new T.ConeGeometry(0.35, 0.9, 12);
  function poleGhost(x, z, hgt, ok, ang = 0, kind = 'belt') {
    const base = elev(S.level);
    const isPipe = kind === 'pipe';
    const hm = getModel(isPipe ? 'pipepole' : 'pole');
    const top = base + hgt - (isPipe ? 0.75 : 0.2);
    const holderH = hm ? hm.b[4] - hm.b[1] : 0.9;
    const stemTop = Math.max(base + 0.05, top - (isPipe ? 0 : holderH));
    const stem = new T.Mesh(unitCyl, ghostMat(ok));
    stem.scale.set(0.3, Math.max(0.05, stemTop - base), 0.3); stem.position.set(x, (base + stemTop) / 2, z);
    gOver.add(stem);
    if (hm) {
      const m = new T.Mesh(hm.geo, ghostMat(ok));
      m.rotation.y = -ang - Math.PI / 2;               // same orientation rule as placed poles
      m.position.set(x, isPipe ? top - hm.b[4] + 1.5 : top - hm.b[4], z);
      gOver.add(m);
    } else {
      const cap = new T.Mesh(unitBox, ghostMat(ok));
      cap.scale.set(0.9, 0.3, 1.8); cap.rotation.y = -ang - Math.PI / 2; cap.position.set(x, top - 0.15, z);
      gOver.add(cap);
    }
    // arrow showing which way the belt will leave the pole
    const arrow = new T.Mesh(coneGeo, new T.MeshBasicMaterial({ color: ok ? '#4ade80' : '#f87171', transparent: true, opacity: 0.9, depthTest: false }));
    arrow.renderOrder = 10;
    arrow.rotation.z = -Math.PI / 2;                    // point along +x ...
    const pivot = new T.Group();
    pivot.add(arrow); arrow.position.x = 1.4;
    pivot.rotation.y = -ang;                            // ... then turn to the pole facing
    pivot.position.set(x, base + hgt + 0.7, z);
    gOver.add(pivot);
  }

  function updateOverlay() {
    const ed = SF.ed;
    let key = '';
    const api = SF.edApi;
    if (ed.tool === 'place' && ed.placeDef && mouse.ground) {
      const d = SF.defs[ed.placeDef];
      // splitters / mergers / junctions snap onto an existing belt or pipe
      syncEditorMouse(null, false);
      const ag = api && api.attachGhost();
      const [x, y] = ag ? [ag.e.x, ag.e.y] : SF.snapPos(ed.placeDef, mouse.ground.x, mouse.ground.z, ed.rot);
      const rot = ag ? ag.e.rot : ed.rot;
      key = `${ed.placeDef}|${x}|${y}|${rot}|${S.level}|${!!ag}`;
      if (key !== ghostKey) {
        clearGroup(gOver);
        const e = { id: '__g', def: ed.placeDef, x, y, rot, level: S.level };
        const [w, h] = SF.entSize(e);
        const hz = d.kind === 'designer' || d.kind === 'zone' ? 0.3 : (ag ? 3 : entityHeight(d));
        const ok = ag ? true : !SF.overlaps(e);
        const yb = d.structure && d.kind !== 'wall' ? elev(S.level) - hz / 2 : elev(S.level) + (ag ? 0.5 : 0) + hz / 2;
        addBox(gOver, x, yb, y, w, hz, h, mat(ok ? '#22c55e' : '#ef4444', 0.35), { shadow: false });
        const edg = new T.LineSegments(unitEdges, lineMat(ok ? 0x22c55e : 0xef4444));
        edg.position.set(x, yb, y); edg.scale.set(w, hz, h); gOver.add(edg);
        ghost = { e, ok, attach: ag };
      }
      showTip(ag ? ['Click to insert into this ' + (ag.l.kind === 'pipe' ? 'pipeline' : 'belt')] : null);
    } else if (ed.tool === 'link' && mouse.ground && api) {
      const L = ed.link;
      const hover = pick();
      syncEditorMouse(hover && hover.port ? hover : null, mouse.alt);
      const pv = L && L.start ? api.linkPreview() : null;
      const mp = api.magnetPort(ed.mouse.wx, ed.mouse.wy);
      key = 'link|' + ed.mouse.wx.toFixed(2) + ',' + ed.mouse.wy.toFixed(2) + '|' + (L ? L.h + L.style + L.start.join() + (L.rotOffset || 0) : '') + '|' + ed.beltTier;
      if (key !== ghostKey) {
        clearGroup(gOver);
        const base = elev(S.level);
        if (pv && pv.pts.length > 1) {
          const pts = pv.pts.map(p => new T.Vector3(p[0], base + p[2], p[1]));
          const geo = null;               // preview as a line
          if (geo) {
            const m = new T.Mesh(geo, ghostMat(pv.ok)); m.userData.ownGeo = true; m.renderOrder = 5;
            gOver.add(m);
          } else {
            const g = new T.BufferGeometry().setFromPoints(pts);
            const line = new T.Line(g, lineMat(pv.ok ? 0x22c55e : 0xef4444)); line.userData.ownGeo = true;
            gOver.add(line);
          }
          if (pv.free) poleGhost(pv.free[0], pv.free[1], L.h, pv.ok, pv.ang, L.kind);
        } else if (!L && !mp) {
          const [fx, fz] = api.snapPt(ed.mouse.wx, ed.mouse.wy);
          poleGhost(fx, fz, 1, true, 0, ed.linkKind);
        }
        if (mp) {
          const P = SF.portWorld3(S.entities.get(mp[0]), mp[1]);
          const hh = SF.portHeight(S.entities.get(mp[0]), mp[1]);
          const ring = new T.Mesh(new T.TorusGeometry(1.1, 0.12, 8, 32), new T.MeshBasicMaterial({ color: '#22c55e' }));
          ring.userData.ownGeo = true;
          ring.rotation.x = Math.PI / 2; ring.position.set(P.x, base + hh, P.y);
          gOver.add(ring);
        }
      }
      // floating tip like the 2D view
      const spec = (L ? L.kind : ed.linkKind) === 'pipe' ? D.pipes[ed.pipeTier - 1] : D.belts[ed.beltTier - 1];
      if (!L) showTip([`${spec.name} · click a port or the ground to start`, 'Right-drag to pan while placing']);
      else if (pv && pv.error) showTip([pv.error], true);
      else if (pv && pv.tooShort) showTip(['Move further away']);
      else {
        const len = pv ? SF.pathLength(pv.pts) : 0;
        const rot = Math.round((L.rotOffset || 0) * 180 / Math.PI);
        showTip([`${spec.name} · ${SF.fmt(len, 1)} m · height ${SF.fmt(L.h, 1)} m · ${api.styleName(L.style)}${rot ? ` · turned ${rot > 0 ? '+' : ''}${rot}°` : ''}${pv && pv.problems && pv.problems.length ? ' · ' + pv.problems[0].text : ''}`,
          '↑/↓ height · [ ] or Ctrl+wheel rotate pole · R style · right-click to finish'], pv && !pv.ok && !pv.tooShort);
      }
    } else {
      // nothing to preview: always clear (a click may have reset ghostKey before the tool changed)
      if (gOver.children.length) clearGroup(gOver);
      showTip(null);
    }
    ghostKey = key;
  }

  // ------------------------------------------------------------ input
  const ray = new T.Raycaster();
  const ndc = new T.Vector2();
  function setMouse(ev) {
    const r = cv3.getBoundingClientRect();
    mouse.x = ev.clientX - r.left; mouse.y = ev.clientY - r.top;
    mouse.alt = ev.altKey;
    ndc.set(mouse.x / r.width * 2 - 1, -(mouse.y / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const plane = new T.Plane(new T.Vector3(0, 1, 0), -elev(S.level));
    const hit = new T.Vector3();
    mouse.ground = ray.ray.intersectPlane(plane, hit) ? hit : null;
  }
  const tmpP = new T.Vector3();
  function pick() {
    // port markers are small and often sit against a model: pick them by screen distance first
    const r = cv3.getBoundingClientRect();
    let best = null, bd = 14;
    for (const pm of portMeshes) {
      tmpP.copy(pm.position).project(camera);
      if (tmpP.z > 1) continue;
      const d = Math.hypot((tmpP.x + 1) / 2 * r.width - mouse.x, (1 - tmpP.y) / 2 * r.height - mouse.y);
      if (d < bd) { bd = d; best = pm; }
    }
    if (best) return { port: best.userData.port };
    const hits = ray.intersectObjects([...pickables, ...gLinks.children], false);
    for (const h of hits) {
      const u = h.object.userData;
      if (u.lids && h.instanceId != null) return { link: u.lids[h.instanceId] };
      if (u.eids && h.instanceId != null) return { ent: u.eids[h.instanceId], structure: u.structure };
      if (u.ranges && h.faceIndex != null) return { link: lidAt(u.ranges, h.faceIndex) };
      if (u.port) return { port: u.port };
      if (u.eid) return { ent: u.eid, structure: u.structure };
      if (u.lid) return { link: u.lid };
    }
    return null;
  }

  let wheelRot = 0;
  function linkClick(hit, alt) {
    const ed = SF.ed, api = SF.edApi;
    if (!mouse.ground && !(hit && hit.port)) return;
    syncEditorMouse(hit && hit.port ? hit : null, alt);
    if (!ed.link) {
      const mp = api.magnetPort(ed.mouse.wx, ed.mouse.wy);
      if (mp) api.startLink(mp);
      else if (ed.tool === 'link') api.startOnGround();
    } else api.placeNext();
    ghostKey = '';
  }
  function bindInput() {
    cv3.addEventListener('contextmenu', ev => ev.preventDefault());
    cv3.addEventListener('mousedown', ev => {
      setMouse(ev); cv3.focus();
      const hit = pick();
      const ed = SF.ed, api = SF.edApi;
      if (ev.button === 0 && ev.altKey) {
        // Alt + drag always rotates the camera (even over foundations / buildings)
        drag = { type: 'orbit', sx: mouse.x, sy: mouse.y, yaw: cam.yaw, pitch: cam.pitch, moved: false, altClick: { hit, alt: true } };
        return;
      }
      if (ev.button === 0 && !SF.ed.space) {
        if (ed.tool === 'place' && ed.placeDef && ghost) {
          if (ghost.attach) { api.attachOnto(ghost.attach); ghostKey = ''; return; }
          if (!ghost.ok && !ev.altKey) { SF.toast('Overlaps another building (hold Alt to force)', 'warn'); return; }
          const e = SF.addEntity(ed.placeDef, ghost.e.x, ghost.e.y, ed.rot, S.level, { ...(ed.placeProps || {}) });
          if (ed.placeDef === 'LiftBottom') { SF.makeLift(e, ed.beltTier || 1); SF.onLevelsChanged && SF.onLevelsChanged(); }
          SF.changed(); SF.selectOnly([e.id]); ghostKey = '';
          return;
        }
        // belts & pipes: same chain logic as 2D (ports, ground poles, magnet snapping, heights)
        if (ed.tool === 'link' || (ed.tool === 'select' && hit && hit.port)) { linkClick(hit, ev.altKey); return; }
        if (ed.tool === 'delete' && hit && (hit.ent || hit.link)) {
          if (hit.ent) SF.removeEntity(hit.ent); else S.links.delete(hit.link);
          SF.changed(); SF.selectOnly(); return;
        }
        if (hit && hit.ent && hit.structure && !SF.sel.ents.has(hit.ent) && !ev.shiftKey && !ev.ctrlKey) {
          // foundations are everywhere: dragging an unselected one orbits, a plain click selects it
          drag = { type: 'orbit', sx: mouse.x, sy: mouse.y, yaw: cam.yaw, pitch: cam.pitch, moved: false, selectOnClick: hit.ent };
          return;
        }
        if (hit && hit.ent) {
          if (ev.shiftKey || ev.ctrlKey) { SF.sel.ents.has(hit.ent) ? SF.sel.ents.delete(hit.ent) : SF.sel.ents.add(hit.ent); SF.onSelection && SF.onSelection(); }
          else if (!SF.sel.ents.has(hit.ent)) SF.selectOnly([hit.ent]);
          if (mouse.ground && SF.sel.ents.has(hit.ent)) {
            const orig = new Map([...SF.sel.ents].map(id => { const e = S.entities.get(id); return [id, [e.x, e.y]]; }));
            const links = new Map([...S.links.values()].filter(l => SF.sel.ents.has(l.from[0]) && SF.sel.ents.has(l.to[0])).map(l => [l.id, (l.pts || []).map(p => [...p])]));
            drag = { type: 'move', anchor: hit.ent, gx: mouse.ground.x, gz: mouse.ground.z, orig, links, moved: false, sx: mouse.x, sy: mouse.y };
          }
          return;
        }
        if (hit && hit.link) { SF.selectOnly([], [hit.link]); return; }
        drag = { type: 'orbit', sx: mouse.x, sy: mouse.y, yaw: cam.yaw, pitch: cam.pitch, moved: false };
        return;
      }
      drag = { type: 'pan', sx: mouse.x, sy: mouse.y, tx: cam.tx, tz: cam.tz, moved: false, button: ev.button };
    });
    window.addEventListener('mousemove', ev => {
      if (!v3.active) return;
      setMouse(ev);
      if (drag) {
        const dx = mouse.x - drag.sx, dy = mouse.y - drag.sy;
        if (Math.hypot(dx, dy) > 3) drag.moved = true;
        if (drag.type === 'orbit') { cam.yaw = drag.yaw - dx * 0.006; cam.pitch = drag.pitch + dy * 0.005; }
        else if (drag.type === 'pan') {
          const k = cam.dist / 700;
          const sx = Math.cos(cam.yaw), sz = -Math.sin(cam.yaw);     // camera right on the ground
          const fx = -Math.sin(cam.yaw), fz = -Math.cos(cam.yaw);    // camera forward on the ground
          cam.tx = drag.tx - (dx * sx - dy * fx) * k; cam.tz = drag.tz - (dx * sz - dy * fz) * k;
        } else if (drag.type === 'move' && mouse.ground && drag.moved) {
          const a = S.entities.get(drag.anchor);
          const [ox, oy] = drag.orig.get(drag.anchor);
          const [nx, ny] = SF.snapPos(a.def, ox + mouse.ground.x - drag.gx, oy + mouse.ground.z - drag.gz, a.rot);
          const ddx = nx - ox, ddy = ny - oy;
          for (const [id, [x, y]] of drag.orig) { const e = S.entities.get(id); e.x = x + ddx; e.y = y + ddy; }
          for (const [lid, pts] of drag.links) { const l = S.links.get(lid); if (l) l.pts = pts.map(p => [p[0] + ddx, p[1] + ddy]); }
          SF.touch();
        }
      } else if (ev.target === cv3) {
        const hit = pick();
        SF.hover = hit;
        const linking = SF.ed.tool === 'link';
        cv3.style.cursor = SF.ed.tool === 'place' || linking ? 'crosshair' : hit && hit.port ? 'pointer' : hit && hit.ent ? 'move' : 'grab';
        SF.onHover && SF.onHover(!linking && hit && !hit.structure ? hit : null, ev);
      }
    });
    window.addEventListener('mouseup', () => {
      if (!v3.active || !drag) return;
      const d = drag; drag = null;
      if (d.type === 'move' && d.moved) SF.changed();
      else if (d.type === 'orbit' && !d.moved) {
        if (d.selectOnClick) SF.selectOnly([d.selectOnClick]);
        else if (d.altClick && SF.ed.tool === 'link') linkClick(d.altClick.hit, true);
        else SF.selectOnly();
      }
      else if (d.type === 'pan' && !d.moved && d.button === 2) {
        // right-click: finish the belt chain, else leave the current tool
        if (SF.ed.link) SF.edApi.endChain();
        else if (SF.ed.tool !== 'select') SF.setTool('select');
      }
    });
    cv3.addEventListener('dblclick', ev => {
      setMouse(ev);
      if (SF.ed.tool === 'link') return;
      const hit = pick();
      if (hit && hit.ent) {
        const e = S.entities.get(hit.ent);
        const [w, h] = SF.entSize(e);
        v3.lookAt(e.x, e.y, Math.max(25, Math.max(w, h) * 2.4));
      }
    });
    cv3.addEventListener('mouseleave', () => showTip(null));
    cv3.addEventListener('wheel', ev => {
      ev.preventDefault();
      if (ev.ctrlKey && SF.ed.link) {
        // Ctrl + wheel turns the next pole while placing
        wheelRot += ev.deltaY;
        if (Math.abs(wheelRot) >= 50) { SF.rotateNextPole(wheelRot < 0 ? 15 : -15); wheelRot = 0; }
        return;
      }
      if (ev.altKey) { SF.changeLevel && SF.changeLevel((ev.deltaY || ev.deltaX) < 0 ? 1 : -1, false); return; }
      // zoom towards the point under the cursor
      setMouse(ev);
      const f = Math.pow(1.0015, ev.deltaY);
      if (mouse.ground) {
        const k = 1 - f;
        cam.tx += (mouse.ground.x - cam.tx) * k * 0.6; cam.tz += (mouse.ground.z - cam.tz) * k * 0.6;
      }
      cam.dist *= f;
    }, { passive: false });
  }

  // ------------------------------------------------------------ public
  v3.setActive = (on) => {
    if (on && !v3.ready) init();
    v3.active = on;
    cv3.style.display = on ? 'block' : 'none';
    document.getElementById('cv').style.display = on ? 'none' : 'block';
    document.body.classList.toggle('mode3d', on);
    if (on) {
      resize();
      if (!v3.fitted) { v3.fit(); v3.fitted = true; }
      builtVersion = -1;
      cv3.focus();
    } else { if (SF.ed.link) SF.edApi.endChain(); showTip(null); SF.dirty = true; }
    SF.onMode && SF.onMode();
  };
  v3.toggle = () => v3.setActive(!v3.active);
  // planner point (x, y, height above the current floor) -> client pixel position
  v3.toScreen = (x, y, h = 0) => {
    updateCamera();
    const v = new T.Vector3(x, elev(S.level) + h, y).project(camera);
    const r = cv3.getBoundingClientRect();
    return { clientX: r.left + (v.x + 1) / 2 * r.width, clientY: r.top + (1 - v.y) / 2 * r.height };
  };
  // frame a point (planner coords) at a given distance
  // debugging / performance numbers
  v3.stats = () => {
    let meshes = 0, tris = 0;
    scene.traverse(o => { if (o.isMesh) { meshes++; const g = o.geometry; tris += (g.index ? g.index.count : (g.attributes.position ? g.attributes.position.count : 0)) / 3 * (o.isInstancedMesh ? o.count : 1); } });
    const c0 = gLinks.children.find(o => o.isMesh);
    const sample = c0 && { lid: c0.userData.lid, index: !!c0.geometry.index, attrs: Object.keys(c0.geometry.attributes), pos: c0.position.toArray(), q: c0.quaternion.toArray(), s: c0.scale.toArray(), inst: !!c0.isInstancedMesh, ranges: !!c0.userData.ranges };
    return { buildTimes: { ...buildTimes }, sample, calls: renderer.info.render.calls, triangles: renderer.info.render.triangles, meshes, entities: gEnts.children.length, links: gLinks.children.length, geometries: renderer.info.memory.geometries, textures: renderer.info.memory.textures };
  };
  v3.lookAt = (x, y, dist, yaw, pitch) => {
    cam.tx = x; cam.tz = y; if (dist) cam.dist = dist;
    if (yaw != null) cam.yaw = yaw; if (pitch != null) cam.pitch = pitch;
  };

  let lastRes = null, lastCapCheck = 0, lastLiveBuild = 0, entsDirty = false, builtTints = '';
  // which belts are drawn tinted (jammed red / pipe fluid colour) under the current result
  function tintSig() {
    const res = SF.sim.result;
    if (!res) return '';
    let sig = '';
    for (const l of S.links.values()) {
      const r = res.edges.get(l.id);
      if (!r) continue;
      if (l.kind === 'pipe') { const main = Object.keys(r.flows).sort((a, b) => r.flows[b] - r.flows[a])[0]; if (main) sig += l.id + main; }
      else if (r.jam > 0.2) sig += l.id + 'j';
    }
    return sig;
  }
  const buildTimes = {};
  const timed = (k, fn) => { const t0 = performance.now(); fn(); buildTimes[k] = Math.round(performance.now() - t0); };
  v3.frame = (t) => {
    if (!v3.active) return;
    const key = [S.levels.map((l, i) => SF.levelZ(i) + (SF.levelVisible(i) ? 'v' : 'h')).join(','), S.settings.hideWalls, S.settings.hideFoundations, S.settings.models3d, S.settings.simpleBelts, S.settings.cubeModels, SF.ed.tool === 'link', [...SF.sel.ents].join(), [...SF.sel.links].join()].join('|');
    // in Sim mode results arrive several times a second: refresh statuses at most every 2 s
    const resChanged = SF.sim.result !== lastRes && (!SF.sim.result || !SF.sim.result.live || !lastRes || !lastRes.live || t - lastLiveBuild > 2);
    if (resChanged) lastLiveBuild = t;
    const liveOnly = resChanged && SF.sim.result && SF.sim.result.live && S.version === builtVersion && S.level === builtLevel && key === builtKey;
    if (liveOnly) {
      // Sim mode update: statuses and item positions change, belt geometry does not
      timed('entities', buildEntities);
      timed('itemPaths', () => buildLinks(false));
      lastRes = SF.sim.result; entsDirty = false;
    } else if (resChanged && S.version === builtVersion && S.level === builtLevel && key === builtKey && tintSig() === builtTints) {
      // a new Free run result that does not change any belt colour: refresh statuses and item paths only
      timed('entities', buildEntities);
      timed('itemPaths', () => buildLinks(false));
      lastRes = SF.sim.result; entsDirty = false;
    } else if (S.version !== builtVersion || S.level !== builtLevel || key !== builtKey || resChanged) {
      timed('entities', buildEntities);
      timed('links', () => buildLinks());
      builtTints = tintSig();
      entsDirty = false;
      builtVersion = S.version; builtLevel = S.level; builtKey = key; lastRes = SF.sim.result;
      grid.position.y = elev(S.level) - 0.02;
    }
    // ease the camera target to the current floor's height
    cam.ty += (elev(S.level) - cam.ty) * 0.15;
    for (const r of runners) {
      const sp = S.settings.anim ? r.eff : 0;
      r.mesh.rotation.y = t * 2.2 * sp;
      r.mesh.rotation.x = t * 1.3 * sp;
      r.mesh.position.y = r.y + Math.sin(t * 3) * 0.25 * sp;
    }
    // refresh roof textures whose icons finished loading
    if (canIcon && t - lastCapCheck > 0.5) {
      lastCapCheck = t;
      for (const c of capCache.values()) if (!c.done) { entsDirty = true; break; }
    }
    if (entsDirty) { entsDirty = false; timed('entities', buildEntities); }   // roof icons finished loading
    updateItems(t);
    updateOverlay();
    updateCamera();
    renderer.render(scene, camera);
  };
})(window.SF);
