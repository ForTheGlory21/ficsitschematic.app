"""Minimal binary glTF 2.0 (.glb) reader returning the same structure as uemodel.read_uemodel.

Only what the converter needs: positions, normals, UV0, indices and per-primitive material
sections. Node transforms are applied so multi-node exports come out in one model space.
Coordinates are returned exactly as stored in the glTF; convert_models maps them to its
internal (UE) convention via GLTF_TO_UE.
"""
import json
import struct

import numpy as np

_CTYPE = {5120: np.int8, 5121: np.uint8, 5122: np.int16, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}
_NCOMP = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}


def _read_glb(path):
    d = open(path, 'rb').read()
    magic, version, length = struct.unpack_from('<III', d, 0)
    if magic != 0x46546C67:
        raise ValueError('not a GLB file')
    off, js, binc = 12, None, b''
    while off < length:
        clen, ctype = struct.unpack_from('<II', d, off)
        chunk = d[off + 8:off + 8 + clen]
        if ctype == 0x4E4F534A:
            js = json.loads(chunk.decode('utf-8'))
        elif ctype == 0x004E4942:
            binc = chunk
        off += 8 + clen
    return js, binc


def _accessor(js, binc, i):
    a = js['accessors'][i]
    ctype = _CTYPE[a['componentType']]
    n = _NCOMP[a['type']]
    count = a['count']
    if 'bufferView' not in a:
        return np.zeros((count, n) if n > 1 else count, ctype)
    bv = js['bufferViews'][a['bufferView']]
    start = bv.get('byteOffset', 0) + a.get('byteOffset', 0)
    itemsize = np.dtype(ctype).itemsize * n
    stride = bv.get('byteStride', itemsize)
    if stride == itemsize:
        arr = np.frombuffer(binc, ctype, count * n, start).reshape(count, n) if n > 1 else \
            np.frombuffer(binc, ctype, count, start)
    else:
        raw = np.frombuffer(binc, np.uint8, stride * (count - 1) + itemsize, start)
        rows = np.lib.stride_tricks.as_strided(raw, (count, itemsize), (stride, 1))
        arr = rows.copy().view(ctype).reshape(count, n) if n > 1 else rows.copy().view(ctype).reshape(count)
    if a.get('normalized') and ctype is not np.float32:
        info = np.iinfo(ctype)
        arr = np.maximum(arr.astype(np.float32) / info.max, -1.0)
    return np.asarray(arr)


def _node_matrix(node):
    if 'matrix' in node:
        return np.array(node['matrix'], np.float64).reshape(4, 4).T
    t = np.array(node.get('translation', [0, 0, 0]), np.float64)
    q = np.array(node.get('rotation', [0, 0, 0, 1]), np.float64)
    s = np.array(node.get('scale', [1, 1, 1]), np.float64)
    x, y, z, w = q
    R = np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                  [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                  [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])
    M = np.eye(4)
    M[:3, :3] = R * s
    M[:3, 3] = t
    return M


def read_glb(path):
    js, binc = _read_glb(path)
    mats = js.get('materials', [])
    pos_l, nrm_l, uv_l, idx_l, sections = [], [], [], [], []
    base = 0
    tri_base = 0

    def visit(ni, parent):
        nonlocal base, tri_base
        node = js['nodes'][ni]
        M = parent @ _node_matrix(node)
        if 'mesh' in node:
            nm = np.linalg.inv(M[:3, :3]).T
            for prim in js['meshes'][node['mesh']]['primitives']:
                if prim.get('mode', 4) != 4:
                    continue
                at = prim['attributes']
                p = _accessor(js, binc, at['POSITION']).astype(np.float64)
                p = p @ M[:3, :3].T + M[:3, 3]
                n = _accessor(js, binc, at['NORMAL']).astype(np.float64) if 'NORMAL' in at else np.zeros_like(p)
                n = n @ nm.T
                uv = _accessor(js, binc, at['TEXCOORD_0']).astype(np.float64) if 'TEXCOORD_0' in at \
                    else np.zeros((len(p), 2))
                idx = _accessor(js, binc, prim['indices']).astype(np.int64) if 'indices' in prim \
                    else np.arange(len(p))
                mi = prim.get('material')
                name = mats[mi].get('name', f'mat{mi}') if mi is not None and mi < len(mats) else 'default'
                faces = len(idx) // 3
                sections.append({'name': name, 'path': name, 'first': tri_base * 3, 'faces': faces,
                                 'gltf_material': mats[mi] if mi is not None and mi < len(mats) else {}})
                pos_l.append(p); nrm_l.append(n); uv_l.append(uv); idx_l.append(idx + base)
                base += len(p)
                tri_base += faces
        for c in node.get('children', []):
            visit(c, M)

    scene = js.get('scenes', [{}])[js.get('scene', 0)] if js.get('scenes') else {'nodes': list(range(len(js.get('nodes', []))))}
    for ni in scene.get('nodes', []):
        visit(ni, np.eye(4))
    if not pos_l:
        raise ValueError('no triangle meshes in ' + path)
    lod = {
        'pos': np.concatenate(pos_l), 'nrm': np.concatenate(nrm_l),
        'idx': np.concatenate(idx_l), 'uvs': [np.concatenate(uv_l)], 'materials': sections,
        'images': js.get('images', []), 'textures': js.get('textures', []),
    }
    return {'name': path, 'version': 'gltf', 'lods': [lod], 'gltf': js}
