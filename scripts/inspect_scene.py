"""Read-only inspection of the original Gaussian PLY. Requires NumPy."""
from pathlib import Path
import hashlib
import json
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
SOURCE = Path(r'D:\Lustron\experiments\BLUNT\2026-11-04_repair-office-single-image\output\repair-office.ply')

def inspect(path):
    with path.open('rb') as stream:
        header = []
        while True:
            line = stream.readline().decode('ascii').strip()
            header.append(line)
            if line == 'end_header':
                offset = stream.tell()
                break
            if len(header) > 100:
                raise ValueError('Invalid PLY header')
    assert 'format binary_little_endian 1.0' in header
    count = int(next(x.split()[2] for x in header if x.startswith('element vertex ')))
    fields = [x.split()[2] for x in header if x.startswith('property float ')]
    assert len(fields) == 17, fields
    assert path.stat().st_size == offset + count * len(fields) * 4
    data = np.memmap(path, mode='r', dtype='<f4', offset=offset, shape=(count, len(fields)))
    assert np.isfinite(data).all(), 'Nonfinite splat attributes'
    coords = data[:, [fields.index(a) for a in ('x', 'y', 'z')]]
    quaternion = data[:, [fields.index(f'rot_{n}') for n in range(4)]]
    return {
        'source': str(path), 'bytes': path.stat().st_size, 'gaussians': count,
        'fields': fields, 'all_fields_finite': True,
        'sha256': hashlib.file_digest(path.open('rb'), 'sha256').hexdigest() if hasattr(hashlib, 'file_digest') else hashlib.sha256(path.read_bytes()).hexdigest(),
        'coordinate_percentiles_1_50_99': np.percentile(coords, [1, 50, 99], axis=0).tolist(),
        'max_quaternion_norm_error': float(np.max(np.abs(np.linalg.norm(quaternion, axis=1) - 1))),
        'original_camera': {'position': [0, 0, 0], 'fov_y': 71.15105584416116,
                            'convert': 'rotate X 180 degrees; model-relative units'},
    }

if __name__ == '__main__':
    result = inspect(SOURCE)
    (ROOT / 'evidence' / 'source-inspection.json').write_text(json.dumps(result, indent=2))
    print(json.dumps(result, indent=2))
