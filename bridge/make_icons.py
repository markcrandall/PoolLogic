"""One-shot generator for the app icons (M2 placeholders, polish in M5)."""
from PIL import Image, ImageDraw
import math
import os

OUT = os.path.join(os.path.dirname(__file__), "..", "app", "icons")
os.makedirs(OUT, exist_ok=True)


def make(size, path):
    img = Image.new("RGB", (size, size), "#1b7fc4")
    d = ImageDraw.Draw(img)
    for row in range(3):
        y0 = size * (0.52 + 0.16 * row)
        amp = size * 0.035
        w = max(2, size // 28)
        pts = [
            (x, y0 + amp * math.sin((x / size) * 4 * math.pi))
            for x in range(0, size + 1, max(1, size // 128))
        ]
        d.line(pts, fill="white", width=w)
    r = size * 0.13
    cx, cy = size * 0.72, size * 0.26
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill="#ffd54d")
    img.save(path)


make(192, os.path.join(OUT, "icon-192.png"))
make(512, os.path.join(OUT, "icon-512.png"))
print("icons written")
