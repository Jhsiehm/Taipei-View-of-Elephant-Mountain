"""Bundle everything into two self-contained, offline HTML pages.

Usage (from the repo root):  python3 tools/build.py
Writes index.html (full-screen immersive view) and studio.html (view with the full control panel).
"""
import base64, glob, json, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
A = os.path.join(ROOT, "assets")


def uri(path):
    with open(path, "rb") as f:
        return "data:image/png;base64," + base64.b64encode(f.read()).decode()


assets = {
    "illustrated": uri(os.path.join(A, "source", "illustrated_base.png")),
    "faithful": uri(os.path.join(A, "source", "reference_pixel_base.png")),
}
for mode in ("illustrated", "faithful"):
    assets["cls_" + mode] = uri(os.path.join(A, "generated", f"cls_{mode}.png"))
    assets["plate_" + mode] = uri(os.path.join(A, "generated", f"plate_{mode}.png"))
assets["falling"] = [uri(p) for p in sorted(glob.glob(os.path.join(A, "generated", "falling", "*.png")))]

assets_js = "window.TAIPEI_ASSETS=" + json.dumps(assets) + ";"
with open(os.path.join(ROOT, "src", "taipei-engine.js")) as f:
    engine_js = f.read()

for shell, out in (("immersive.html", "index.html"), ("studio.html", "studio.html")):
    with open(os.path.join(ROOT, "src", shell)) as f:
        html = f.read()
    html = html.replace("<script>/*ASSETS*/</script>", "<script>" + assets_js + "</script>")
    html = html.replace("<script>/*ENGINE*/</script>", "<script>" + engine_js + "</script>")
    with open(os.path.join(ROOT, out), "w") as f:
        f.write(html)
    print(f"wrote {out} ({os.path.getsize(os.path.join(ROOT, out)) / 1e6:.1f} MB)")
