"""Build the static GitHub Pages copy of the menu (gh-pages branch).

usage: python make_site.py <out_dir>
Same app as viewer/, with three.js and Spark loaded from a pinned CDN instead of node_modules.
"""
import json
import re
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VIEWER = ROOT / "viewer"
THREE = "https://cdn.jsdelivr.net/npm/three@0.180.0"
SPARK = "https://cdn.jsdelivr.net/npm/@sparkjsdev/spark@2.3.1/dist/spark.module.js"
ASSETS = ["patterson-high.spz", "patterson-quest.spz", "scene-high.json", "scene-quest.json", "depth-grid.bin"]


def main():
    out = Path(sys.argv[1])
    out.mkdir(parents=True, exist_ok=True)
    shutil.copytree(VIEWER / "src", out / "src", dirs_exist_ok=True)
    (out / "public/assets").mkdir(parents=True, exist_ok=True)
    for name in ASSETS:
        shutil.copy2(VIEWER / "public/assets" / name, out / "public/assets" / name)
    importmap = json.dumps({"imports": {
        "three": f"{THREE}/build/three.module.js",
        "three/addons/": f"{THREE}/examples/jsm/",
        "@sparkjsdev/spark": SPARK,
    }}, indent=2)
    html = (VIEWER / "index.html").read_text(encoding="utf-8")
    html = re.sub(r'<script type="importmap">.*?</script>', f'<script type="importmap">\n{importmap}\n</script>', html, flags=re.S)
    (out / "index.html").write_text(html, encoding="utf-8")
    (out / ".nojekyll").write_text("")
    print("site written to", out)


if __name__ == "__main__":
    main()
