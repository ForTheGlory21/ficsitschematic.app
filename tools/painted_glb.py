"""Write coloured reference GLBs for the Custom/ folder from the planner's converted models (web/models/*.js).

The FModel .glb exports have no textures (FModel keeps them as separate files), so they look grey. The planner's
converted models carry the painted FICSIT colours, so this turns each one back into a .glb, in the same axes as the
original export, so it lines up with the originals and with any replacement modelled from them.

    python tools/painted_glb.py            -> "<Name> - painted.glb" in every Custom/ model folder
"""
import base64, json, os, re, struct
import numpy as np

ROOT = os.path.join(os.path.dirname(__file__), '..')
MODELS = os.path.join(ROOT, '_game_models')        # converted game meshes (kept out of the website)
CUSTOM = os.path.join(ROOT, 'Custom')


def load_model(key):
    src = open(os.path.join(MODELS, key + '.js'), encoding='utf-8').read()
    m = re.search(r'SF\.modelData\("[^"]+",(\{.*?\}),"([^"]+)"\)', src, re.S)
    meta, raw = json.loads(m.group(1)), base64.b64decode(m.group(2))
    nv, ni = meta['v'], meta['i']
    pad = lambda o: o + (-o) % 4
    off = 0
    q = np.frombuffer(raw, '<i2', nv * 3, off).reshape(-1, 3).astype(np.float64); off = pad(off + nv * 6)
    nq = np.frombuffer(raw, 'i1', nv * 3, off).reshape(-1, 3).astype(np.float64); off = pad(off + nv * 3)
    uv = None
    if meta.get('uv'):
        uv = np.frombuffer(raw, '<i2', nv * 2, off).reshape(-1, 2).astype(np.float64) / meta['uv']; off = pad(off + nv * 4)
    idx = np.frombuffer(raw, '<u4' if meta['i32'] else '<u2', ni, off).astype(np.uint32)
    lo, hi = np.array(meta['b'][:3]), np.array(meta['b'][3:])
    pos = lo + (q + 32768) / 65535 * (hi - lo)
    nrm = nq / 127.0
    # planner 3D frame (x = UE Y, y = UE Z, z = -UE X) -> FModel glTF frame (UE X, UE Z, UE Y)
    to_gltf = lambda v: np.stack([-v[:, 2], v[:, 1], v[:, 0]], 1)
    pos, nrm = to_gltf(pos), to_gltf(nrm)
    nrm /= np.maximum(np.linalg.norm(nrm, axis=1, keepdims=True), 1e-9)
    images = [base64.b64decode(u.split(',', 1)[1]) for u in meta.get('t', [])]
    return pos.astype(np.float32), nrm.astype(np.float32), None if uv is None else uv.astype(np.float32), idx, meta['g'], images


def write_glb(path, pos, nrm, uv, idx, groups, images):
    bin_ = bytearray()
    views, accessors = [], []
    def add_view(data, target=None):
        while len(bin_) % 4: bin_.append(0)
        views.append({'buffer': 0, 'byteOffset': len(bin_), 'byteLength': len(data), **({'target': target} if target else {})})
        bin_.extend(data)
        return len(views) - 1
    def add_acc(arr, comp, typ, target, minmax=False):
        v = add_view(arr.tobytes(), target)
        a = {'bufferView': v, 'componentType': comp, 'count': int(arr.shape[0]), 'type': typ}
        if minmax: a['min'] = arr.min(0).tolist(); a['max'] = arr.max(0).tolist()
        accessors.append(a)
        return len(accessors) - 1
    attrs = {'POSITION': add_acc(pos, 5126, 'VEC3', 34962, True), 'NORMAL': add_acc(nrm, 5126, 'VEC3', 34962)}
    if uv is not None: attrs['TEXCOORD_0'] = add_acc(uv, 5126, 'VEC2', 34962)
    imgs = [{'bufferView': add_view(b), 'mimeType': 'image/jpeg'} for b in images]
    # materials: slate body, glass, light, then one per painted texture (same as the planner's 3D view)
    mats = [
        {'name': 'body', 'pbrMetallicRoughness': {'baseColorFactor': [0.16, 0.18, 0.23, 1], 'metallicFactor': 0.2, 'roughnessFactor': 0.6}},
        {'name': 'glass', 'pbrMetallicRoughness': {'baseColorFactor': [0.6, 0.8, 1.0, 0.35], 'metallicFactor': 0.1, 'roughnessFactor': 0.1}, 'alphaMode': 'BLEND'},
        {'name': 'light', 'pbrMetallicRoughness': {'baseColorFactor': [1.0, 0.75, 0.3, 1]}, 'emissiveFactor': [1.0, 0.6, 0.2]},
    ] + [{'name': f'painted{i}', 'pbrMetallicRoughness': {'baseColorTexture': {'index': i}, 'metallicFactor': 0.15, 'roughnessFactor': 0.55}}
         for i in range(len(images))]
    slot = {'main': 0, 'glass': 1, 'light': 2}
    prims = []
    for start, count, kind, tex in groups:
        ia = add_acc(np.ascontiguousarray(idx[start:start + count]).astype(np.uint32), 5125, 'SCALAR', 34963)
        prims.append({'attributes': attrs, 'indices': ia, 'material': 3 + tex if kind == 'main' and tex >= 0 else slot.get(kind, 0)})
    gltf = {'asset': {'version': '2.0', 'generator': 'satisfactory planner painted_glb.py'}, 'scene': 0,
            'scenes': [{'nodes': [0]}], 'nodes': [{'mesh': 0, 'name': os.path.basename(path)[:-4]}],
            'meshes': [{'primitives': prims}], 'materials': mats, 'accessors': accessors, 'bufferViews': views,
            'buffers': [{'byteLength': len(bin_)}]}
    if images:
        gltf['images'] = imgs
        gltf['samplers'] = [{'wrapS': 10497, 'wrapT': 10497}]
        gltf['textures'] = [{'source': i, 'sampler': 0} for i in range(len(images))]
    js = json.dumps(gltf, separators=(',', ':')).encode()
    js += b' ' * ((-len(js)) % 4)
    while len(bin_) % 4: bin_.append(0)
    with open(path, 'wb') as f:
        f.write(struct.pack('<III', 0x46546C67, 2, 12 + 8 + len(js) + 8 + len(bin_)))
        f.write(struct.pack('<II', len(js), 0x4E4F534A)); f.write(js)
        f.write(struct.pack('<II', len(bin_), 0x004E4942)); f.write(bin_)


def main():
    man = json.load(open(os.path.join(CUSTOM, 'manifest.json'), encoding='utf-8'))
    n = 0
    for folder, m in man.items():
        name = folder.split('/')[-1]
        d = os.path.join(CUSTOM, *folder.split('/'))
        pieces = {'Conveyor Lift': [('lift_bottom', 'bottom'), ('lift1', 'middle'), ('lift_top', 'top')]}.get(name)
        jobs = [(k, f'{name} - {label} painted.glb') for k, label in pieces] if pieces else [(m['used_for'][0] if name not in ('Miner',) else 'Build_MinerMk2_C', f'{name} - painted.glb')]
        if name == 'Storage Container': jobs = [('Build_StorageContainerMk1_C', f'{name} - painted.glb')]
        if name == 'Fluid Buffer': jobs = [('Build_PipeStorageTank_C', f'{name} - painted.glb')]
        for key, fn in jobs:
            if not os.path.exists(os.path.join(MODELS, key + '.js')):
                print('no converted model for', key); continue
            write_glb(os.path.join(d, fn), *load_model(key)); n += 1
    print(n, 'painted reference models written')


if __name__ == '__main__':
    main()
