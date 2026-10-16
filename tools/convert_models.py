"""Convert FModel .uemodel exports into compact, lazily-loadable model scripts for the 3D view.

Usage: python tools/convert_models.py [path-to-.../Buildable/Factory] [--tris 14000]

For each building: reads LOD0, drops decal/effect sections, converts UE (cm, Z-up, left-handed)
to three.js (m, Y-up, right-handed), simplifies by vertex clustering (position + normal bucket,
so hard edges survive) down to a triangle budget, quantizes, and writes web/models/<key>.js.
"""
import base64
import io
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from uemodel import read_uemodel  # noqa: E402
from gltf import read_glb  # noqa: E402

# Maps glTF-space vectors (rows) into the UE convention the converter uses (X fwd, Y right, Z up, cm).
# None = not calibrated yet: set it by comparing one .glb against the same mesh's .uemodel.
# FModel glTF: (x, y, z) = (UE X, UE Z, UE Y) / 100 -- measured against the same mesh's .uemodel
GLTF_TO_UE = {'axes': [[1, 0, 0], [0, 0, 1], [0, 1, 0]], 'scale': 100.0, 'flip_v': False}


def part_path(part):
    """'B:Wall/...' = Buildable/Building (structures), anything else = Buildable/Factory (SRC)."""
    if part.startswith('B:'):
        return os.path.join(os.path.dirname(os.path.normpath(SRC)), 'Building', part[2:].replace('/', os.sep))
    return os.path.join(SRC, part.replace('/', os.sep))


def load_mesh(part):
    """Read <part>.uemodel if present, else <part>.glb (FModel glTF 2.0 binary export)."""
    base = part_path(part)
    if os.path.exists(base + '.uemodel'):
        return read_uemodel(base + '.uemodel')
    if os.path.exists(base + '.glb'):
        if GLTF_TO_UE is None:
            raise ValueError('glTF axis conversion not calibrated yet (GLTF_TO_UE)')
        m = read_glb(base + '.glb')
        lod = m['lods'][0]
        A, scale = np.array(GLTF_TO_UE['axes'], np.float64), GLTF_TO_UE['scale']
        lod['pos'] = (lod['pos'] @ A.T) * scale
        lod['nrm'] = lod['nrm'] @ A.T
        if GLTF_TO_UE.get('flip_v'):
            lod['uvs'] = [np.stack([uv[:, 0], 1 - uv[:, 1]], 1) for uv in lod['uvs']]
        return m
    raise FileNotFoundError(base + '.uemodel / .glb')

def make_boxes(boxes, mat):
    """A mesh (same layout as load_mesh, UE cm) from boxes [x0, x1, y0, y1, z0, z1] in metres (UE axes), one
    material section; planar UVs at 4 m per texture repeat."""
    P, N, U, I = [], [], [], []
    for x0, x1, y0, y1, z0, z1 in boxes:
        c = np.array([[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]])
        faces = [([0, 3, 2, 1], [0, 0, -1]), ([4, 5, 6, 7], [0, 0, 1]), ([0, 1, 5, 4], [0, -1, 0]),
                 ([2, 3, 7, 6], [0, 1, 0]), ([1, 2, 6, 5], [1, 0, 0]), ([3, 0, 4, 7], [-1, 0, 0])]
        for q, n in faces:
            b = len(P)
            n = np.array(n, float)
            ax = [k for k in range(3) if n[k] == 0]
            for v in q:
                P.append(c[v]); N.append(n); U.append([c[v][ax[0]] / 4.0, c[v][ax[1]] / 4.0])
            I += [b, b + 1, b + 2, b, b + 2, b + 3]
    pos = np.array(P) * 100.0
    return {'lods': [{'pos': pos, 'nrm': np.array(N), 'uvs': [np.array(U)], 'idx': np.array(I, np.int64),
                      'materials': [{'name': mat, 'first': 0, 'faces': len(I) // 3}]}]}


def load_part(part):
    """A mesh part: a path (see load_mesh), {'boxes': [...], 'mat': name} or {'mesh': path, 'move': [x, y, z] m,
    'turn': quarter turns about up}. Each part's winding is made to agree with its normals."""
    if isinstance(part, dict) and 'boxes' in part:
        m = make_boxes(part['boxes'], part['mat'])
    else:
        m = load_mesh(part['mesh'] if isinstance(part, dict) else part)
        if isinstance(part, dict):
            lod = m['lods'][0]
            p, n = lod['pos'].astype(np.float64), lod['nrm'].astype(np.float64)
            if part.get('open'):
                # drop the panels that close an opening: triangles centred inside [y0, y1, z0, z1] (m, the part's own axes)
                y0, y1, z0, z1 = part['open']
                t = lod['idx'].astype(np.int64).reshape(-1, 3)
                c = p[t].mean(1) / 100.0
                keep = ~((c[:, 1] > y0) & (c[:, 1] < y1) & (c[:, 2] > z0) & (c[:, 2] < z1))
                first = 0
                for sec in lod['materials']:                     # rebuild section ranges after the drop
                    a = sec['first'] // 3
                    k = int(keep[a:a + sec['faces']].sum())
                    sec['first'], sec['faces'] = first * 3, k
                    first += k
                lod['idx'] = t[keep].reshape(-1)
            if part.get('mirror'):                               # upside down (inverted ramps)
                p = p * np.array([1, 1, -1]); n = n * np.array([1, 1, -1])
            for _ in range(part.get('turn', 0) % 4):
                p = np.stack([-p[:, 1], p[:, 0], p[:, 2]], 1); n = np.stack([-n[:, 1], n[:, 0], n[:, 2]], 1)
            lod['pos'] = p + np.array(part.get('move', [0, 0, 0])) * 100.0
            lod['nrm'] = n
    lod = m['lods'][0]
    p, n = lod['pos'].astype(np.float64), lod['nrm'].astype(np.float64)
    t = lod['idx'].astype(np.int64).reshape(-1, 3)
    fn = np.cross(p[t[:, 1]] - p[t[:, 0]], p[t[:, 2]] - p[t[:, 0]])
    if len(t) and np.mean(np.sum(fn * (n[t[:, 0]] + n[t[:, 1]] + n[t[:, 2]]), 1) > 0) < 0.5:
        lod['idx'] = t[:, [0, 2, 1]].reshape(-1)
    return m


def part_name(part):
    return part if isinstance(part, str) else part.get('mesh', 'B:Wall/generated')


SRC = next((a for a in sys.argv[1:] if not a.startswith('--')),
           r'O:\Downloads\d61549776a0ca9411903804640c7a61de721c4e6\Output\Exports\FactoryGame\Content\FactoryGame\Buildable\Factory')
TRIS = int(sys.argv[sys.argv.index('--tris') + 1]) if '--tris' in sys.argv else 14000
# the converted game meshes are kept OUT of the website (copyright): only numbers go to web/model_meta.js
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '_game_models')

# planner building class -> mesh (relative to SRC, without extension)
MAP = {
    # several buildings keep moving parts in a skeletal (SK_) or vertex-animated (VAT) mesh; those are
    # merged in (verified by overlay renders with tools/audit_models.py: they fill visible gaps)
    'Build_ConstructorMk1_C': ['ConstructorMk1/Mesh/ConstructorMk1_static', 'ConstructorMk1/Mesh/SK_Constructor_01',
                               'ConstructorMk1/Mesh/SK_Constructor_CableMesh'],
    # the smelter's static mesh is only the base; the furnace body lives in the skeletal mesh
    'Build_SmelterMk1_C': ['SmelterMk1/Mesh/SmelterMk1_static', 'SmelterMk1/Mesh/SK_SmelterMk1'],
    'Build_FoundryMk1_C': ['FoundryMk1/Mesh/FoundryMk1_static', 'FoundryMk1/Mesh/SM_VAT_Foundry'],
    'Build_AssemblerMk1_C': ['AssemblerMk1/Mesh/AssemblerMk1_static', 'AssemblerMk1/Mesh/SM_Assembler_VAT'],
    'Build_ManufacturerMk1_C': ['ManufacturerMk1/Mesh/SM_Manufacturer', 'ManufacturerMk1/Mesh/SM_VAT_Manufacturer'],
    'Build_OilRefinery_C': ['OilRefinery/Mesh/SM_OilRefinery_01', 'OilRefinery/Mesh/SM_Refinery_VAT_01'],
    'Build_Packager_C': ['Packager/Mesh/SM_Packager_01', 'Packager/Mesh/SK_Packager_01'],
    'Build_Blender_C': ['Blender/Mesh/SM_Blender_01', 'Blender/Mesh/SM_Blender_VAT'],
    'Build_HadronCollider_C': 'HadronCollider/Mesh/SM_HadronCollider_01',
    'Build_Converter_C': ['Converter/Mesh/SM_Converter_01', 'Converter/Mesh/SM_VAT_Converter'],
    'Build_QuantumEncoder_C': ['QuantumEncoder/Mesh/SM_QuantumEncoder_01', 'QuantumEncoder/Mesh/SK_QuantumEncoder_01'],
    'Build_MinerMk1_C': ['MinerMK1/Mesh/MinerMk1_static', 'MinerMK1/Mesh/SK_MinerMk1'],
    'Build_MinerMk2_C': ['MinerMk2/Mesh/MinerMk2_static', 'MinerMk2/Mesh/SK_MinerMk2'],
    'Build_MinerMk3_C': ['MinerMk3/Mesh/Miner_Mk3_Static', 'MinerMk2/Mesh/SK_MinerMk2'],   # Mk3 has no drill mesh of its own
    'Build_OilPump_C': ['OilPump/Mesh/OilPump_static', 'OilPump/Mesh/SM_VAT_OilPump'],
    'Build_WaterPump_C': 'WaterPump/Mesh/SM_WaterPump_01',
    'Build_FrackingExtractor_C': 'FrackingExtractor/Mesh/SM_FrackerExtractor_01',
    'Build_FrackingSmasher_C': ['FrackingSmasher/Mesh/SM_Fracker_01', 'FrackingSmasher/Mesh/SK_Fracker_01'],
    'Build_GeneratorBiomass_Automated_C': 'GeneratorBiomass/Mesh/GeneratorBiomass_static',
    'Build_GeneratorCoal_C': 'GeneratorCoal/Mesh/GeneratorCoal_static',
    'Build_GeneratorFuel_C': ['GeneratorFuel/Mesh/GeneratorFuel_static', 'GeneratorFuel/Mesh/SM_VAT_FuelGenerator'],
    'Build_GeneratorGeoThermal_C': ['GeneratorGeoThermal/Mesh/SM_GeneratorGeoThermal_01', 'GeneratorGeoThermal/Mesh/SK_GeneratorGeoThermal'],
    'Build_GeneratorNuclear_C': 'GeneratorNuclear/Mesh/SM_Generator_Nuclear',
    'Build_PowerStorageMk1_C': ['PowerStorage/Mesh/SM_PowerStorage_01', 'PowerStorage/Mesh/SK_PowerStorage_01'],
    # SM_ versions are the full 4x4 m models (the *_static ones are a cut-down variant whose UVs don't
    # match the textures); their origin sits at belt height
    'Build_ConveyorAttachmentSplitter_C': 'CA_Splitter/Mesh/SM_Splitter_01',
    'Build_ConveyorAttachmentMerger_C': 'CA_Merger/Mesh/SM_Merger_01',
    'Build_ConveyorAttachmentSplitterSmart_C': 'CA_SplitterSmart/Mesh/SM_SplitterSmart_01',
    'Build_ConveyorAttachmentSplitterProgrammable_C': 'CA_SplitterProgrammable/Mesh/SM_ProgSplitter_01',
    'Build_ConveyorAttachmentMergerPriority_C': 'CA_MergerPriority/Mesh/SM_PriorityMerger_01',
    'Build_PipelineJunction_Cross_C': 'PipeJunction/Mesh/SM_Pipe_Junction_Cross_01',
    'Build_PipelineJunction_T_C': 'PipeJunction/Mesh/SM_PipeJunction_T_01',
    'Build_PipelinePump_C': 'PipePump/Mesh/SM_PipePump',
    'Build_PipelinePumpMk2_C': 'PipePumpMk2/Mesh/SM_PipePumpMk2_01',
    'Build_Valve_C': 'PipeValve/Mesh/SM_PipeValve_01',
    'Build_StorageContainerMk1_C': 'StorageContainerMk1/Mesh/StorageContainerMk1_static',
    'Build_StorageContainerMk2_C': 'StorageContainerMk2/Mesh/StorageContainerMk2_static',
    'Build_PipeStorageTank_C': 'FluidContainer/Mesh/SM_FluidContainer_01',
    'Build_IndustrialTank_C': 'IndustrialFluidContainer/Mesh/SM_IndustrialFluidContainer',
    'Build_CentralStorage_C': 'CentralStorage/Mesh/SM_CentralStorage_01',
    'Build_ResourceSink_C': ['ResourceSink/Mesh/SM_ResourceSink', 'ResourceSink/Mesh/SK_ResourceSink'],
    'Build_SpaceElevator_C': 'SpaceElevator/Mesh/SpaceElevator',
    # belt / pipe segments (tiled along paths in the 3D view)
    'belt1': 'ConveyorBeltMk1/Mesh/SM_ConveyorBelt_Mk1',
    'belt2': 'ConveyorBeltMk2/Mesh/SM_ConveyorBelt_Mk2',
    'belt3': 'ConveyorBeltMk3/Mesh/SM_ConveyorBelt_Mk3',
    'belt4': 'ConveyorBeltMk4/Mesh/SM_ConveyorBelt_Mk4',
    'belt5': 'ConveyorBeltMk5/Mesh/SM_ConveyorBelt_Mk5',
    'belt6': 'ConveyorBeltMk6/Mesh/SM_ConveyorBelt_Mk6',
    'pipe': 'Pipeline/Mesh/SM_Pipe_Static',
    # supports and lifts used by the 3D belt/pipe builder
    'pole': 'ConveyorPole/Mesh/SM_ConveyorPole_01',
    'pipepole': 'PipelineSupport/Mesh/PipelineSupport_static',
    'lift_bottom': 'ConveyorLiftMk1/Mesh/SM_ConveyorLift_Bottom_01',
    'lift_top': 'ConveyorLiftMk1/Mesh/SM_ConveyorLift_Top_01',
    'lift1': 'ConveyorLiftMk1/Mesh/SM_ConveyorLiftMid_MK1_01',
    'lift2': 'ConveyorLiftMk2/Mesh/ConveyorLiftMid_Mk2_static_LOD0',
    'lift3': 'ConveyorLiftMk3/Mesh/ConveyorLiftMid_Mk3_static_LOD0',
    'lift4': 'ConveyorLiftMk4/Mesh/ConveyorLiftMid_Mk4_static_LOD0',
    'lift5': 'ConveyorLiftMk5/Mesh/ConveyorLiftMid_Mk5_static_LOD0',
    'lift6': 'ConveyorLiftMk6/Mesh/ConveyorLiftMid_Mk6_static_LOD0',
}
# ---------------------------------------------------------------- structures (foundations, walls, ramps...)
# One model per distinct mesh; several planner structures can share one (the Asphalt and Polished sets use the
# Concrete meshes, Metal uses the FICSIT meshes with the grip-metal texture). The 3D view tints per structure.
# kind: 'floor' (foundations / ramps: top at 0, sunk below the floor) or 'wall' (bottom at 0); 'ramp' also
# turns the mesh so it rises towards the planner's -x (the arrow in 2D).
GRIP = ('Foundation/GripMetal/Textures/TX_GripMetal_Foundation_01_BC.png', 'Foundation/GripMetal/Textures/TX_GripMetal_Foundation_01_AOMasks.png')
STRUCT = {}
STRUCT_USE = {}            # planner structure id -> [model key, tint (multiplier) or None]
TINT = {'Asphalt': [0.46, 0.47, 0.5], 'Polished': [1.12, 1.1, 1.06], 'Concrete': None, 'FICSIT': None, 'Metal': None}


def _st(key, mesh, kind, tex=None):
    STRUCT[key] = {'mesh': 'B:' + mesh, 'kind': kind, 'tex': tex}


for n in (1, 2, 4):
    _st(f'S_FoundConcrete_{n}', f'Foundation/ConcreteSet/Meshes/SM_Foundation_Concrete_8x{n}', 'floor')
    _st(f'S_FoundFicsit_{n}', f'Foundation/FicsitSet/SM_Foundation_FicsitSet_8x{n}_01', 'floor')
    _st(f'S_FoundGrip_{n}', f'Foundation/FicsitSet/SM_Foundation_FicsitSet_8x{n}_01', 'floor', GRIP)
    _st(f'S_HalfConcrete_{n}', f'Foundation/ConcreteSet/Meshes/SM_ConcreteQuarterPipeStraight_8x{n}', 'floor')
    _st(f'S_HalfFicsit_{n}', f'Foundation/FicsitSet/Meshes/SM_QuarterPipeMiddle_Ficsit_8x{n}', 'floor')
    _st(f'S_HalfGrip_{n}', f'Foundation/FicsitSet/Meshes/SM_QuarterPipeMiddle_Ficsit_8x{n}', 'floor', GRIP)
    _st(f'S_RampConcrete_{n}', f'Foundation/ConcreteSet/Meshes/SM_ConcreteRamp_8x{n}_01', 'ramp')
    _st(f'S_RampFicsit_{n}', f'Foundation/FicsitSet/SM_Foundation_FicsitSet_Ramp_8x{n}_01', 'ramp')
    _st(f'S_RampGrip_{n}', f'Foundation/FicsitSet/SM_Foundation_FicsitSet_Ramp_8x{n}_01', 'ramp', GRIP)
    _st(f'S_StairConcrete_{n}', f'Foundation/ConcreteSet/SM_ConcreteStair_8x{n}_01', 'ramp')
    _st(f'S_StairFicsit_{n}', f'Foundation/FicsitSet/SM_Foundation_FicsitSet_Stair_8x{n}_01', 'ramp')
    _st(f'S_StairGrip_{n}', f'Foundation/GripMetal/Meshes/SM_Foundation_GripMetal_Stair_8x{n}_01', 'ramp')
_st('S_FrameFloor', 'Foundation/Mesh/SM_FrameFoundation_01', 'floor')
_st('S_FrameFound', 'Foundation/Mesh/SM_FoundationFrame_01', 'floor')
_st('S_GlassFound', 'Foundation/Mesh/SM_FoundationGlass_01', 'floor')
for k, m in {
    'S_WallConcrete_4': 'Wall/ConcreteWallSet/SM_WallSet_Concrete_8x4', 'S_WallConcrete_1': 'Wall/ConcreteWallSet/SM_WallSetConcrete_8x1_01',
    'S_WallConcrete_Hole1': 'Wall/ConcreteWallSet/SM_WallSet_Concrete_CHole1_8x4_01', 'S_WallConcrete_Hole2': 'Wall/ConcreteWallSet/SM_WallSet_Concrete_CHole2_8x4_01',
    'S_WallConcrete_Hole3': 'Wall/ConcreteWallSet/SM_WallSet_Concrete_CHole3_8x4_01', 'S_WallConcrete_Window': 'Wall/ConcreteWallSet/SM_WallSet_Concrete_Window_8x4_01',
    'S_WallConcrete_Gate': 'Wall/ConcreteWallSet/SM_WallSet_Concrete_Gate_8x4',
    'S_WallOrange_4': 'Wall/FicsitWallSet/SM_WallSet_Orange_8x4', 'S_WallOrange_1': 'Wall/FicsitWallSet/SM_WallSet_Orange_8x1_01',
    'S_WallOrange_Window': 'Wall/FicsitWallSet/SM_WallSet_Orange_Window_8x4_01',
    'S_WallSteel_1': 'Wall/SteelWallSet/SM_WallSet_Steel_8x1', 'S_WallSteel_Hole1': 'Wall/SteelWallSet/SM_WallSet_Steel_CHole1_8x4',
    'S_WallSteel_Hole2': 'Wall/SteelWallSet/SM_WallSet_Steel_CHole2_8x4', 'S_WallSteel_Hole3': 'Wall/SteelWallSet/SM_WallSet_Steel_CHole3_8x4',
    'S_WallSteel_Gate': 'Wall/SteelWallSet/SM_WallSet_Steel_Gate_8x4_01',
    'S_Window_05': 'Wall/Mesh/SM_Wall_Window_8x4_05', 'S_Window_06': 'Wall/Mesh/SM_Wall_Window_8x4_06', 'S_Window_07': 'Wall/Mesh/SM_Wall_Window_8x4_07',
    'S_WindowThin_01': 'Wall/Mesh/SM_Wall_Window_Thin_8x4_01', 'S_WindowThin_02': 'Wall/Mesh/SM_Wall_Window_Thin_8x4_02',
    'S_BarrierLow': 'Barrier/SM_Barrier_low_01', 'S_BarrierTall': 'Barrier/SM_Barrier_tall_01',
    'S_Railing': 'Fence/Mesh/Fence_01', 'S_ModernRailing': 'Walkway/Mesh/SM_Railing_01', 'S_TarpFence': 'TarpFence/Mesh/SM_TarpFence_01',
}.items():
    _st(k, m, 'wall')


# The export only has simplified stand-ins for some structures (conveyor walls without holes, stairs as a
# wedge), so those are built here: a slab with openings plus the game's conveyor-hole frame, and 25 cm steps.
HOLE_W, HOLE_H = 2.4, 2.2
HOLES = {1: [0.0], 2: [-1.4, 1.4], 3: [-2.7, 0.0, 2.7]}         # opening centres along the wall


def conveyor_wall(mat, n, long_axis):
    xs = sorted(HOLES[n])
    cuts = [(-4.0, 4.0)]
    boxes = []
    edge = -4.0
    for c in xs:                                                 # columns between the openings, lintels above them
        boxes.append((edge, c - HOLE_W / 2, 0, 4)); boxes.append((c - HOLE_W / 2, c + HOLE_W / 2, HOLE_H, 4)); edge = c + HOLE_W / 2
    boxes.append((edge, 4.0, 0, 4))
    out = []
    for a0, a1, z0, z1 in boxes:
        if a1 - a0 < 1e-3:
            continue
        out.append([a0, a1, -0.25, 0.25, z0, z1] if long_axis == 'X' else [-0.25, 0.25, a0, a1, z0, z1])
    parts = [{'boxes': out, 'mat': mat}]
    for c in xs:                                                 # the frame mesh is 2.4 m wide along UE Y
        parts.append({'mesh': 'B:ConveyorHole/SM_ConveyorHole_01', 'open': [-0.85, 0.85, 0.25, 1.95], 'move': [c, 0, 0] if long_axis == 'X' else [0, c, 0], 'turn': 1 if long_axis == 'X' else 0})
    return parts


def stairs(mat, rise):
    n = int(round(rise / 0.25))                                  # 25 cm steps over the 8 m run, rising towards +X
    d = 8.0 / n
    return [{'boxes': [[-4 + k * d, 4, -4, 4, 0, (k + 1) * 0.25] for k in range(n)], 'mat': mat}]


for n in (1, 2, 4):
    STRUCT[f'S_RampInvConcrete_{n}'] = {'mesh': [{'mesh': f'B:Foundation/ConcreteSet/Meshes/SM_ConcreteRamp_8x{n}_01', 'mirror': True}], 'kind': 'iramp', 'tex': None}
    STRUCT[f'S_RampInvFicsit_{n}'] = {'mesh': [{'mesh': f'B:Foundation/FicsitSet/SM_Foundation_FicsitSet_Ramp_8x{n}_01', 'mirror': True}], 'kind': 'iramp', 'tex': None}
    STRUCT[f'S_RampInvGrip_{n}'] = {'mesh': [{'mesh': f'B:Foundation/FicsitSet/SM_Foundation_FicsitSet_Ramp_8x{n}_01', 'mirror': True}], 'kind': 'iramp', 'tex': GRIP}
for n in (1, 2, 3):
    STRUCT[f'S_WallConcrete_Hole{n}'] = {'mesh': conveyor_wall('MI_WallSetConcrete_8x4', n, 'X'), 'kind': 'wall', 'tex': None}
    STRUCT[f'S_WallSteel_Hole{n}'] = {'mesh': conveyor_wall('MI_SteelWall_8x4', n, 'Y'), 'kind': 'wall', 'tex': None}
for n in (1, 2, 4):
    STRUCT[f'S_StairConcrete_{n}'] = {'mesh': stairs('MI_Foundation_Concrete', n), 'kind': 'ramp', 'tex': None}
    STRUCT[f'S_StairFicsit_{n}'] = {'mesh': stairs('MI_Foundation_FicsitSet_01', n), 'kind': 'ramp', 'tex': None}
    STRUCT[f'S_StairGrip_{n}'] = {'mesh': stairs('MI_GripMetal_Foundation', n), 'kind': 'ramp', 'tex': None}


def _use(ids, key, mat=None):
    for i in ids if isinstance(ids, list) else [ids]:
        STRUCT_USE[i] = [key, TINT.get(mat)]


for n in (1, 2, 4):
    for mat, tag in (('Asphalt', 'Asphalt'), ('Concrete', 'Concrete'), ('Polished', 'ConcretePolished')):
        _use(f'Build_Foundation_{tag}_8x{n}_C' if not (mat == 'Polished' and n == 2) else 'Build_Foundation_ConcretePolished_8x2_2_C', f'S_FoundConcrete_{n}', mat)
        _use(f'Build_QuarterPipeMiddle_{"PolishedConcrete" if mat == "Polished" else mat}_8x{n}_C', f'S_HalfConcrete_{n}', mat)
        _use(f'Build_Ramp_{mat}_8x{n}_C', f'S_RampConcrete_{n}', mat)
        _use(f'Build_Stair_{"PolishedConcrete" if mat == "Polished" else mat}_8x{n}_C', f'S_StairConcrete_{n}', mat)
    _use(f'Build_Foundation_8x{n}_01_C', f'S_FoundFicsit_{n}')
    _use(f'Build_QuarterPipeMiddle_Ficsit_8x{n}_C', f'S_HalfFicsit_{n}')
    _use(f'Build_Ramp_8x{n}_01_C', f'S_RampFicsit_{n}')
    _use(f'Build_Stair_FicsitSet_8x{n}_01_C', f'S_StairFicsit_{n}')
    _use(f'Build_Foundation_Metal_8x{n}_C', f'S_FoundGrip_{n}')
    _use(f'Build_QuarterPipeMiddle_Grip_8x{n}_C', f'S_HalfGrip_{n}')
    _use(f'Build_Ramp_Metal_8x{n}_C', f'S_RampGrip_{n}')
    _use(f'Build_Stair_GripMetal_8x{n}_C', f'S_StairGrip_{n}')
for n in (1, 2, 4):
    for mat in ('Asphalt', 'Concrete', 'Polished'):
        _use(f'Build_InvertedRamp_{mat}_8x{n}_C', f'S_RampInvConcrete_{n}', mat)
        _use(f'Build_RampDouble_{mat}_8x{n}_C', f'S_RampConcrete_{n}', mat)
    _use(f'Build_InvertedRamp_Metal_8x{n}_C', f'S_RampInvGrip_{n}')
    _use(f'Build_RampDouble_Metal_8x{n}_C', f'S_RampGrip_{n}')
_use('Build_RampInverted_8x1_C', 'S_RampInvFicsit_1'); _use('Build_RampInverted_8x2_01_C', 'S_RampInvFicsit_2'); _use('Build_Ramp_8x4_Inverted_01_C', 'S_RampInvFicsit_4')
_use('Build_RampDouble_8x1_C', 'S_RampFicsit_1'); _use('Build_RampDouble_C', 'S_RampFicsit_2'); _use('Build_Ramp_8x8x8_C', 'S_RampFicsit_4')
_use('Build_Flat_Frame_01_C', 'S_FrameFloor'); _use('Build_Foundation_Frame_01_C', 'S_FrameFound'); _use('Build_FoundationGlass_01_C', 'S_GlassFound')
_use('Build_Wall_Concrete_8x4_C', 'S_WallConcrete_4'); _use('Build_Wall_Concrete_8x1_C', 'S_WallConcrete_1')
_use('Build_Wall_Concrete_8x4_ConveyorHole_01_C', 'S_WallConcrete_Hole1'); _use('Build_Wall_Concrete_8x4_ConveyorHole_02_C', 'S_WallConcrete_Hole2')
_use('Build_Wall_Concrete_8x4_ConveyorHole_03_C', 'S_WallConcrete_Hole3'); _use('Build_Wall_Concrete_8x4_Window_02_C', 'S_WallConcrete_Window')
_use('Build_Wall_Concrete_Gate_8x4_C', 'S_WallConcrete_Gate')
_use('Build_Wall_8x4_02_C', 'S_WallOrange_4'); _use('Build_Wall_Orange_8x1_C', 'S_WallOrange_1'); _use('Build_Wall_Window_8x4_02_C', 'S_WallOrange_Window')
_use('Build_SteelWall_8x1_C', 'S_WallSteel_1'); _use('Build_SteelWall_8x4_Gate_01_C', 'S_WallSteel_Gate')
# the game numbers its steel conveyor walls backwards: _03 has one hole, _01 three
_use('Build_Wall_Conveyor_8x4_03_Steel_C', 'S_WallSteel_Hole1'); _use('Build_Wall_Conveyor_8x4_02_Steel_C', 'S_WallSteel_Hole2'); _use('Build_Wall_Conveyor_8x4_01_Steel_C', 'S_WallSteel_Hole3')
_use('Build_Wall_Window_8x4_05_C', 'S_Window_05'); _use('Build_Wall_Window_8x4_06_C', 'S_Window_06'); _use('Build_Wall_Window_8x4_07_C', 'S_Window_07')
_use('Build_Wall_Window_Thin_8x4_01_C', 'S_WindowThin_01'); _use('Build_Wall_Window_Thin_8x4_02_C', 'S_WindowThin_02')
_use('Build_Barrier_Low_01_C', 'S_BarrierLow'); _use('Build_Barrier_Tall_01_C', 'S_BarrierTall')
_use('Build_Fence_01_C', 'S_Railing'); _use('Build_Railing_01_C', 'S_ModernRailing'); _use('Build_TarpFence_C', 'S_TarpFence')


def normalise_structure(V, kind):
    """Put a structure mesh in the planner's box frame: long side along x, centred on the footprint, top at 0
    (foundations / ramps, which sit below the floor) or bottom at 0 (walls); ramps rise towards -x."""
    P, N = V[:, 0:3], V[:, 3:6]
    def turn(P, N, q):                   # q quarter turns about +y: (x, z) -> (z, -x)
        for _ in range(q % 4):
            P = np.stack([P[:, 2], P[:, 1], -P[:, 0]], 1); N = np.stack([N[:, 2], N[:, 1], -N[:, 0]], 1)
        return P, N
    lo, hi = P.min(0), P.max(0)
    if kind in ('ramp', 'iramp'):
        # ramps: the high side goes to -x; inverted ramps (flat on top): the deep side goes to -x
        top = P[P[:, 1] > hi[1] - 0.15 * (hi[1] - lo[1])] if kind == 'ramp' else P[P[:, 1] < lo[1] + 0.15 * (hi[1] - lo[1])]
        c = (lo + hi) / 2
        dx, dz = top[:, 0].mean() - c[0], top[:, 2].mean() - c[2]
        # quarter turns that bring the high side to -x
        q = 0 if abs(dx) >= abs(dz) and dx < 0 else 2 if abs(dx) >= abs(dz) else 1 if dz > 0 else 3
        P, N = turn(P, N, q)
    elif (hi[2] - lo[2]) > (hi[0] - lo[0]) + 1e-3:
        P, N = turn(P, N, 1)
    lo, hi = P.min(0), P.max(0)
    P = P - np.array([(lo[0] + hi[0]) / 2, hi[1] if kind != 'wall' else lo[1], (lo[2] + hi[2]) / 2])
    V = V.copy(); V[:, 0:3] = P; V[:, 3:6] = N
    return V


DROP = ('decal', 'effect', 'hologram', 'fogplane', 'factorylod', 'scanshell')
GLASS = ('glass', 'window')
LIGHT = ('light', 'indica', 'monitor', 'powerstri')


def section_kind(name):
    n = name.lower()
    if any(k in n for k in DROP):
        return None
    if any(k in n for k in GLASS):
        return 'glass'
    if any(k in n for k in LIGHT):
        return 'light'
    return 'main'


def to_three(v):
    # UE (X fwd, Y right, Z up; cm) -> three (x = UE Y, y = UE Z, z = -UE X; m)
    return np.stack([v[:, 1], v[:, 2], -v[:, 0]], axis=1)


# ---------------------------------------------------------------- paint from textures
# Satisfactory factory textures: *_BC = base colour, *_AOMasks = R ambient occlusion,
# G primary-paint mask, B secondary-paint mask. Default FICSIT swatch below.
PRIMARY = np.array([250, 149, 73]) / 255.0
SECONDARY = np.array([95, 102, 140]) / 255.0
DEFAULT_GREY = np.array([0.42, 0.43, 0.45])
_mat_index = None
_png_index = None
_tex_cache = {}


def _content_root():
    # search the whole FModel export (…/Exports/FactoryGame/Content) so shared materials and
    # textures outside Buildable/Factory (e.g. FactoryGame/-Shared) are found too
    p = os.path.normpath(SRC)
    parts = p.split(os.sep)
    if 'Content' in parts:
        return os.sep.join(parts[:len(parts) - parts[::-1].index('Content')])
    return p


def _indexes():
    global _mat_index, _png_index
    if _mat_index is None:
        _mat_index, _png_index = {}, {}
        for dirpath, _, files in os.walk(_content_root()):
            for f in files:
                base, ext = os.path.splitext(f)
                if ext == '.json':
                    _mat_index[base] = os.path.join(dirpath, f)
                elif ext == '.png':
                    _png_index[base.lower()] = os.path.join(dirpath, f)
    return _mat_index, _png_index


def _painted(bc_path, mk_path, paint=True):
    """Return a (S,S,3) float array of the painted base colour (sRGB 0..1). paint=False: the mask only darkens
    (ambient occlusion) -- concrete, steel and other unpainted structure materials."""
    key = (bc_path, mk_path, paint)
    if key in _tex_cache:
        return _tex_cache[key]
    from PIL import Image
    S = 512
    bc = np.asarray(Image.open(bc_path).convert('RGB').resize((S, S), Image.BILINEAR), np.float32) / 255
    out = bc.copy()
    if mk_path:
        mk = np.asarray(Image.open(mk_path).convert('RGB').resize((S, S), Image.BILINEAR), np.float32) / 255
        lum = (bc * np.array([0.3, 0.59, 0.11], np.float32)).sum(-1, keepdims=True)
        g, b, ao = mk[..., 1:2], mk[..., 2:3], mk[..., 0:1]
        if not paint:
            g = b = np.zeros_like(g)
        out = out * (1 - g) + PRIMARY * np.minimum(1, lum * 1.1) * g
        out = out * (1 - b) + SECONDARY * np.minimum(1, lum * 1.3) * b
        out *= 0.45 + 0.55 * ao
    elif not paint:
        pass
    else:
        # no paint-mask texture: Satisfactory albedos leave paintable panels near-white, so treat
        # bright, unsaturated texels as primary paint
        mx, mn = bc.max(-1, keepdims=True), bc.min(-1, keepdims=True)
        lum = (bc * np.array([0.3, 0.59, 0.11], np.float32)).sum(-1, keepdims=True)
        sat = (mx - mn) / np.maximum(mx, 1e-3)
        g = np.clip((lum - 0.78) / 0.12, 0, 1) * np.clip((0.12 - sat) / 0.08, 0, 1)
        out = out * (1 - g) + PRIMARY * g
    _tex_cache[key] = np.clip(out, 0, 1)
    return _tex_cache[key]


def _from_game_path(game_path, ext):
    """'/Game/FactoryGame/X/Y.Y' -> '<export>/Content/FactoryGame/X/Y<ext>' if that file exists."""
    if not game_path or not game_path.startswith('/Game/'):
        return None
    rel = game_path[len('/Game/'):].split('.')[0]
    f = os.path.join(_content_root(), rel.replace('/', os.sep) + ext)
    return f if os.path.exists(f) else None


def textures_for(material_name, part, material_path=None):
    """(bc, masks) paths for a section: from its material JSON, else the building's own texture folder.
    Materials and textures are resolved by full game path first (names are not unique across the game)."""
    mats, pngs = _indexes()
    bc = mk = None
    j = _from_game_path(material_path, '.json') or mats.get(material_name)
    if j:
        try:
            d = json.load(open(j, encoding='utf-8')) or {}
            for k, v in (d.get('Textures') or {}).items():
                if not isinstance(v, dict):
                    continue
                name = str(v.get('ObjectName', '')).split("'")
                name = (name[1] if len(name) > 1 else name[0]).lower()
                tex_file = _from_game_path(v.get('ObjectPath'), '.png') or pngs.get(name)
                if not name or not tex_file:
                    continue
                kl = k.lower()
                is_bc = kl in ('albedo', 'pm_diffuse', 'basecolor', 'base color', 'diffuse') or                     name.endswith(('_bc', '_albedo', '_basecolor', '_d'))
                is_mask = 'aomask' in kl or name.endswith('_aomasks')
                if is_bc and not bc:
                    bc = tex_file
                elif is_mask and not mk:
                    mk = tex_file
        except (OSError, ValueError):
            pass
    if not bc:
        # fall back to the building's skeletal-mesh texture set (its static mesh shares UV0)
        folder = os.path.dirname(part_path(part)) if part.startswith('B:') else os.path.join(SRC, part.split('/')[0])
        cands = []
        for dirpath, _, files in os.walk(folder):
            for f in files:
                fl = f.lower()
                # base colour textures; skip ones that only cover a sub-part (e.g. nuclear plant legs)
                # skip textures that only cover a sub-part or are placeholders
                if (fl.endswith('_bc.png') or fl.endswith('_albedo.png')) and                         not any(x in fl for x in ('leg', 'defaultmaterial', 'upperline')):
                    cands.append(os.path.join(dirpath, f))
        if cands:
            bc = sorted(cands, key=lambda x: ('_sk_' not in x.lower(), len(x)))[0]
            stem = bc[:bc.lower().rfind('_')]
            m2 = stem + '_AOMasks.png'
            mk = m2 if os.path.exists(m2) else mk
    return bc, mk


def sample(tex, uv):
    S = tex.shape[0]
    u = np.mod(uv[:, 0], 1.0); v = np.mod(uv[:, 1], 1.0)
    return tex[(v * (S - 1)).astype(int), (u * (S - 1)).astype(int)]


# ---------------------------------------------------------------- simplification on packed vertices
# V columns: 0-2 position, 3-5 normal, 6-7 UV0
UV_SCALE = 2048.0          # UVs stored as int16 / UV_SCALE  (range +-16, ~0.25 texel at 512px)


def cluster(V, tri, cell):
    """Vertex clustering on exact (grid cell, normal bucket, UV bucket) keys -- no hashing, so
    vertices from different places can never be merged; UV buckets keep texture seams intact."""
    if cell <= 0:
        return V, tri
    gk = np.floor(V[:, 0:3] / cell).astype(np.int64)
    nk = np.round(V[:, 3:6] * 2.0).astype(np.int64)                 # ~30 degree buckets
    uk = np.floor(V[:, 6:8] * 16.0).astype(np.int64)                # 1/16 UV buckets
    keys = np.column_stack([gk, nk, uk])
    _, inv = np.unique(keys, axis=0, return_inverse=True)
    inv = inv.reshape(-1)
    n = inv.max() + 1
    cnt = np.bincount(inv, minlength=n).astype(np.float64)[:, None]
    V2 = np.zeros((n, V.shape[1])); np.add.at(V2, inv, V); V2 /= cnt
    V2[:, 3:6] /= np.maximum(np.linalg.norm(V2[:, 3:6], axis=1, keepdims=True), 1e-9)
    t2 = inv[tri]
    ok = (t2[:, 0] != t2[:, 1]) & (t2[:, 1] != t2[:, 2]) & (t2[:, 0] != t2[:, 2])
    t2 = t2[ok]
    srt = np.sort(t2, axis=1)
    _, first = np.unique(srt, axis=0, return_index=True)
    return V2, t2[np.sort(first)]


def compact(V, tri):
    used = np.unique(tri)
    remap = np.full(len(V), -1, np.int64); remap[used] = np.arange(len(used))
    return V[used], remap[tri]


def texture_data_uri(bc, mk, size=512, paint=True):
    """Painted texture as an embedded JPEG data URI (works in WebGL even from file://)."""
    from PIL import Image
    img = Image.fromarray((_painted(bc, mk, paint) * 255).astype(np.uint8))
    if img.size[0] != size:
        img = img.resize((size, size), Image.LANCZOS)
    b = io.BytesIO()
    img.save(b, 'JPEG', quality=86, optimize=True)
    return 'data:image/jpeg;base64,' + base64.b64encode(b.getvalue()).decode('ascii')


def convert(key, rel):
    # one or more source meshes merged into a single model (skeletal meshes use their bind pose)
    parts = rel if isinstance(rel, list) else [rel]
    V_l, groups, base = [], {}, 0
    textures = []                       # list of (bc, mk) used by this model
    for part in parts:
        m = load_part(part)
        part = part_name(part)
        lod = m['lods'][0]
        pos = to_three(lod['pos'].astype(np.float64)) / 100.0
        n = to_three(lod['nrm'].astype(np.float64))
        n /= np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-9)
        uv = lod['uvs'][0].astype(np.float64) if lod.get('uvs') else np.zeros((len(pos), 2))
        idx = lod['idx'].astype(np.int64).reshape(-1, 3)
        for sec in lod['materials']:
            kind = section_kind(sec['name'])
            if kind is None:
                continue
            a = sec['first'] // 3
            tris = idx[a:a + sec['faces']]
            tex = -1
            if kind == 'main':
                bc, mk = textures_for(sec['name'], part, sec.get('path'))
                if key in STRUCT and STRUCT[key]['tex']:
                    root = os.path.join(os.path.dirname(os.path.normpath(SRC)), 'Building')
                    bc, mk = (os.path.join(root, *t.split('/')) for t in STRUCT[key]['tex'])
                if bc:
                    if (bc, mk) not in textures:
                        textures.append((bc, mk))
                    tex = textures.index((bc, mk))
            groups.setdefault((kind, tex), []).append(tris + base)
        V_l.append(np.hstack([pos, n, uv]))
        base += len(pos)
    V = np.concatenate(V_l)
    if key in STRUCT:
        V = normalise_structure(V, STRUCT[key]['kind'])
    if not groups:
        raise ValueError('no usable sections')
    pos, nrm = V[:, 0:3], V[:, 3:6]
    # winding: three.js treats counter-clockwise as front; compare with stored normals
    allt = np.concatenate([t for g in groups.values() for t in g])
    fn = np.cross(pos[allt[:, 1]] - pos[allt[:, 0]], pos[allt[:, 2]] - pos[allt[:, 0]])
    vn = nrm[allt[:, 0]] + nrm[allt[:, 1]] + nrm[allt[:, 2]]
    flip = np.mean(np.sum(fn * vn, axis=1) > 0) < 0.5
    out_V, out_idx, out_groups = [], [], []
    base = 0
    budget = TRIS if key.startswith('Build_') else 3000
    total_tris = len(allt)
    order = sorted(groups, key=lambda k: (['main', 'glass', 'light'].index(k[0]), k[1]))
    for gkey in order:
        kind, tex = gkey
        t = np.concatenate(groups[gkey])
        if flip:
            t = t[:, [0, 2, 1]]
        Vk, t = compact(V, t)
        share = max(200, int(budget * len(t) / max(total_tris, 1)))
        cell = 0.0
        while len(t) > share and cell < 0.6:
            cell = 0.02 if cell == 0 else cell * 1.35
            V2, t2 = cluster(Vk, t, cell)
            V2, t2 = compact(V2, t2)
            if len(t2) <= share or cell >= 0.6:
                Vk, t = V2, t2
                break
        out_groups.append([int(sum(len(x) for x in out_idx) * 3), int(len(t) * 3), kind, int(tex)])
        out_V.append(Vk); out_idx.append(t + base)
        base += len(Vk)
    VV = np.concatenate(out_V); I = np.concatenate(out_idx).reshape(-1)
    P, N, UV = VV[:, 0:3], VV[:, 3:6], VV[:, 6:8]
    lo, hi = P.min(0), P.max(0)
    span = np.maximum(hi - lo, 1e-6)
    q = np.round((P - lo) / span * 65535 - 32768).astype('<i2')
    nq = np.round(N * 127).astype('i1')
    i32 = len(P) > 65535
    ib = I.astype('<u4' if i32 else '<u2')
    buf = io.BytesIO()
    buf.write(q.tobytes()); buf.write(b'\0' * ((-buf.tell()) % 4))
    buf.write(nq.tobytes()); buf.write(b'\0' * ((-buf.tell()) % 4))
    if textures:
        uq = np.round(np.clip(UV, -15.99, 15.99) * UV_SCALE).astype('<i2')
        buf.write(uq.tobytes()); buf.write(b'\0' * ((-buf.tell()) % 4))
    buf.write(ib.tobytes())
    # side profile at belt height: for each 0.5 m slice along the model's depth (three z), how far the mesh
    # reaches left (min x) and right (max x). The planner moves belt ports inward to touch the model.
    prof = None
    if key.startswith('Build_'):
        allP = V[:, 0:3]
        # only the belt connection height: feet / braces near the floor stick out past the connectors
        band = (allP[:, 1] > 0.6) & (allP[:, 1] < 1.6)
        bp = allP[band]
        if len(bp):
            z0 = float(np.floor(bp[:, 2].min() * 2) / 2)
            nb = int(np.ceil((bp[:, 2].max() - z0) / 0.5)) + 1
            Lm, Rm = [None] * nb, [None] * nb
            bins = np.clip(((bp[:, 2] - z0) / 0.5).astype(int), 0, nb - 1)
            for k in range(nb):
                sel = bp[bins == k]
                if len(sel) >= 4:
                    # ignore the outermost few percent (thin rails, handles) so ports reach the actual face
                    Lm[k] = round(float(np.quantile(sel[:, 0], 0.03)), 2); Rm[k] = round(float(np.quantile(sel[:, 0], 0.97)), 2)
            prof = {'z0': z0, 'step': 0.5, 'L': Lm, 'R': Rm}
    meta = {'b': [round(float(x), 4) for x in list(lo) + list(hi)], 'v': int(len(P)), 'i': int(len(I)),
            'i32': bool(i32), 'g': out_groups, 'uv': UV_SCALE if textures else 0,
            't': [texture_data_uri(bc, mk, paint=key not in STRUCT or any(x in key for x in ('Ficsit', 'Orange'))) for bc, mk in textures]}
    js = ('SF.modelData(%s,%s,"%s");\n' % (json.dumps(key), json.dumps(meta, separators=(',', ':')),
                                          base64.b64encode(buf.getvalue()).decode('ascii')))
    with open(os.path.join(OUT, key + '.js'), 'w', encoding='ascii') as fh:
        fh.write(js)
    meta['c'] = bool(textures)
    meta['prof'] = prof
    return meta, total_tris, len(js)


def main():
    os.makedirs(OUT, exist_ok=True)
    index = {}
    total = 0
    only_struct = '--structures' in sys.argv
    jobs = {k: v['mesh'] for k, v in STRUCT.items()} if only_struct else {**MAP, **{k: v['mesh'] for k, v in STRUCT.items()}}
    if only_struct:
        old = open(os.path.join(OUT, 'index.js'), encoding='utf-8').read()
        index = json.loads(old[old.index('window.SF_MODELS = ') + len('window.SF_MODELS = '):].split(';\n')[0])
    for key, rel in jobs.items():
        try:
            meta, src_tris, size = convert(key, rel)
        except Exception as e:  # keep going; the viewer falls back to a box
            print(f'  ! {key}: {e}')
            continue
        import hashlib
        digest = hashlib.md5(open(os.path.join(OUT, key + '.js'), 'rb').read()).hexdigest()[:10]
        index[key] = {'b': meta['b'], 'kb': round(size / 1024), 'h': digest}
        if meta.get('prof'):
            index[key]['p'] = meta['prof']
        total += size
        print(f'{key:46s} {src_tris:7d} -> {meta["i"] // 3:6d} tris  {size / 1024:7.0f} KB  {"painted" if meta["c"] else "-"}')
    with open(os.path.join(OUT, 'index.js'), 'w', encoding='utf-8') as fh:
        fh.write('// Generated by tools/convert_models.py. Do not edit.\nwindow.SF_MODELS = ')
        json.dump(index, fh, separators=(',', ':'))
        fh.write(';\n')
        # structures: planner structure id -> [model key, colour tint]
        fh.write('window.SF_STRUCT = ')
        json.dump({k: v for k, v in STRUCT_USE.items() if v[0] in index}, fh, separators=(',', ':'))
        fh.write(';\n')
    # what the website gets: bounds and belt-height profiles only (no meshes), plus the structure mapping
    with open(os.path.join(os.path.dirname(OUT), 'web', 'model_meta.js'), 'w', encoding='utf-8') as fh:
        fh.write('// Generated by tools/convert_models.py. Do not edit.\n// Model bounds and belt-height side profiles (numbers only, no meshes): the planner uses them to line belt\n'
                 '// ports up with the buildings. SF_STRUCT: structure id -> [cube model key, colour tint].\n')
        fh.write('window.SF_MODELS = ' + json.dumps({k: {kk: v[kk] for kk in ('b', 'p') if kk in v} for k, v in index.items()}, separators=(',', ':')) + ';\n')
        fh.write('window.SF_STRUCT = ' + json.dumps({k: v for k, v in STRUCT_USE.items() if v[0] in index}, separators=(',', ':')) + ';\n')
    print(f'{len(index)} models, {total / 1024 / 1024:.1f} MB')


if __name__ == '__main__':
    main()
