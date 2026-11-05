"""Lift the single Patterson photo + DA3 depth into a 3D Gaussian splat.

Outputs (in <out>/):
  patterson-<tier>.spz   web runtime (Spark), Y-up metres, floor at y=0
  patterson-<tier>.ply   standard 3DGS PLY, same frame (for engines/editors)
  scene.json             camera, scale, anchors for menu typography, depth grid info
  depth-grid.bin         float32 low-res depth (metres, along camera z) for ray picking

usage: python build_splat.py <photo> <build_dir> <out_dir> [tier=high|quest]
"""
import gzip
import json
import struct
import sys
from pathlib import Path

import cv2
import numpy as np

# ---- scene calibration (see README: solved from room geometry) ----
FOCAL_PX = 1250.0                 # at 1536x2048
UNIT_TO_M = 2.4                   # DA3 units -> metres (CRT bezel ~0.40 m)
UP_CAM = np.array([0.0657, -0.9866, -0.1465])  # gravity-up in camera coords (x right, y down, z fwd)
EDGE_REL = 0.025                  # relative depth jump between neighbours = discontinuity
SIGMA_K = 0.46                    # gaussian sigma per pixel footprint
OPACITY = 0.995

SH_C0 = 0.28209479177387814


def logit(p):
    return np.log(p / (1 - p))


def box_down(a, s):
    h, w = a.shape[:2]
    return a[:h // s * s, :w // s * s].reshape(h // s, s, w // s, s, *a.shape[2:]).mean((1, 3))


def block_any(m, s):
    h, w = m.shape
    return m[:h // s * s, :w // s * s].reshape(h // s, s, w // s, s).any((1, 3))


def block_std(c, s):
    m = box_down(c, s)
    m2 = box_down(c * c, s)
    return np.sqrt(np.maximum(m2 - m * m, 0)).max(-1)


def robust_grad(z, axis):
    fwd = np.diff(z, axis=axis, append=np.take(z, [-1], axis=axis))
    bwd = np.diff(z, axis=axis, prepend=np.take(z, [0], axis=axis))
    return np.where(np.abs(fwd) < np.abs(bwd), fwd, bwd)


def depth_edges(z):
    e = np.zeros(z.shape, bool)
    near = np.zeros(z.shape, bool)
    for axis in (0, 1):
        for sh in (1, -1):
            zn = np.roll(z, sh, axis=axis)
            jump = np.abs(z - zn) / np.minimum(z, zn) > EDGE_REL
            e |= jump
            near |= jump & (z < zn)
    return e, near


def surfels(u, v, z, zu, zv, s, f, cx, cy, sigma_k, max_stretch=4.0):
    """Gaussians whose footprint matches an s-pixel cell on the local depth surface.
    u,v: cell-centre pixel coords; zu,zv: dz per pixel. Returns centres, scales, quats (camera frame)."""
    s = np.asarray(s, dtype=np.float64)
    sb = s[..., None] if s.ndim else s
    rx, ry = (u - cx) / f, (v - cy) / f
    ray = np.stack([rx, ry, np.ones_like(rx)], -1)
    P = ray * z[:, None]
    a = (zu[:, None] * ray + np.stack([z / f, 0 * z, 0 * z], -1)) * sb  # dP per cell along u
    b = (zv[:, None] * ray + np.stack([0 * z, z / f, 0 * z], -1)) * sb  # dP per cell along v
    # 2x2 Gram matrix -> principal tangent axes (closed-form symmetric eigen)
    g11, g22, g12 = (a * a).sum(1), (b * b).sum(1), (a * b).sum(1)
    tr, det = g11 + g22, g11 * g22 - g12 * g12
    disc = np.sqrt(np.maximum(tr * tr / 4 - det, 0))
    l1, l2 = tr / 2 + disc, np.maximum(tr / 2 - disc, 1e-20)
    # eigenvector for l1 in (a,b) coefficient space
    ex, ey = g12, l1 - g11
    small = (np.abs(ex) + np.abs(ey)) < 1e-14
    ex = np.where(small, 1.0, ex)
    ey = np.where(small, 0.0, ey)
    n = np.sqrt(ex * ex + ey * ey)
    ex, ey = ex / n, ey / n
    s1, s2 = np.sqrt(l1), np.sqrt(l2)
    ax1 = (a * ex[:, None] + b * ey[:, None]) / s1[:, None]
    ax2 = (a * -ey[:, None] + b * ex[:, None]) / s2[:, None]
    # re-orthogonalise
    ax2 -= ax1 * (ax1 * ax2).sum(1, keepdims=True)
    ax2 /= np.linalg.norm(ax2, axis=1, keepdims=True) + 1e-20
    nrm = np.cross(ax1, ax2)
    base = z / f * s
    s1 = np.minimum(s1, base * max_stretch)
    s2 = np.minimum(s2, base * max_stretch)
    scales = np.stack([s1 * sigma_k, s2 * sigma_k, np.minimum(s1, s2) * 0.08], -1)
    R = np.stack([ax1, ax2, nrm], -1)  # columns
    return P, scales, mat_to_quat(R)


def mat_to_quat(R):
    """Rotation matrices (N,3,3) -> quaternions (N,4) as (w,x,y,z)."""
    m00, m11, m22 = R[:, 0, 0], R[:, 1, 1], R[:, 2, 2]
    t = m00 + m11 + m22
    q = np.zeros((len(R), 4))
    c0 = t > 0
    s = np.sqrt(np.maximum(t + 1, 1e-12)) * 2
    q[c0] = np.stack([0.25 * s, (R[:, 2, 1] - R[:, 1, 2]) / s, (R[:, 0, 2] - R[:, 2, 0]) / s,
                      (R[:, 1, 0] - R[:, 0, 1]) / s], -1)[c0]
    c1 = ~c0 & (m00 > m11) & (m00 > m22)
    s = np.sqrt(np.maximum(1 + m00 - m11 - m22, 1e-12)) * 2
    q[c1] = np.stack([(R[:, 2, 1] - R[:, 1, 2]) / s, 0.25 * s, (R[:, 0, 1] + R[:, 1, 0]) / s,
                      (R[:, 0, 2] + R[:, 2, 0]) / s], -1)[c1]
    c2 = ~c0 & ~c1 & (m11 > m22)
    s = np.sqrt(np.maximum(1 + m11 - m00 - m22, 1e-12)) * 2
    q[c2] = np.stack([(R[:, 0, 2] - R[:, 2, 0]) / s, (R[:, 0, 1] + R[:, 1, 0]) / s, 0.25 * s,
                      (R[:, 1, 2] + R[:, 2, 1]) / s], -1)[c2]
    c3 = ~c0 & ~c1 & ~c2
    s = np.sqrt(np.maximum(1 + m22 - m00 - m11, 1e-12)) * 2
    q[c3] = np.stack([(R[:, 1, 0] - R[:, 0, 1]) / s, (R[:, 0, 2] + R[:, 2, 0]) / s,
                      (R[:, 1, 2] + R[:, 2, 1]) / s, 0.25 * s], -1)[c3]
    return q / np.linalg.norm(q, axis=1, keepdims=True)


def quat_mul(a, b):
    w1, x1, y1, z1 = a.T
    w2, x2, y2, z2 = b.T
    return np.stack([w1 * w2 - x1 * x2 - y1 * y2 - z1 * z2, w1 * x2 + x1 * w2 + y1 * z2 - z1 * y2,
                     w1 * y2 - x1 * z2 + y1 * w2 + z1 * x2, w1 * z2 + x1 * y2 - y1 * x2 + z1 * w2], -1)


def world_transform():
    """Camera frame (x right, y down, z fwd, DA3 units) -> world (Y up, metres)."""
    up = UP_CAM / np.linalg.norm(UP_CAM)
    fwd_c = np.array([0, 0, 1.0])
    fwd_c = fwd_c - up * (fwd_c @ up)
    fwd_c /= np.linalg.norm(fwd_c)
    right_c = np.cross(fwd_c, up)       # camera-frame vector that maps to world +X ... check sign
    right_c = -right_c if right_c[0] < 0 else right_c
    # world axes expressed in camera coords: X=right, Y=up, Z=-forward
    M = np.stack([right_c, up, -fwd_c], 0)   # rows: world basis -> world = M @ cam
    if np.linalg.det(M) < 0:
        raise RuntimeError("left-handed world transform")
    return M * UNIT_TO_M, M


def main():
    photo_p, build, out = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])
    tier = sys.argv[4] if len(sys.argv) > 4 else "high"
    out.mkdir(parents=True, exist_ok=True)
    img = cv2.imread(str(photo_p), cv2.IMREAD_COLOR)[:, :, ::-1].astype(np.float32) / 255
    H0, W0 = img.shape[:2]
    work = 1.0 if tier == "high" else 0.5
    if work != 1.0:
        img = cv2.resize(img, (int(W0 * work), int(H0 * work)), interpolation=cv2.INTER_AREA)
    H, W = img.shape[:2]
    f = FOCAL_PX * W / W0
    cx, cy = W / 2, H / 2

    disp = 1.0 / np.load(build / "depth-model-res.npy")
    disp = cv2.resize(disp, (W, H), interpolation=cv2.INTER_CUBIC)
    z = 1.0 / np.maximum(disp, 1e-4)
    # snap depth at discontinuities to near/far side (kills "flying pixels")
    edge, _ = depth_edges(z)
    band = cv2.dilate(edge.astype(np.uint8), np.ones((5, 5), np.uint8)) > 0
    lo = cv2.erode(z, np.ones((5, 5), np.uint8))
    hi = cv2.dilate(z, np.ones((5, 5), np.uint8))
    snapped = np.where(z - lo < hi - z, lo, hi)
    z = np.where(band, snapped, z).astype(np.float32)
    edge, near_edge = depth_edges(z)

    # ---------------- foreground: quadtree of 4/2/1 px cells ----------------
    lum_t4, lum_t2 = (0.010, 0.018) if tier == "high" else (0.014, 0.024)
    levels = {}
    for s in (4, 2, 1):
        hs, ws = H // s, W // s
        zs = box_down(z, s) if s > 1 else z.copy()
        cs = box_down(img, s) if s > 1 else img.copy()
        es = block_any(edge, s) if s > 1 else edge.copy()
        levels[s] = dict(z=zs[:hs, :ws], c=cs[:hs, :ws], e=es[:hs, :ws],
                         std=(block_std(img, s)[:hs, :ws] if s > 1 else None))
    zr4 = (cv2.dilate(levels[4]["z"], np.ones((3, 3))) - cv2.erode(levels[4]["z"], np.ones((3, 3)))) / levels[4]["z"]
    acc4 = (levels[4]["std"] < lum_t4) & ~levels[4]["e"] & (zr4 < 0.04)
    acc2 = (levels[2]["std"] < lum_t2) & ~levels[2]["e"]
    acc2 &= ~np.repeat(np.repeat(acc4, 2, 0), 2, 1)[:acc2.shape[0], :acc2.shape[1]]
    cover2 = np.repeat(np.repeat(acc4, 2, 0), 2, 1)[:acc2.shape[0], :acc2.shape[1]] | acc2
    acc1 = ~np.repeat(np.repeat(cover2, 2, 0), 2, 1)
    acc1 = np.pad(acc1, ((0, H - acc1.shape[0]), (0, W - acc1.shape[1])), constant_values=True)

    parts = []
    for s, acc in ((4, acc4), (2, acc2), (1, acc1)):
        L = levels[s]
        zs = L["z"]
        zu = np.where(L["e"], 0, robust_grad(zs, 1)) / s
        zv = np.where(L["e"], 0, robust_grad(zs, 0)) / s
        ii, jj = np.nonzero(acc)
        u, v = (jj + 0.5) * s, (ii + 0.5) * s
        P, S, Q = surfels(u, v, zs[ii, jj], zu[ii, jj], zv[ii, jj], s, f, cx, cy, SIGMA_K)
        parts.append(dict(P=P, S=S, Q=Q, C=L["c"][ii, jj], A=np.full(len(P), OPACITY), layer=0))
        print(f"level {s}px: {len(P):,} splats")

    # ---------------- hidden background layer (disocclusion fill) ----------------
    s = 2
    zb, cb = levels[2]["z"].copy(), levels[2]["c"].copy()
    hb, wb = zb.shape
    R = int(0.085 * wb)
    zmax = cv2.dilate(zb, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * R + 1, 2 * R + 1)))
    unknown = zb < zmax / (1 + EDGE_REL * 2)
    orig_z = zb.copy()
    known = ~unknown
    assigned = np.zeros_like(known)
    for _ in range(R):
        best_z = np.full_like(zb, -1)
        best_c = np.zeros_like(cb)
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                if dx == 0 and dy == 0:
                    continue
                kz = np.roll(np.roll(np.where(known, zb, -1), dy, 0), dx, 1)
                kc = np.roll(np.roll(cb, dy, 0), dx, 1)
                better = kz > best_z
                best_z = np.where(better, kz, best_z)
                best_c = np.where(better[..., None], kc, best_c)
        take = ~known & (best_z > orig_z * (1 + EDGE_REL))
        zb = np.where(take, best_z, zb)
        cb = np.where(take[..., None], best_c, cb)
        known |= take
        assigned |= take
        if not take.any():
            break
    cb_blur = cv2.GaussianBlur(cb, (0, 0), 2.0)
    cb = np.where(assigned[..., None], cb_blur, cb) * 0.82   # slightly shadowed, reads as occlusion
    ii, jj = np.nonzero(assigned)
    u, v = (jj + 0.5) * s, (ii + 0.5) * s
    P, S, Q = surfels(u, v, zb[ii, jj], 0 * u, 0 * u, s, f, cx, cy, 0.62)
    parts.append(dict(P=P, S=S, Q=Q, C=cb[ii, jj], A=np.full(len(P), 0.97), layer=1))
    print(f"background fill: {len(P):,} splats (radius {R} cells)")

    # ---------------- frame extension: fade into darkness past the photo edge ----------------
    s = 8 if tier == "high" else 4
    z4, c4 = box_down(z, s), box_down(img, s)
    pad = int(z4.shape[1] * 0.16)
    zp = cv2.copyMakeBorder(z4, pad, pad, pad, pad, cv2.BORDER_REPLICATE)
    cp = cv2.copyMakeBorder(c4, pad, pad, pad, pad, cv2.BORDER_REPLICATE)
    zp = cv2.GaussianBlur(zp, (0, 0), 6)
    cp = cv2.GaussianBlur(cp, (0, 0), 5)
    hp, wp = zp.shape
    yy, xx = np.mgrid[0:hp, 0:wp]
    dx = np.maximum(np.maximum(pad - xx, xx - (wp - 1 - pad)), 0)
    dy = np.maximum(np.maximum(pad - yy, yy - (hp - 1 - pad)), 0)
    dist = np.sqrt(dx ** 2 + dy ** 2) / pad
    ring = (dist > 0) & (dist < 1)
    ii, jj = np.nonzero(ring)
    t = dist[ii, jj]
    fade = (1 - t) ** 2
    u, v = (jj - pad + 0.5) * s, (ii - pad + 0.5) * s
    zz = zp[ii, jj] * (1 + 0.25 * t)
    P, S, Q = surfels(u, v, zz, 0 * u, 0 * u, s * (1 + t), f, cx, cy, 0.7)
    parts.append(dict(P=P, S=S, Q=Q, C=cp[ii, jj] * (0.75 * fade[:, None] + 0.05),
                      A=0.9 * fade + 0.02, layer=2))
    print(f"frame extension: {len(P):,} splats")

    # ---------------- to world frame ----------------
    Mw, M = world_transform()
    Pc = np.concatenate([p["P"] for p in parts])
    S = np.concatenate([p["S"] for p in parts]) * UNIT_TO_M
    Qc = np.concatenate([p["Q"] for p in parts])
    C = np.clip(np.concatenate([p["C"] for p in parts]), 0, 1)
    A = np.clip(np.concatenate([p["A"] for p in parts]), 0.005, 0.999)
    Pw = Pc @ Mw.T
    # floor: median height of the floor patch (preview box -> photo coords)
    qM = mat_to_quat(M[None])[0]
    Qw = quat_mul(np.repeat(qM[None], len(Qc), 0), Qc)
    floor_box = (np.array([378, 458, 525, 600]) * 1536 / 567 * work).astype(int)
    fz = z[floor_box[2]:floor_box[3], floor_box[0]:floor_box[1]]
    fy, fx = np.mgrid[floor_box[2]:floor_box[3], floor_box[0]:floor_box[1]]
    fP = np.stack([(fx + 0.5 - cx) / f * fz, (fy + 0.5 - cy) / f * fz, fz], -1).reshape(-1, 3) @ Mw.T
    floor_y = float(np.median(fP[:, 1]))
    eye_h = -floor_y
    Pw[:, 1] -= floor_y
    print(f"camera height above floor {eye_h:.2f} m; total {len(Pw):,} splats")

    name = f"patterson-{tier}"
    write_spz(out / f"{name}.spz", Pw, S, Qw, C, A)
    write_ply(out / f"{name}.ply", Pw, S, Qw, C, A)

    # ---------------- scene.json: camera + low-res depth for picking ----------------
    gh, gw = 256, 192
    zg = cv2.resize(z, (gw, gh), interpolation=cv2.INTER_AREA) * UNIT_TO_M
    (out / "depth-grid.bin").write_bytes(zg.astype("<f4").tobytes())
    scene = {
        "photo": {"width": W0, "height": H0, "focal_px": FOCAL_PX},
        "camera": {"position": [0, eye_h, 0], "fov_y_deg": float(np.degrees(2 * np.arctan(H0 / 2 / FOCAL_PX))),
                   "aspect": W0 / H0, "world_from_cam_rows": M.tolist(),
                   "note": "cam frame: x right, y down, z forward. world = rows @ cam * unit_to_m, then +eye_h on y"},
        "unit_to_m": UNIT_TO_M, "eye_height_m": eye_h,
        "depth_grid": {"file": "depth-grid.bin", "width": gw, "height": gh, "units": "metres along camera z"},
        "counts": {"total": int(len(Pw)), **{f"layer{p['layer']}_{i}": int(len(p['P'])) for i, p in enumerate(parts)}},
    }
    (out / f"scene-{tier}.json").write_text(json.dumps(scene, indent=2))
    print(json.dumps(scene["counts"]))


def write_spz(path, P, S, Q, C, A, frac_bits=12):
    n = len(P)
    fixed = np.round(P * (1 << frac_bits)).astype(np.int64)
    if np.abs(fixed).max() >= (1 << 23):
        raise RuntimeError("positions overflow 24-bit fixed point")
    fixed &= 0xFFFFFF
    pos = np.stack([(fixed >> (8 * k)) & 0xFF for k in range(3)], -1).astype(np.uint8).reshape(n, 9)
    alpha = np.clip(np.round(A * 255), 0, 255).astype(np.uint8)
    dc = (C - 0.5) / SH_C0
    col = np.clip(np.round(dc * (0.15 * 255) + 0.5 * 255), 0, 255).astype(np.uint8)
    sc = np.clip(np.round((np.log(np.maximum(S, 1e-9)) + 10.0) * 16.0), 0, 255).astype(np.uint8)
    q = Q / np.linalg.norm(Q, axis=1, keepdims=True)
    q = np.where(q[:, :1] < 0, -q, q)
    rot = np.clip(np.round(q[:, 1:] * 127.5 + 127.5), 0, 255).astype(np.uint8)
    header = struct.pack("<IIIBBBB", 0x5053474E, 2, n, 0, frac_bits, 0, 0)
    body = header + pos.tobytes() + alpha.tobytes() + col.tobytes() + sc.tobytes() + rot.tobytes()
    path.write_bytes(gzip.compress(body, compresslevel=9))
    print(f"wrote {path.name}: {path.stat().st_size / 1e6:.1f} MB")


def write_ply(path, P, S, Q, C, A):
    n = len(P)
    props = ["x", "y", "z", "nx", "ny", "nz", "f_dc_0", "f_dc_1", "f_dc_2", "opacity",
             "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3"]
    data = np.zeros((n, len(props)), "<f4")
    data[:, 0:3] = P
    data[:, 6:9] = (C - 0.5) / SH_C0
    data[:, 9] = logit(A)
    data[:, 10:13] = np.log(np.maximum(S, 1e-9))
    data[:, 13:17] = Q
    header = "ply\nformat binary_little_endian 1.0\n" + f"element vertex {n}\n" + \
        "".join(f"property float {p}\n" for p in props) + "end_header\n"
    with path.open("wb") as fh:
        fh.write(header.encode("ascii"))
        fh.write(data.tobytes())
    print(f"wrote {path.name}: {path.stat().st_size / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
