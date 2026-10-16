"""Prune an FModel export down to what tools/convert_models.py needs.

Usage:
  python tools/prune_export.py "<…>/Exports/FactoryGame/Content/FactoryGame/Buildable/Factory"           # dry run
  python tools/prune_export.py "<…>/Exports/FactoryGame/Content/FactoryGame/Buildable/Factory" --apply   # do it

Keeps: every mesh listed in convert_models.MAP, the material JSONs their sections use, and the
base-colour / paint-mask PNGs those materials (or the building's own texture folder) provide.
Everything else under the export's `Exports` folder is MOVED (not deleted) into a sibling
`_pruned_<timestamp>` folder, so nothing is lost until you delete that folder yourself.
"""
import os
import shutil
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
APPLY = '--apply' in sys.argv[1:]          # read before argv is rewritten for convert_models
src = next((a for a in sys.argv[1:] if not a.startswith('--')), None)
if src:
    sys.argv = [sys.argv[0], src]          # convert_models reads its source path from argv
import convert_models as cm               # noqa: E402
from uemodel import read_uemodel          # noqa: E402



def scope_root():
    p = os.path.normpath(cm.SRC).split(os.sep)
    if 'Exports' in p:
        return os.sep.join(p[:p.index('Exports') + 1])
    return cm._content_root()


def needed_files():
    keep, missing = set(), []
    mats, pngs = cm._indexes()
    for key, rel in cm.MAP.items():
        for part in (rel if isinstance(rel, list) else [rel]):
            base = os.path.join(cm.SRC, part.replace('/', os.sep))
            found = [base + ext for ext in ('.uemodel', '.glb') if os.path.exists(base + ext)]
            if not found:
                missing.append(base + '.uemodel/.glb')
                continue
            for f in found:
                keep.add(os.path.normcase(os.path.abspath(f)))
            try:
                lod = cm.load_mesh(part)['lods'][0]
            except ValueError:
                lod = read_uemodel(found[0])['lods'][0] if found[0].endswith('.uemodel') else {'materials': []}
            for sec in lod['materials']:
                if cm.section_kind(sec['name']) is None:
                    continue
                mj = cm._from_game_path(sec.get('path'), '.json') or mats.get(sec['name'])
                if mj:
                    keep.add(os.path.normcase(os.path.abspath(mj)))
                bc, mk = cm.textures_for(sec['name'], part, sec.get('path'))
                for f in (bc, mk):
                    if f:
                        keep.add(os.path.normcase(os.path.abspath(f)))
    return keep, missing


def plan(root, keep):
    """Return the top-most paths to move: whole folders with nothing kept inside, and loose files."""
    keep_dirs = set()
    for f in keep:
        d = os.path.dirname(f)
        while len(d) >= len(root):
            keep_dirs.add(d)
            nd = os.path.dirname(d)
            if nd == d:
                break
            d = nd
    moves = []
    for dirpath, dirnames, filenames in os.walk(root):
        dn = os.path.normcase(os.path.abspath(dirpath))
        for d in list(dirnames):
            full = os.path.normcase(os.path.abspath(os.path.join(dirpath, d)))
            if full not in keep_dirs:
                moves.append(os.path.join(dirpath, d))
                dirnames.remove(d)
        for f in filenames:
            full = os.path.normcase(os.path.abspath(os.path.join(dirpath, f)))
            if full not in keep:
                moves.append(os.path.join(dirpath, f))
        if dn not in keep_dirs and dn != os.path.normcase(os.path.abspath(root)):
            pass
    return moves


def size_of(p):
    if os.path.isfile(p):
        return 1, os.path.getsize(p)
    n = b = 0
    for dp, _, fs in os.walk(p):
        for f in fs:
            n += 1
            try:
                b += os.path.getsize(os.path.join(dp, f))
            except OSError:
                pass
    return n, b


def main():
    if not src:
        print(__doc__)
        return
    root = os.path.abspath(scope_root())
    keep, missing = needed_files()
    moves = plan(root, keep)
    files = sum(size_of(p)[0] for p in moves)
    bytes_ = sum(size_of(p)[1] for p in moves)
    kept_bytes = sum(os.path.getsize(f) for f in keep if os.path.exists(f))
    print(f'scope : {root}')
    print(f'keep  : {len(keep)} files, {kept_bytes / 1024 / 1024:.1f} MB')
    print(f'move  : {len(moves)} entries ({files} files, {bytes_ / 1024 / 1024:.1f} MB)')
    for m in missing:
        print('  ! missing mesh:', m)
    if not APPLY:
        print('DRY RUN — re-run with --apply to move them. Kept files:')
        for f in sorted(keep):
            print('   ', f[len(root) + 1:] if f.startswith(os.path.normcase(root)) else f)
        return
    dest = os.path.join(os.path.dirname(root), '_pruned_' + time.strftime('%Y%m%d_%H%M%S'))
    for p in moves:
        rel = os.path.relpath(p, root)
        target = os.path.join(dest, rel)
        os.makedirs(os.path.dirname(target), exist_ok=True)
        shutil.move(p, target)
    print(f'moved to {dest}  (delete that folder once you are happy)')


if __name__ == '__main__':
    main()
