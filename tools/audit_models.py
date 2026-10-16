"""Audit converted buildings for missing mesh parts.

For each building in convert_models.MAP, compares the mesh(es) in use against the game's clearance
height/footprint (web/data.js) and lists every other mesh in the building's folder (including the
_pruned_* folder next to the export) with its bounding box, so separately-stored parts stand out.

Usage: python tools/audit_models.py ["<export>/…/Buildable/Factory"]
"""
import glob
import io
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
ARGS = sys.argv[1:]
sys.argv = sys.argv[:1] + ARGS[:1]
import convert_models as cm  # noqa: E402
from gltf import read_glb  # noqa: E402
from uemodel import read_uemodel  # noqa: E402

src = open(os.path.join(HERE, '..', 'web', 'data.js'), encoding='utf-8').read()
D = json.loads(src[src.index('{'):src.rstrip().rstrip(';').rindex('}') + 1])

exports = os.path.normpath(cm.SRC).split(os.sep)
exports_root = os.sep.join(exports[:exports.index('Exports') + 1])
rel_factory = os.path.relpath(cm.SRC, exports_root)
pruned = sorted(glob.glob(os.path.join(os.path.dirname(exports_root), '_pruned_*')))
search_roots = [cm.SRC] + [os.path.join(p, rel_factory) for p in pruned]


def bbox_m(path):
    """UE-space bbox in metres + triangle count for a .uemodel or .glb."""
    if path.endswith('.uemodel'):
        lod = read_uemodel(path)['lods'][0]
        p = lod['pos'] / 100.0
    else:
        lod = read_glb(path)['lods'][0]
        A = np.array(cm.GLTF_TO_UE['axes'], float)
        p = (lod['pos'] @ A.T) * cm.GLTF_TO_UE['scale'] / 100.0
    secs = [s for s in lod['materials'] if cm.section_kind(s['name']) is not None]
    return p.min(0), p.max(0), sum(s['faces'] for s in secs)


def all_meshes(folder):
    found = {}
    for root in search_roots:
        for f in glob.glob(os.path.join(root, folder, '**', '*.*'), recursive=True):
            if f.endswith(('.uemodel', '.glb')):
                stem = os.path.splitext(os.path.basename(f))[0]
                if stem not in found or f.endswith('.uemodel'):
                    found[stem] = f
    return found


def overlap(a0, a1, b0, b1):
    inter = np.prod(np.clip(np.minimum(a1, b1) - np.maximum(a0, b0), 0, None))
    vol = np.prod(np.maximum(b1 - b0, 1e-3))
    return inter / vol


for key, rel in cm.MAP.items():
    if not key.startswith('Build_'):
        continue
    parts = rel if isinstance(rel, list) else [rel]
    b = D['buildings'].get(key, {})
    folder = parts[0].split('/')[0]
    used = {os.path.basename(p) for p in parts}
    lo, hi = np.full(3, np.inf), np.full(3, -np.inf)
    for part in parts:
        base = os.path.join(cm.SRC, part.replace('/', os.sep))
        f = base + '.uemodel' if os.path.exists(base + '.uemodel') else base + '.glb'
        l0, l1, _ = bbox_m(f)
        lo, hi = np.minimum(lo, l0), np.maximum(hi, l1)
    print(f'\n{key}  game: {b.get("w")}x{b.get("h")} m, {b.get("z")} m tall | in use: '
          f'{np.round(hi - lo, 1).tolist()} (UE X,Y,Z m), top {hi[2]:.1f} m')
    for stem, f in sorted(all_meshes(folder).items()):
        if stem in used:
            continue
        try:
            m0, m1, tris = bbox_m(f)
        except Exception as e:  # noqa: BLE001
            print(f'    {stem:40s} unreadable: {e}')
            continue
        ov = overlap(lo, hi, m0, m1)
        tag = 'pruned' if '_pruned_' in f else 'kept'
        print(f'    {stem:40s} {tris:6d} tris  size {np.round(m1 - m0, 1).tolist()}  '
              f'z {m0[2]:.1f}..{m1[2]:.1f}  inside-main {ov:4.0%}  [{tag}]')
