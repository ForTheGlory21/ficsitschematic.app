"""Add the structures (foundations, walls, ramps, barriers, railings...) to the Custom/ folder, like the buildings:
one folder per distinct shape under "8 Structures", with an entry in Custom/manifest.json (which planner models it is used for, its
size and the voxel size cubify.py uses). Then run tools/painted_glb.py and cubify.py as usual.

    python tools/structures_to_custom.py
"""
import json, os, shutil, sys

sys.argv = sys.argv[:1]                       # convert_models reads its own arguments at import
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import convert_models as cm                   # noqa: E402

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
CUSTOM = os.path.join(ROOT, 'Custom')
VOXEL = 0.25                                  # one grid for every structure: 8 m = 32 boxes, a wall 2 boxes thick

FAMILY = [  # key prefix -> (sub folder, readable name)
    ('S_FoundConcrete_', 'Foundations', 'Concrete Foundation {n} m'), ('S_FoundFicsit_', 'Foundations', 'FICSIT Foundation {n} m'),
    ('S_FoundGrip_', 'Foundations', 'Metal Foundation {n} m'), ('S_HalfConcrete_', 'Foundations', 'Concrete Half Foundation {n} m'),
    ('S_HalfFicsit_', 'Foundations', 'FICSIT Half Foundation {n} m'), ('S_HalfGrip_', 'Foundations', 'Metal Half Foundation {n} m'),
    ('S_RampConcrete_', 'Ramps', 'Concrete Ramp {n} m'), ('S_RampFicsit_', 'Ramps', 'FICSIT Ramp {n} m'), ('S_RampGrip_', 'Ramps', 'Metal Ramp {n} m'),
    ('S_RampInvConcrete_', 'Ramps', 'Concrete Inverted Ramp {n} m'), ('S_RampInvFicsit_', 'Ramps', 'FICSIT Inverted Ramp {n} m'),
    ('S_RampInvGrip_', 'Ramps', 'Metal Inverted Ramp {n} m'),
    ('S_StairConcrete_', 'Ramps', 'Concrete Stairs {n} m'), ('S_StairFicsit_', 'Ramps', 'FICSIT Stairs {n} m'), ('S_StairGrip_', 'Ramps', 'Metal Stairs {n} m'),
]
NAMES = {
    'S_FrameFloor': ('Foundations', 'Frame Floor'), 'S_FrameFound': ('Foundations', 'Frame Foundation'), 'S_GlassFound': ('Foundations', 'Glass Foundation'),
    'S_WallConcrete_4': ('Walls', 'Concrete Wall 4 m'), 'S_WallConcrete_1': ('Walls', 'Concrete Wall 1 m'),
    'S_WallConcrete_Hole1': ('Walls', 'Concrete Conveyor Wall x1'), 'S_WallConcrete_Hole2': ('Walls', 'Concrete Conveyor Wall x2'),
    'S_WallConcrete_Hole3': ('Walls', 'Concrete Conveyor Wall x3'), 'S_WallConcrete_Window': ('Walls', 'Concrete Frame Window'),
    'S_WallConcrete_Gate': ('Walls', 'Concrete Gate Wall'), 'S_WallOrange_4': ('Walls', 'FICSIT Wall 4 m'), 'S_WallOrange_1': ('Walls', 'FICSIT Wall 1 m'),
    'S_WallOrange_Window': ('Walls', 'FICSIT Frame Window'), 'S_WallSteel_1': ('Walls', 'Steel Wall 1 m'),
    'S_WallSteel_Hole1': ('Walls', 'Steel Conveyor Wall x1'), 'S_WallSteel_Hole2': ('Walls', 'Steel Conveyor Wall x2'),
    'S_WallSteel_Hole3': ('Walls', 'Steel Conveyor Wall x3'), 'S_WallSteel_Gate': ('Walls', 'Steel Gate Wall'),
    'S_Window_05': ('Windows', 'Angled Frame Window'), 'S_Window_06': ('Windows', 'Honeycomb Frame Window'), 'S_Window_07': ('Windows', 'Triple Frame Window'),
    'S_WindowThin_01': ('Windows', 'Full Frame Window'), 'S_WindowThin_02': ('Windows', 'Hex Frame Window'),
    'S_BarrierLow': ('Barriers and Railings', 'Low Barrier'), 'S_BarrierTall': ('Barriers and Railings', 'High Barrier'),
    'S_Railing': ('Barriers and Railings', 'Industrial Railing'), 'S_ModernRailing': ('Barriers and Railings', 'Modern Railing'),
    'S_TarpFence': ('Barriers and Railings', 'Tarp Construction Fence'),
}


def name_of(key):
    for pre, sub, fmt in FAMILY:
        if key.startswith(pre):
            return sub, fmt.format(n=key[len(pre):])
    return NAMES[key]


def main():
    man_path = os.path.join(CUSTOM, 'manifest.json')
    man = json.load(open(man_path, encoding='utf-8'))
    man = {k: v for k, v in man.items() if not k.startswith('8 Structures/')}
    defs = {}
    import re
    data = open(os.path.join(ROOT, 'web', 'data.js'), encoding='utf-8').read()
    for s in json.loads(re.search(r'window\.SF_DATA = (\{.*\});', data, re.S).group(1))['structures']:
        defs[s['id']] = s
    by_key = {}
    for sid, (key, tint) in cm.STRUCT_USE.items():
        by_key.setdefault(key, []).append(sid)
    for key, st in cm.STRUCT.items():
        sub, name = name_of(key)
        folder = f'8 Structures/{sub}/{name}'
        d = os.path.join(CUSTOM, '8 Structures', sub, name)
        os.makedirs(d, exist_ok=True)
        # the reference is "- painted.glb" (tools/painted_glb.py): already in the planner's frame for structures
        # (centred, long side along x), unlike the raw export whose pivot and facing vary from set to set
        files = [f'{name} - painted.glb']
        ids = sorted(by_key.get(key, []))
        s0 = defs.get(ids[0]) if ids else None
        note = 'used for ' + ', '.join(sorted({f"{defs[i]['name']} ({defs[i]['mat']})" for i in ids if i in defs}))
        if not isinstance(st['mesh'], str):
            note += '. Built by tools/convert_models.py (the game export only has a simplified stand-in)'
        if st['tex']:
            note += '. Same shape as the FICSIT one, grip-metal texture'
        man[folder] = {'files': files, 'used_for': [key], 'size': f"{s0['w']} x {s0['h']} m footprint, {s0['z']} m tall" if s0 else '',
                       'note': note, 'voxel': VOXEL}
    # splitters and mergers: same box size as the constructor (0.24 m) instead of their automatic 0.1 m
    for k in ('5 Logistics/Splitter', '5 Logistics/Merger'):
        man[k]['voxel'] = 0.24
    json.dump(man, open(man_path, 'w', encoding='utf-8'), indent=1)
    print(len(cm.STRUCT), 'structure models in Custom/8 Structures')


if __name__ == '__main__':
    main()
