"""Candidate abstract tracking-target artwork for the 4 site-model ledge
mounts (front/back/left/right) — first pass at replacing the QR-plaque
artwork as the physical thing 8th Wall's image tracker locks onto.

BACKGROUND (2026-08-2x planning session, not yet wired into
build_site_buildings.py/manifest.ts): on-device testing of the QR-plaque
design (tools/build_site_plaques.py) showed slow acquisition, wrong
initial pose, and continuous jitter/repositioning while moving the
camera. Root cause, cross-checked against two independent sources:

  - This project's own docs/asset-authoring-guide.md §3.1: avoid
    repeating patterns, avoid extremely thin/long aspect ratios (the old
    plaques were 90x30mm, 3:1), avoid large flat/plain areas.
  - 8th Wall's own docs (8thwall.org/docs/engine/guides/image-targets):
    "a lot of varied detail" + "high contrast"; avoid "repetitive
    patterns," "excessive dead space," "low resolution images"; and
    "Image target detection cannot distinguish between colors, so don't
    rely on it as a key differentiator between targets."

A QR code IS a repeating black/white module grid, and since all 4
plaques encode the SAME experience URL (§A: identity resolved by
tracking, never the QR payload), that grid is pixel-identical across all
4 "distinct" targets — violating the repetition rule twice over. Decision
(this planning session): decouple the two roles entirely.

  - The QR code becomes pure session-bootstrap (open the web app) and
    moves OFF the ledge entirely — a separate, ordinary QR sign, no
    longer part of the tracked scene at all.
  - The 4 ledge-mounted plaques are replaced by purpose-built abstract
    tracking artwork: no QR, no shared regions between sides, true
    binary black/white (a monochrome laser toner printer can't do
    color, and 8th Wall's own docs confirm color wouldn't help tracking
    anyway), closer to square than the old 3:1 landscape shape.

TECHNIQUE: random Voronoi cells (scipy.spatial.cKDTree nearest-seed
lookup), each cell colored pure black or white, roughly balanced so no
tone dominates. This produces dense, highly irregular, non-repeating
edges — directly what both guidance sources ask for — and is true binary
tone throughout, so a B&W laser printer renders it with no gray
halftone-dithering (dithering would risk imposing the printer's own
repeating dot screen on top of the artwork). Each side uses a distinct
RNG seed, so the 4 images share zero visual structure (unlike the old
shared QR block).

A small side label (FRONT/BACK/LEFT/RIGHT) is stamped in one corner —
both for installer verification and as a substitute orientation cue now
that the shape is square (the old landscape aspect ratio used to make a
90-degree mounting mistake obvious on its own; legible text serves the
same purpose here, since upside-down/sideways text is obviously wrong to
a human at a glance).

STATUS: candidates only. Not sized/positioned against the real ledge
geometry in build_site_buildings.py, not compiled into 8th Wall/MindAR
targets, not wired into the manifest. Next steps once these are visually
reviewed (and ideally checked against 8th Wall Studio's own upload
feedback): compile with tools/compile_8thwall_target.mjs, validate on the
single-target harness pattern (like 8thwall-test/site-front), then
recompute build_site_buildings.py's plaque geometry + manifest.ts's
'site' entry offsets — same discipline as every other tracking change
in this project.

Outputs (tools/plaque/site-tracking/):
  tracking-front.png / tracking-back.png / tracking-left.png / tracking-right.png
  print-sheet.html   all 4 at exact size + a 100mm calibration ruler

Run (needs numpy, scipy, pillow — all already project dependencies):
  python3 tools/build_site_tracking_targets.py
"""

from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont
from scipy.spatial import cKDTree

OUT_DIR = Path(__file__).resolve().parent / "plaque" / "site-tracking"

# Square, not the old 90x30mm landscape -- freed from needing to share
# the plaque with a QR+text layout, and squarer shapes track more
# reliably per docs/asset-authoring-guide.md §3.1. Still ledge-bounded:
# real measured ledge is 3.5cm (build_site_buildings.py's LEDGE_WIDTH_M);
# 30mm keeps the same ~5mm install-tolerance margin the old design used,
# now applied on both axes since the shape is square.
TARGET_SIZE_MM = 30.0
# Matches build_site_plaques.py's density -- @8thwall/image-target-cli
# enforces a hard 640px minimum per dimension; 30 * 24 = 720 > 640.
PX_PER_MM = 24.0
SIZE_PX = round(TARGET_SIZE_MM * PX_PER_MM)

# Seed point count for the Voronoi cells -- tuned for "dense, varied
# detail" at this resolution without looking like uniform static; not a
# measured/derived number, adjust and re-run if a printed candidate looks
# too sparse or too busy.
N_CELLS = 140

BLACK = 10
WHITE = 255
BLACK_RGB = (BLACK, BLACK, BLACK)
WHITE_RGB = (WHITE, WHITE, WHITE)

# One RNG seed per side -- distinct seeds are the entire mechanism that
# guarantees the 4 images share no visual structure (unlike the old
# shared QR block). Values themselves are arbitrary, just fixed so runs
# are reproducible.
SIDES = {"front": 1, "back": 2, "left": 3, "right": 4}


def sample_points(rng: np.random.Generator, n_points: int, size: float,
                   min_dist_factor: float = 0.75, max_attempts: int = 60) -> np.ndarray:
    """Blue-noise-ish scatter (rejection sampling against a minimum
    pairwise distance) instead of pure uniform random. Uniform random
    clusters unevenly, producing occasional oversized Voronoi cells with
    smooth, edge-free interiors -- visible as "dead space" blobs in the
    first candidate batch (2026-08-2x planning session). Falls back to
    placing a point regardless once max_attempts is exhausted, so the
    point count is always exactly n_points even under tight packing."""
    avg_spacing = size / np.sqrt(n_points)
    min_dist = min_dist_factor * avg_spacing

    points = np.empty((n_points, 2))
    points[0] = rng.uniform(0, size, size=2)
    for i in range(1, n_points):
        for _ in range(max_attempts):
            candidate = rng.uniform(0, size, size=2)
            if np.hypot(*(points[:i] - candidate).T).min() >= min_dist:
                break
        points[i] = candidate
    return points


def make_voronoi_pattern(seed: int) -> np.ndarray:
    rng = np.random.default_rng(seed)
    points = sample_points(rng, N_CELLS, SIZE_PX)

    # Roughly balanced black/white per cell (shuffled, not alternating in
    # seed order) so no large same-tone cluster dominates the image --
    # 8th Wall's "avoid excessive dead space" guidance applies to any one
    # tone covering too much area, not just literal blank space.
    tones = np.resize([BLACK, WHITE], N_CELLS)
    rng.shuffle(tones)

    yy, xx = np.mgrid[0:SIZE_PX, 0:SIZE_PX]
    pixel_coords = np.stack([xx.ravel(), yy.ravel()], axis=1).astype(np.float64)

    nearest_cell = cKDTree(points).query(pixel_coords)[1]
    return tones[nearest_cell].reshape(SIZE_PX, SIZE_PX).astype(np.uint8)


def load_font(size_px: int, bold: bool = True) -> ImageFont.FreeTypeFont:
    ttc = "/System/Library/Fonts/Helvetica.ttc"
    try:
        return ImageFont.truetype(ttc, size_px, index=1 if bold else 0)
    except OSError:
        return ImageFont.truetype(ttc, size_px)


def add_side_label(img: Image.Image, label: str) -> Image.Image:
    """Small legible tag in one corner -- installer verification +
    orientation cue (see module docstring). Needs its own solid-white
    backing box to stay legible over the busy pattern; kept small (~20%
    of one edge) so it doesn't eat into the tracking-relevant area."""
    draw = ImageDraw.Draw(img)
    font = load_font(round(SIZE_PX * 0.11))
    pad = round(SIZE_PX * 0.015)

    bbox = draw.textbbox((0, 0), label, font=font)
    text_w, text_h = bbox[2] - bbox[0], bbox[3] - bbox[1]
    box = (pad, SIZE_PX - text_h - pad * 4, pad * 3 + text_w, SIZE_PX - pad)

    draw.rectangle(box, fill=WHITE_RGB, outline=BLACK_RGB, width=max(1, round(SIZE_PX * 0.006)))
    draw.text((box[0] + pad, box[1] + pad), label, font=font, fill=BLACK_RGB)
    return img


def build_candidate(side: str, seed: int) -> Image.Image:
    arr = make_voronoi_pattern(seed)
    img = Image.fromarray(arr, mode="L").convert("RGB")
    return add_side_label(img, side.upper())


def build_print_sheet() -> str:
    tiles = "\n".join(
        f"""<div class="target">
  <img src="tracking-{side}.png" alt="{side} tracking-target candidate">
  <div class="tag">{side.upper()}</div>
</div>"""
        for side in SIDES
    )
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>site tracking-target candidates — print sheet</title>
<style>
  @page {{ margin: 12mm; }}
  body {{ font: 11pt/1.5 system-ui, sans-serif; color: #111; margin: 0; }}
  h1 {{ font-size: 14pt; }}
  .grid {{ display: grid; grid-template-columns: repeat(2, {TARGET_SIZE_MM}mm); gap: 14mm; margin-top: 8mm; }}
  .target {{ position: relative; width: {TARGET_SIZE_MM}mm; height: {TARGET_SIZE_MM}mm; }}
  .target img {{ width: {TARGET_SIZE_MM}mm; height: {TARGET_SIZE_MM}mm; display: block; }}
  .tag {{ position: absolute; bottom: -6mm; left: 0; font-size: 8pt; font-weight: bold; }}
  .ruler {{ width: 100mm; height: 8mm; margin-top: 20mm; border: 0.3mm solid #000;
            background: repeating-linear-gradient(to right,
              #000 0, #000 0.25mm, transparent 0.25mm, transparent 10mm); }}
  .ruler-label {{ font-size: 9pt; margin-top: 1mm; }}
  ol {{ max-width: 150mm; }}
  .note {{ max-width: 150mm; padding: 3mm; border: 0.3mm dashed #000; font-size: 9pt; }}
</style>
</head>
<body>
<h1>Site tracking-target candidates — 4 × {TARGET_SIZE_MM:g}mm × {TARGET_SIZE_MM:g}mm</h1>
<div class="note">
  <strong>These are CANDIDATES, not final artwork.</strong> Print for visual
  review and hand-testing only — not yet compiled into an 8th Wall/MindAR
  target or wired into the app. Do not remove/replace the existing printed
  QR plaques on the ledge yet.
</div>
<ol>
  <li>Print at <strong>100% scale / "Actual Size"</strong> — never "Fit to page".</li>
  <li>Verify the calibration bar below measures exactly 100mm with a ruler
      before trusting anything else on this page.</li>
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
    for side, seed in SIDES.items():
        candidate = build_candidate(side, seed)
        path = OUT_DIR / f"tracking-{side}.png"
        candidate.save(path)
        print(f"wrote {path} ({SIZE_PX}x{SIZE_PX}px, {TARGET_SIZE_MM:g}mm @ {PX_PER_MM:g}px/mm)")
    sheet_path = OUT_DIR / "print-sheet.html"
    sheet_path.write_text(build_print_sheet())
    print(f"wrote {sheet_path}")
