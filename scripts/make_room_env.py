"""Bake a small, blurred equirect reflection map of the office from the source photo.

The letters' metal and enamel reflect this so they pick up the room's own colours.
Directions outside the photo fold back onto it (a rough enclosure, not measured geometry).
Reads the preserved source read-only. Run with: python scripts/make_room_env.py
"""
from pathlib import Path
import numpy as np
from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parents[1]
RUN = Path(r'D:\Lustron\experiments\BLUNT\2026-11-04_repair-office-single-image')
PHOTO = RUN / 'input' / 'source.jpg'
K = np.load(RUN / 'output' / 'predicted-intrinsics.npy')  # intrinsics at depth resolution
DEPTH_W = 756
OUTPUT = ROOT / 'public' / 'assets' / 'room-env.jpg'
W, H = 512, 256

photo = np.asarray(Image.open(PHOTO).convert('RGB'), dtype=np.float32)
scale = photo.shape[1] / DEPTH_W
fx, fy, cx, cy = K[0, 0] * scale, K[1, 1] * scale, K[0, 2] * scale, K[1, 2] * scale

# PlayCanvas equirect: u = atan(x, z) / 2pi + 0.5, v = 0.5 - asin(y) / pi (top row is up).
u = (np.arange(W) + 0.5) / W
v = (np.arange(H) + 0.5) / H
phi = (u[None, :] - 0.5) * 2 * np.pi
theta = (0.5 - v[:, None]) * np.pi
x = np.cos(theta) * np.sin(phi)
y = np.sin(theta) * np.ones_like(phi)
z = np.cos(theta) * np.cos(phi)
# App world looks down -z with y up; the photo camera looks down +Z with Y down.
X, Y, Z = x, -y, np.maximum(np.abs(-z), 0.25)
px = np.clip(fx * X / Z + cx, 0, photo.shape[1] - 1).astype(int)
py = np.clip(fy * Y / Z + cy, 0, photo.shape[0] - 1).astype(int)
env = photo[py, px]
behind = (-z) <= 0
env[behind] *= 0.7  # what is behind the viewer was never photographed: keep it dimmer
image = Image.fromarray(np.clip(env, 0, 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(3))
OUTPUT.parent.mkdir(parents=True, exist_ok=True)
image.save(OUTPUT, quality=88)
print(f'Wrote {OUTPUT.relative_to(ROOT)} {W}x{H}')
