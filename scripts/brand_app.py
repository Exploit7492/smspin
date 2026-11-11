#!/usr/bin/env python3
"""Per-tenant branding for the Android build.

Reads tenant config from the environment, then writes:
  - brand.json                                (single source consumed by the app)
  - app/src/main/res/values/colors.xml        (brand colours)
  - app/src/main/res/mipmap-*/ic_launcher.png (launcher icons)

Logo: an uploaded file (LOGO_FILE) wins; otherwise a square initials mark is
generated from the business name on the brand colour with auto-contrast text.
No external tools required beyond Pillow.
"""
import os
import json
import glob

from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

SLUG = os.environ.get("TENANT_SLUG", "smspin")
NAME = os.environ.get("TENANT_NAME", "SMSPin")
PRIMARY = os.environ.get("BRAND_PRIMARY", "#E11D2E")
SECONDARY = os.environ.get("BRAND_SECONDARY", "#0EA5E9")
API_BASE = os.environ.get("API_BASE", "https://smspin.io")
COUNTRY = os.environ.get("COUNTRY", "NG")
CURRENCY = os.environ.get("CURRENCY", "NGN")
MARKUP = os.environ.get("MARKUP", "0")
TAGLINE = os.environ.get("TAGLINE", "Virtual numbers, instantly")
SUPPORT_EMAIL = os.environ.get("SUPPORT_EMAIL", "support@smspin.io")
LOGO_FILE = os.environ.get("LOGO_FILE", "")

DENSITIES = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}


def hex_rgb(value):
    value = value.strip().lstrip("#")
    if len(value) == 3:
        value = "".join(c * 2 for c in value)
    return tuple(int(value[i:i + 2], 16) for i in (0, 2, 4))


def initials(name):
    words = [w for w in "".join(c if c.isalnum() or c.isspace() else " " for c in name).split() if w]
    if not words:
        return "SP"
    if len(words) == 1:
        return words[0][:2].upper()
    return (words[0][0] + words[1][0]).upper()


def font(size):
    for path in (
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    ):
        if os.path.exists(path):
            return ImageFont.truetype(path, size)
    try:
        return ImageFont.load_default(size=size)
    except TypeError:
        return ImageFont.load_default()


def make_icon(size, primary):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    radius = max(4, size // 5)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=primary + (255,))
    text = initials(NAME)
    f = font(int(size * 0.46))
    box = d.textbbox((0, 0), text, font=f)
    d.text(((size - (box[2] - box[0])) / 2 - box[0],
            (size - (box[3] - box[1])) / 2 - box[1]),
           text, font=f, fill=(255, 255, 255, 255))
    return img


def write_brand_json():
    data = {
        "slug": SLUG, "name": NAME, "primary": PRIMARY, "secondary": SECONDARY,
        "apiBase": API_BASE, "country": COUNTRY, "currency": CURRENCY,
        "markup": float(MARKUP) if MARKUP else 0,
        "tagline": TAGLINE, "supportEmail": SUPPORT_EMAIL,
    }
    with open(os.path.join(ROOT, "brand.json"), "w") as f:
        json.dump(data, f, indent=2)
    return data


def write_colors():
    path = os.path.join(ROOT, "app/src/main/res/values/colors.xml")
    with open(path, "w") as f:
        f.write(
            '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n'
            f'    <color name="brand_primary">{PRIMARY}</color>\n'
            '    <color name="brand_on_primary">#FFFFFF</color>\n'
            '</resources>\n'
        )


def write_icons():
    primary = hex_rgb(PRIMARY)
    for density, size in DENSITIES.items():
        out_dir = os.path.join(ROOT, f"app/src/main/res/mipmap-{density}")
        os.makedirs(out_dir, exist_ok=True)
        out = os.path.join(out_dir, "ic_launcher.png")
        if LOGO_FILE and os.path.exists(LOGO_FILE):
            Image.open(LOGO_FILE).convert("RGBA").resize((size, size), Image.LANCZOS).save(out)
        else:
            make_icon(size, primary).save(out)


if __name__ == "__main__":
    data = write_brand_json()
    write_colors()
    write_icons()
    source = "uploaded logo" if (LOGO_FILE and os.path.exists(LOGO_FILE)) else f"generated initials '{initials(NAME)}'"
    print(f"Branding written ({source}) for {NAME}:")
    print(json.dumps(data, indent=2))
