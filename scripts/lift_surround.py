"""Lift the generated surround views into 3D Gaussians in the app's room frame.

Same recipe as the original photo (DA3-BASE depth + BLUNT depth_to_gaussians), applied to each
generated view from scripts/outpaint_surround.py. Only each view's generated pixels become
Gaussians, so the photo's own splat is not duplicated. Output positions are app world metres
(eye at (0, 1.6, 0), -z forward), so the app loads the PLY with an identity transform.

Depth scale (--align):
  shell      one scale per view from the room shell (walls are the far limit). v0.7.0.
  neighbour  match depth to geometry already placed around the view (the photo splat, then earlier
             views): the log depth ratio on those pixels is spread smoothly into the new area and
             relaxes to the shell scale further away, so seams line up. Default.
Depth is always clamped to just inside the room shell.

Run with the BLUNT environment python:
  <BLUNT>/environment/Scripts/python.exe scripts/lift_surround.py <outpaint output dir> <out dir> [--res 1024]
Generated content is invented; depths are monocular guesses, not measurements.
"""
import argparse, json, math, re, sys, time
from pathlib import Path
import numpy as np, cv2

ap = argparse.ArgumentParser()
ap.add_argument('views_dir'); ap.add_argument('out_dir')
ap.add_argument('--res', type=int, default=1024, help='per-view sampling resolution (one Gaussian per pixel)')
ap.add_argument('--quantile', type=float, default=25.0, help='percentile of shell/DA3 depth ratio used as the fallback scale')
ap.add_argument('--align', choices=['shell', 'neighbour'], default='neighbour')
ap.add_argument('--inpaint', action='store_true', help="BLUNT occlusion inpainting (stretches colour across depth jumps; v0.7.0 had it on)")
ap.add_argument('--no-level-seams', dest='level_seams', action='store_false', help='skip colour levelling at view seams')
ap.add_argument('--device', default='cuda')
args = ap.parse_args()

ROOT = Path(__file__).resolve().parents[1]
BLUNT_RUN = Path(r'D:\Lustron\experiments\BLUNT\2026-11-04_repair-office-single-image')
repos = json.loads((BLUNT_RUN / 'provenance/repositories.json').read_text(encoding='utf-8'))
sys.path.insert(0, str(Path(next(r['source_dir'] for r in repos if r['repository'].endswith('Depth-Anything-3'))) / 'src'))
sys.path.insert(0, next(r['source_dir'] for r in repos if r['repository'].endswith('blunt')))
SNAPSHOT = json.loads((BLUNT_RUN / 'provenance/depth-model.json').read_text(encoding='utf-8'))['snapshot']

import torch
from depth_anything_3.api import DepthAnything3
import blunt
from scipy.spatial.transform import Rotation

SRC = Path(args.views_dir); OUT = Path(args.out_dir); (OUT / 'depth').mkdir(parents=True, exist_ok=True)
meta = json.loads((SRC / 'surround.json').read_text(encoding='utf-8'))
EYE = np.array([0.0, 1.6, 0.0]); FOV = float(meta['view'][1]); RES = args.res
t = math.tan(math.radians(FOV) / 2); F = RES / 2 / t

# Room shell triangles (world metres).
shell = json.loads((ROOT / 'public/assets/room-shell.json').read_text(encoding='utf-8'))
P = np.array(shell['positions'], np.float64); TRI = P[np.array(shell['indices'])]

def read_ply_xyz(path):
    with open(path, 'rb') as f:
        header = b''
        while not header.endswith(b'end_header\n'): header += f.readline()
        props = re.findall(rb'property float (\w+)', header); n = int(re.search(rb'element vertex (\d+)', header).group(1))
        data = np.fromfile(f, np.float32, n * len(props)).reshape(n, len(props))
    names = [p.decode() for p in props]
    return data[:, [names.index('x'), names.index('y'), names.index('z')]].astype(np.float64)

def photo_points_world():
    """The original photo splat's centres, placed exactly as the app places them (T * R * S)."""
    frame = (ROOT / 'src' / 'room-frame.js').read_text(encoding='utf-8')
    grab = lambda key: np.array(json.loads(re.search(key + r': (\[[^\]]+\])', frame).group(1)), np.float64)
    rot, scale, pos = Rotation.from_quat(grab('rotation')), grab('scale'), grab('position')
    return rot.apply(read_ply_xyz(BLUNT_RUN / 'output' / 'repair-office.ply') * scale) + pos

def view_basis(yaw, pitch):   # identical to outpaint_surround.py: columns = right, up, back in world
    y, p = math.radians(yaw), math.radians(pitch)
    Ry = np.array([[math.cos(y), 0, -math.sin(y)], [0, 1, 0], [math.sin(y), 0, math.cos(y)]])
    Rx = np.array([[1, 0, 0], [0, math.cos(p), -math.sin(p)], [0, math.sin(p), math.cos(p)]])
    return Ry @ Rx

def shell_zdepth(B):
    """Distance along the view axis to the room shell for each pixel (ray dir has local z = -1)."""
    g = ((np.arange(RES) + 0.5) / RES * 2 - 1) * t
    GX, GY = np.meshgrid(g, -g)
    d = np.stack([GX, GY, -np.ones_like(GX)], -1).reshape(-1, 3) @ B.T
    best = np.full(len(d), np.inf)
    for a, b, c in TRI:   # Moller-Trumbore, vectorised over rays
        e1, e2 = b - a, c - a; s = EYE - a
        pv = np.cross(d, e2); det = pv @ e1
        with np.errstate(divide='ignore', invalid='ignore'):
            inv = 1 / det; u = (pv @ s) * inv
            q = np.cross(s, e1); v = (d @ q) * inv; tt = (q @ e2) * inv
        ok = (np.abs(det) > 1e-12) & (u >= 0) & (v >= 0) & (u + v <= 1) & (tt > 1e-4)
        best = np.where(ok & (tt < best), tt, best)
    return best.reshape(RES, RES)

def known_zdepth(B, pts):
    """Nearest z-depth of already-placed points in this view (inf where nothing projects)."""
    v = (pts - EYE) @ B                       # view coords: right, up, back
    z = -v[:, 2]; front = z > 0.05
    v, z = v[front], z[front]
    px = ((v[:, 0] / z / t + 1) / 2 * RES).astype(np.int64); py = ((-v[:, 1] / z / t + 1) / 2 * RES).astype(np.int64)
    ok = (px >= 0) & (px < RES) & (py >= 0) & (py < RES)
    idx, z = py[ok] * RES + px[ok], z[ok]
    order = np.argsort(-z)                     # far first, so nearer points overwrite
    zbuf = np.full(RES * RES, np.inf, np.float32); zbuf[idx[order]] = z[order]
    zbuf = zbuf.reshape(RES, RES)
    filled = cv2.erode(np.where(np.isfinite(zbuf), zbuf, 1e6).astype(np.float32), np.ones((3, 3), np.uint8))
    return np.where(filled < 1e5, filled, np.inf)

def spread(values, weights, sigma):
    """Normalised convolution: smooth weighted average of `values`, plus the weight density."""
    num = cv2.GaussianBlur(values * weights, (0, 0), sigma); den = cv2.GaussianBlur(weights, (0, 0), sigma)
    return num, den

def level_seams(img, mask):
    """Match the generated area's colour to the earlier content along its edge.

    outpaint_surround.py wrote each view's new pixels next to earlier ones with a hard edge, so any
    exposure difference shows as a step. Measure (earlier - new) colour just across the edge, spread
    it smoothly into the new area and let it fade to zero inside."""
    m8 = mask.astype(np.uint8)
    inside = cv2.distanceTransform(m8, cv2.DIST_L2, 5); outside = cv2.distanceTransform(1 - m8, cv2.DIST_L2, 5)
    s = RES / 1024
    ring_new = ((inside > 0) & (inside <= 8 * s)).astype(np.float32)
    ring_old = ((outside >= 20 * s) & (outside <= 32 * s)).astype(np.float32)   # past outpaint's 12 px feather band and its blur
    if ring_new.sum() < 50 or ring_old.sum() < 50: return img, 0.0
    f = img.astype(np.float32); sig = 24 * s
    a_num, a_den = spread(f, ring_old[..., None].repeat(3, -1), sig)
    b_num, b_den = spread(f, ring_new[..., None].repeat(3, -1), sig)
    both = ((a_den[..., 0] > 0.02) & (b_den[..., 0] > 0.02)).astype(np.float32)
    D = np.where(both[..., None] > 0, a_num / np.maximum(a_den, 1e-6) - b_num / np.maximum(b_den, 1e-6), 0)
    edge = both * ring_new          # sample the offset on the new side of the edge
    num, den = spread(D.astype(np.float32), edge[..., None].repeat(3, -1), 60 * s)
    offset = num / (den + 0.02)      # fades to zero far from the edge
    out = np.where(mask[..., None], np.clip(f + offset, 0, 255), f).astype(np.uint8)
    return out, float(np.abs(D[edge > 0]).mean()) if edge.any() else 0.0

model = DepthAnything3.from_pretrained(SNAPSHOT).to(device=torch.device(args.device)); model.eval()
names = {v['view']: v for v in meta['views']}
files = sorted(p for p in SRC.glob('views/*.jpg') if not p.stem.endswith('-mask'))
known = [photo_points_world()] if args.align == 'neighbour' else []
parts, log, t0 = [], [], time.time()
for jpg in files:
    name = jpg.stem.split('-', 1)[1]; v = names[name]
    B = view_basis(v['yaw'], v['pitch'])
    depth, _, K = blunt.da3_single_depth(str(jpg), model, process_res=1008)
    depth = cv2.resize(depth.astype(np.float32), (RES, RES), interpolation=cv2.INTER_LINEAR)
    img = cv2.cvtColor(cv2.resize(cv2.imread(str(jpg)), (RES, RES), interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2RGB)
    mask = cv2.resize((cv2.imread(str(jpg.with_name(jpg.stem + '-mask.png')), 0) > 127).astype(np.float32), (RES, RES), interpolation=cv2.INTER_AREA) > 0.5
    img, seam_step = level_seams(img, mask) if args.level_seams else (img, 0.0)
    zs = shell_zdepth(B)
    good = mask & np.isfinite(zs) & (depth > 1e-6)
    ratio = zs[good] / depth[good]
    shell_scale = float(np.percentile(ratio, args.quantile))
    logk = np.full((RES, RES), math.log(shell_scale), np.float32); rec_align = {}
    if args.align == 'neighbour':
        kz = known_zdepth(B, np.concatenate(known))
        ov = (~mask) & np.isfinite(kz) & (depth > 1e-6) & np.isfinite(zs) & (kz < zs * 1.05)
        if ov.sum() > 500:
            L = np.zeros((RES, RES), np.float32); L[ov] = np.log(kz[ov] / depth[ov])
            med = float(np.median(L[ov])); w = (ov & (np.abs(L - med) < 0.4)).astype(np.float32)
            sigma = RES / 24
            num, den = spread(L, w, sigma)
            prior = 0.02   # weight of the shell scale; wins once neighbours are > ~2 sigma away
            logk = ((num + prior * math.log(shell_scale)) / (den + prior)).astype(np.float32)
            rec_align = {'overlap_px': int(w.sum()), 'neighbour_scale': round(math.exp(med), 4)}
    zd = depth * np.exp(logk)
    zd = np.minimum(zd, np.where(np.isfinite(zs), zs * 1.02, zd)).astype(np.float32)
    zd = np.maximum(zd, 0.25)
    np.save(OUT / 'depth' / f'{jpg.stem}.npy', zd)
    g, keep = blunt.depth_to_gaussians(img, zd, F, overlap_factor=1.3, depth_disc_threshold=0.1, is_metric=True,
                                       skip_sky=False, fast_mode=False, return_keep_mask=True, inpaint=args.inpaint)
    sel = mask[keep]
    g = {k: val[sel] for k, val in g.items()}
    # OpenCV camera (x right, y down, z forward) -> world.
    M = B @ np.diag([1.0, -1.0, -1.0])
    pos = np.stack([g['x'], g['y'], g['z']], 1) @ M.T + EYE
    q = Rotation.from_matrix(M) * Rotation.from_quat(np.stack([g['rot_1'], g['rot_2'], g['rot_3'], g['rot_0']], 1))
    qx = q.as_quat()
    g['x'], g['y'], g['z'] = (pos[:, i].astype(np.float32) for i in range(3))
    g['rot_0'], g['rot_1'], g['rot_2'], g['rot_3'] = (qx[:, i].astype(np.float32) for i in (3, 0, 1, 2))
    parts.append(g)
    if args.align == 'neighbour': known.append(pos)
    rec = {'view': name, 'yaw': v['yaw'], 'pitch': v['pitch'], 'generated_px': int(mask.sum()), 'gaussians': int(sel.sum()),
           'shell_scale': round(shell_scale, 4), **rec_align, 'seam_colour_step': round(seam_step, 1),
           'clamped_fraction': round(float((depth[good] * np.exp(logk[good]) > zs[good] * 1.02).mean()), 3),
           'range_m_p5_p95': [round(float(x), 2) for x in np.percentile(zd[mask], [5, 95])], 'seconds': round(time.time() - t0, 1)}
    log.append(rec); print(json.dumps(rec), flush=True)

merged = blunt.merge_gaussian_dicts(parts)
n = len(merged['x'])
assert all(np.isfinite(a).all() for a in merged.values()), 'non-finite Gaussian attribute'
rot = np.stack([merged[f'rot_{i}'] for i in range(4)], 1); assert np.abs(np.linalg.norm(rot, axis=1) - 1).max() < 1e-3
tag = f'{RES}-{args.align}' + ('-inpaint' if args.inpaint else '') + ('-levelled' if args.level_seams else '')
ply = OUT / f'surround-lift-{tag}.ply'
if ply.exists(): raise SystemExit(f'refusing to overwrite {ply}')
blunt.write_ply(merged, str(ply))
summary = {'gaussians': n, 'res': RES, 'focal_px': F, 'align': args.align, 'inpaint': args.inpaint, 'quantile': args.quantile,
           'ply': str(ply), 'bytes': ply.stat().st_size, 'seconds': round(time.time() - t0, 1),
           'frame': 'app world metres, eye (0,1.6,0), -z forward; load with identity transform', 'views': log}
(OUT / f'surround-lift-{tag}.json').write_text(json.dumps(summary, indent=1), encoding='utf-8')
print('done', n, 'gaussians', summary['seconds'], 's', flush=True)
