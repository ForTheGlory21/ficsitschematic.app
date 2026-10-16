"""Download item / building icons from the Satisfactory community wiki (satisfactory.wiki.gg).

Reads web/data.js, resolves an icon file on the wiki for every item, building, belt,
pipe and structure, downloads a 128px thumbnail into web/img/, and writes web/icons.js.

Usage: python tools/scrape_icons.py [--force]
"""
import io
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "web")
API = "https://satisfactory.wiki.gg/api.php"
UA = {"User-Agent": "SFSchematicPlanner/1.0 (personal fan tool; icon cache)"}
THUMB = 128
FORCE = "--force" in sys.argv

with io.open(os.path.join(ROOT, "data.js"), encoding="utf-8") as fh:
    src = fh.read()
D = json.loads(src[src.index("{"):src.rstrip().rstrip(";").rindex("}") + 1])


def get_json(params):
    url = API + "?" + urllib.parse.urlencode({**params, "format": "json"})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=30) as r:
                return json.loads(r.read().decode("utf-8"))
        except Exception as e:  # network hiccup / rate limit
            print("  retry", attempt + 1, e)
            time.sleep(2 + attempt * 3)
    raise RuntimeError("API failed: " + url)


# ------------------------------------------------------------ what we want icons for
wanted = {}  # key -> list of candidate wiki file base names (without .png)


def variants(name):
    n = name.replace(" ", " ").replace(" ", " ").strip()
    out = [n]
    out.append(re.sub(r"^Alternate: ", "", n))
    out.append(n.replace(" Mk.", " Mk"))
    out.append(re.sub(r"\s*\(.*?\)", "", n))
    out.append(n.replace("FICSIT ", ""))
    out.append(n.title())
    seen, res = set(), []
    for v in out:
        if v and v not in seen:
            seen.add(v); res.append(v)
    return res


for cls, it in D["items"].items():
    wanted[cls] = variants(it["name"])
for cls, b in D["buildings"].items():
    wanted[cls] = variants(b["name"])
for b in D["belts"] + D["pipes"]:
    wanted[b["id"]] = variants(b["name"])

# structures: the wiki names icons like "Concrete Foundation (4 m)" / "Foundation (4 m)"
MAT_WIKI = {"FICSIT": "", "Concrete": "Concrete ", "Polished": "Polished Concrete ", "Asphalt": "Asphalt ",
            "Metal": "Grip Metal ", "Frame": "", "Glass": ""}
for s in D["structures"]:
    base = s["name"].replace(" ", " ")
    pre = MAT_WIKI.get(s["mat"], "")
    cands = [pre + base, base, pre + re.sub(r"\s*\(.*?\)", "", base), re.sub(r"\s*\(.*?\)", "", base)]
    if s["mat"] == "FICSIT":
        cands.insert(0, "FICSIT " + base)
    # wiki convention: "Foundation 1m (Concrete)", polished = "Coated", metal = "Grip Metal"
    wmat = {"FICSIT": "FICSIT", "Concrete": "Concrete", "Polished": "Coated", "Asphalt": "Asphalt",
            "Metal": "Grip Metal"}.get(s["mat"])
    if wmat:
        sized = re.sub(r"\((\d+) m\)", r"\1m", base).strip()
        cands = [f"{sized} ({wmat})", f"{sized} (FICSIT)"] + cands
    wanted[s["id"]] = list(dict.fromkeys(cands))

# a few known renames on the wiki
MANUAL = {
    "Desc_LiquidOil_C": ["Crude Oil"], "Desc_Water_C": ["Water"],
    "Build_PipelineJunction_Cross_C": ["Pipeline Junction Cross", "Pipeline Junction"],
    "Build_GeneratorBiomass_Automated_C": ["Biomass Burner"],
    "Build_ConveyorAttachmentMergerPriority_C": ["Priority Merger"],
    "Build_CentralStorage_C": ["Dimensional Depot Uploader"],
    "Build_FrackingExtractor_C": ["Resource Well Extractor"],
    "Build_WaterPump_C": ["Water Extractor"],
    "Build_StorageContainerMk2_C": ["Industrial Storage Container"],
    "Build_PipeStorageTank_C": ["Fluid Buffer"], "Build_IndustrialTank_C": ["Industrial Fluid Buffer"],
    "Build_BlueprintDesigner_C": ["Blueprint Designer Mk.1", "Blueprint Designer"],
}
for k, v in MANUAL.items():
    if k in wanted:
        wanted[k] = v + wanted[k]

# ------------------------------------------------------------ resolve file URLs in batches
def resolve(titles):
    """titles: list of file base names -> {base: thumburl}"""
    found = {}
    for i in range(0, len(titles), 50):
        batch = titles[i:i + 50]
        q = get_json({"action": "query", "prop": "imageinfo", "iiprop": "url", "iiurlwidth": THUMB,
                      "redirects": 1, "titles": "|".join("File:" + t + ".png" for t in batch)})
        norm = {n["to"]: n["from"] for n in q.get("query", {}).get("normalized", [])}
        redir = {r["to"]: r["from"] for r in q.get("query", {}).get("redirects", [])}
        for p in q.get("query", {}).get("pages", {}).values():
            if "imageinfo" not in p:
                continue
            t = p["title"]
            t = redir.get(t, t)
            t = norm.get(t, t)
            base = t[5:-4] if t.startswith("File:") else t
            info = p["imageinfo"][0]
            found[base] = info.get("thumburl") or info["url"]
        time.sleep(0.4)
    return found


resolved = {}
pending = dict(wanted)
for rnd in range(6):
    titles = sorted({c[rnd] for c in pending.values() if len(c) > rnd})
    if not titles:
        break
    print(f"round {rnd + 1}: querying {len(titles)} names")
    hits = resolve(titles)
    for key, cands in list(pending.items()):
        if len(cands) > rnd and cands[rnd] in hits:
            resolved[key] = hits[cands[rnd]]
            del pending[key]

# fallback: wiki full-text search in the File namespace for anything still missing
for key, cands in list(pending.items()):
    q = get_json({"action": "query", "list": "search", "srnamespace": 6, "srlimit": 3,
                  "srsearch": 'intitle:"' + cands[0] + '"'})
    hits = [h["title"] for h in q.get("query", {}).get("search", []) if h["title"].lower().endswith(".png")]
    if hits:
        r = resolve([hits[0][5:-4]])
        if r:
            resolved[key] = next(iter(r.values()))
            del pending[key]
    time.sleep(0.3)

print(f"resolved {len(resolved)} / {len(wanted)}; missing {len(pending)}")
if pending:
    print("missing:", ", ".join(sorted(pending)[:60]))

# the wiki only has a "?" placeholder for these; better to fall back to a drawn glyph
PLACEHOLDERS = {"Build_Converter_C"}
for k in PLACEHOLDERS:
    resolved.pop(k, None)

# ------------------------------------------------------------ download (deduplicated by URL)
img_dir = os.path.join(ROOT, "img")
os.makedirs(img_dir, exist_ok=True)
by_url = {}
icons = {}
for key, url in sorted(resolved.items()):
    clean = url.split("?")[0]
    if clean in by_url:
        icons[key] = by_url[clean]
        continue
    fname = re.sub(r"[^A-Za-z0-9_.-]", "_", key) + ".png"
    path = os.path.join(img_dir, fname)
    if FORCE or not os.path.exists(path):
        for attempt in range(3):
            try:
                with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=30) as r:
                    data = r.read()
                if not data.startswith(b"\x89PNG") and not data[:4] == b"RIFF" and not data[:3] == b"\xff\xd8\xff":
                    raise ValueError("not an image")
                with open(path, "wb") as fh:
                    fh.write(data)
                break
            except Exception as e:
                print("  download retry", key, e)
                time.sleep(2)
        else:
            continue
        time.sleep(0.15)
    by_url[clean] = "img/" + fname
    icons[key] = "img/" + fname

with io.open(os.path.join(ROOT, "icons.js"), "w", encoding="utf-8") as fh:
    fh.write("// Icon map generated by tools/scrape_icons.py (images from satisfactory.wiki.gg). Do not edit.\n")
    fh.write("window.SF_ICONS = ")
    json.dump(icons, fh, separators=(",", ":"), sort_keys=True)
    fh.write(";\n")
total = sum(os.path.getsize(os.path.join(img_dir, f)) for f in os.listdir(img_dir))
print(f"icons.js: {len(icons)} entries, {len(os.listdir(img_dir))} files, {total // 1024} KB")
