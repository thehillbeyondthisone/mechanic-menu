"""Read-only: fraction of each wall-sign box hidden by splats in front of it, in the corrected room
frame (src/room-frame.js). Input: JSON of wall signs written by node from src/layout.js (path argv[1]).
Splats: preserved original PLY, centres + 1.5x largest scale, opacity > 0.25 (as in check_wall_occlusion.py)."""
import json, sys
import numpy as np
from scipy.spatial.transform import Rotation
PLY = r'D:/Lustron/experiments/BLUNT/2026-11-04_repair-office-single-image/output/repair-office.ply'
cfg = json.load(open(sys.argv[1]))
with open(PLY, 'rb') as f:
    while f.readline().strip() != b'end_header': pass
    off = f.tell()
a = np.memmap(PLY, '<f4', 'r', offset=off).reshape(-1, 17)
keep = 1 / (1 + np.exp(-a[:, 9])) > 0.25
Rm = Rotation.from_quat(cfg['OFFICE']['rotation']).as_matrix(); sc = np.array(cfg['OFFICE']['scale'])
M = Rm * sc[None, :]
eye = np.array([0, 1.6, 0])
Wp = a[keep][:, :3] @ M.T + eye
Sz = (np.exp(a[keep][:, 10:13]) * sc[None, :]).max(1)
V = Wp - eye; Dn = np.linalg.norm(V, axis=1); Dir = V / Dn[:, None]
n = np.array(cfg['ROOM']['wall']['normal']); t = np.array(cfg['TANGENT'])
def occluded(c, w, h, front):
    A, B = np.meshgrid(np.linspace(-.48, .48, 16), np.linspace(-.45, .45, 5))
    P = c + A.ravel()[:, None] * w * t + B.ravel()[:, None] * h * np.array([0, 1, 0]) + front * n
    hits = 0
    for p in P:
        v = p - eye; d = np.linalg.norm(v); u = v / d
        m = (Dn < d - 0.01) & (Dir @ u > np.cos(0.05))
        if m.any():
            ang = np.arccos(np.clip(Dir[m] @ u, -1, 1)); hits += (ang * Dn[m] < 1.5 * Sz[m]).any()
    return hits / len(P)
shifts = [float(x) for x in sys.argv[2:]] or [0.0]
for dx in shifts:   # dx: move the whole list along the wall (metres, negative = further left)
    for s in cfg['signs']:
        c = np.array(s['position']) + dx * t
        print(f"shift {dx:+.2f} {s['text']:<20} y {c[1]:.2f} occluded {occluded(c, s['width'], s['size'], s['depth'] / 2):.2f}")
