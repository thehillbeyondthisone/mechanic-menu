"""Lift the generated surround views into 3D Gaussians in the app's room frame.

Same recipe as the original photo (DA3-BASE depth + BLUNT depth_to_gaussians), applied to each
generated view from scripts/outpaint_surround.py. Each view's depth is scaled to the room shell
(walls are the far limit) and only that view's generated pixels become Gaussians, so the photo's
own splat is not duplicated. Output positions are app world metres (eye at (0, 1.6, 0), -z forward),
so the app loads the PLY with an identity transform.

Run with the BLUNT environment python:
  <BLUNT>/environment/Scripts/python.exe scripts/lift_surround.py <outpaint output dir> <out dir> [--res 512]
Generated content is invented; depths are monocular guesses, not measurements.
"""
import argparse, json, math, sys, time
from pathlib import Path
import numpy as np, cv2

ap = argparse.ArgumentParser()
ap.add_argument('views_dir'); ap.add_argument('out_dir')
ap.add_argument('--res', type=int, default=512, help='per-view sampling resolution (Gaussians per pixel)')
ap.add_argument('--quantile', type=float, default=25.0, help='percentile of shell/DA3 depth ratio used as scale')
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

model = DepthAnything3.from_pretrained(SNAPSHOT).to(device=torch.device(args.device)); model.eval()
names = {v['view']: v for v in meta['views']}
files = sorted(p for p in SRC.glob('views/*.jpg'))
parts, log, t0 = [], [], time.time()
for jpg in files:
    name = jpg.stem.split('-', 1)[1]; v = names[name]
    B = view_basis(v['yaw'], v['pitch'])
    depth, _, K = blunt.da3_single_depth(str(jpg), model, process_res=1008)
    depth = cv2.resize(depth.astype(np.float32), (RES, RES), interpolation=cv2.INTER_LINEAR)
    img = cv2.cvtColor(cv2.resize(cv2.imread(str(jpg)), (RES, RES), interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2RGB)
    mask = cv2.resize((cv2.imread(str(jpg.with_name(jpg.stem + '-mask.png')), 0) > 127).astype(np.float32), (RES, RES), interpolation=cv2.INTER_AREA) > 0.5
    zs = shell_zdepth(B)
    good = mask & np.isfinite(zs) & (depth > 1e-6)
    ratio = zs[good] / depth[good]
    scale = float(np.percentile(ratio, args.quantile))
    zd = np.minimum(depth * scale, np.where(np.isfinite(zs), zs * 1.02, depth * scale)).astype(np.float32)
    zd = np.maximum(zd, 0.25)
    np.save(OUT / 'depth' / f'{jpg.stem}.npy', zd)
    g, keep = blunt.depth_to_gaussians(img, zd, F, overlap_factor=1.3, depth_disc_threshold=0.1, is_metric=True,
                                       skip_sky=False, fast_mode=False, return_keep_mask=True, inpaint=True)
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
    rec = {'view': name, 'yaw': v['yaw'], 'pitch': v['pitch'], 'generated_px': int(mask.sum()), 'gaussians': int(sel.sum()),
           'scale': round(scale, 4), 'ratio_p10_p50_p90': [round(float(x), 3) for x in np.percentile(ratio, [10, 50, 90])],
           'clamped_fraction': round(float((depth[good] * scale > zs[good] * 1.02).mean()), 3),
           'range_m_p5_p95': [round(float(x), 2) for x in np.percentile(zd[mask], [5, 95])], 'seconds': round(time.time() - t0, 1)}
    log.append(rec); print(json.dumps(rec), flush=True)

merged = blunt.merge_gaussian_dicts(parts)
n = len(merged['x'])
assert all(np.isfinite(a).all() for a in merged.values()), 'non-finite Gaussian attribute'
rot = np.stack([merged[f'rot_{i}'] for i in range(4)], 1); assert np.abs(np.linalg.norm(rot, axis=1) - 1).max() < 1e-3
ply = OUT / f'surround-lift-{RES}.ply'
if ply.exists(): raise SystemExit(f'refusing to overwrite {ply}')
blunt.write_ply(merged, str(ply))
summary = {'gaussians': n, 'res': RES, 'focal_px': F, 'quantile': args.quantile, 'ply': str(ply), 'bytes': ply.stat().st_size,
           'seconds': round(time.time() - t0, 1), 'frame': 'app world metres, eye (0,1.6,0), -z forward; load with identity transform',
           'views': log}
(OUT / f'surround-lift-{RES}.json').write_text(json.dumps(summary, indent=1), encoding='utf-8')
print('done', n, 'gaussians', summary['seconds'], 's', flush=True)
