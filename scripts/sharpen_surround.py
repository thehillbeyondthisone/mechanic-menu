"""Upscale the generated surround views 2x and assemble training data from them.

Input: the output folder of scripts/outpaint_surround.py (views/NN-name.jpg + -mask.png, surround.json).
Each generated view (1024 px, 90 deg, ~11 px/degree) is upscaled to 2048 px (~23 px/degree) with
Real-ESRGAN x2plus (BSD-3, D:\\Lustron\\models\\realesrgan-x2plus, loaded weights-only). A dedicated
super-resolution model keeps the content; an SDXL img2img detail pass was tried first and rewrote objects
without getting sharper (see the run record).

Writes to <out>:
  views/NN-name.jpg + -mask.png   2048 px views and the pixels each view generated (for lift_surround.py)
  train-masks/NN-name.png         training mask: the view's own pixels plus a small margin (white = train)
  surround-sharp.jpg              8192x4096 panorama: the photo re-seeded at full resolution + upscaled views
  surround.json                   metadata (views with yaw/pitch, as lift_surround.py expects)
Run with the shared Python (torch cu121):  python scripts/sharpen_surround.py <outpaint output> <out>
"""
import argparse, json, math, re, time
from pathlib import Path
import numpy as np, cv2, torch
import torch.nn as nn, torch.nn.functional as F

ap = argparse.ArgumentParser()
ap.add_argument('src'); ap.add_argument('out')
ap.add_argument('--weights', default=r'D:\Lustron\models\realesrgan-x2plus\RealESRGAN_x2plus.pth')
ap.add_argument('--margin', type=int, default=24, help='training-mask margin around each view\'s own pixels (2048 px scale)')
ap.add_argument('--limit', type=int, default=99)
args = ap.parse_args()
SRC, OUT = Path(args.src), Path(args.out)
for d in ('views', 'train-masks'): (OUT / d).mkdir(parents=True, exist_ok=True)
ROOT = Path(__file__).resolve().parents[1]
BLUNT = Path(r'D:\Lustron\experiments\BLUNT\2026-11-04_repair-office-single-image')
meta = json.loads((SRC / 'surround.json').read_text(encoding='utf-8'))
PW, PH, VIEW, FOV = 8192, 4096, 2048, float(meta['view'][1])
t = math.tan(math.radians(FOV) / 2)

# Real-ESRGAN RRDBNet (x2: pixel-unshuffle input), same layout and parameter names as basicsr.
class RDB(nn.Module):
    def __init__(s, nf=64, gc=32):
        super().__init__()
        s.conv1, s.conv2, s.conv3, s.conv4 = (nn.Conv2d(nf + i * gc, gc, 3, 1, 1) for i in range(4))
        s.conv5 = nn.Conv2d(nf + 4 * gc, nf, 3, 1, 1); s.lrelu = nn.LeakyReLU(0.2, True)
    def forward(s, x):
        x1 = s.lrelu(s.conv1(x)); x2 = s.lrelu(s.conv2(torch.cat((x, x1), 1)))
        x3 = s.lrelu(s.conv3(torch.cat((x, x1, x2), 1))); x4 = s.lrelu(s.conv4(torch.cat((x, x1, x2, x3), 1)))
        return s.conv5(torch.cat((x, x1, x2, x3, x4), 1)) * 0.2 + x
class RRDB(nn.Module):
    def __init__(s, nf, gc):
        super().__init__(); s.rdb1, s.rdb2, s.rdb3 = RDB(nf, gc), RDB(nf, gc), RDB(nf, gc)
    def forward(s, x): return s.rdb3(s.rdb2(s.rdb1(x))) * 0.2 + x
class RRDBNet(nn.Module):
    def __init__(s, nf=64, nb=23, gc=32):
        super().__init__()
        s.conv_first = nn.Conv2d(12, nf, 3, 1, 1); s.body = nn.Sequential(*[RRDB(nf, gc) for _ in range(nb)])
        s.conv_body, s.conv_up1, s.conv_up2, s.conv_hr = (nn.Conv2d(nf, nf, 3, 1, 1) for _ in range(4))
        s.conv_last = nn.Conv2d(nf, 3, 3, 1, 1); s.lrelu = nn.LeakyReLU(0.2, True)
    def forward(s, x):
        feat = s.conv_first(F.pixel_unshuffle(x, 2)); feat = feat + s.conv_body(s.body(feat))
        feat = s.lrelu(s.conv_up1(F.interpolate(feat, scale_factor=2, mode='nearest')))
        feat = s.lrelu(s.conv_up2(F.interpolate(feat, scale_factor=2, mode='nearest')))
        return s.conv_last(s.lrelu(s.conv_hr(feat)))

net = RRDBNet()
state = torch.load(args.weights, map_location='cpu', weights_only=True)
net.load_state_dict(state.get('params_ema', state.get('params', state)), strict=True)
net = net.eval().half().cuda()

@torch.inference_mode()
def upscale(bgr):
    x = torch.from_numpy(cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)).permute(2, 0, 1)[None].half().cuda() / 255
    y = net(F.pad(x, (8, 8, 8, 8), mode='reflect'))[..., 16:-16, 16:-16].clamp(0, 1)
    return cv2.cvtColor((y[0].permute(1, 2, 0).float().cpu().numpy() * 255 + 0.5).astype(np.uint8), cv2.COLOR_RGB2BGR)

def pano_dirs():
    lon = (np.arange(PW) + 0.5) / PW * 2 * np.pi - np.pi
    lat = np.pi / 2 - (np.arange(PH) + 0.5) / PH * np.pi
    LON, LAT = np.meshgrid(lon, lat)
    return np.stack([np.cos(LAT) * np.sin(LON), np.sin(LAT), -np.cos(LAT) * np.cos(LON)], -1).astype(np.float32)

def view_basis(yaw, pitch):   # same as outpaint_surround.py
    y, p = math.radians(yaw), math.radians(pitch)
    Ry = np.array([[math.cos(y), 0, -math.sin(y)], [0, 1, 0], [math.sin(y), 0, math.cos(y)]])
    Rx = np.array([[1, 0, 0], [0, math.cos(p), -math.sin(p)], [0, math.sin(p), math.cos(p)]])
    return Ry @ Rx

# Panorama: the photo re-seeded at full resolution (same projection as outpaint_surround.py).
D = pano_dirs()
pano = cv2.resize(cv2.imread(str(SRC / 'surround.jpg')), (PW, PH), interpolation=cv2.INTER_LANCZOS4)
frame = (ROOT / 'src' / 'room-frame.js').read_text(encoding='utf-8')
from scipy.spatial.transform import Rotation
R = Rotation.from_quat(json.loads(re.search(r'rotation: (\[[^\]]+\])', frame).group(1))).as_matrix()
K = np.load(BLUNT / 'output' / 'predicted-intrinsics.npy'); cx, cy = float(K[0, 2]), float(K[1, 2])
photo = cv2.imread(str(BLUNT / 'input' / 'source.jpg')); ph, pw = photo.shape[:2]
cam = D @ R
with np.errstate(divide='ignore', invalid='ignore'):
    pu = meta['focal'] * cam[..., 0] / cam[..., 2] + cx; pv = meta['focal'] * cam[..., 1] / cam[..., 2] + cy
inside = (cam[..., 2] > 0) & (pu >= 0.5) & (pu <= 2 * cx - 0.5) & (pv >= 0.5) & (pv <= 2 * cy - 0.5)
mx = np.where(inside, pu * pw / (2 * cx), -1).astype(np.float32); my = np.where(inside, pv * ph / (2 * cy), -1).astype(np.float32)
pano = np.where(inside[..., None], cv2.remap(photo, mx, my, cv2.INTER_LANCZOS4, borderMode=cv2.BORDER_REPLICATE), pano)
owned = inside.copy(); del cam, pu, pv, mx, my

log, t0 = [], time.time()
views = [v for v in meta['views'] if 'yaw' in v][:args.limit]
for i, v in enumerate(views):
    src = next(SRC.glob(f'views/*-{v["view"]}.jpg'))
    sharp = upscale(cv2.imread(str(src)))
    mask = cv2.resize(cv2.imread(str(src.with_name(src.stem + '-mask.png')), 0), (VIEW, VIEW), interpolation=cv2.INTER_NEAREST) > 127
    name = f'{i:02d}-{v["view"]}'
    cv2.imwrite(str(OUT / 'views' / f'{name}.jpg'), sharp, [cv2.IMWRITE_JPEG_QUALITY, 95])
    cv2.imwrite(str(OUT / 'views' / f'{name}-mask.png'), mask.astype(np.uint8) * 255)
    k = 2 * args.margin + 1
    cv2.imwrite(str(OUT / 'train-masks' / f'{name}.png'), cv2.dilate(mask.astype(np.uint8), np.ones((k, k), np.uint8)) * 255)
    # Panorama pixels this view generated (same rule as outpaint_surround.write_back, replayed in order).
    B = view_basis(v['yaw'], v['pitch']); vv = D @ B
    with np.errstate(divide='ignore', invalid='ignore'):
        x = vv[..., 0] / -vv[..., 2]; y = vv[..., 1] / -vv[..., 2]
    sel = (vv[..., 2] < 0) & (np.abs(x) < t * 0.97) & (np.abs(y) < t * 0.97) & ~owned
    gx = ((x / t + 1) / 2 * VIEW - 0.5).astype(np.float32); gy = ((-y / t + 1) / 2 * VIEW - 0.5).astype(np.float32)
    pano[sel] = cv2.remap(sharp, gx, gy, cv2.INTER_LANCZOS4, borderMode=cv2.BORDER_REFLECT)[sel]; owned |= sel
    lap = lambda im: float(cv2.Laplacian(cv2.cvtColor(im, cv2.COLOR_BGR2GRAY), cv2.CV_32F)[mask].var())
    base = cv2.resize(cv2.imread(str(src)), (VIEW, VIEW), interpolation=cv2.INTER_LANCZOS4)
    log.append({'view': v['view'], 'yaw': v['yaw'], 'pitch': v['pitch'], 'own_px': int(mask.sum()), 'pano_px': int(sel.sum()),
                'laplacian_var_lanczos_vs_esrgan': [round(lap(base), 1), round(lap(sharp), 1)], 'seconds': round(time.time() - t0, 1)})
    print(json.dumps(log[-1]), flush=True)

cv2.imwrite(str(OUT / 'surround-sharp.jpg'), pano, [cv2.IMWRITE_JPEG_QUALITY, 92])
summary = dict(meta, views=log, panorama=[PW, PH], view=[VIEW, FOV], upscaler='Real-ESRGAN RealESRGAN_x2plus.pth (BSD-3)',
               unowned_after=float((~owned).mean()), seconds=round(time.time() - t0, 1))
(OUT / 'surround.json').write_text(json.dumps(summary, indent=1), encoding='utf-8')
print('done', round(time.time() - t0, 1), 's', flush=True)
