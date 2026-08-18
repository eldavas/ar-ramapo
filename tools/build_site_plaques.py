"""Production digital-twin QR-plaque artwork generator (AR_SYSTEM.md §A/§E
four-plaque design).

Produces the 4 site-model plaques (front/back/left/right — the mounting
ledge, `tools/build_site_buildings.py`). §A requires the four plaques be
**visually distinct from each other, not rotated copies of one design**
— feature-based tracking (MindAR/8th Wall) is generally in-plane
rotation-invariant, so identical artwork on all 4 would make it
impossible for the tracker to tell which physical plaque is in view.
Each side gets a different corner-badge shape (not just the same mark
rotated), which also satisfies §3.1's asymmetric/non-repeating
tracking-quality guidance.

All 4 encode the SAME experience URL (§A: "which plaque is in use is
resolved entirely by tracking identity, never by the QR payload").

REVISION (2026-08-18): redesigned from a 50mm square (a placeholder size
never tied to anything real) to an elongated 90x30mm landscape layout —
QR left, "Scan me" instructional text right, matching a reference design
the user supplied — sized to fit the real measured ledge width (3.5cm),
with a 5mm margin so the plaque doesn't span the full ledge edge to edge.
30mm (not 35mm) was chosen deliberately, not just "smaller than 3.5cm":
see PLAQUE_HEIGHT_MM below. The distinguishing badge (shape + side label)
moved from an actual corner of the artwork to a fixed badge column, since
the landscape aspect ratio itself already rules out 90°-rotation mounting
mistakes a human would notice (unlike the old square, which looked
"valid" in any of 4 orientations) — the badge's job now is purely
tracking-distinctness and installer verification, not rotation-proofing.

Mounting orientation is UNCHANGED from the previous design and still
governed by `docs/physical-plaque-placement.md` §2: each plaque's "up"
(the artwork's own top edge, unrotated) must point at the terrain
center once mounted flat.

Outputs (tools/plaque/site/):
  plaque-front.png / plaque-back.png / plaque-left.png / plaque-right.png
    artwork at ~580dpi (matches the previous design's print density)
  print-sheet.html   all 4 at exact size + a 100mm calibration ruler

Run with the same environment as build_plaque.py (segno + pillow):
  python3 tools/build_site_plaques.py
"""

from pathlib import Path

import segno
from PIL import Image, ImageDraw, ImageFont

AR_EXPERIENCE_URL = "https://ar-ramapo.onrender.com"

PLAQUE_WIDTH_MM = 90.0
# Real measured ledge width is 3.5cm (tools/build_site_buildings.py's
# LEDGE_WIDTH_M) -- 30mm leaves a real, deliberate 5mm margin so the
# plaque doesn't run edge-to-edge on the ledge strip (installation
# tolerance, and it visually reads as "mounted on" the ledge rather than
# "exactly the width of" it).
PLAQUE_HEIGHT_MM = 30.0
# 24px/mm (~610dpi), not the previous design's 20.48 -- @8thwall/image-target-cli
# (tools/compile_8thwall_target.mjs) enforces a hard 640px minimum in both
# dimensions; at the old density this plaque's 30mm height would compile
# to 614px and fail outright. This only raises print resolution, not the
# real 90x30mm physical size.
PX_PER_MM = 24.0
WIDTH_PX = round(PLAQUE_WIDTH_MM * PX_PER_MM)
HEIGHT_PX = round(PLAQUE_HEIGHT_MM * PX_PER_MM)

OUT_DIR = Path(__file__).resolve().parent / "plaque" / "site"

BLACK = (10, 10, 10)
WHITE = (255, 255, 255)
GRAY_BG = (235, 235, 235)

# side -> distinguishing badge shape. All 4 otherwise share identical
# QR/text layout (matching the reference design closely) -- only the
# badge differs, which is enough for the 4 images to be byte-distinct
# and non-confusable under rotation (see module docstring).
SIDES = {
    "front": {"shape": "triangle", "label": "FRONT"},
    "back": {"shape": "circle", "label": "BACK"},
    "left": {"shape": "diamond", "label": "LEFT"},
    "right": {"shape": "square", "label": "RIGHT"},
}


def mm(v: float) -> int:
    return round(v * PX_PER_MM)


def load_font(size_px: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    ttc = "/System/Library/Fonts/Helvetica.ttc"
    try:
        return ImageFont.truetype(ttc, size_px, index=1 if bold else 0)
    except OSError:
        return ImageFont.truetype(ttc, size_px)


def draw_badge_shape(draw: ImageDraw.ImageDraw, shape: str, cx: float, cy: float, size: float) -> None:
    r = size / 2
    if shape == "triangle":
        draw.polygon([(cx, cy - r), (cx + r, cy + r), (cx - r, cy + r)], fill=BLACK)
    elif shape == "circle":
        draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=BLACK)
    elif shape == "diamond":
        draw.polygon([(cx, cy - r), (cx + r, cy), (cx, cy + r), (cx - r, cy)], fill=BLACK)
    elif shape == "square":
        draw.rectangle([cx - r, cy - r, cx + r, cy + r], fill=BLACK)
    else:
        raise ValueError(f"unknown badge shape: {shape!r}")


def build_artwork(side: str, qr_img: Image.Image) -> Image.Image:
    spec = SIDES[side]
    img = Image.new("RGB", (WIDTH_PX, HEIGHT_PX), WHITE)
    draw = ImageDraw.Draw(img)

    inset, stroke = mm(1.0), mm(0.3)
    draw.rectangle([inset, inset, WIDTH_PX - inset, HEIGHT_PX - inset], outline=BLACK, width=stroke)

    # QR block, left-aligned, square, vertically centered.
    qr_x, qr_y = mm(2.5), (HEIGHT_PX - qr_img.height) // 2
    img.paste(qr_img, (qr_x, qr_y))

    # Badge column, far right: distinguishing shape + tiny side label.
    badge_cx = WIDTH_PX - mm(6.0)
    draw_badge_shape(draw, spec["shape"], badge_cx, mm(9.0), mm(7.0))
    label_font = load_font(mm(2.3), bold=True)
    draw.text((badge_cx, mm(16.0)), spec["label"], font=label_font, fill=BLACK, anchor="ma")

    # Instructional text, between the QR and the badge column (matches
    # the reference design: bold "Scan me" + smaller two-line subtext).
    text_x0 = qr_x + qr_img.width + mm(4.0)
    scan_font = load_font(mm(5.0), bold=True)
    sub_font = load_font(mm(2.6))
    draw.text((text_x0, mm(7.0)), "Scan me", font=scan_font, fill=BLACK, anchor="lm")
    draw.text((text_x0, mm(16.5)), "Hold the camera", font=sub_font, fill=BLACK, anchor="lm")
    draw.text((text_x0, mm(21.0)), "to the image", font=sub_font, fill=BLACK, anchor="lm")

    return img


def make_qr_image() -> Image.Image:
    qr = segno.make(AR_EXPERIENCE_URL, error="q")
    modules = qr.symbol_size(border=3)[0]
    target_px = mm(24.0)  # QR footprint, incl. quiet zone -- fits within the 30mm height with margin
    scale = max(1, target_px // modules)
    tmp_path = OUT_DIR / "_qr_tmp.png"
    qr.save(tmp_path, scale=scale, border=3)
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
  <img src="plaque-{side}.png" alt="{side} plaque artwork">
  <div class="tag">{side.upper()}</div>
</div>"""
        for side in SIDES
    )
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>site-plaque print sheet</title>
<style>
  @page {{ margin: 12mm; }}
  body {{ font: 11pt/1.5 system-ui, sans-serif; color: #111; margin: 0; }}
  h1 {{ font-size: 14pt; }}
  .grid {{ display: grid; grid-template-columns: repeat(1, 98mm); gap: 10mm; margin-top: 8mm; }}
  .plaque {{ position: relative; width: 90mm; height: 30mm; }}
  .plaque img {{ width: 90mm; height: 30mm; display: block; }}
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
</style>
</head>
<body>
<h1>Site-model QR plaques — 4 × 90mm × 30mm</h1>
<ol>
  <li>Print at <strong>100% scale / "Actual Size"</strong> — never "Fit to page".</li>
  <li>Verify the calibration bar below measures exactly 100mm with a ruler
      before trusting anything else on this page.</li>
  <li>Mount flat, artwork facing up, rotated so it reads right-side-up
      standing at that edge facing into the model (§2 of
      docs/physical-plaque-placement.md).</li>
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
