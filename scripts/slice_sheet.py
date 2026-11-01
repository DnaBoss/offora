import sys
import numpy as np
from PIL import Image
from scipy import ndimage as ndi

sheet, out_dir, *names = sys.argv[1:]
im = np.array(Image.open(sheet).convert('RGBA')).astype(int)
r, g, b = im[..., 0], im[..., 1], im[..., 2]
key = (r > 150) & (b > 150) & (g < 140) & (r - g > 90) & (b - g > 90)
im[..., 3] = np.where(key, 0, 255)
keep = ndi.binary_opening(im[..., 3] > 0, iterations=1)
h, w = keep.shape
lab, n = ndi.label(ndi.binary_dilation(keep, iterations=3))
cells = {}
for index, box in enumerate(ndi.find_objects(lab), start=1):
    if (box[0].stop - box[0].start) < 40 and (box[1].stop - box[1].start) < 40:
        continue
    cy = (box[0].start + box[0].stop) / 2
    cx = (box[1].start + box[1].stop) / 2
    cell = int(cy / (h / 3)) * 3 + int(cx / (w / 3))
    y0, y1, x0, x1 = box[0].start, box[0].stop, box[1].start, box[1].stop
    if cell in cells:
        a = cells[cell]
        cells[cell] = (min(a[0], y0), max(a[1], y1), min(a[2], x0), max(a[3], x1))
    else:
        cells[cell] = (y0, y1, x0, x1)
assert len(cells) == len(names) == 9, (len(cells), sorted(cells))
for cell, name in enumerate(names):
    y0, y1, x0, x1 = cells[cell]
    sub = im[y0:y1, x0:x1].copy()
    mask = keep[y0:y1, x0:x1]
    sub[..., 3] = np.where(mask, 255, 0)
    ys, xs = np.where(sub[..., 3] > 0)
    sub = sub[ys.min():ys.max() + 1, xs.min():xs.max() + 1]
    Image.fromarray(sub.astype('uint8'), 'RGBA').save(f'{out_dir}/{name}.png')
    print(name, sub.shape[1], sub.shape[0])
