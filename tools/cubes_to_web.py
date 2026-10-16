"""Copy the cube models (Custom/**/* - cubes.glb, made by tools/cubify.py) into the website for the
"Cube models (test)" option in the 3D view.  python tools/cubes_to_web.py
"""
import base64, json, os, shutil, hashlib

ROOT = os.path.join(os.path.dirname(__file__), '..')
CUSTOM = os.path.join(ROOT, 'Custom')
OUT = os.path.join(ROOT, 'web', 'models_cubes')
# sizes differ too much to reuse the shared model as-is (the planner keeps the original for these)
SKIP = {'Build_StorageContainerMk2_C', 'Build_IndustrialTank_C'}
LIFT = {'lift_bottom': 'bottom', 'lift_top': 'top'}

man = json.load(open(os.path.join(CUSTOM, 'manifest.json'), encoding='utf-8'))
if os.path.isdir(OUT):
    shutil.rmtree(OUT)
os.makedirs(OUT)
index = {}
for folder, m in man.items():
    d = os.path.join(CUSTOM, *folder.split('/'))
    name = folder.split('/')[-1]
    for key in m['used_for']:
        if key in SKIP:
            continue
        if name == 'Conveyor Lift':
            src = os.path.join(d, f"{name} - {LIFT.get(key, 'middle')} cubes.glb")
        else:
            src = os.path.join(d, f'{name} - cubes.glb')
        if not os.path.exists(src):
            continue
        # stored as a script (like web/models) so it also loads when the page is opened from disk (file://)
        raw = open(src, 'rb').read()
        dst = key + '.js'
        open(os.path.join(OUT, dst), 'w', encoding='ascii').write(f'SF.cubeData({json.dumps(key)},"{base64.b64encode(raw).decode()}");' + chr(10))
        index[key] = {'f': 'models_cubes/' + dst, 'h': hashlib.md5(raw).hexdigest()[:10]}
open(os.path.join(OUT, 'index.js'), 'w', encoding='utf-8').write('window.SF_CUBES = ' + json.dumps(index, indent=1) + ';\n')
print(len(index), 'planner models have a cube version')
