"""Cubify: rebuild a model out of plain boxes (Blender script).

Voxelises the model, fills its inside, colours it from the original surface (texture sampled at the nearest
point) and writes ONE mesh with ONE material: only the outside faces, with same-coloured neighbours on each
plane merged into large rectangles, and the colours stored as vertex colours. The result keeps the original size, origin and
facing, so it drops straight in as a replacement.

Batch (whole Custom folder, or any folders / .glb files):
    blender -b -P tools/cubify.py -- "O:/Games/sat/Custom" [--voxel 0.4] [--colors 8] [--force]
  Each model folder gets "<Name> - cubes.glb" (a building's body + moving parts are combined into one);
  folders with separate pieces (belt, lift bottom/middle/top...) get one "- cubes" file per piece.

Inside Blender (Scripting tab): select mesh objects and run the script: a "<name>_cubes" object is added.

Options:
    --voxel V    box grid size in metres (default: the folder's "voxel" in Custom/manifest.json, else automatic,
                 ~1/40 of the model's longest side, 0.1–1 m)
    --colors N   number of colours / materials in the result (default 8)
    --force      rebuild files that already have a "- cubes.glb"
"""
import bpy, bmesh, sys, os, math, re
from collections import deque, Counter
from mathutils import Vector
from mathutils.bvhtree import BVHTree

try:
    import numpy as np
except ImportError:          # Blender ships numpy; this is just a guard
    np = None


# ------------------------------------------------------------------ geometry + colour sampling
def gather(objs):
    """World-space triangles of the given objects (evaluated, so skinned / modified meshes work)."""
    dg = bpy.context.evaluated_depsgraph_get()
    verts, tris, tri_info = [], [], []          # tri_info: (material, uv0, uv1, uv2)
    for ob in objs:
        if ob.type != 'MESH':
            continue
        ev = ob.evaluated_get(dg)
        me = ev.to_mesh()
        me.calc_loop_triangles()
        mw = ob.matrix_world
        base = len(verts)
        verts.extend(mw @ v.co for v in me.vertices)
        uvl = me.uv_layers.active.data if me.uv_layers.active else None
        for lt in me.loop_triangles:
            tris.append(tuple(base + i for i in lt.vertices))
            mat = ob.material_slots[lt.material_index].material if lt.material_index < len(ob.material_slots) else None
            uvs = tuple(tuple(uvl[li].uv) for li in lt.loops) if uvl else None
            tri_info.append((mat, uvs))
        ev.to_mesh_clear()
    return verts, tris, tri_info


_img_cache = {}
def material_sampler(mat):
    """Returns f(u, v) -> (r, g, b) for a material: its base-colour texture if it has one, else its colour."""
    if mat is None:
        return lambda u, v: (0.6, 0.6, 0.6)
    if mat.name in _img_cache:
        return _img_cache[mat.name]
    col, img = (0.6, 0.6, 0.6), None
    if mat.use_nodes:
        bsdf = next((n for n in mat.node_tree.nodes if n.type == 'BSDF_PRINCIPLED'), None)
        if bsdf:
            inp = bsdf.inputs.get('Base Color')
            if inp is not None:
                col = tuple(inp.default_value[:3])
                if inp.is_linked:
                    src = inp.links[0].from_node
                    # follow simple chains (mix / multiply nodes) back to an image
                    for _ in range(4):
                        if src.type == 'TEX_IMAGE':
                            img = src.image
                            break
                        nxt = [i for i in src.inputs if i.is_linked]
                        if not nxt:
                            break
                        src = nxt[0].links[0].from_node
    else:
        col = tuple(mat.diffuse_color[:3])
    if img is not None and img.size[0] > 0 and np is not None:
        w, h = img.size
        px = np.empty(w * h * 4, dtype=np.float32)
        img.pixels.foreach_get(px)
        px = px.reshape(h, w, 4)
        lin = img.colorspace_settings.name.lower() in ('srgb', 'srgb (standard)') or 'srgb' in img.colorspace_settings.name.lower()
        def f(u, v, px=px, w=w, h=h, lin=lin):
            x = int((u % 1.0) * (w - 1)); y = int((v % 1.0) * (h - 1))
            r, g, b, _ = px[y, x]
            if lin:            # sRGB texture: convert to linear like a material colour
                return tuple(c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in (float(r), float(g), float(b)))
            return (float(r), float(g), float(b))
    else:
        f = lambda u, v, c=col: c
    _img_cache[mat.name] = f
    return f


def surface_colour(tri_info, verts, tris, face, loc):
    mat, uvs = tri_info[face]
    s = material_sampler(mat)
    if not uvs:
        return s(0, 0)
    a, b, c = (verts[i] for i in tris[face])
    # barycentric coordinates of loc on triangle abc
    v0, v1, v2 = b - a, c - a, loc - a
    d00, d01, d11, d20, d21 = v0.dot(v0), v0.dot(v1), v1.dot(v1), v2.dot(v0), v2.dot(v1)
    den = d00 * d11 - d01 * d01 or 1e-12
    wb = (d11 * d20 - d01 * d21) / den
    wc = (d00 * d21 - d01 * d20) / den
    wa = 1 - wb - wc
    u = wa * uvs[0][0] + wb * uvs[1][0] + wc * uvs[2][0]
    v = wa * uvs[0][1] + wb * uvs[1][1] + wc * uvs[2][1]
    return s(u, v)


# ------------------------------------------------------------------ voxels -> boxes
def cubify(verts, tris, tri_info, voxel=None, ncolors=8):
    lo = Vector((min(v.x for v in verts), min(v.y for v in verts), min(v.z for v in verts)))
    hi = Vector((max(v.x for v in verts), max(v.y for v in verts), max(v.z for v in verts)))
    size = hi - lo
    if not voxel:
        voxel = min(1.0, max(0.1, max(size) / 40))
    nx, ny, nz = (int(math.ceil(s / voxel)) + 2 for s in size)        # one empty cell of padding each side
    origin = lo - Vector((voxel, voxel, voxel)) * 0.5
    bvh = BVHTree.FromPolygons(verts, tris)
    idx = lambda x, y, z: (z * ny + y) * nx + x
    N = nx * ny * nz
    surf = bytearray(N)
    colour = {}
    reach = voxel * 0.87                                               # half the cell diagonal
    for z in range(nz):
        for y in range(ny):
            for x in range(nx):
                c = origin + Vector(((x + 0.5) * voxel, (y + 0.5) * voxel, (z + 0.5) * voxel))
                loc, nor, face, dist = bvh.find_nearest(c, reach)
                if loc is not None:
                    i = idx(x, y, z)
                    surf[i] = 1
                    colour[i] = surface_colour(tri_info, verts, tris, face, loc)
    # flood the outside; whatever it can't reach is the model (open meshes are fine if gaps < one voxel)
    outside = bytearray(N)
    q = deque()
    for z in (0, nz - 1):
        for y in range(ny):
            for x in range(nx):
                q.append((x, y, z))
    for y in (0, ny - 1):
        for z in range(nz):
            for x in range(nx):
                q.append((x, y, z))
    for x in (0, nx - 1):
        for z in range(nz):
            for y in range(ny):
                q.append((x, y, z))
    while q:
        x, y, z = q.popleft()
        i = idx(x, y, z)
        if outside[i] or surf[i]:
            continue
        outside[i] = 1
        for dx, dy, dz in ((1, 0, 0), (-1, 0, 0), (0, 1, 0), (0, -1, 0), (0, 0, 1), (0, 0, -1)):
            a, b, c = x + dx, y + dy, z + dz
            if 0 <= a < nx and 0 <= b < ny and 0 <= c < nz and not outside[idx(a, b, c)]:
                q.append((a, b, c))
    solid = bytearray(1 if not outside[i] else 0 for i in range(N))

    # colour palette: quantise surface colours to a few materials (k-means)
    cols = list(colour.values())
    palette = kmeans(cols, ncolors) if cols else [(0.6, 0.6, 0.6)]
    nearest = lambda c: min(range(len(palette)), key=lambda k: sum((c[j] - palette[k][j]) ** 2 for j in range(3)))
    vcol = {i: nearest(c) for i, c in colour.items()}

    # every solid voxel gets a colour: interior voxels take the colour of the nearest surface voxel
    q = deque(i for i in vcol)
    while q:
        i = q.popleft()
        z, r = divmod(i, nx * ny); y, x = divmod(r, nx)
        for dx, dy, dz in ((1, 0, 0), (-1, 0, 0), (0, 1, 0), (0, -1, 0), (0, 0, 1), (0, 0, -1)):
            a, b, c = x + dx, y + dy, z + dz
            if 0 <= a < nx and 0 <= b < ny and 0 <= c < nz:
                j = idx(a, b, c)
                if solid[j] and j not in vcol:
                    vcol[j] = vcol[i]
                    q.append(j)

    # Surface only: emit just the faces that touch empty space (faces between two solid voxels can never be
    # seen), merging same-coloured neighbours on each plane into big rectangles (greedy meshing).
    dims = (nx, ny, nz)
    def solid_at(c):
        x, y, z = c
        return 0 <= x < nx and 0 <= y < ny and 0 <= z < nz and solid[idx(x, y, z)]
    faces = []                       # (axis, sign, plane, u0, v0, u1, v1, colour) in voxel units
    for d in range(3):
        u, v = (d + 1) % 3, (d + 2) % 3
        nu, nv = dims[u], dims[v]
        for sgn in (1, -1):
            for k in range(dims[d]):
                mask = [-1] * (nu * nv)
                for b_ in range(nv):
                    for a_ in range(nu):
                        c = [0, 0, 0]; c[d] = k; c[u] = a_; c[v] = b_
                        if not solid_at(c):
                            continue
                        c2 = list(c); c2[d] += sgn
                        if solid_at(c2):
                            continue
                        mask[b_ * nu + a_] = vcol.get(idx(*c), 0)
                for b_ in range(nv):
                    a_ = 0
                    while a_ < nu:
                        col = mask[b_ * nu + a_]
                        if col < 0:
                            a_ += 1
                            continue
                        w = 1
                        while a_ + w < nu and mask[b_ * nu + a_ + w] == col:
                            w += 1
                        h = 1
                        while b_ + h < nv and all(mask[(b_ + h) * nu + a_ + t] == col for t in range(w)):
                            h += 1
                        for hh in range(h):
                            for t in range(w):
                                mask[(b_ + hh) * nu + a_ + t] = -1
                        faces.append((d, sgn, k + 1 if sgn > 0 else k, a_, b_, a_ + w, b_ + h, col))
                        a_ += w
    return faces, palette, origin, voxel, (nx, ny, nz), sum(solid)


def kmeans(cols, k, iters=12):
    pts = list(cols)
    if len(pts) <= k:
        return [tuple(p) for p in set(map(tuple, pts))]
    # start from colours spread across the brightness range
    pts_sorted = sorted(pts, key=sum)
    cent = [pts_sorted[int(i * (len(pts) - 1) / (k - 1))] for i in range(k)]
    for _ in range(iters):
        groups = [[] for _ in cent]
        for p in pts:
            j = min(range(len(cent)), key=lambda m: (p[0] - cent[m][0]) ** 2 + (p[1] - cent[m][1]) ** 2 + (p[2] - cent[m][2]) ** 2)
            groups[j].append(p)
        cent = [tuple(sum(c[d] for c in g) / len(g) for d in range(3)) if g else cent[m] for m, g in enumerate(groups)]
    return cent


def build_object(name, faces, palette, origin, voxel):
    """One mesh, one material; colours are stored per face corner (exported to glTF as vertex colours)."""
    me = bpy.data.meshes.new(name)
    verts, polys, cols = [], [], []
    for d, sgn, plane, u0, v0, u1, v1, col in faces:
        u, v = (d + 1) % 3, (d + 2) % 3
        quad = []
        for a_, b_ in ((u0, v0), (u1, v0), (u1, v1), (u0, v1)):
            c = [0.0, 0.0, 0.0]; c[d] = plane; c[u] = a_; c[v] = b_
            quad.append(len(verts))
            verts.append((origin.x + c[0] * voxel, origin.y + c[1] * voxel, origin.z + c[2] * voxel))
        polys.append(quad if sgn > 0 else quad[::-1])
        cols.append(palette[col])
    me.from_pydata(verts, [], polys)
    attr = me.color_attributes.new('Col', 'FLOAT_COLOR', 'CORNER')
    for poly, c in zip(me.polygons, cols):
        for li in poly.loop_indices:
            attr.data[li].color = (c[0], c[1], c[2], 1.0)
    me.color_attributes.active_color = attr
    me.update()
    m = bpy.data.materials.new(name + '_mat')
    m.use_nodes = True
    nt = m.node_tree
    bsdf = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
    ca = nt.nodes.new('ShaderNodeVertexColor'); ca.layer_name = 'Col'
    nt.links.new(ca.outputs['Color'], bsdf.inputs['Base Color'])
    bsdf.inputs['Roughness'].default_value = 0.6
    m.use_backface_culling = True          # closed shape: single-sided in the exported file
    me.materials.append(m)
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    return ob


# ------------------------------------------------------------------ batch over files / folders
def clear_scene():
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete()
    for coll in (bpy.data.meshes, bpy.data.materials, bpy.data.images, bpy.data.armatures):
        for x in list(coll):
            if x.users == 0:
                coll.remove(x)
    _img_cache.clear()


def import_glbs(paths):
    before = set(bpy.data.objects)
    for p in paths:
        bpy.ops.import_scene.gltf(filepath=p)
    return [o for o in bpy.data.objects if o not in before]


def jobs_for(path):
    """(output file, [input files]) pairs for a folder or a single .glb."""
    if os.path.isfile(path):
        return [(re.sub(r'\.glb$', '', path, flags=re.I) + ' - cubes.glb', [path])]
    out = []
    for root, dirs, files in os.walk(path):
        glbs = sorted(f for f in files if f.lower().endswith('.glb') and 'cubes' not in f and 'painted' not in f)
        painted = sorted(f for f in files if f.lower().endswith('painted.glb'))
        if painted:       # coloured references (tools/painted_glb.py): one cube model per painted file
            for f in painted:
                out.append((os.path.join(root, f.replace('painted.glb', 'cubes.glb')), [os.path.join(root, f)]))
            continue
        if not glbs:
            continue
        body = [f for f in glbs if f.endswith(' - body.glb')]
        if body:          # body + moving parts make one building
            name = body[0][:-len(' - body.glb')]
            out.append((os.path.join(root, name + ' - cubes.glb'), [os.path.join(root, f) for f in glbs]))
        else:             # separate pieces (model / bottom / middle / top)
            for f in glbs:
                out.append((os.path.join(root, f[:-4] + ' - cubes.glb'), [os.path.join(root, f)]))
    return out


_manifests = {}
def manifest_voxel(out):
    """Voxel size set for this model's folder in Custom/manifest.json ("voxel"), if any."""
    d = os.path.dirname(os.path.abspath(out))
    probe = d
    while True:
        m = os.path.join(probe, 'manifest.json')
        if os.path.exists(m):
            if m not in _manifests:
                import json
                _manifests[m] = json.load(open(m, encoding='utf-8'))
            rel = os.path.relpath(d, probe).replace(os.sep, '/')
            return _manifests[m].get(rel, {}).get('voxel')
        up = os.path.dirname(probe)
        if up == probe:
            return None
        probe = up


def run_batch(args):
    voxel = float(args[args.index('--voxel') + 1]) if '--voxel' in args else None
    ncol = int(args[args.index('--colors') + 1]) if '--colors' in args else 8
    force = '--force' in args
    paths = [a for i, a in enumerate(args) if not a.startswith('--') and (i == 0 or args[i - 1] not in ('--voxel', '--colors'))]
    for p in paths:
        for out, ins in jobs_for(p):
            if os.path.exists(out) and not force:
                print('skip (exists):', out)
                continue
            clear_scene()
            objs = import_glbs(ins)
            verts, tris, info = gather(objs)
            if not tris:
                print('no geometry:', ins)
                continue
            faces, pal, origin, v, dims, nsolid = cubify(verts, tris, info, voxel or manifest_voxel(out), ncol)
            name = os.path.basename(out)[:-4]
            for o in objs:
                o.select_set(False)
            ob = build_object(name, faces, pal, origin, v)
            bpy.ops.object.select_all(action='DESELECT')
            ob.select_set(True)
            bpy.context.view_layer.objects.active = ob
            bpy.ops.export_scene.gltf(filepath=out, export_format='GLB', use_selection=True)
            print(f'{name}: {len(faces)} faces ({len(faces) * 2} triangles) from {nsolid} voxels of {v:.2f} m ({dims[0]}x{dims[1]}x{dims[2]} grid), {len(pal)} colours, 1 material -> {out}')


def run_selected():
    sel = [o for o in bpy.context.selected_objects if o.type == 'MESH']
    if not sel:
        print('Select one or more mesh objects first.')
        return
    verts, tris, info = gather(sel)
    faces, pal, origin, v, dims, nsolid = cubify(verts, tris, info)
    ob = build_object(sel[0].name + '_cubes', faces, pal, origin, v)
    print(f'{ob.name}: {len(faces)} faces ({v:.2f} m voxels)')


if __name__ == '__main__':
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    if argv:
        run_batch(argv)
    else:
        run_selected()
