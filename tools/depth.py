"""Monocular depth for the single Patterson photo.

Runs Depth Anything 3 (BASE, Apache-2.0) from the earlier BLUNT run's
read-only source + weights, on GPU when available, with a horizontal-flip
pass averaged in. Writes depth + intrinsics at the full photo resolution.

usage: python depth.py <da3-python-env-root> <photo.jpg> <out_dir>
"""
import json
import sys
import time
from pathlib import Path

import numpy as np
from PIL import Image

DA3_RUN = Path(r"D:\Lustron\experiments\BLUNT\2026-11-04_repair-office-single-image")
DA3_SRC = DA3_RUN / "source/Depth-Anything-3-3d835ec1a5802d64a8b8b15f817a1ab54809bfe4/src"
DA3_WEIGHTS = next((DA3_RUN / "cache/huggingface/hub/models--depth-anything--DA3-BASE/snapshots").iterdir())


def run(model, img, res, device):
    import torch
    with torch.inference_mode():
        pred = model.inference([img], process_res=res)
    return pred.depth[0].astype(np.float32), pred.intrinsics[0].astype(np.float64), \
        (pred.conf[0].astype(np.float32) if pred.conf is not None else None)


def main():
    photo, out = Path(sys.argv[1]), Path(sys.argv[2])
    res = int(sys.argv[3]) if len(sys.argv) > 3 else 1512
    out.mkdir(parents=True, exist_ok=True)
    sys.path.insert(0, str(DA3_SRC))
    import torch
    from depth_anything_3.api import DepthAnything3

    device = "cuda" if torch.cuda.is_available() else "cpu"
    t0 = time.time()
    model = DepthAnything3.from_pretrained(str(DA3_WEIGHTS)).to(device).eval()
    img = Image.open(photo).convert("RGB")
    W, H = img.size

    d0, K0, c0 = run(model, img, res, device)
    d1, K1, c1 = run(model, img.transpose(Image.FLIP_LEFT_RIGHT), res, device)
    d1 = d1[:, ::-1]
    # flip pass may land at a slightly different scale; align by median before averaging
    s = np.median(d0) / np.median(d1)
    depth = 0.5 * (d0 + d1 * s)
    conf = None if c0 is None else 0.5 * (c0 + c1[:, ::-1])
    h, w = depth.shape
    K = K0.copy()
    K[0] *= W / w
    K[1] *= H / h
    np.save(out / "depth-model-res.npy", depth)
    if conf is not None:
        np.save(out / "conf-model-res.npy", conf)
    meta = {
        "model": "depth-anything/DA3-BASE (Apache-2.0)",
        "device": device, "process_res": res, "model_hw": [h, w], "photo_hw": [H, W],
        "flip_scale": float(s), "K_photo": K.tolist(),
        "fov_y_deg": float(np.degrees(2 * np.arctan(H / 2 / K[1, 1]))),
        "fov_x_deg": float(np.degrees(2 * np.arctan(W / 2 / K[0, 0]))),
        "depth_min": float(depth.min()), "depth_max": float(depth.max()),
        "depth_median": float(np.median(depth)), "seconds": time.time() - t0,
    }
    (out / "depth-meta.json").write_text(json.dumps(meta, indent=2))
    print(json.dumps(meta, indent=2))


if __name__ == "__main__":
    main()
