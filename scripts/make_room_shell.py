"""Build the room shell that surrounds the viewer outside the photo's field of view.

The splat only covers the ~60 degree cone the photo saw. In a headset everything else was
empty, so the room read as a framed picture floating in space. This script:

1. Corrects the reconstruction's shape. DA3 predicted different focal lengths for x and y
   (621 vs 788 px), which a phone photo cannot have. A square-pixel focal length is chosen
   so the fitted walls meet at right angles (--focal, default from the 2026-11-05 test).
2. Levels the room from the fitted floor and ceiling, and sets metric scale so the capture
   eye sits at a handheld standing height (cross-checked against the CRT monitor's size).
3. Fits floor, ceiling and walls, closes them into a room polygon around the viewer, and
   bakes a texture per surface: photo colour where the photo saw that surface, filled
   outward from it elsewhere, darkened into corners.

Inputs (read-only): D:\\Lustron\\...\\input\\source.jpg, output\\depth-model.npy, predicted-intrinsics.npy.
Outputs: public/assets/room-shell.json, public/assets/room-shell.jpg, src/room-frame.js.
"""
import argparse, base64, json, math
from pathlib import Path
import numpy as np
import cv2

BLUNT = Path(r'D:\Lustron\experiments\BLUNT\2026-11-04_repair-office-single-image')
ROOT = Path(__file__).resolve().parents[1]
EYE_Y = 1.6          # content-space height of the capture eye (the app's EYE)
LEGACY_SCALE = 3.0   # v0.4 mapping: world = (3X, 1.6 - 3Y, -3Z)

ap = argparse.ArgumentParser()
ap.add_argument('--focal', type=float, default=700.0, help='square-pixel focal length at depth-map resolution')
ap.add_argument('--eye-height', type=float, default=1.4, help='capture eye above the floor, metres (handheld phone; CRT bezel then ~0.35 m)')
ap.add_argument('--left-side', type=float, default=-2.4, help='assumed side wall closing the room on the left, content x in metres')
ap.add_argument('--behind', type=float, default=1.6, help='assumed wall behind the viewer, metres')
ap.add_argument('--texel', type=float, default=0.015, help='metres per texel')
ap.add_argument('--surround', help='equirect panorama in this room frame (scripts/outpaint_surround.py); replaces the mirrored blur')
args = ap.parse_args()

depth = np.load(BLUNT / 'output' / 'depth-model.npy').astype(np.float64)
K = np.load(BLUNT / 'output' / 'predicted-intrinsics.npy')
H, W = depth.shape
fx, fy, cx, cy = (float(K[i, j]) for i, j in ((0, 0), (1, 1), (0, 2), (1, 2)))
f = args.focal
# A model point for pixel (u,v) is X = (u-cx)/fx*z. The square-pixel point is (u-cx)/f*z = X*fx/f.
photo = cv2.cvtColor(cv2.imread(str(BLUNT / 'input' / 'source.jpg')), cv2.COLOR_BGR2RGB)
PH, PW = photo.shape[:2]

v, u = np.mgrid[0:H, 0:W]
Q = np.stack([(u - cx) / f * depth, (v - cy) / f * depth, depth], -1)   # corrected camera space (y down)

def fit(*boxes, thr=0.012, step=2):
    pts = np.concatenate([Q[y0:y1:step, x0:x1:step].reshape(-1, 3) for x0, x1, y0, y1 in boxes])
    rng = np.random.default_rng(1); best = None
    for _ in range(250):
        s = pts[rng.choice(len(pts), 3, replace=False)]
        n = np.cross(s[1] - s[0], s[2] - s[0]); ln = np.linalg.norm(n)
        if ln < 1e-12: continue
        n /= ln; inl = np.abs((pts - s[0]) @ n) < thr
        if best is None or inl.sum() > best.sum(): best = inl
    q = pts[best]; c = q.mean(0); n = np.linalg.svd(q - c)[2][2]
    if n @ c > 0: n = -n          # normal faces the camera
    return n, c

# Pixel boxes at depth-map resolution. The window wall and the right-hand posters are one plane
# (fitted separately they agree within ~1 degree), so they are fitted together as the back wall.
REGIONS = {'floor': [(560, 756, 930, 1008)], 'ceiling': [(60, 560, 0, 60)], 'left': [(20, 290, 90, 380)],
           'back': [(395, 500, 250, 335), (625, 750, 130, 300)]}
planes = {k: fit(*r) for k, r in REGIONS.items()}

# Level frame from the ceiling, the largest clean plane (rms ~2 mm). The small floor patch at the
# image corner disagrees by ~7 degrees, so it sets only the floor height, not the level.
up = -planes['ceiling'][0]; up /= np.linalg.norm(up)
fwd = np.array([0, 0, 1.0]); fwd -= up * (fwd @ up); fwd /= np.linalg.norm(fwd)
right = np.cross(up, fwd)   # y-down camera: right-handed check below
if right[0] < 0: right = -right
# Rotation from corrected camera space to content space (x right, y up, z toward viewer).
R = np.stack([right, up, -fwd])          # rows: content axes expressed in camera coords
floor_dist = float(-(planes['floor'][1] @ up))          # floor patch centre below the eye
ceil_dist = float(np.median(Q[0:60:2, 60:560:2].reshape(-1, 3) @ up))   # ceiling above the eye
S = args.eye_height / floor_dist
room_height = (floor_dist + ceil_dist) * S

def to_content(p):   # corrected camera space (model units) -> content metres
    return S * (R @ p) + np.array([0, EYE_Y, 0])
def from_content(p):
    return R.T @ ((p - np.array([0, EYE_Y, 0])) / S)

floor_y = EYE_Y - floor_dist * S
ceil_y = EYE_Y + ceil_dist * S

# Wall lines in plan (x, z): n . (x, z) = c, normal faces the viewer, made exactly vertical.
lines = {}
for k in ('left', 'back'):
    n, c = planes[k]
    nc = R @ n; nc[1] = 0; nc /= np.linalg.norm(nc)
    pc_ = to_content(c)
    lines[k] = (np.array([nc[0], nc[2]]), float(nc[0] * pc_[0] + nc[2] * pc_[2]))
lines['behind'] = (np.array([0.0, -1.0]), -args.behind)   # wall at z = +behind, facing -z
lines['side'] = (np.array([1.0, 0.0]), args.left_side)        # wall at x = left_side, facing +x

def angle(a, b):
    return math.degrees(math.acos(min(1, abs(float(lines[a][0] @ lines[b][0])))))

# Room polygon: clip a large square by each wall's half-plane (keep the viewer's side).
poly = [np.array(p, float) for p in [(-20, -20), (20, -20), (20, 20), (-20, 20)]]
edge_wall = [None] * 4
for name, (n, c) in lines.items():
    # Inside: n . p >= c  (normal faces the viewer at the origin, so origin side has n.p > c)
    inside = lambda p: n @ p - c >= 0
    out, owners = [], []
    for i in range(len(poly)):
        a, b, wa = poly[i], poly[(i + 1) % len(poly)], edge_wall[i]
        ia, ib = inside(a), inside(b)
        if ia: out.append(a); owners.append(wa)
        if ia != ib:
            t = (c - n @ a) / (n @ (b - a)); out.append(a + t * (b - a))
            owners.append(name if ia else wa)  # leaving: next edge runs along this wall
    poly, edge_wall = out, owners
# Each polygon edge i runs poly[i] -> poly[i+1] and belongs to edge_wall[i].
assert all(w is not None for w in edge_wall), 'room polygon is not closed by fitted walls'

# Surfaces: walls (vertical quads), floor and ceiling (polygon).
surfaces = []
for i, name in enumerate(edge_wall):
    a, b = poly[i], poly[(i + 1) % len(poly)]
    corners = [np.array([a[0], floor_y, a[1]]), np.array([b[0], floor_y, b[1]]),
               np.array([b[0], ceil_y, b[1]]), np.array([a[0], ceil_y, a[1]])]
    surfaces.append({'name': name, 'corners': corners})
P3 = lambda y: [np.array([p[0], y, p[1]]) for p in poly]
surfaces.append({'name': 'floor', 'polygon': P3(floor_y)})
surfaces.append({'name': 'ceiling', 'polygon': P3(ceil_y)})

dsmall = cv2.resize(depth, (W, H))
def bake(origin, eu, ev, nu, nv, plane_n, plane_c, inside_fn, target=None, fade=90.0):
    """Texture for a planar surface: origin + s*eu + t*ev. Returns RGB uint8 (nv, nu, 3)."""
    s = (np.arange(nu) + 0.5) / nu; t = (np.arange(nv) + 0.5) / nv
    T, Sg = np.meshgrid(t, s, indexing='ij')
    pts = origin + Sg[..., None] * eu + T[..., None] * ev            # content metres
    cam = (pts - np.array([0, EYE_Y, 0])) / S @ R                     # corrected camera space
    z = cam[..., 2]
    with np.errstate(divide='ignore', invalid='ignore'):
        pu = f * cam[..., 0] / z + cx; pv = f * cam[..., 1] / z + cy
    ok = (z > 0.02) & (pu >= 0) & (pu < W - 1) & (pv >= 0) & (pv < H - 1)
    iu = np.clip(pu, 0, W - 1).astype(int); iv = np.clip(pv, 0, H - 1).astype(int)
    seen = ok & (np.abs(dsmall[iv, iu] - z) < 0.07 * np.maximum(z, 1e-6))
    colour = photo[np.clip((pv * PH / H), 0, PH - 1).astype(int), np.clip((pu * PW / W), 0, PW - 1).astype(int)].astype(np.float32)
    known = seen & inside_fn(Sg, T)
    img = np.where(known[..., None], colour, 0).astype(np.float32)
    # Pull-push fill: unknown texels take a blurred average of the nearest known ones.
    w = known.astype(np.float32)
    levels = [(img * w[..., None], w)]
    while max(levels[-1][1].shape) > 1:   # down to 1x1 so every texel gets some colour
        ci, cw = levels[-1]; h, w_ = cw.shape; size = (max(1, w_ // 2), max(1, h // 2))
        k = (w_ * h) / (size[0] * size[1])
        levels.append((cv2.resize(ci, size, interpolation=cv2.INTER_AREA).reshape(size[1], size[0], 3) * k,
                       cv2.resize(cw, size, interpolation=cv2.INTER_AREA).reshape(size[1], size[0]) * k))
    fill_i, fill_w = levels[-1]
    for ci, cw in reversed(levels[:-1]):
        up_i = cv2.resize(fill_i, (cw.shape[1], cw.shape[0]), interpolation=cv2.INTER_LINEAR).reshape(ci.shape)
        up_w = cv2.resize(fill_w, (cw.shape[1], cw.shape[0]), interpolation=cv2.INTER_LINEAR).reshape(cw.shape)
        a = np.clip(cw, 0, 1)[..., None]
        fill_i = ci + (1 - a) * up_i; fill_w = cw + (1 - a[..., 0]) * up_w
    filled = fill_i / np.maximum(fill_w, 1e-6)[..., None]
    if not known.any(): filled[:] = FALLBACK
    # Blur the filled part (keep seen texels sharp), and fade unseen texels a little darker.
    dist = cv2.distanceTransform((~known).astype(np.uint8), cv2.DIST_L2, 5) * args.texel
    if target is not None:   # unseen parts drift toward a plausible lit tone, not the seen patch's shadow
        tmix = np.clip(dist / 0.6, 0, 1)[..., None]
        filled = filled * (1 - tmix) + np.asarray(target, np.float32) * tmix
    plain = cv2.GaussianBlur(filled, (0, 0), 3)
    # Continue the photo past its edges: mirror it about each edge (in viewing angle) and blur it
    # more the further outside the frame the texel is, so peripheral vision sees the shop's own
    # colours and clutter rhythm, seamless with the splat at the frame edge. Blend toward the plain
    # fill over `fade` degrees outside the frame (quickly for the floor, which should read as floor).
    X, Y, Z = cam[..., 0], cam[..., 1], cam[..., 2]
    ax = np.arctan2(X, Z); ay = np.arctan2(Y, np.hypot(X, Z))
    out_x = np.maximum(np.abs(ax) - EDGE_X, 0)
    ax_m = np.where(out_x > 0, np.sign(ax) * np.maximum(EDGE_X - out_x * MIRROR_K, -EDGE_X), ax)
    edge_y = np.arctan(cy / f * np.cos(ax_m))
    out_y = np.maximum(np.abs(ay) - edge_y, 0)
    ay_m = np.where(out_y > 0, np.sign(ay) * np.clip(edge_y - out_y, -edge_y, edge_y), ay)
    mu = (cx + f * np.tan(ax_m)).astype(np.float32); mv = (cy + f * np.tan(ay_m) / np.cos(ax_m)).astype(np.float32)
    outside = np.degrees(out_x + out_y)
    sigma = np.clip(outside * 1.1, 0, BLUR_SIGMAS[-1])
    mirror = np.zeros(cam.shape, np.float32)
    lo = np.clip(np.searchsorted(BLUR_SIGMAS, sigma, side='right') - 1, 0, len(BLUR_SIGMAS) - 2)
    for i in range(len(BLUR_SIGMAS) - 1):
        sel = lo == i
        if not sel.any(): continue
        a0 = cv2.remap(BLURRED[i], mu, mv, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT)
        a1 = cv2.remap(BLURRED[i + 1], mu, mv, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT)
        w = np.clip((sigma - BLUR_SIGMAS[i]) / (BLUR_SIGMAS[i + 1] - BLUR_SIGMAS[i]), 0, 1)[..., None]
        mirror[sel] = (a0 * (1 - w) + a1 * w)[sel]
    blend = np.clip(outside / fade, 0, 1)[..., None]
    out = mirror * (1 - blend) + plain * blend
    out *= (1 - 0.22 * np.clip(outside / 70, 0, 1))[..., None]
    if SURROUND is not None:   # generated panorama: sample by direction from the eye
        dvec = pts - np.array([0, EYE_Y, 0]); dvec /= np.linalg.norm(dvec, axis=-1, keepdims=True)
        lon = np.arctan2(dvec[..., 0], -dvec[..., 2]); lat = np.arcsin(np.clip(dvec[..., 1], -1, 1))
        su = ((lon + np.pi) / (2 * np.pi) * SURROUND.shape[1] - 0.5).astype(np.float32)
        sv = ((np.pi / 2 - lat) / np.pi * SURROUND.shape[0] - 0.5).astype(np.float32)
        out = cv2.remap(SURROUND, su, sv, cv2.INTER_LINEAR, borderMode=cv2.BORDER_WRAP)
    return np.clip(out, 0, 255).astype(np.uint8), float(known.mean())

SURROUND = None
if args.surround:
    SURROUND = cv2.cvtColor(cv2.imread(args.surround), cv2.COLOR_BGR2RGB).astype(np.float32)
    SURROUND = cv2.GaussianBlur(SURROUND, (0, 0), 0.8)   # light prefilter: texels are coarser than panorama pixels

# Viewing-angle mirror: the half-width of the frame, and how much angle beyond it maps back inside
# (the remaining ~150 degrees to straight behind fold into one image width).
EDGE_X = math.atan(cx / f)
MIRROR_K = 2 * EDGE_X / (math.pi - EDGE_X)
BLUR_SIGMAS = np.array([0, 3, 8, 16, 32, 64, 120], np.float32)
_small = cv2.resize(photo, (W, H), interpolation=cv2.INTER_AREA).astype(np.float32)
BLURRED = [_small if s_ == 0 else cv2.GaussianBlur(_small, (0, 0), float(s_), borderType=cv2.BORDER_REFLECT) for s_ in BLUR_SIGMAS]

FALLBACK = None
# Fallback colour for a surface the photo never saw: median of seen wall texels (computed lazily).
wall_samples = []
for k in ('left', 'back'):
    for x0, x1, y0, y1 in REGIONS[k]:
        wall_samples.append(cv2.resize(photo, (W, H))[y0:y1, x0:x1].reshape(-1, 3))
FALLBACK = np.median(np.concatenate(wall_samples), 0) * 0.85

tiles, meta = [], []
for surf in surfaces:
    if 'corners' in surf:
        c0, c1, c2, c3 = surf['corners']
        eu, ev = c1 - c0, c3 - c0; origin = c0
        nu = max(8, int(np.linalg.norm(eu) / args.texel)); nv = max(8, int(np.linalg.norm(ev) / args.texel))
        img, cover = bake(origin, eu, ev, nu, nv, None, None, lambda s, t: np.ones_like(s, bool), fade=45.0)
        verts = [c0, c1, c2, c3]; uvs = [(0, 0), (1, 0), (1, 1), (0, 1)]; tris = [(0, 1, 2), (0, 2, 3)]
        # Corner shading: darker towards the wall's edges, floor and ceiling.
        s = (np.arange(img.shape[1]) + 0.5) / img.shape[1] * np.linalg.norm(eu)
        t = (np.arange(img.shape[0]) + 0.5) / img.shape[0] * np.linalg.norm(ev)
        ds = np.minimum(s, np.linalg.norm(eu) - s)[None, :]; dt = np.minimum(t, np.linalg.norm(ev) - t)[:, None]
    else:
        pg = surf['polygon']; xs = [p[0] for p in pg]; zs = [p[2] for p in pg]
        origin = np.array([min(xs), pg[0][1], min(zs)])
        eu = np.array([max(xs) - min(xs), 0, 0]); ev = np.array([0, 0, max(zs) - min(zs)])
        nu = max(8, int(eu[0] / args.texel)); nv = max(8, int(ev[2] / args.texel))
        # The only floor the photo shows is in shadow under the counter (RGB ~27,23,13); open floor
        # under the strip lights is assumed to be lit concrete.
        target = (92, 86, 72) if surf['name'] == 'floor' else None
        img, cover = bake(origin, eu, ev, nu, nv, None, None, lambda s, t: np.ones_like(s, bool), target,
                          fade=12.0 if surf['name'] == 'floor' else 45.0)
        verts = pg; uvs = [((p[0] - origin[0]) / eu[0], (p[2] - origin[2]) / ev[2]) for p in pg]
        tris = [(0, i, i + 1) for i in range(1, len(pg) - 1)]
        if surf['name'] == 'ceiling': tris = [(a, c, b) for a, b, c in tris]
        # Distance to the polygon edge for corner shading.
        mask = np.zeros(img.shape[:2], np.uint8)
        pix = np.array([[(p[0] - origin[0]) / args.texel, (p[2] - origin[2]) / args.texel] for p in pg], np.int32)
        cv2.fillPoly(mask, [pix], 1)
        edge = cv2.distanceTransform(mask, cv2.DIST_L2, 5) * args.texel
        ds = edge; dt = np.full_like(edge, 9.0)
    ao = 1 - (0.18 if SURROUND is not None else 0.35) * np.exp(-np.minimum(ds, dt) / 0.25)
    img = np.clip(img * ao[..., None], 0, 255).astype(np.uint8)
    tiles.append(img); meta.append({'name': surf['name'], 'verts': verts, 'uvs': uvs, 'tris': tris, 'seen': round(cover, 3)})

# Atlas: fixed 512 tiles in a grid (surfaces are resampled to the tile).
TILE = 1024; cols = 4; rows = math.ceil(len(tiles) / cols)
atlas = np.zeros((rows * TILE, cols * TILE, 3), np.uint8)
positions, uvs_out, indices = [], [], []
for i, (img, m) in enumerate(zip(tiles, meta)):
    r, c = divmod(i, cols)
    atlas[r * TILE:(r + 1) * TILE, c * TILE:(c + 1) * TILE] = cv2.resize(img, (TILE, TILE), interpolation=cv2.INTER_AREA)
    base = len(positions)
    pad = 2 / TILE
    for p, (su, tv) in zip(m['verts'], m['uvs']):
        positions.append([float(x) for x in p])
        U = (c + pad + su * (1 - 2 * pad)) / cols
        V = (r + pad + tv * (1 - 2 * pad)) / rows
        uvs_out.append([U, V])   # texture uploaded with flipY false: v follows image rows
    # Faces must point toward the viewer (inside of the room).
    for a, b, cc in m['tris']:
        pa, pb, pcc = (np.array(positions[base + k]) for k in (a, b, cc))
        nrm = np.cross(pb - pa, pcc - pa); centre = (pa + pb + pcc) / 3
        if nrm @ (np.array([0, EYE_Y, 0]) - centre) < 0: b, cc = cc, b
        indices.append([base + a, base + b, base + cc])

cv2.imwrite(str(ROOT / 'public' / 'assets' / 'room-shell.jpg'), cv2.cvtColor(atlas, cv2.COLOR_RGB2BGR), [cv2.IMWRITE_JPEG_QUALITY, 84])

# Office splat transform: model (y-down camera) -> corrected (diag(fx/f, fy/f, 1)) -> content (S*R, +eye).
M = S * R @ np.diag([fx / f, fy / f, 1.0])   # linear part
# PlayCanvas entity transform is T * Rot * Scale: decompose M = Rot * diag(scale) with Rot orthonormal.
# R is orthonormal, so Rot = R and scale = S * (fx/f, fy/f, 1) exactly. R maps camera y-down to y-up.
rot = R
if np.linalg.det(rot) < 0: raise SystemExit('unexpected reflection in level frame')
from scipy.spatial.transform import Rotation
quat = list(Rotation.from_matrix(rot).as_quat())   # x, y, z, w (robust near 180 degrees)
scale = [S * fx / f, S * fy / f, S]

# Legacy v0.4 world -> new content: legacy = (3X, 1.6 - 3Y, -3Z) of model point (X, Y, Z).
L = np.diag([LEGACY_SCALE, -LEGACY_SCALE, -LEGACY_SCALE])
A = M @ np.linalg.inv(L)   # new = A @ (legacy - (0, 1.6, 0)) + (0, 1.6, 0)

json.dump({'positions': positions, 'uvs': uvs_out, 'indices': indices, 'texture': 'room-shell.jpg',
           'surfaces': [{'name': m['name'], 'seen': m['seen']} for m in meta]},
          open(ROOT / 'public' / 'assets' / 'room-shell.json', 'w'), indent=0)

report = {'focal': f, 'predicted': [fx, fy], 'scale': S, 'eye_height': args.eye_height, 'room_height': room_height,
          'floor_y': floor_y, 'ceiling_y': ceil_y, 'tilt_deg': math.degrees(math.acos(min(1, abs(up @ np.array([0, -1.0, 0]))))), 'floor_vs_ceiling_deg': math.degrees(math.acos(min(1, abs(planes['floor'][0] @ planes['ceiling'][0])))),
          'wall_vertical_err_deg': {k: 90 - math.degrees(math.acos(min(1, abs(planes[k][0] @ up)))) for k in ('left', 'back')},
          'wall_angles': {'left-back': angle('left', 'back')},
          'surfaces_seen': {m['name']: m['seen'] for m in meta}, 'polygon': [list(map(float, p)) for p in poly]}
frame = f"""// Generated by scripts/make_room_shell.py — do not edit by hand.
// Corrected, levelled, metric frame for the office (content space: eye at (0, {EYE_Y}, 0), -z forward).
export const OFFICE = {{
  rotation: {json.dumps([round(x, 6) for x in quat])}, // quaternion x, y, z, w
  scale: {json.dumps([round(x, 6) for x in scale])},
  position: [0, {EYE_Y}, 0],
}};
export const FLOOR_Y = {floor_y:.4f}, CEILING_Y = {ceil_y:.4f};
// Maps a point measured in the v0.4 frame (uniform 3x, unlevelled) into this frame.
const A = {json.dumps([[round(x, 6) for x in row] for row in A])};
export function fromLegacy([x, y, z]) {{
  const p = [x, y - {EYE_Y}, z];
  return A.map((row, i) => row[0] * p[0] + row[1] * p[1] + row[2] * p[2] + (i === 1 ? {EYE_Y} : 0));
}}
// Directions (plane normals) transform by the inverse transpose.
const N = {json.dumps([[round(x, 6) for x in row] for row in np.linalg.inv(A).T])};
export function normalFromLegacy(n) {{
  const m = N.map(row => row[0] * n[0] + row[1] * n[1] + row[2] * n[2]);
  const l = Math.hypot(...m); return m.map(v => v / l);
}}
export const SHELL_REPORT = {json.dumps(report, default=float)};
"""
(ROOT / 'src' / 'room-frame.js').write_text(frame, encoding='utf-8')
print(json.dumps(report, indent=1, default=float))
