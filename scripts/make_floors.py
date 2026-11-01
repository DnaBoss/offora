import sys
import numpy as np
from PIL import Image

src, out = sys.argv[1], sys.argv[2]


def load(name):
    return np.array(Image.open(f'{src}/{name}').convert('RGB')).astype(float)


def seamless(img, border=0.3):
    h, w, _ = img.shape
    ramp = lambda n: np.clip(np.minimum(np.arange(n), n - 1 - np.arange(n)) / (n * border), 0, 1)
    mask = np.outer(ramp(h), ramp(w))[..., None]
    shifted = np.roll(np.roll(img, h // 2, axis=0), w // 2, axis=1)
    return img * mask + shifted * (1 - mask)


def tone(img, sat, gain, tint):
    gray = img.mean(axis=2, keepdims=True)
    mixed = gray + (img - gray) * sat
    return np.clip(mixed * gain * np.array(tint), 0, 255)


def save(img, name, size):
    Image.fromarray(img.astype('uint8')).resize((size, size), Image.LANCZOS).save(f'{out}/{name}.png')


wood = tone(seamless(load('g1.png')), 0.62, 0.97, (1.0, 0.97, 0.9))
save(wood, 'wood', 512)
carpet = load('g2.png')[30:600, 30:600]
carpet = tone(seamless(carpet, 0.5), 0.5, 1.12, (1.07, 1.0, 0.88))
save(carpet, 'carpet', 288)
tile = load('g3.png')
save(tile[:1254 // 6 * 6, :1254 // 6 * 6], 'tile', 418)
