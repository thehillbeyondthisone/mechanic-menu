"""Build a hosted copy of the menu for claude.ai Artifacts (per-file cap ~15 MB, CDN-only scripts).

usage: python make_artifact.py <out_dir>
Writes index.html (no doctype/html/head/body: the host wraps it), src/*.js, public/assets/*.
The splat is base64-encoded and split into parts that main.js joins back together (window.PATTERSON_SPLAT_PARTS).
"""
import base64
import json
import re
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VIEWER = ROOT / "viewer"
PART_BYTES = 9 * 1024 * 1024
THREE = "https://cdn.jsdelivr.net/npm/three@0.180.0"
SPARK = "https://cdn.jsdelivr.net/npm/@sparkjsdev/spark@2.3.1/dist/spark.module.js"


def main():
    out = Path(sys.argv[1])
    if out.exists():
        shutil.rmtree(out)
    (out / "src").mkdir(parents=True)
    (out / "public/assets").mkdir(parents=True)
    for js in (VIEWER / "src").glob("*.js"):
        shutil.copy2(js, out / "src" / js.name)

    assets = VIEWER / "public/assets"
    parts = {}
    for tier in ("high", "quest"):
        data = (assets / f"patterson-{tier}.spz").read_bytes()
        names = []
        for i in range(0, len(data), PART_BYTES):
            name = f"patterson-{tier}.part{i // PART_BYTES + 1}.b64.txt"
            (out / "public/assets" / name).write_bytes(base64.b64encode(data[i:i + PART_BYTES]))
            names.append(name)
        parts[tier] = names
    # the host serves text/data types only, so binaries travel as base64 text
    (out / "public/assets/depth-grid.b64.txt").write_bytes(base64.b64encode((assets / "depth-grid.bin").read_bytes()))
    for f in ("scene-high.json", "scene-quest.json"):
        scene = json.loads((assets / f).read_text())
        scene["depth_grid"]["file"] = "depth-grid.b64.txt"
        (out / "public/assets" / f).write_text(json.dumps(scene, indent=2))

    html = (VIEWER / "index.html").read_text(encoding="utf-8")
    head = re.search(r"<head>(.*?)</head>", html, re.S).group(1)
    body = re.search(r"<body>(.*?)</body>", html, re.S).group(1)
    head = re.sub(r'<meta charset="utf-8">\s*|<meta name="viewport"[^>]*>\s*', "", head)
    importmap = json.dumps({"imports": {
        "three": f"{THREE}/build/three.module.js",
        "three/addons/": f"{THREE}/examples/jsm/",
        "@sparkjsdev/spark": SPARK,
    }}, indent=2)
    head = re.sub(r'<script type="importmap">.*?</script>',
                  f'<script type="importmap">\n{importmap}\n</script>\n'
                  f'<script>window.PATTERSON_SPLAT_PARTS = {json.dumps(parts)};</script>', head, flags=re.S)
    # single dark look: say so to the host so form controls/scrollbars match
    head = head.replace(":root { --bg:", ":root { color-scheme: dark; --bg:", 1)
    (out / "index.html").write_text(head.strip() + "\n" + body.strip() + "\n", encoding="utf-8")
    files = sorted(str(p.relative_to(out)).replace("\\", "/") for p in out.rglob("*") if p.is_file())
    print(json.dumps({"files": files, "parts": parts}, indent=2))


if __name__ == "__main__":
    main()
