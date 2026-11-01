import json
from pathlib import Path
import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[1] / 'apps' / 'web'
out = {}
for folder in ('scene-v1', 'office-v2'):
    for path in sorted((ROOT / 'public' / 'assets' / folder).glob('*.png')):
        alpha = np.array(Image.open(path).convert('RGBA'))[..., 3] > 40
        h, w = alpha.shape
        bands = []
        for k in range(10):
            rows = alpha[k * h // 10:(k + 1) * h // 10]
            cols = np.where(rows.any(axis=0))[0]
            bands.append([round(cols.min() / w, 3), round((cols.max() + 1) / w, 3)] if len(cols) else None)
        out[path.stem] = {'aspect': round(w / h, 4), 'bands': bands}
(ROOT / 'src' / 'asset-bounds.json').write_text(json.dumps(out, indent=1))
print(len(out))
