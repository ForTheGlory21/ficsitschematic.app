"""Extract Satisfactory game data from CommunityResources/Docs into web/data.js.

Usage: python tools/extract.py [path-to-Satisfactory-install]
"""
import io
import json
import math
import os
import re
import sys
import colorsys
import hashlib

GAME = sys.argv[1] if len(sys.argv) > 1 else r"D:\SteamLibrary\steamapps\common\Satisfactory"
DOCS = os.path.join(GAME, "CommunityResources", "Docs", "en-US.json")
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "web", "data.js")


# ---------------------------------------------------------------- UE text parser
def parse_ue(s):
    """Parse Unreal exported struct text like (A=1,B=(X=2),C="x") into python objects."""
    pos = 0

    def ws():
        nonlocal pos
        while pos < len(s) and s[pos] in " \r\n\t":
            pos += 1

    def value():
        nonlocal pos
        ws()
        if pos >= len(s):
            return ""
        c = s[pos]
        if c == "(":
            pos += 1
            items = []
            keyed = True
            while True:
                ws()
                if pos < len(s) and s[pos] == ")":
                    pos += 1
                    break
                # try key=
                m = re.match(r"([A-Za-z_][A-Za-z0-9_]*)\s*=", s[pos:])
                if m and not s[pos:].startswith('"'):
                    pos += m.end()
                    items.append((m.group(1), value()))
                else:
                    keyed = False
                    items.append((None, value()))
                ws()
                if pos < len(s) and s[pos] == ",":
                    pos += 1
            if items and keyed:
                return {k: v for k, v in items}
            return [v for _, v in items]
        if c == '"':
            end = s.index('"', pos + 1)
            v = s[pos + 1:end]
            pos = end + 1
            return v
        start = pos
        depth = 0
        while pos < len(s):
            ch = s[pos]
            if ch == "(":
                depth += 1
            elif ch == ")":
                if depth == 0:
                    break
                depth -= 1
            elif ch == "," and depth == 0:
                break
            elif ch == '"':
                pos = s.index('"', pos + 1)
            pos += 1
        return s[start:pos].strip()

    if not s:
        return []
    return value()


def cls_of(path):
    """'/Game/.../Desc_IronPlate.Desc_IronPlate_C' -> 'Desc_IronPlate_C'"""
    m = re.search(r"\.([A-Za-z0-9_]+)'?\"?$", path.strip().strip("'\""))
    if m:
        return m.group(1)
    return path.split(".")[-1].strip("'\"")


def f(v, d=0.0):
    try:
        return float(v)
    except (TypeError, ValueError):
        return d


def clean_name(n):
    return (n or "").replace("\u202f", " ").replace("\u00a0", " ").strip()


# ---------------------------------------------------------------- load
data = json.load(io.open(DOCS, encoding="utf-16"))
G = {}
for g in data:
    native = g["NativeClass"].split(".")[-1].rstrip("'")
    G.setdefault(native, []).extend(g["Classes"])
BY_CLASS = {}
for native, classes in G.items():
    for c in classes:
        c["_native"] = native
        BY_CLASS[c["ClassName"]] = c


# ---------------------------------------------------------------- footprint
def footprint(c):
    """Return (w, h, cx, cy) in metres in *screen* orientation:
    screen x = UE Y (flow direction), screen y = UE X."""
    raw = c.get("mClearanceData", "")
    boxes = parse_ue(raw) if raw else []
    if isinstance(boxes, dict):
        boxes = [boxes]
    hard, soft = [], []
    for b in boxes:
        if not isinstance(b, dict) or "ClearanceBox" not in b:
            continue
        box = b["ClearanceBox"]
        if str(box.get("IsValid", "True")) != "True":
            continue
        mn, mx = box["Min"], box["Max"]
        rt = b.get("RelativeTransform", {}) or {}
        tr = rt.get("Translation", {}) or {}
        rot = rt.get("Rotation", {}) or {}
        tx, ty = f(tr.get("X")), f(tr.get("Y"))
        qz, qw = f(rot.get("Z")), f(rot.get("W"), 1.0)
        yaw = 2 * math.atan2(qz, qw) if (qz or qw) else 0.0
        # rotations about other axes are ignored (rare and not relevant top-down)
        corners = []
        for x in (f(mn["X"]), f(mx["X"])):
            for y in (f(mn["Y"]), f(mx["Y"])):
                rx = x * math.cos(yaw) - y * math.sin(yaw)
                ry = x * math.sin(yaw) + y * math.cos(yaw)
                corners.append((rx + tx, ry + ty))
        tz = f(tr.get("Z"))
        rect = (min(p[0] for p in corners), min(p[1] for p in corners),
                max(p[0] for p in corners), max(p[1] for p in corners), f(mx.get("Z")) + tz)
        if b.get("ExcludeForSnapping") == "True" and False:
            continue
        (soft if b.get("Type") == "CT_Soft" else hard).append(rect)
    use = hard or soft
    if not use:
        return None
    x0 = min(r[0] for r in use); y0 = min(r[1] for r in use)
    x1 = max(r[2] for r in use); y1 = max(r[3] for r in use)
    # screen x <- UE Y, screen y <- UE X ; centimetres -> metres, rounded to 0.5 m
    w = round((y1 - y0) / 50) / 2
    h = round((x1 - x0) / 50) / 2
    top = max(r[4] for r in use) / 100   # metres above the building's origin
    # footprint centre relative to the building pivot, in planner coords (x = UE Y, y = -UE X)
    ox = round((y0 + y1) / 200, 2)
    oy = round(-(x0 + x1) / 200, 2)
    return max(w, 0.5), max(h, 0.5), round(max(top, 1.0), 1), ox, oy


# ---------------------------------------------------------------- items
ITEM_NATIVES = ["FGResourceDescriptor", "FGItemDescriptor", "FGItemDescriptorBiomass",
                "FGItemDescriptorNuclearFuel", "FGAmmoTypeProjectile", "FGAmmoTypeSpreadshot",
                "FGAmmoTypeInstantHit", "FGEquipmentDescriptor", "FGConsumableDescriptor",
                "FGPowerShardDescriptor", "FGItemDescriptorPowerBoosterFuel"]

PALETTE = [  # keyword -> hex colour for solids (first match wins)
    ("ficsonium", "#c5287f"), ("ficsite", "#e7b33b"), ("time crystal", "#d877ff"),
    ("dark matter", "#7b3fcf"), ("singularity", "#3d1d63"), ("sam", "#a050e0"),
    ("reanimated", "#a050e0"), ("diamond", "#bfefff"), ("plutonium", "#38d26e"),
    ("uranium", "#7cd23a"), ("nuclear", "#7cd23a"), ("encased uranium", "#7cd23a"),
    ("copper", "#e0823a"), ("wire", "#e8a03c"), ("cable", "#d77b3a"),
    ("caterium", "#e8c43b"), ("quickwire", "#f2d24d"), ("iron", "#9fb0bf"),
    ("screw", "#b9c4ce"), ("reinforced", "#8a9aa8"), ("rotor", "#8fa3b5"),
    ("steel", "#6f7f8f"), ("encased", "#8d8f86"), ("coal", "#3a3a3a"),
    ("compacted", "#2e2e2e"), ("limestone", "#d8cfb4"), ("concrete", "#c9c3b0"),
    ("quartz", "#e9a3c6"), ("crystal", "#f0b9d8"), ("silica", "#ead6e8"),
    ("sulfur", "#e2e03a"), ("bauxite", "#c7623d"), ("alumin", "#c6d0d9"),
    ("plastic", "#5bb6e8"), ("rubber", "#555c66"), ("polymer", "#4a6c84"),
    ("petroleum", "#2a2a35"), ("circuit", "#3fa66b"), ("computer", "#2e8a5a"),
    ("motor", "#c75d38"), ("stator", "#b8763c"), ("battery", "#58c4d8"),
    ("biomass", "#6fa14a"), ("leaves", "#6ca83e"), ("wood", "#8a6a3e"),
    ("mycelia", "#a9946b"), ("fabric", "#b4c97c"), ("solid biofuel", "#4f7a32"),
    ("filter", "#9aa36b"), ("gas", "#8fa18f"), ("fuel", "#e07d15"), ("frame", "#7c94a8"),
    ("heat sink", "#c4cfd8"), ("cooling", "#69c6e8"), ("turbo", "#d42e29"),
    ("supercomputer", "#2b6e8c"), ("radio", "#7caac2"), ("pressure", "#5f6f80"),
    ("ammo", "#c8a34d"), ("rebar", "#9b8a6e"), ("nobelisk", "#b0a64c"),
    ("power shard", "#d0e94f"), ("slug", "#c4e85a"), ("somersloop", "#b53fa0"),
    ("hard drive", "#7a8a99"), ("mercer", "#b07a47"), ("packaged", "#c8b18a"),
    ("empty", "#a3a9ae"), ("sink", "#e48a2b"), ("smart plating", "#a37de8"),
    ("versatile", "#7f9cd0"), ("automated", "#d29a52"), ("modular", "#9db7d4"),
    ("adaptive", "#83c06f"), ("assembly director", "#d36ae0"), ("magnetic", "#e0565a"),
    ("thermal", "#e85e2e"), ("nuclear pasta", "#e8d36a"), ("ai limiter", "#5cc7a8"),
    ("high-speed", "#4ea0e0"), ("crystal oscillator", "#f0b9d8"), ("electromagnetic", "#6f8de8"),
]


def item_color(name, cls):
    n = name.lower()
    for k, col in PALETTE:
        if k in n:
            return col
    h = int(hashlib.md5(cls.encode()).hexdigest()[:6], 16)
    r, g, b = colorsys.hls_to_rgb((h % 360) / 360, 0.6, 0.45)
    return "#%02x%02x%02x" % (int(r * 255), int(g * 255), int(b * 255))


def parse_rgba(s):
    d = parse_ue(s) if s else {}
    if not isinstance(d, dict):
        return None
    return "#%02x%02x%02x" % (int(d.get("R", 255)), int(d.get("G", 255)), int(d.get("B", 255)))


items = {}
for native in ITEM_NATIVES:
    for c in G.get(native, []):
        name = clean_name(c.get("mDisplayName"))
        if not name:
            continue
        form = c.get("mForm", "RF_SOLID")
        fluid = form in ("RF_LIQUID", "RF_GAS")
        col = parse_rgba(c.get("mFluidColor")) if fluid else item_color(name, c["ClassName"])
        if form == "RF_GAS":
            gc = parse_rgba(c.get("mGasColor"))
            if gc and gc != "#ffffff":
                col = gc
        items[c["ClassName"]] = {
            "name": name,
            "fluid": fluid,
            "gas": form == "RF_GAS",
            "color": col,
            "energy": f(c.get("mEnergyValue")) * (1000 if fluid else 1),  # MJ per item / per m3
            "sink": int(f(c.get("mResourceSinkPoints"))),
            "stack": int(f(c.get("mCachedStackSize"), 100)),
            "raw": native == "FGResourceDescriptor",
        }

# ---------------------------------------------------------------- recipes
def parse_amounts(s):
    out = []
    for m in re.finditer(r"ItemClass=\"[^\"]*?\.([A-Za-z0-9_]+)'\",Amount=(\d+)", s or ""):
        cls, amt = m.group(1), int(m.group(2))
        it = items.get(cls)
        if it and it["fluid"]:
            amt = amt / 1000
        out.append([cls, amt])
    return out


MACHINE_NATIVES = {"FGBuildableManufacturer", "FGBuildableManufacturerVariablePower"}
machine_classes = {c["ClassName"] for n in MACHINE_NATIVES for c in G.get(n, [])}

recipes = {}
build_costs = {}
build_recipe = {}          # recipe class -> building class it builds (build gun recipes)
for c in G["FGRecipe"]:
    produced = [cls_of(p) for p in re.findall(r"\"([^\"]+)\"", c.get("mProducedIn", ""))]
    ing = parse_amounts(c.get("mIngredients"))
    prod = parse_amounts(c.get("mProduct"))
    machines = [p for p in produced if p in machine_classes]
    if "BP_BuildGun_C" in produced or any("BuildGun" in p for p in produced):
        for pcls, _ in prod:
            if pcls.startswith("Desc_"):
                build_costs["Build_" + pcls[5:]] = ing
                build_recipe[c["ClassName"]] = "Build_" + pcls[5:]
        continue
    if not machines or not prod:
        continue
    name = clean_name(c.get("mDisplayName"))
    recipes[c["ClassName"]] = {
        "name": name,
        "alt": c["ClassName"].startswith("Recipe_Alternate") or name.startswith("Alternate"),
        "time": f(c.get("mManufactoringDuration")),
        "in": ing,
        "out": prod,
        "machine": machines[0],
        "pc": f(c.get("mVariablePowerConsumptionConstant")),
        "pf": f(c.get("mVariablePowerConsumptionFactor"), 1.0),
        "event": bool(c.get("mRelevantEvents")) or "Xmas" in c["ClassName"] or "Ficsmas" in c["ClassName"],
    }

# items that are actually used somewhere
used_items = set()
for r in recipes.values():
    for cls, _ in r["in"] + r["out"]:
        used_items.add(cls)

# ---------------------------------------------------------------- buildings
buildings = {}


def add_building(c, cat, kind, **extra):
    fp = footprint(c)
    b = {
        "name": clean_name(c.get("mDisplayName")),
        "cat": cat,
        "kind": kind,
        "w": fp[0] if fp else 4,
        "h": fp[1] if fp else 4,
        "z": fp[2] if fp else 4,
        "ox": fp[3] if fp else 0,
        "oy": fp[4] if fp else 0,
        "power": f(c.get("mPowerConsumption")),
        "powerExp": f(c.get("mPowerConsumptionExponent"), 1.321929),
        "canOC": c.get("mCanChangePotential") == "True",
        "sloops": int(f(c.get("mProductionShardSlotSize"))) if c.get("mCanChangeProductionBoost") == "True" else 0,
        "cost": build_costs.get(c["ClassName"], []),
    }
    b.update(extra)
    buildings[c["ClassName"]] = b
    return b


# manufacturers: port counts from their recipes
for native in ["FGBuildableManufacturer", "FGBuildableManufacturerVariablePower"]:
    for c in G.get(native, []):
        rs = [r for r in recipes.values() if r["machine"] == c["ClassName"]]
        def cnt(lst, fluid):
            return sum(1 for cls, _ in lst if items.get(cls, {}).get("fluid") == fluid)
        ports = {
            "inS": max([cnt(r["in"], False) for r in rs] or [0]),
            "inF": max([cnt(r["in"], True) for r in rs] or [0]),
            "outS": max([cnt(r["out"], False) for r in rs] or [0]),
            "outF": max([cnt(r["out"], True) for r in rs] or [0]),
        }
        b = add_building(c, "Production", "machine", ports=ports)
        if native == "FGBuildableManufacturerVariablePower":
            b["variablePower"] = True
            b["powerMin"] = f(c.get("mEstimatedMininumPowerConsumption"))
            b["powerMax"] = f(c.get("mEstimatedMaximumPowerConsumption"))

# extractors
for c in G.get("FGBuildableResourceExtractor", []) + G.get("FGBuildableWaterPump", []) + G.get("FGBuildableFrackingExtractor", []):
    forms = c.get("mAllowedResourceForms", "")
    allowed = [cls_of(p) for p in re.findall(r"'([^']+)'", c.get("mAllowedResources", ""))]
    fluid = "RF_SOLID" not in forms
    if c["_native"] == "FGBuildableWaterPump":
        allowed = ["Desc_Water_C"]
    if c["_native"] == "FGBuildableFrackingExtractor":
        allowed = allowed or ["Desc_Water_C", "Desc_LiquidOil_C", "Desc_NitrogenGas_C"]
    if not allowed:
        allowed = [k for k, it in items.items() if it["raw"] and not it["fluid"] and k in used_items]
    rate = f(c.get("mItemsPerCycle"), 1) / max(f(c.get("mExtractCycleTime"), 1), 1e-6) * 60  # per minute
    if fluid:
        rate /= 1000
    add_building(c, "Extraction", "extractor", rate=rate, resources=allowed, fluidOut=fluid,
                 purity=c["_native"] != "FGBuildableWaterPump")

# resource well pressurizer: no item ports, but a big constant power draw that powers its wells
for c in G.get("FGBuildableFrackingActivator", []):
    add_building(c, "Extraction", "pressurizer")

# generators
for c in G.get("FGBuildableGeneratorFuel", []) + G.get("FGBuildableGeneratorNuclear", []):
    fuels = []
    for fu in c.get("mFuel", []) or []:
        fuels.append({
            "fuel": fu.get("mFuelClass"),
            "supp": fu.get("mSupplementalResourceClass") or None,
            "by": fu.get("mByproduct") or None,
            "byAmt": f(fu.get("mByproductAmount")),
        })
    fuels = [x for x in fuels if x["fuel"] in items]
    add_building(c, "Power", "generator", produce=f(c.get("mPowerProduction")), fuels=fuels,
                 suppRatio=f(c.get("mSupplementalToPowerRatio")))
for c in G.get("FGBuildableGeneratorGeoThermal", []):
    add_building(c, "Power", "generator", produce=200, fuels=[], suppRatio=0, geo=True)
for c in G.get("FGBuildablePowerStorage", []):
    add_building(c, "Power", "deco")

# logistics nodes
for c in G.get("FGBuildableAttachmentSplitter", []):
    add_building(c, "Logistics", "splitter")
for c in G.get("FGBuildableSplitterSmart", []):
    add_building(c, "Logistics", "splitter", smart=True)
for c in G.get("FGBuildableAttachmentMerger", []):
    add_building(c, "Logistics", "merger")
for c in G.get("FGBuildableMergerPriority", []):
    add_building(c, "Logistics", "merger", priority=True)
for c in G.get("FGBuildablePipelineJunction", []):
    add_building(c, "Logistics", "junction", ports=4 if "Cross" in c["ClassName"] else 3)
for c in G.get("FGBuildablePipelinePump", []):
    add_building(c, "Logistics", "pump", headLift=f(c.get("mDesignPressure")), headMax=f(c.get("mMaxPressure")))

# storage
for c in G.get("FGBuildableStorage", []):
    if c["ClassName"] in ("Build_StorageContainerMk1_C", "Build_StorageContainerMk2_C"):
        n = 2 if "Mk2" in c["ClassName"] else 1
        add_building(c, "Storage", "storage", slots=int(f(c.get("mInventorySizeX")) * f(c.get("mInventorySizeY"))),
                     ports={"inS": n, "outS": n})
for c in G.get("FGBuildablePipeReservoir", []):
    add_building(c, "Storage", "storage", fluidStorage=True,
                 capacity=f(c.get("mStorageCapacity"), 400) / (1000 if f(c.get("mStorageCapacity")) > 5000 else 1),
                 ports={"inF": 1, "outF": 1})
for c in G.get("FGCentralStorageContainer", []):
    add_building(c, "Storage", "sink", upload=True)
for c in G.get("FGBuildableResourceSink", []):
    add_building(c, "Storage", "sink", awesome=True)
for c in G.get("FGBuildableSpaceElevator", []):
    add_building(c, "Storage", "sink")

# blueprint designers (no clearance data; sizes are fixed in game)
BP_SIZES = {"Build_BlueprintDesigner_C": 32, "Build_BlueprintDesigner_MK2_C": 40, "Build_BlueprintDesigner_Mk3_C": 48}
for c in G.get("FGBuildableBlueprintDesigner", []):
    s = BP_SIZES.get(c["ClassName"], 32)
    b = add_building(c, "Structures", "designer")
    b["w"] = b["h"] = s

# belts / lifts / pipes
belts = []
for c in G.get("FGBuildableConveyorBelt", []):
    speed = f(c.get("mSpeed"))
    belts.append({"id": c["ClassName"], "name": clean_name(c["mDisplayName"]), "rate": speed / 2,
                  "speed": speed / 100, "tier": int(re.search(r"Mk(\d)", c["ClassName"]).group(1)),
                  "cost": build_costs.get(c["ClassName"], [])})
belts.sort(key=lambda b: b["tier"])
pipes = []
for c in G.get("FGBuildablePipeline", []):
    if "NoIndicator" in c["ClassName"]:
        continue
    pipes.append({"id": c["ClassName"], "name": clean_name(c["mDisplayName"]),
                  "rate": f(c.get("mFlowLimit")) * 60, "tier": 2 if "MK2" in c["ClassName"].upper() else 1,
                  "cost": build_costs.get(c["ClassName"], [])})
pipes.sort(key=lambda p: p["tier"])

# structures: foundations / floors / ramps / walls
MATS = [("Asphalt", "#3b3f45"), ("Polished", "#b8b4ad"), ("Concrete", "#9a958a"),
        ("Metal", "#5c6670"), ("Grip", "#5c6670"), ("Frame", "#4a5560"), ("Glass", "#6aa7c4"),
        ("Orange", "#c47a2c"), ("Tar", "#2d2f33")]


def mat_of(cls):
    for k, col in MATS:
        if k.lower() in cls.lower():
            return k if k != "Grip" else "Metal", col
    return "FICSIT", "#7d6b52"


structures = []
for c in G.get("FGBuildableFoundationLightweight", []) + G.get("FGBuildableRampLightweight", []) + G.get("FGBuildableWallLightweight", []):
    name = clean_name(c.get("mDisplayName"))
    w, d, hgt = f(c.get("mWidth")) / 100, f(c.get("mDepth")) / 100, f(c.get("mHeight")) / 100
    if not w:
        continue
    native = c["_native"]
    if native == "FGBuildableWallLightweight":
        if not any(k in name for k in ("Basic Wall", "Conveyor Wall", "Frame Window", "Gate Hole", "Railing", "Barrier", "Fence")):
            continue
        kind, d = "wall", max(f(c.get("mElementSize")) / 100 if c.get("mElementSize") else 0, 0.5)
        d = 0.5
    elif native == "FGBuildableRampLightweight":
        if not (name.startswith("Ramp") or name.startswith("Double Ramp") or name.startswith("Inverted Ramp") or name.startswith("Foundation Stairs")):
            continue
        kind = "ramp"
        d = d or w
    else:
        if any(k in name for k in ("Quarter Pipe", "Corner", "Extension")):
            continue
        kind = "foundation"
        d = d or w
    mat, col = mat_of(c["ClassName"])
    if name.startswith("Half Foundation"):
        d = w / 2 if d == w else d
    structures.append({"id": c["ClassName"], "name": name, "mat": mat, "color": col, "kind": kind,
                       "w": w, "h": d, "z": hgt, "cost": build_costs.get(c["ClassName"], [])})
seen = set()
structures = [s for s in structures if not ((s["name"], s["mat"]) in seen or seen.add((s["name"], s["mat"])))]
structures.sort(key=lambda s: (s["kind"], s["mat"], s["name"]))

# footprints where clearance boxes are misleading top-down (sizes per in-game measurements)
OVERRIDES = {"Build_HadronCollider_C": (38, 24), "Build_SpaceElevator_C": (54, 54),
             "Build_QuantumEncoder_C": (48, 22), "Build_ConveyorAttachmentSplitter_C": (2, 2)}
for k, (w, h) in OVERRIDES.items():
    if k in buildings and k != "Build_ConveyorAttachmentSplitter_C":
        buildings[k]["w"], buildings[k]["h"] = w, h

# restrict items to relevant ones
for b in buildings.values():
    for fu in b.get("fuels", []):
        for k in ("fuel", "supp", "by"):
            if fu.get(k):
                used_items.add(fu[k])
    for r in b.get("resources", []):
        used_items.add(r)
for coll in [b["cost"] for b in buildings.values()] + [s["cost"] for s in structures] + [b["cost"] for b in belts + pipes]:
    for cls, _ in coll:
        used_items.add(cls)
items = {k: v for k, v in items.items() if k in used_items}

# ---------------------------------------------------------------- progression: which schematic unlocks what
# Milestones (HUB tiers), MAM research, alternate recipes (hard drives) and the AWESOME Shop. Recipes and buildings
# get "unlock": [schematic ids]; anything with no schematic is available from the start.
STYPE = {"EST_Milestone": "milestone", "EST_MAM": "mam", "EST_Alternate": "alt", "EST_ResourceSink": "shop",
         "EST_Tutorial": "start", "EST_Custom": "start", "EST_HardDrive": "alt"}
link_ids = {b["id"]: b for b in belts + pipes}
schematics = {}
unlocks = {}               # recipe class -> [schematic ids]
for c in G.get("FGSchematic", []):
    t = STYPE.get(c.get("mType"))
    if not t:
        continue
    got = []
    for u in c.get("mUnlocks", []) or []:
        for p in re.findall(r"\"([^\"]+)\"", u.get("mRecipes", "") or ""):
            got.append(cls_of(p))
    rel = [r for r in got if r in recipes or build_recipe.get(r) in buildings or build_recipe.get(r) in link_ids]
    if not rel:
        continue
    sid = c["ClassName"]
    deps = []
    for d in c.get("mSchematicDependencies", []) or []:
        deps += [cls_of(p) for p in re.findall(r"\"([^\"]+)\"", d.get("mSchematics", "") or "")]
    tier = int(f(c.get("mTechTier")))
    if t == "start" and tier > 0:
        t = "milestone"        # granted along with that tier (e.g. Bauxite Refinement 2)
    if clean_name(c.get("mDisplayName")).startswith("Alternate"):
        t = "alt"              # alternates granted by other means still count as found alternates
    schematics[sid] = {"name": clean_name(c.get("mDisplayName")), "type": t, "tier": tier, "deps": deps}
    for r in rel:
        unlocks.setdefault(r, []).append(sid)
for rid, r in recipes.items():
    if rid in unlocks:
        r["unlock"] = unlocks[rid]
for rid, bid in build_recipe.items():
    if rid in unlocks and bid in buildings:
        buildings[bid].setdefault("unlock", [])
        buildings[bid]["unlock"] += [x for x in unlocks[rid] if x not in buildings[bid]["unlock"]]
for rid, bid in build_recipe.items():
    if rid in unlocks and bid in link_ids:
        link_ids[bid]["unlock"] = unlocks[rid]
for sid, sc in schematics.items():
    sc["deps"] = [d for d in sc["deps"] if d in schematics]

out = {
    "version": os.path.getmtime(DOCS),
    "schematics": schematics,
    "items": items,
    "recipes": recipes,
    "buildings": buildings,
    "belts": belts,
    "pipes": pipes,
    "structures": structures,
}
os.makedirs(os.path.dirname(OUT), exist_ok=True)
with io.open(OUT, "w", encoding="utf-8") as fh:
    fh.write("// Generated by tools/extract.py from the Satisfactory install. Do not edit.\n")
    fh.write("window.SF_DATA = ")
    json.dump(out, fh, ensure_ascii=False, separators=(",", ":"))
    fh.write(";\n")
print(f"items={len(items)} recipes={len(recipes)} buildings={len(buildings)} belts={len(belts)} "
      f"pipes={len(pipes)} structures={len(structures)} -> {os.path.normpath(OUT)} ({os.path.getsize(OUT)//1024} KB)")
