"""Minimal reader for UEFormat .uemodel files (as exported by FModel), static meshes only."""
import struct
from compression import zstd

import numpy as np


def _fstr(b, q):
    n = struct.unpack_from('<i', b, q)[0]
    return b[q + 4:q + 4 + n].decode('utf-8', 'replace'), q + 4 + n


def read_uemodel(path):
    d = open(path, 'rb').read()
    if d[:8] != b'UEFORMAT':
        raise ValueError('not a UEFormat file')
    p = 8
    ident, p = _fstr(d, p)
    version = d[p]; p += 1
    name, p = _fstr(d, p)
    if version >= 10:
        _objpath, p = _fstr(d, p)
    compressed = d[p]; p += 1
    if compressed:
        ctype, p = _fstr(d, p)
        usz, csz = struct.unpack_from('<ii', d, p); p += 8
        if ctype != 'ZSTD':
            raise ValueError('unsupported compression ' + ctype)
        raw = zstd.decompress(d[p:p + csz])
    else:
        raw = d[p:]
    out = {'name': name, 'version': version, 'lods': []}
    q = 0
    ntop = struct.unpack_from('<i', raw, q)[0]; q += 4
    for _ in range(ntop):
        cname, q = _fstr(raw, q)
        bsz = struct.unpack_from('<i', raw, q)[0]; q += 4
        end = q + bsz
        if cname == 'LODS':
            r = q
            nl = struct.unpack_from('<i', raw, r)[0]; r += 4
            for _ in range(nl):
                lname, r = _fstr(raw, r)
                ns = struct.unpack_from('<i', raw, r)[0]; r += 4
                lod = {'name': lname}
                for _ in range(ns):
                    hn, r = _fstr(raw, r)
                    b = struct.unpack_from('<i', raw, r)[0]; r += 4
                    s, e = r, r + b
                    cnt = struct.unpack_from('<i', raw, s)[0]
                    body = raw[s + 4:e]
                    if hn == 'VERTICES':
                        lod['pos'] = np.frombuffer(body, '<f4', cnt * 3).reshape(-1, 3)
                    elif hn == 'NORMALS':
                        lod['nrm'] = np.frombuffer(body, '<f4', cnt * 4).reshape(-1, 4)[:, 1:4]
                    elif hn == 'INDICES':
                        lod['idx'] = np.frombuffer(body, '<i4', cnt)
                    elif hn == 'VERTEXCOLORS':
                        t = 0
                        cols = []
                        for _ in range(cnt):
                            cn, t2 = _fstr(body, t)
                            c = struct.unpack_from('<i', body, t2)[0]
                            cols.append((cn, np.frombuffer(body[t2 + 4:t2 + 4 + c * 4], np.uint8).reshape(-1, 4)))
                            t = t2 + 4 + c * 4
                        lod['colors'] = cols
                    elif hn == 'TEXCOORDS':
                        t = 0
                        uvs = []
                        for _ in range(cnt):
                            un, t2 = _fstr(body, t)
                            c = struct.unpack_from('<i', body, t2)[0]
                            uvs.append(np.frombuffer(body[t2 + 4:t2 + 4 + c * 8], '<f4').reshape(-1, 2))
                            t = t2 + 4 + c * 8
                        lod['uvs'] = uvs
                    elif hn == 'MATERIALS':
                        t = 0
                        mats = []
                        for _ in range(cnt):
                            mn, t = _fstr(body, t)
                            mp, t = _fstr(body, t)
                            first, nfaces = struct.unpack_from('<ii', body, t); t += 8
                            mats.append({'name': mn, 'path': mp, 'first': first, 'faces': nfaces})
                        lod['materials'] = mats
                    r = e
                out['lods'].append(lod)
        q = end
    return out
