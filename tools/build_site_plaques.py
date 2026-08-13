"""Production digital-twin QR-plaque placeholder generator (AR_SYSTEM.md
§A/§E four-plaque design).

Produces PLACEHOLDER artwork for the 4 site-model plaques (front/back/
left/right — the mounting ledge added 2026-08-13 in
tools/build_site_buildings.py). Same technique as tools/build_plaque.py
(the Phase 3 bench-test's single plaque), extended to 4 designs because
§A requires the four plaques be **visually distinct from each other, not
rotated copies of one design** — feature-based tracking (MindAR/8th Wall)
is generally in-plane rotation-invariant, so identical artwork on all 4
would make it impossible for the tracker to tell which physical plaque is
in view. Each side gets a different corner shape at a different corner
(not just the same mark rotated), which also satisfies §3.1's
asymmetric/non-repeating tracking-quality guidance independently per side.

All 4 encode the SAME experience URL (§A: "which plaque is in use is
resolved entirely by tracking identity, never by the QR payload").

PLACEHOLDER status, same caveats as the ledge/plaque geometry in
build_site_buildings.py:
  - 50mm size matches PLAQUE_SIZE_M there, not a real production
    plaque-size decision.
  - AR_EXPERIENCE_URL below is the existing bench-test deployment (the
    only real deployed URL this project has) — the production Ramapo
    experience has no manifest entry/route of its own yet, so this is a
    placeholder decode target, not the real production URL.
  - Not textured onto the Blender placeholder plaques, not compiled into
    a .mind target, not copied into public/assets/ — staging only, same
    boundary build_site_buildings.py's outputs respect.

Outputs (tools/plaque/site/):
  plaque-front.png / plaque-back.png / plaque-left.png / plaque-right.png
    1024x1024 artwork (50mm -> ~520dpi, matches bench-plaque.png)
  print-sheet.html   all 4 at exactly 50mm + a 100mm calibration ruler

Run with the same environment as build_plaque.py (segno + pillow):
  python3 tools/build_site_plaques.py
"""

from pathlib import Path

import segno
from PIL import Image, ImageDraw, ImageFont

AR_EXPERIENCE_URL = "https://ar-ramapo.onrender.com"

SIZE_PX = 1024          # artwork resolution
SIZE_MM = 50.0          # PLACEHOLDER — matches build_site_buildings.py's PLAQUE_SIZE_M
PX_PER_MM = SIZE_PX / SIZE_MM

OUT_DIR = Path(__file__).resolve().parent / "plaque" / "site"

BLACK = (10, 10, 10)
WHITE = (255, 255, 255)

# side -> (corner shape, corner position). Different shape AND different
# corner per side — not the same mark rotated — so the 4 designs stay
# distinguishable from each other under arbitrary in-plane rotation.
SIDES = {
    "front": {"shape": "triangle", "corner": "tl", "label": "FRONT"},
    "back": {"shape": "triangle", "corner": "tr", "label": "BACK"},
    "left": {"shape": "circle", "corner": "bl", "label": "LEFT"},
    "right": {"shape": "diamond", "corner": "br", "label": "RIGHT"},
}


def mm(v: float) -> int:
    return round(v * PX_PER_MM)


def load_font(size_px: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    ttc = "/System/Library/Fonts/Helvetica.ttc"
    try:
        return ImageFont.truetype(ttc, size_px, index=1 if bold else 0)
    except OSError:
        return ImageFont.truetype(ttc, size_px)


def corner_origin(corner: str, inset: int, size: int) -> tuple:
    """Top-left pixel of a `size`x`size` bounding box sitting in the given
    corner, inset from the plaque edge."""
    x = inset if corner in ("tl", "bl") else SIZE_PX - inset - size
    y = inset if corner in ("tl", "tr") else SIZE_PX - inset - size
    return x, y


def draw_corner_shape(draw: ImageDraw.ImageDraw, shape: str, corner: str, inset: int) -> None:
    size = mm(9)
    x, y = corner_origin(corner, inset, size)
    if shape == "triangle":
        # Right angle sits at the plaque's actual corner; legs run along
        # the two edges meeting there.
        pts = {
            "tl": [(x, y), (x + size, y), (x, y + size)],
            "tr": [(x + size, y), (x, y), (x + size, y + size)],
            "bl": [(x, y + size), (x, y), (x + size, y + size)],
            "br": [(x + size, y + size), (x + size, y), (x, y + size)],
        }[corner]
        draw.polygon(pts, fill=BLACK)
    elif shape == "circle":
        draw.ellipse([x, y, x + size, y + size], fill=BLACK)
    elif shape == "diamond":
        cx, cy, r = x + size / 2, y + size / 2, size / 2
        draw.polygon([(cx, cy - r), (cx + r, cy), (cx, cy + r), (cx - r, cy)], fill=BLACK)
    else:
        raise ValueError(f"unknown corner shape: {shape!r}")


def build_artwork(side: str, qr_img: Image.Image) -> Image.Image:
    spec = SIDES[side]
    img = Image.new("RGB", (SIZE_PX, SIZE_PX), WHITE)
    draw = ImageDraw.Draw(img)

    inset, stroke = mm(1.2), mm(0.4)
    draw.rectangle([inset, inset, SIZE_PX - inset, SIZE_PX - inset], outline=BLACK, width=stroke)
    draw_corner_shape(draw, spec["shape"], spec["corner"], inset + stroke + mm(0.8))

    # All text is centered on the plaque's horizontal midline, within the
    # gap between the two corner marks — safe regardless of which two
    # corners this side's shape occupies (every corner shape's footprint
    # is confined to its own corner, never the centered mid-column).
    cx = SIZE_PX // 2
    top_font = load_font(mm(2.2))
    draw.text((cx, mm(3.0)), "RAMAPO SITE MODEL", font=top_font, fill=BLACK, anchor="ma")

    qr_x = (SIZE_PX - qr_img.width) // 2
    qr_y = mm(9)
    img.paste(qr_img, (qr_x, qr_y))
    text_top_mm = (qr_y + qr_img.height) / PX_PER_MM + 1.5

    label_font = load_font(mm(4.2), bold=True)
    sub_font = load_font(mm(2.2))
    draw.text((cx, mm(text_top_mm)), spec["label"], font=label_font, fill=BLACK, anchor="ma")
    draw.text((cx, mm(text_top_mm + 5.2)), "PLACEHOLDER", font=sub_font, fill=BLACK, anchor="ma")

    return img


def make_qr_image() -> Image.Image:
    qr = segno.make(AR_EXPERIENCE_URL, error="q")
    modules = qr.symbol_size(border=4)[0]
    scale = max(1, mm(31) // modules)
    tmp_path = OUT_DIR / "_qr_tmp.png"
    qr.save(tmp_path, scale=scale, border=4)
    qr_img = Image.open(tmp_path).convert("RGB")
    tmp_path.unlink()
    return qr_img


def build_print_sheet() -> str:
    tiles = "\n".join(
        f"""<div class="plaque">
  <span class="crop tl"><i class="h"></i><i class="v"></i></span>
  <span class="crop tr"><i class="h"></i><i class="v"></i></span>
  <span class="crop bl"><i class="h"></i><i class="v"></i></span>
  <span class="crop br"><i class="h"></i><i class="v"></i></span>
  <img src="plaque-{side}.png" alt="{side} plaque artwork (placeholder)">
  <div class="tag">{side.upper()}</div>
</div>"""
        for side in SIDES
    )
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>site-plaque print sheet (PLACEHOLDER)</title>
<style>
  @page {{ margin: 12mm; }}
  body {{ font: 11pt/1.5 system-ui, sans-serif; color: #111; margin: 0; }}
  h1 {{ font-size: 14pt; }}
  .grid {{ display: grid; grid-template-columns: repeat(2, 58mm); gap: 8mm; margin-top: 8mm; }}
  .plaque {{ position: relative; width: 50mm; height: 50mm; }}
  .plaque img {{ width: 50mm; height: 50mm; display: block; }}
  .tag {{ position: absolute; bottom: -6mm; left: 0; font-size: 8pt; font-weight: bold; }}
  .crop {{ position: absolute; width: 6mm; height: 6mm; }}
  .crop i {{ position: absolute; background: #000; }}
  .crop .h {{ width: 6mm; height: 0.2mm; }}
  .crop .v {{ width: 0.2mm; height: 6mm; }}
  .tl {{ top: -6.2mm; left: -6.2mm; }} .tl .h {{ bottom: 0; }} .tl .v {{ right: 0; }}
  .tr {{ top: -6.2mm; right: -6.2mm; }} .tr .h {{ bottom: 0; }} .tr .v {{ left: 0; }}
  .bl {{ bottom: -6.2mm; left: -6.2mm; }} .bl .h {{ top: 0; }} .bl .v {{ right: 0; }}
  .br {{ bottom: -6.2mm; right: -6.2mm; }} .br .h {{ top: 0; }} .br .v {{ left: 0; }}
  .ruler {{ width: 100mm; height: 8mm; margin-top: 18mm; border: 0.3mm solid #000;
            background: repeating-linear-gradient(to right,
              #000 0, #000 0.25mm, transparent 0.25mm, transparent 10mm); }}
  .ruler-label {{ font-size: 9pt; margin-top: 1mm; }}
  ol {{ max-width: 150mm; }}
  .warn {{ color: #900; font-weight: bold; }}
</style>
</head>
<body>
<h1>Site-model QR plaques — 4 × 50mm — <span class="warn">PLACEHOLDER</span></h1>
<ol>
  <li class="warn">Placeholder artwork/size — not for physical fabrication. Real plaque
      size and content are still pending (see AR_SYSTEM.md §A/§G).</li>
  <li>If printing anyway for a mockup: <strong>100% scale / "Actual Size"</strong>, never "Fit to page".</li>
  <li>Calibration bar below should measure exactly 100mm with a ruler.</li>
</ol>
<div class="grid">
{tiles}
</div>
<div class="ruler"></div>
<div class="ruler-label">calibration bar — must measure exactly 100 mm (ticks every 10 mm)</div>
</body>
</html>
"""


if __name__ == "__main__":
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    qr_img = make_qr_image()
    for side in SIDES:
        artwork = build_artwork(side, qr_img)
        path = OUT_DIR / f"plaque-{side}.png"
        artwork.save(path)
        print(f"wrote {path}")
    sheet_path = OUT_DIR / "print-sheet.html"
    sheet_path.write_text(build_print_sheet())
    print(f"wrote {sheet_path}")
