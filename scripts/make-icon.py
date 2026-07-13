#!/usr/bin/env python3
"""Generate build/icon.png + build/icon.ico — a CRT-ish screen with a play glyph."""
import os
from PIL import Image, ImageDraw

S = 512
BG1 = (77, 163, 255)
BG2 = (124, 92, 255)
SCREEN = (11, 14, 20)

img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

# rounded square with a vertical gradient
grad = Image.new("RGBA", (S, S))
gd = ImageDraw.Draw(grad)
for y in range(S):
    t = y / (S - 1)
    gd.line(
        [(0, y), (S, y)],
        fill=(
            int(BG1[0] + (BG2[0] - BG1[0]) * t),
            int(BG1[1] + (BG2[1] - BG1[1]) * t),
            int(BG1[2] + (BG2[2] - BG1[2]) * t),
            255,
        ),
    )
mask = Image.new("L", (S, S), 0)
ImageDraw.Draw(mask).rounded_rectangle([0, 0, S - 1, S - 1], radius=112, fill=255)
img.paste(grad, (0, 0), mask)

# inner screen
pad, top, bot = 74, 104, 118
d.rounded_rectangle([pad, top, S - pad, S - bot], radius=28, fill=SCREEN)

# play triangle
cx, cy, r = S // 2, (top + (S - bot)) // 2, 54
d.polygon([(cx - r + 12, cy - r), (cx - r + 12, cy + r), (cx + r + 4, cy)], fill=(255, 255, 255, 236))

# stand
d.rounded_rectangle([cx - 70, S - bot + 16, cx + 70, S - bot + 30], radius=7, fill=(255, 255, 255, 210))

os.makedirs("build", exist_ok=True)
img.save("build/icon.png")
img.resize((256, 256), Image.LANCZOS).save(
    "build/icon.ico", sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
)
print("wrote build/icon.png and build/icon.ico")
