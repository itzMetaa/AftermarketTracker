"""Generates build/icon.png and src/renderer/icon.png. Run: python scripts/make-icon.py"""
import os
from PIL import Image, ImageDraw, ImageFont

S = 1024
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# diagonal purple -> pink gradient
grad = Image.new("RGB", (S, S))
px = grad.load()
a, b = (43, 15, 54), (232, 51, 130)
for y in range(S):
    for x in range(S):
        t = min(1, max(0, (x + y) / (2 * S) * 1.25 - 0.1))
        px[x, y] = tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))

mask = Image.new("L", (S, S), 0)
ImageDraw.Draw(mask).rounded_rectangle((32, 32, S - 32, S - 32), radius=200, fill=255)
icon = Image.new("RGBA", (S, S), (0, 0, 0, 0))
icon.paste(grad, (0, 0), mask)
d = ImageDraw.Draw(icon)

# speed stripes
for i, w in enumerate((70, 46, 26)):
    x0 = 170 + i * 110
    d.polygon([(x0, 800), (x0 + w, 800), (x0 + w + 120, 640), (x0 + 120, 640)], fill=(255, 255, 255, 70))

font_path = "C:/Windows/Fonts/bahnschrift.ttf"
try:
    font = ImageFont.truetype(font_path, 470)
    font.set_variation_by_name("Bold")
except Exception:
    font = ImageFont.load_default()
txt = Image.new("RGBA", (S, S), (0, 0, 0, 0))
ImageDraw.Draw(txt).text((S // 2, S // 2 - 60), "AM", font=font, fill="white", anchor="mm")
txt = txt.transform((S, S), Image.AFFINE, (1, 0.22, -110, 0, 1, 0), resample=Image.BICUBIC)  # italic slant
icon.alpha_composite(txt)

# check badge
cx, cy, r = 790, 790, 150
d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=(53, 208, 127), outline=(18, 10, 24), width=24)
d.line([(cx - 70, cy + 5), (cx - 15, cy + 60), (cx + 80, cy - 55)], fill="white", width=42, joint="curve")

out = icon.resize((512, 512), Image.LANCZOS)
os.makedirs(os.path.join(root, "build"), exist_ok=True)
out.save(os.path.join(root, "build", "icon.png"))
icon.resize((128, 128), Image.LANCZOS).save(os.path.join(root, "src", "renderer", "icon.png"))
print("ok")
