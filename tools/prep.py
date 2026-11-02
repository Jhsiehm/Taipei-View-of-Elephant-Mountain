"""Preprocess the Taipei base paintings into the masks and clean plates the WebGL renderer needs.

Usage (from the repo root):  python3 tools/prep.py [--debug DIR]
Reads assets/source/, writes assets/generated/.

Outputs per mode:
  cls_<mode>.png  RGBA  R=foliage(moving) G=flex B=plate class*60 A=window-light threshold
  plate_<mode>.png RGBA patch: inpainted pixels (alpha 255) behind foliage edges
  debug_<mode>.png  visualisation
"""
import sys, json, numpy as np, cv2
from PIL import Image

import os, glob
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS = os.path.join(ROOT, "assets", "source")
OUT = os.path.join(ROOT, "assets", "generated")
DBG = sys.argv[sys.argv.index("--debug") + 1] if "--debug" in sys.argv else None
os.makedirs(OUT, exist_ok=True)
if DBG:
    os.makedirs(DBG, exist_ok=True)

W, H = 948, 1024
SKY, FAR, FOL, FRONT, TOWER = 0, 1, 2, 3, 4

MODES = {
    "illustrated": dict(
        src="illustrated_base.png",
        window=[(330,0),(700,0),(720,110),(760,200),(850,330),(805,470),(800,600),(770,770),
                (560,770),(400,770),(170,710),(110,580),(70,470),(180,440),(300,340),(330,250),(355,150)],
        tower=[(545,316),(551,316),(554,345),(563,370),(573,396),(576,642),(518,642),(521,396),(533,370),(542,345)],
        far=[(90,534),(330,524),(450,514),(600,504),(700,484),(805,480),(805,775),(90,775)],
        front=[
            [(585,835),(760,805),(855,636),(948,630),(948,1024),(585,1024)],   # railing, sign, lantern, path
            [(852,40),(920,0),(948,0),(948,640),(902,640),(878,400),(858,200)],  # right trunk
        ],
        center=(540,560), radii=(430,540),
        windows_ymin=536,
    ),
    "faithful": dict(
        src="reference_pixel_base.png",
        window=[(340,0),(770,0),(700,90),(625,200),(605,280),(660,330),(800,395),(700,425),
                (625,450),(595,560),(525,640),(480,755),(80,765),(55,640),(115,560),(130,470),
                (120,380),(250,340),(360,250),(420,150)],
        tower=[(461,390),(467,390),(470,420),(477,440),(479,468),(489,470),(491,722),(438,722),(439,470),(451,466),(454,440),(458,420)],
        far=[(60,612),(300,606),(600,600),(600,770),(60,770)],
        front=[
            [(838,0),(948,0),(948,1024),(912,1024),(888,700),(858,420),(842,200)],
        ],
        center=(470,560), radii=(430,540),
        windows_ymin=628,
    ),
}


def poly_mask(pts):
    m = np.zeros((H, W), np.uint8)
    cv2.fillPoly(m, [np.array(pts, np.int32)], 1)
    return m.astype(bool)


def process(name, cfg):
    rgb = np.array(Image.open(f"{ASSETS}/{cfg['src']}").convert("RGB"))
    f = rgb.astype(np.float32) / 255
    hsv = cv2.cvtColor(rgb, cv2.COLOR_RGB2HSV).astype(np.float32)
    Hh = hsv[..., 0] * 2; S = hsv[..., 1] / 255; V = hsv[..., 2] / 255

    window = poly_mask(cfg["window"])
    tower = poly_mask(cfg["tower"])
    far = poly_mask(cfg["far"])
    front_region = np.zeros((H, W), bool)
    for p in cfg["front"]:
        front_region |= poly_mask(p)

    green = (Hh >= 48) & (Hh <= 170) & ((S > 0.35) | ((V < 0.62) & (S > 0.12))) & ((V < 0.80) | (S > 0.6)) & ~((Hh < 62) & (V > 0.82))
    dark = (V < 0.22) & ~far
    fol_in_window = green | dark
    # small non-foliage clusters inside the canopy (leaf highlights) -> foliage
    nf = (~fol_in_window).astype(np.uint8)
    n, lab, stats, _ = cv2.connectedComponentsWithStats(nf, connectivity=4)
    smallc = np.isin(lab, np.where(stats[:, cv2.CC_STAT_AREA] < 60)[0]) & nf.astype(bool) & ~far
    fol_in_window |= smallc
    colour_fol = fol_in_window.copy()
    # outside the main window: only clearly sky-coloured, sizeable regions are sky
    skycol = ~green & (((Hh >= 180) & (Hh <= 270) & (V > 0.45)) | (V > 0.72)) & (S < 0.75)
    sc = skycol.astype(np.uint8)
    n2, lab2, st2, _ = cv2.connectedComponentsWithStats(sc, connectivity=4)
    bigsky = np.isin(lab2, np.where(st2[:, cv2.CC_STAT_AREA] >= 40)[0]) & skycol
    outside_fol = ~bigsky
    foliage = np.where(window, fol_in_window, outside_fol)
    # front objects: non-green pixels in front regions
    front = front_region & ~green & ~(V < 0.10)
    # dark crevices inside front region that are not green: count as front too
    front |= front_region & (V < 0.10) & ~green
    foliage &= ~front
    foliage &= ~tower
    # clean tiny specks of foliage floating in open sky (area <= 3)
    fu8 = foliage.astype(np.uint8)
    n, lab, stats, _ = cv2.connectedComponentsWithStats(fu8, connectivity=4)
    small = np.isin(lab, np.where(stats[:, cv2.CC_STAT_AREA] <= 3)[0]) & window & fu8.astype(bool)
    foliage &= ~small

    cls = np.full((H, W), SKY, np.uint8)
    cls[far] = FAR
    cls[foliage] = FOL
    cls[front] = FRONT
    cls[tower] = TOWER

    # ---------- plate: inpaint background behind foliage edges ----------
    nonfol = (~foliage).astype(np.uint8)
    dist_to_bg = cv2.distanceTransform(foliage.astype(np.uint8), cv2.DIST_L2, 5)
    band = foliage & (dist_to_bg <= 18)
    # only inpaint where foliage borders sky/far/tower (not front)
    bgish = ((cls == SKY) | (cls == FAR) | (cls == TOWER)).astype(np.uint8)
    d_bgish = cv2.distanceTransform(1 - bgish, cv2.DIST_L2, 5)
    band &= d_bgish <= 18
    inp_mask = band.astype(np.uint8) * 255
    # protect against inpainting sampling foliage colour: set foliage interior to neutral via mask
    bgr = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
    # inpaint with all foliage masked so only bg colours propagate; then keep band
    full_mask = (foliage | front).astype(np.uint8) * 255
    # limit inpainting work: mask = band, but foliage outside band would be read as source; mask it too by
    # temporarily filling far foliage with nearest bg colour via a big blur trick -> simpler: inpaint full mask on
    # a downscaled crop region around band.
    ys, xs = np.where(band)
    plate_rgba = np.zeros((H, W, 4), np.uint8)
    plate_cls = cls.copy()
    if len(ys):
        y0, y1 = max(ys.min() - 24, 0), min(ys.max() + 25, H)
        x0, x1 = max(xs.min() - 24, 0), min(xs.max() + 25, W)
        crop = bgr[y0:y1, x0:x1].copy()
        m = ((foliage | front)[y0:y1, x0:x1]).astype(np.uint8) * 255
        filled = cv2.inpaint(crop, m, 5, cv2.INPAINT_TELEA)
        filled = cv2.cvtColor(filled, cv2.COLOR_BGR2RGB)
        sub = band[y0:y1, x0:x1]
        plate_rgba[y0:y1, x0:x1][sub, :3] = filled[sub]
        plate_rgba[y0:y1, x0:x1][sub, 3] = 255
        # class of nearest background pixel for band pixels
        _, labels = cv2.distanceTransformWithLabels((1 - bgish).astype(np.uint8), cv2.DIST_L2, 5,
                                                    labelType=cv2.DIST_LABEL_PIXEL)
        idx_y, idx_x = np.where(bgish.astype(bool))
        lut = np.zeros(labels.max() + 1, np.uint8)
        lut[labels[idx_y, idx_x]] = cls[idx_y, idx_x]
        plate_cls[band] = lut[labels[band]]

    # ---------- flex field ----------
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    cx, cy = cfg["center"]; rx, ry = cfg["radii"]
    d = np.sqrt(((xx - cx) / rx) ** 2 + ((yy - cy) / ry) ** 2)
    t = np.clip((d - 0.30) / (0.85 - 0.30), 0, 1)
    depth = 0.15 + 0.85 * t * t * (3 - 2 * t)
    F = foliage.astype(np.float32)
    cf = (colour_fol | front | tower) & ~(~foliage & window)
    cf = colour_fol & foliage
    dist_in = cv2.distanceTransform(cf.astype(np.uint8), cv2.DIST_L2, 5)
    edge = 1 - np.clip(dist_in / 40, 0, 1)
    border = np.minimum(np.minimum(xx, W - 1 - xx), np.minimum(yy, H - 1 - yy))
    attach = np.clip(border / 90, 0.4, 1)
    raw = F * depth * (0.55 + 0.45 * edge) * attach
    num = cv2.GaussianBlur(raw, (0, 0), 10)
    den = cv2.GaussianBlur(F, (0, 0), 10)
    flex = num / np.maximum(den, 1e-3)
    dist_out = cv2.distanceTransform((~foliage).astype(np.uint8), cv2.DIST_L2, 5)
    flex *= np.clip(1 - dist_out / 22, 0, 1)
    protect = cv2.dilate((tower).astype(np.uint8), np.ones((5, 5), np.uint8)).astype(bool)
    flex[protect] = 0
    flex[front] = 0
    flex = cv2.GaussianBlur(flex, (0, 0), 1.5)
    flex[tower] = 0
    flex = np.clip(flex, 0, 1)

    # ---------- window lights ----------
    rng = np.random.default_rng(7 if name == "illustrated" else 11)
    A = np.zeros((H, W), np.uint8)
    r, g, b = f[..., 0], f[..., 1], f[..., 2]
    lum = 0.299 * r + 0.587 * g + 0.114 * b
    folfrac = cv2.blur(foliage.astype(np.float32), (9, 9))
    farcore = cv2.erode((cls == FAR).astype(np.uint8), np.ones((5, 5), np.uint8)).astype(bool) & (folfrac < 0.25)
    citylike = farcore & (yy >= cfg["windows_ymin"])
    citylike |= (cls == TOWER)
    warm = (r > 0.62) & (g > 0.42) & (b < 0.55) & (r > b + 0.18)
    blur = cv2.blur(lum, (5, 5))
    painted = citylike & warm & (lum > blur + 0.04)
    A[painted] = rng.integers(1, 110, painted.sum())
    # synthetic windows on building faces: jittered sparse grid on non-sky-coloured city pixels
    jit = rng.random((H, W))
    gridpick = ((xx.astype(int) % 3) == 0) & ((yy.astype(int) % 4) == 1)
    synth = citylike & ~painted & gridpick & (jit < (0.20 if name == "illustrated" else 0.16)) & (lum < 0.75)
    A[synth] = rng.integers(110, 256, synth.sum())

    # ---------- write ----------
    out = np.zeros((H, W, 4), np.uint8)
    out[..., 0] = foliage.astype(np.uint8) * 255
    out[..., 1] = (flex * 255 + 0.5).astype(np.uint8)
    out[..., 2] = plate_cls * 60
    out[..., 3] = A
    Image.fromarray(out, "RGBA").save(f"{OUT}/cls_{name}.png", optimize=True)
    Image.fromarray(plate_rgba, "RGBA").save(f"{OUT}/plate_{name}.png", optimize=True)

    if DBG:
        pal = np.array([[90, 160, 255], [180, 120, 200], [40, 170, 60], [230, 140, 40], [255, 40, 40]], np.uint8)
        dbg = pal[cls].astype(np.float32)
        dbg = dbg * 0.55 + rgb * 0.45
        Image.fromarray(dbg.astype(np.uint8)).save(f"{DBG}/dbg_cls_{name}.png")
        fv = (np.stack([flex] * 3, -1) * 255).astype(np.uint8)
        Image.fromarray(fv).save(f"{DBG}/dbg_flex_{name}.png")
        pv = rgb.copy(); pm = plate_rgba[..., 3] > 0; pv[pm] = plate_rgba[pm, :3]
        Image.fromarray(pv).save(f"{DBG}/dbg_plate_{name}.png")
        av = (rgb * 0.25).astype(np.uint8); av[A > 0] = [255, 220, 120]
        Image.fromarray(av).save(f"{DBG}/dbg_lights_{name}.png")
    print(name, "foliage", foliage.mean().round(3), "band", band.sum(), "lights", (A > 0).sum())


for k, v in MODES.items():
    process(k, v)


def clean_falling():
    """Keep only the main leaf blob in each falling-leaf sprite (one had concept-sheet label text baked in)."""
    dst = os.path.join(OUT, "falling"); os.makedirs(dst, exist_ok=True)
    for f in sorted(glob.glob(os.path.join(ASSETS, "falling", "*.png"))):
        a = np.array(Image.open(f).convert("RGBA"))
        m = (a[..., 3] > 100).astype(np.uint8)
        n, lab, st, _ = cv2.connectedComponentsWithStats(m, connectivity=8)
        k = 1 + np.argmax(st[1:, cv2.CC_STAT_AREA])
        keep = cv2.dilate((lab == k).astype(np.uint8), np.ones((3, 3), np.uint8)).astype(bool) & (m > 0)
        a[..., 3] = np.where(keep, 255, 0)
        ys, xs = np.where(keep)
        Image.fromarray(a[ys.min():ys.max() + 1, xs.min():xs.max() + 1]).save(os.path.join(dst, os.path.basename(f)))


clean_falling()
