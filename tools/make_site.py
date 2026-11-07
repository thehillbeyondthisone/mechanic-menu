"""Build the Workshop chooser, Patterson, Splat Studio and Reality Repair.

usage: python make_site.py <out_dir>
The original Patterson app lives at mechanic/; the bundled VR gallery at studio/.
Patterson uses pinned CDN imports; Studio retains its bundled renderer libraries.
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
    # A base URL keeps Patterson's original src/public paths intact at mechanic/.
    html = html.replace('<head>', '<head>\n<base href="../">', 1)
    (out / "mechanic").mkdir(exist_ok=True)
    (out / "mechanic/index.html").write_text(html, encoding="utf-8")
    (out / "index.html").write_text((VIEWER / "menu.html").read_text(encoding="utf-8"), encoding="utf-8")
    shutil.copytree(VIEWER / "public/assets/menu", out / "public/assets/menu", dirs_exist_ok=True)
    shutil.copytree(VIEWER / "studio", out / "studio", dirs_exist_ok=True,
                    ignore=shutil.ignore_patterns("tests", "serve.py", "__pycache__", "*.pyc"))
    shutil.copytree(VIEWER / "repair", out / "repair", dirs_exist_ok=True,
                    ignore=shutil.ignore_patterns("tests", "__pycache__", "*.pyc"))
    (out / ".nojekyll").write_text("")
    print("site written to", out)


if __name__ == "__main__":
    main()
