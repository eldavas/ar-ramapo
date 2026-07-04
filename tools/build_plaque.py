"""Phase 3 launch-plaque generator (AR_SYSTEM.md §G physical rig).

Produces the single source artwork for the 5×5 cm QR plaque and a
print-calibrated sheet. The SAME PNG must be used everywhere the plaque
exists — printed, compiled into bench-target.mind, and (later) textured
onto ar_launch_plaque's mat_qr_plaque UV — so the tracked image, the
physical object, and the digital twin are pixel-identical by construction.

Outputs (tools/plaque/):
  bench-plaque.png   1024×1024 artwork (50 mm → ~520 dpi)
  print-sheet.html   plaque at exactly 50 mm + 100 mm calibration ruler

Run with the QR tooling venv (segno + pillow):
  <venv>/bin/python tools/build_plaque.py

Design notes:
  * QR error correction Q — survives print artifacts and glare.
  * The design is deliberately asymmetric (corner triangle, north arrow,
    off-center text block) so any axis flip in the tracked overlay is
    visible at a glance, mirroring the domino rig's asymmetry tell.
  * The north arrow marks authored +Y: when placing the plaque on the
    rig, the arrow points toward the dominos (scene north, §F).
"""

from pathlib import Path

import segno
from PIL import Image, ImageDraw, ImageFont

AR_EXPERIENCE_URL = "https://ar-ramapo.onrender.com"

SIZE_PX = 1024          # artwork resolution
SIZE_MM = 50.0          # physical width — manifest physicalTargetWidthMeters
PX_PER_MM = SIZE_PX / SIZE_MM

OUT_DIR = Path(__file__).resolve().parent / "plaque"

# The manifest's trackingImageUrl (AR_SYSTEM.md §E, Phase 4) points at the
# served copy: ARKit builds its ARReferenceImage from this exact bitmap.
# Same single-source artwork, copied into the public tree — never authored
# twice.
SERVED_COPY = Path(__file__).resolve().parents[1] / "public" / "assets" / "bench-plaque.png"


def mm(v: float) -> int:
    return round(v * PX_PER_MM)


def load_font(size_px: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    ttc = "/System/Library/Fonts/Helvetica.ttc"
    try:
        return ImageFont.truetype(ttc, size_px, index=1 if bold else 0)
    except OSError:
        return ImageFont.truetype(ttc, size_px)


def build_artwork() -> Image.Image:
    img = Image.new("RGB", (SIZE_PX, SIZE_PX), "white")
    draw = ImageDraw.Draw(img)
    black = (10, 10, 10)

    # Border frame, inset so trim scissors don't eat it.
    inset, stroke = mm(1.2), mm(0.4)
    draw.rectangle(
        [inset, inset, SIZE_PX - inset, SIZE_PX - inset],
        outline=black,
        width=stroke,
    )

    # Asymmetry tell: solid triangle in the top-left corner only.
    tri = mm(9)
    base = inset + stroke + mm(0.8)
    draw.polygon(
        [(base, base), (base + tri, base), (base, base + tri)],
        fill=black,
    )

    # North arrow at top-center — authored +Y points this way (§F).
    ax, ay, ah = SIZE_PX // 2, base, mm(3.2)
    draw.polygon(
        [(ax, ay), (ax - ah // 2, ay + ah), (ax + ah // 2, ay + ah)],
        fill=black,
    )
    n_font = load_font(mm(2.6), bold=True)
    draw.text((ax + ah, ay + mm(0.2)), "N", font=n_font, fill=black)

    # QR code, centered, ~31 mm wide including its 4-module quiet zone.
    qr = segno.make(AR_EXPERIENCE_URL, error="q")
    modules = qr.symbol_size(border=4)[0]
    scale = max(1, mm(31) // modules)
    qr_img_path = OUT_DIR / "_qr_tmp.png"
    qr.save(qr_img_path, scale=scale, border=4)
    qr_img = Image.open(qr_img_path).convert("RGB")
    qr_img_path.unlink()

    qr_x = (SIZE_PX - qr_img.width) // 2
    qr_y = mm(9)
    img.paste(qr_img, (qr_x, qr_y))

    # Text block, left-aligned under the QR (off-center = more asymmetry).
    tx = mm(7)
    title_font = load_font(mm(4.6), bold=True)
    sub_font = load_font(mm(2.4))
    draw.text((tx, mm(40.0)), "AR SITE MODEL", font=title_font, fill=black)
    draw.text((tx, mm(45.2)), "Scan to launch the experience", font=sub_font, fill=black)

    return img


PRINT_SHEET = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>bench-plaque print sheet</title>
<style>
  @page {{ margin: 12mm; }}
  body {{ font: 11pt/1.5 system-ui, sans-serif; color: #111; margin: 0; }}
  h1 {{ font-size: 14pt; }}
  .plaque {{ position: relative; width: 50mm; height: 50mm; margin: 8mm 0 0 8mm; }}
  .plaque img {{ width: 50mm; height: 50mm; display: block; }}
  .crop {{ position: absolute; width: 6mm; height: 6mm; }}
  .crop i {{ position: absolute; background: #000; }}
  .crop .h {{ width: 6mm; height: 0.2mm; }}
  .crop .v {{ width: 0.2mm; height: 6mm; }}
  .tl {{ top: -6.2mm; left: -6.2mm; }} .tl .h {{ bottom: 0; }} .tl .v {{ right: 0; }}
  .tr {{ top: -6.2mm; right: -6.2mm; }} .tr .h {{ bottom: 0; }} .tr .v {{ left: 0; }}
  .bl {{ bottom: -6.2mm; left: -6.2mm; }} .bl .h {{ top: 0; }} .bl .v {{ right: 0; }}
  .br {{ bottom: -6.2mm; right: -6.2mm; }} .br .h {{ top: 0; }} .br .v {{ left: 0; }}
  .ruler {{ width: 100mm; height: 8mm; margin-top: 14mm; border: 0.3mm solid #000;
            background: repeating-linear-gradient(to right,
              #000 0, #000 0.25mm, transparent 0.25mm, transparent 10mm); }}
  .ruler-label {{ font-size: 9pt; margin-top: 1mm; }}
  ol {{ max-width: 150mm; }}
</style>
</head>
<body>
<h1>AR bench-test launch plaque — 50 × 50 mm</h1>
<ol>
  <li>Print at <strong>100% scale / "Actual Size"</strong> — never "Fit to page".</li>
  <li>Verify the calibration bar below measures <strong>exactly 100 mm</strong> with a ruler.
      If it doesn't, the plaque is unusable: reprint (physicalTargetWidthMeters = 0.05 depends on it).</li>
  <li>Cut along the crop marks; tape the plaque <strong>dead flat</strong> on the box cover
      at the measured spot, north arrow (▲N) pointing at the dominos.</li>
</ol>
<div class="plaque">
  <span class="crop tl"><i class="h"></i><i class="v"></i></span>
  <span class="crop tr"><i class="h"></i><i class="v"></i></span>
  <span class="crop bl"><i class="h"></i><i class="v"></i></span>
  <span class="crop br"><i class="h"></i><i class="v"></i></span>
  <img src="bench-plaque.png" alt="bench plaque artwork">
</div>
<div class="ruler"></div>
<div class="ruler-label">calibration bar — must measure exactly 100 mm (ticks every 10 mm)</div>
</body>
</html>
"""


if __name__ == "__main__":
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    artwork = build_artwork()
    artwork.save(OUT_DIR / "bench-plaque.png")
    artwork.save(SERVED_COPY)
    (OUT_DIR / "print-sheet.html").write_text(PRINT_SHEET)
    print(f"wrote {OUT_DIR / 'bench-plaque.png'}")
    print(f"wrote {SERVED_COPY}  (manifest trackingImageUrl)")
    print(f"wrote {OUT_DIR / 'print-sheet.html'}")
