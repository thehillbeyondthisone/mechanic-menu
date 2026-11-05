"""Build a LichtFeld (COLMAP text) dataset for training the generated surround, plus the photo splat in world space.

Inputs: <sharp>  output of scripts/sharpen_surround.py (views/ 2048 px + masks, train-masks/, surround.json)
        <lift>   output of scripts/lift_surround.py run on <sharp> (depth/*.npy, surround-lift-*.ply)
Writes <out>/dataset/{images,masks,depths,sparse/0} and <out>/office-world.ply.

Cameras: every view is a 90 deg pinhole camera at the capture eye (0, 1.6, 0) in app world metres
(-z forward, y up). Masks (white = train) cover each view's own generated pixels plus a margin, so every
direction is supervised by the view that generated it. Images get the same seam colour levelling as the lift.
Depths: the lift's aligned depth, 16-bit PNG in 0.1 mm (use with --depth-loss-mode ssi-depth).
office-world.ply: the original photo splat with the app's OFFICE transform baked in (positions, and
covariances re-decomposed because the transform scales unevenly), for --add-splat ... --freeze.
"""
import json, math, re, shutil, sys
from pathlib import Path
import numpy as np, cv2
from scipy.spatial.transform import Rotation

SHARP, LIFT, OUT = (Path(a) for a in sys.argv[1:4])
ROOT = Path(__file__).resolve().parents[1]
BLUNT = Path(r'D:\Lustron\experiments\BLUNT\2026-11-04_repair-office-single-image')
EYE = np.array([0.0, 1.6, 0.0])
meta = json.loads((SHARP / 'surround.json').read_text(encoding='utf-8'))
VIEW, FOV = meta['view']; t = math.tan(math.radians(FOV) / 2); F = VIEW / 2 / t
DS = OUT / 'dataset'
if DS.exists(): raise SystemExit(f'refusing to overwrite {DS}')
for d in ('images', 'masks', 'depths', 'sparse/0'): (DS / d).mkdir(parents=True)

def view_basis(yaw, pitch):
    y, p = math.radians(yaw), math.radians(pitch)
    Ry = np.array([[math.cos(y), 0, -math.sin(y)], [0, 1, 0], [math.sin(y), 0, math.cos(y)]])
    Rx = np.array([[1, 0, 0], [0, math.cos(p), -math.sin(p)], [0, math.sin(p), math.cos(p)]])
    return Ry @ Rx

def spread(values, weights, sigma):
    return cv2.GaussianBlur(values * weights, (0, 0), sigma), cv2.GaussianBlur(weights, (0, 0), sigma)

def level_seams(img, mask):   # same method as lift_surround.level_seams, at this resolution
    m8 = mask.astype(np.uint8); s = img.shape[0] / 1024
    inside = cv2.distanceTransform(m8, cv2.DIST_L2, 5); outside = cv2.distanceTransform(1 - m8, cv2.DIST_L2, 5)
    ring_new = ((inside > 0) & (inside <= 8 * s)).astype(np.float32)
    ring_old = ((outside >= 20 * s) & (outside <= 32 * s)).astype(np.float32)
    if ring_new.sum() < 50 or ring_old.sum() < 50: return img
    f = img.astype(np.float32); sig = 24 * s
    a_num, a_den = spread(f, ring_old[..., None].repeat(3, -1), sig)
    b_num, b_den = spread(f, ring_new[..., None].repeat(3, -1), sig)
    both = ((a_den[..., 0] > 0.02) & (b_den[..., 0] > 0.02)).astype(np.float32)
    D = np.where(both[..., None] > 0, a_num / np.maximum(a_den, 1e-6) - b_num / np.maximum(b_den, 1e-6), 0)
    num, den = spread(D.astype(np.float32), (both * ring_new)[..., None].repeat(3, -1), 60 * s)
    return np.where(mask[..., None], np.clip(f + num / (den + 0.02), 0, 255), f).astype(np.uint8)

cams, imgs, pts = [], [], []
for i, v in enumerate(meta['views']):
    name = f'{i:02d}-{v["view"]}'
    img = cv2.imread(str(SHARP / 'views' / f'{name}.jpg')); own = cv2.imread(str(SHARP / 'views' / f'{name}-mask.png'), 0) > 127
    cv2.imwrite(str(DS / 'images' / f'{name}.jpg'), level_seams(img, own), [cv2.IMWRITE_JPEG_QUALITY, 95])
    shutil.copyfile(SHARP / 'train-masks' / f'{name}.png', DS / 'masks' / f'{name}.png')
    z = np.load(LIFT / 'depth' / f'{name}.npy')
    cv2.imwrite(str(DS / 'depths' / f'{name}.png'), np.clip(z * 10000, 1, 65535).astype(np.uint16))
    M = view_basis(v['yaw'], v['pitch']) @ np.diag([1.0, -1.0, -1.0])   # OpenCV camera -> world
    Rwc = M.T; tvec = -Rwc @ EYE
    x, y, zq, w = Rotation.from_matrix(Rwc).as_quat()
    imgs.append(f'{i + 1} {w:.9f} {x:.9f} {y:.9f} {zq:.9f} {tvec[0]:.9f} {tvec[1]:.9f} {tvec[2]:.9f} 1 {name}.jpg\n\n')
(DS / 'sparse/0/cameras.txt').write_text(f'# PINHOLE, square pixels, 90 deg\n1 PINHOLE {VIEW} {VIEW} {F:.6f} {F:.6f} {VIEW / 2:.6f} {VIEW / 2:.6f}\n')
(DS / 'sparse/0/images.txt').write_text('# IMAGE_ID QW QX QY QZ TX TY TZ CAMERA_ID NAME (world to camera)\n' + ''.join(imgs))

def read_ply(path):
    with open(path, 'rb') as f:
        header = b''
        while not header.endswith(b'end_header\n'): header += f.readline()
        names = [p.decode() for p in re.findall(rb'property float (\w+)', header)]
        n = int(re.search(rb'element vertex (\d+)', header).group(1))
        data = np.fromfile(f, np.float32, n * len(names)).reshape(n, len(names))
    return names, data

def write_ply(path, names, data):
    header = 'ply\nformat binary_little_endian 1.0\n' + f'element vertex {len(data)}\n' + ''.join(f'property float {p}\n' for p in names) + 'end_header\n'
    with open(path, 'wb') as f: f.write(header.encode('ascii')); f.write(np.ascontiguousarray(data, np.float32).tobytes())

# A sparse point sample from the init so the COLMAP loader has points (training starts from --init anyway).
names, data = read_ply(next(LIFT.glob('surround-lift-*.ply')))
col = lambda k: data[:, names.index(k)]
rng = np.random.default_rng(5); pick = rng.choice(len(data), 20000, replace=False)
rgb = np.clip((np.stack([col('f_dc_0'), col('f_dc_1'), col('f_dc_2')], 1)[pick] * 0.28209479 + 0.5) * 255, 0, 255).astype(int)
xyz = np.stack([col('x'), col('y'), col('z')], 1)[pick]
(DS / 'sparse/0/points3D.txt').write_text('# POINT3D_ID X Y Z R G B ERROR TRACK[]\n' + ''.join(
    f'{k + 1} {p[0]:.6f} {p[1]:.6f} {p[2]:.6f} {c[0]} {c[1]} {c[2]} 0\n' for k, (p, c) in enumerate(zip(xyz, rgb))))

# Photo splat in world space: world = pos + Rot(scale * p); covariance A S S^T A^T with A = Rot diag(scale).
frame = (ROOT / 'src' / 'room-frame.js').read_text(encoding='utf-8')
grab = lambda key: np.array(json.loads(re.search(key + r': (\[[^\]]+\])', frame).group(1)), np.float64)
rot, scale, pos = Rotation.from_quat(grab('rotation')), grab('scale'), grab('position')
names, data = read_ply(BLUNT / 'output' / 'repair-office.ply')
c = {k: data[:, i].astype(np.float64) for i, k in enumerate(names)}
A = rot.as_matrix() @ np.diag(scale)
xyz = np.stack([c['x'], c['y'], c['z']], 1) @ A.T + pos
Rg = Rotation.from_quat(np.stack([c['rot_1'], c['rot_2'], c['rot_3'], c['rot_0']], 1)).as_matrix()
L = Rg * np.exp(np.stack([c['scale_0'], c['scale_1'], c['scale_2']], 1))[:, None, :]   # R S
AL = A[None] @ L
cov = AL @ AL.transpose(0, 2, 1)
evals, evecs = np.linalg.eigh(cov)
evecs[np.linalg.det(evecs) < 0, :, 2] *= -1
q = Rotation.from_matrix(evecs).as_quat()
out = data.copy()
for k, val in (('x', xyz[:, 0]), ('y', xyz[:, 1]), ('z', xyz[:, 2]), ('scale_0', 0.5 * np.log(np.maximum(evals[:, 0], 1e-20))),
               ('scale_1', 0.5 * np.log(np.maximum(evals[:, 1], 1e-20))), ('scale_2', 0.5 * np.log(np.maximum(evals[:, 2], 1e-20))),
               ('rot_0', q[:, 3]), ('rot_1', q[:, 0]), ('rot_2', q[:, 1]), ('rot_3', q[:, 2])):
    out[:, names.index(k)] = val
assert np.isfinite(out).all()
# Check: covariance rebuilt from the new scales/rotation matches A Sigma A^T.
chk = slice(0, 2000); Rn = Rotation.from_quat(q[chk]).as_matrix(); Sn = np.exp(out[chk][:, [names.index('scale_0'), names.index('scale_1'), names.index('scale_2')]])
err = np.abs((Rn * Sn[:, None, :] ** 2) @ Rn.transpose(0, 2, 1) - cov[chk]).max() / np.abs(cov[chk]).max()
write_ply(OUT / 'office-world.ply', names, out)
print(json.dumps({'views': len(imgs), 'focal': F, 'init_points': 20000, 'office_gaussians': len(out), 'office_cov_rel_err': float(err)}))
