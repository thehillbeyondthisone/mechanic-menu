"""Generate the directions the photo never saw, as one 360-degree panorama around the eye.

Local only: SDXL inpainting (diffusers/stable-diffusion-xl-1.0-inpainting-0.1, fp16) from the
HF cache under D:\\Lustron\\models\\hf-cache. Nothing is uploaded. Generated pixels are invented.

The panorama is equirectangular in the app's levelled room frame (content space: y up, -z forward):
  lon = atan2(x, -z) (0 = straight ahead, + = to the right), lat = asin(y).
It is seeded by projecting the photo through the corrected camera (square f, rotation from
src/room-frame.js). Overlapping 90-degree views are then rendered from the panorama, their unknown
pixels inpainted, and only newly generated pixels written back, so later views see earlier ones.

Usage: python scripts/outpaint_surround.py <output-dir>
Writes <out>/surround.jpg, <out>/surround-known.png (255 = photo, 128 = generated), views/*.jpg.
"""
import json, math, os, re, sys, time
from pathlib import Path
import numpy as np
import cv2

OUT = Path(sys.argv[1]); (OUT / 'views').mkdir(parents=True, exist_ok=True)
ROOT = Path(__file__).resolve().parents[1]
BLUNT = Path(r'D:\Lustron\experiments\BLUNT\2026-11-04_repair-office-single-image')
PW, PH = 4096, 2048           # panorama size
VIEW, FOV = 1024, 90.0        # generated view size and field of view
F_SQUARE = 700.0              # square-pixel focal length at depth-map resolution (see make_room_shell.py)

frame = (ROOT / 'src' / 'room-frame.js').read_text(encoding='utf-8')
quat = json.loads(re.search(r'rotation: (\[[^\]]+\])', frame).group(1))
from scipy.spatial.transform import Rotation
R = Rotation.from_quat(quat).as_matrix()      # camera (y down, z forward) -> content
K = np.load(BLUNT / 'output' / 'predicted-intrinsics.npy'); cx, cy = float(K[0, 2]), float(K[1, 2])
photo = cv2.imread(str(BLUNT / 'input' / 'source.jpg'))   # BGR, 1536x2048
ph, pw = photo.shape[:2]; sx = pw / (2 * cx); sy = ph / (2 * cy)

def pano_dirs():
    lon = (np.arange(PW) + 0.5) / PW * 2 * np.pi - np.pi
    lat = np.pi / 2 - (np.arange(PH) + 0.5) / PH * np.pi
    LON, LAT = np.meshgrid(lon, lat)
    return np.stack([np.cos(LAT) * np.sin(LON), np.sin(LAT), -np.cos(LAT) * np.cos(LON)], -1)

def dir_to_pano(d):
    lon = np.arctan2(d[..., 0], -d[..., 2]); lat = np.arcsin(np.clip(d[..., 1], -1, 1))
    return ((lon + np.pi) / (2 * np.pi) * PW - 0.5).astype(np.float32), ((np.pi / 2 - lat) / np.pi * PH - 0.5).astype(np.float32)

# Seed with the photo.
D = pano_dirs()
cam = D @ R            # rows: content dir -> camera coords (R.T @ d)
with np.errstate(divide='ignore', invalid='ignore'):
    pu = F_SQUARE * cam[..., 0] / cam[..., 2] + cx; pv = F_SQUARE * cam[..., 1] / cam[..., 2] + cy
inside = (cam[..., 2] > 0) & (pu >= 0.5) & (pu <= 2 * cx - 0.5) & (pv >= 0.5) & (pv <= 2 * cy - 0.5)
pano = np.zeros((PH, PW, 3), np.uint8)
mx = np.where(inside, pu * sx, -1).astype(np.float32); my = np.where(inside, pv * sy, -1).astype(np.float32)
pano[:] = cv2.remap(photo, mx, my, cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT)
known = np.where(inside, 255, 0).astype(np.uint8)
print(f'photo covers {inside.mean() * 100:.1f}% of the sphere', flush=True)

def view_basis(yaw, pitch):
    """Rotation whose columns are the view's right, up and back (+z) axes in content space."""
    y, p = math.radians(yaw), math.radians(pitch)
    Ry = np.array([[math.cos(y), 0, -math.sin(y)], [0, 1, 0], [math.sin(y), 0, math.cos(y)]])  # + yaw turns right
    Rx = np.array([[1, 0, 0], [0, math.cos(p), -math.sin(p)], [0, math.sin(p), math.cos(p)]])   # + pitch looks up
    return Ry @ Rx

t = math.tan(math.radians(FOV) / 2)
g = ((np.arange(VIEW) + 0.5) / VIEW * 2 - 1) * t
GX, GY = np.meshgrid(g, -g)
local = np.stack([GX, GY, -np.ones_like(GX)], -1); local /= np.linalg.norm(local, axis=-1, keepdims=True)

def render(B):
    d = local @ B.T
    mxv, myv = dir_to_pano(d)
    img = cv2.remap(pano, mxv, myv, cv2.INTER_LINEAR, borderMode=cv2.BORDER_WRAP)
    msk = cv2.remap(known, mxv, myv, cv2.INTER_NEAREST, borderMode=cv2.BORDER_WRAP)
    return img, msk

def write_back(B, gen, gmask):
    """Write generated pixels into unknown panorama pixels that this view sees."""
    global pano, known
    v = D @ B   # panorama directions in view coords
    with np.errstate(divide='ignore', invalid='ignore'):
        x = v[..., 0] / -v[..., 2]; y = v[..., 1] / -v[..., 2]
    lim = t * 0.97
    sel = (v[..., 2] < 0) & (np.abs(x) < lim) & (np.abs(y) < lim) & (known == 0)
    gx = ((x / t + 1) / 2 * VIEW - 0.5).astype(np.float32); gy = ((-y / t + 1) / 2 * VIEW - 0.5).astype(np.float32)
    sample = cv2.remap(gen, gx, gy, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT)
    pano[sel] = sample[sel]; known[sel] = 128
    return int(sel.sum())

BASE = ('photo inside a cluttered old auto repair shop office, faded car parts posters and notices on the walls, '
        'shelves of boxes and parts, warm fluorescent light, realistic phone photo')
NEG = 'people, person, hands, face, text, watermark, logo, blurry, distorted, fisheye, cartoon, painting, render, oversaturated'
VIEWS = [  # (name, yaw, pitch, extra prompt) in order; each sees earlier results
    ('front', 0, 0, 'cluttered service counter, posters'),
    ('right-60', 60, 0, 'poster-covered wall, shelves of parts and boxes, office desk with old computer'),
    ('left-60', -60, 0, 'poster-covered wall, filing cabinets, framed certificates, notice board'),
    ('right-120', 120, 0, 'wall with shelves and a doorway to the repair garage'),
    ('left-120', -120, 0, 'wall with a parts catalogue rack, chairs for customers'),
    ('back', 180, 0, 'the shop front: glass entry door and a window with blinds, a customer chair, a small table with magazines'),
    ('up-front', 0, 60, 'white ceiling with fluorescent tube light fixtures'),
    ('up-right', 90, 60, 'white ceiling with fluorescent tube light fixtures'),
    ('up-back', 180, 60, 'white ceiling with fluorescent tube light fixtures'),
    ('up-left', -90, 60, 'white ceiling with fluorescent tube light fixtures'),
    ('zenith', 0, 90, 'plain white painted ceiling, fluorescent tube light'),
    ('down-front', 0, -60, 'worn grey concrete floor, scuffed, base of the counter'),
    ('down-right', 90, -60, 'worn grey concrete floor, scuffed'),
    ('down-back', 180, -60, 'worn grey concrete floor, scuffed, a rubber floor mat'),
    ('down-left', -90, -60, 'worn grey concrete floor, scuffed'),
    ('nadir', 0, -90, 'worn grey concrete floor seen from above, scuffed, a rubber floor mat'),
]

import torch
from diffusers import StableDiffusionXLInpaintPipeline
MODEL = Path(r'D:\Lustron\models\sdxl-inpainting-0.1')   # local copy of diffusers/stable-diffusion-xl-1.0-inpainting-0.1
pipe = StableDiffusionXLInpaintPipeline.from_pretrained(str(MODEL), torch_dtype=torch.float16, variant='fp16', local_files_only=True)
# Desktop apps hold ~2.5 GB of the 12 GB card; a full GPU load spilled into shared memory and stalled
# (attempt 2 check hung >4 min on the second view). Offload keeps only the active part on the GPU.
pipe.enable_model_cpu_offload(); pipe.set_progress_bar_config(disable=True)
log = []
start = time.time()
LIMIT = int(os.environ.get("VIEW_LIMIT", len(VIEWS)))   # for quick checks
for i, (name, yaw, pitch, extra) in enumerate(VIEWS[:LIMIT]):
    B = view_basis(yaw, pitch)
    img, msk = render(B)
    unknown = (msk == 0).astype(np.uint8)
    if unknown.mean() < 0.002:
        log.append({'view': name, 'skipped': 'already known'}); continue
    # Repaint a 12 px band of known pixels too, so the new content blends into what is there.
    paint = cv2.dilate(unknown, np.ones((25, 25), np.uint8))
    # Attempt 1 passed black holes and the model (strength 0.99) kept them nearly black. Pre-fill the
    # holes with the surrounding colours (Telea at low resolution, blurred) plus noise to repaint from.
    rng = np.random.default_rng(1105 + i)
    if (unknown == 0).mean() > 0.01:
        small = cv2.inpaint(cv2.resize(img, (256, 256), interpolation=cv2.INTER_AREA),
                            cv2.resize(unknown, (256, 256), interpolation=cv2.INTER_NEAREST), 20, cv2.INPAINT_TELEA)
        base = cv2.GaussianBlur(cv2.resize(small, (VIEW, VIEW), interpolation=cv2.INTER_CUBIC).astype(np.float32), (0, 0), 10)
    else:
        base = np.full((VIEW, VIEW, 3), (112, 128, 142), np.float32)   # BGR warm grey: plaster wall tone
    pre = np.clip(base + rng.normal(0, 20, base.shape), 0, 255).astype(np.uint8)
    seeded = np.where(unknown[..., None] > 0, pre, img)
    from PIL import Image
    for attempt in range(3):   # retry if the new area still comes out dark
        gen = pipe(prompt=f'{BASE}, {extra}', negative_prompt=NEG,
                   image=Image.fromarray(cv2.cvtColor(seeded, cv2.COLOR_BGR2RGB)), mask_image=Image.fromarray(paint * 255),
                   width=VIEW, height=VIEW, num_inference_steps=32, guidance_scale=7.0, strength=0.99,
                   generator=torch.Generator('cuda').manual_seed(1105 + i + 100 * attempt)).images[0]
        gen = cv2.cvtColor(np.array(gen), cv2.COLOR_RGB2BGR)
        new_mean = float(gen[unknown > 0].mean()) if unknown.any() else 255.0
        if new_mean > 45: break
        print(json.dumps({'view': name, 'retry': attempt + 1, 'new_area_mean': round(new_mean, 1)}), flush=True)
    # Keep known pixels exactly; feather the generated band into them.
    soft = cv2.GaussianBlur(paint.astype(np.float32), (0, 0), 6)[..., None]
    w = np.maximum(soft, unknown[..., None].astype(np.float32))
    blended = (gen * w + img * (1 - w)).astype(np.uint8)
    cv2.imwrite(str(OUT / 'views' / f'{i:02d}-{name}.jpg'), blended, [cv2.IMWRITE_JPEG_QUALITY, 90])
    cv2.imwrite(str(OUT / 'views' / f'{i:02d}-{name}-mask.png'), unknown * 255)
    n = write_back(B, blended, unknown)
    log.append({'view': name, 'yaw': yaw, 'pitch': pitch, 'unknown_fraction': round(float(unknown.mean()), 3), 'written': n,
                'new_area_mean': round(new_mean, 1), 'attempts': attempt + 1,
                'seconds': round(time.time() - start, 1)})
    print(json.dumps(log[-1]), flush=True)

# Any remaining holes (seams at the poles) get filled by inpainting in panorama space.
holes = (known == 0).astype(np.uint8)
if holes.any(): pano = cv2.inpaint(pano, holes, 5, cv2.INPAINT_TELEA)
cv2.imwrite(str(OUT / 'surround.jpg'), pano, [cv2.IMWRITE_JPEG_QUALITY, 90])
cv2.imwrite(str(OUT / 'surround-known.png'), known)
json.dump({'model': 'diffusers/stable-diffusion-xl-1.0-inpainting-0.1 fp16', 'panorama': [PW, PH], 'view': [VIEW, FOV],
           'focal': F_SQUARE, 'rotation_quat': quat, 'photo_fraction': float(inside.mean()), 'holes_after_views': int(holes.sum()),
           'views': log, 'seconds': round(time.time() - start, 1), 'base_prompt': BASE, 'negative_prompt': NEG},
          open(OUT / 'surround.json', 'w'), indent=1)
print('done', round(time.time() - start, 1), 's', flush=True)
