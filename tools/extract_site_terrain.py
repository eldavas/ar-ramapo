"""Digital-twin terrain extraction — stage 1 of 2 (AR_SYSTEM.md §G Phase 3
production-swap design notes).

Reads the real site DWG (converted to DXF via ODA File Converter — see the
digital-twin sourcing notes), builds a triangulated terrain surface from the
topography contours clipped to the physical panel footprint, and writes a
small intermediate JSON that `build_site_terrain.py` (stage 2, runs inside
Blender) consumes directly as a vertex/triangle mesh. Split into two stages
because `ezdxf` and `scipy` are system-Python dependencies, not available
inside Blender's bundled interpreter — same reason `build_plaque.py` and
`compile_mind_target.mjs` are separate tools rather than one script.

Run with system Python3 (ezdxf + scipy installed via pip3):

    python3 tools/extract_site_terrain.py

Crop rectangle: derived dynamically from the `00 LASER CUT` layer (the
panel-cut lines the fabricator added to the 2026-08-12 drawing), not
hardcoded — if a future drawing revision changes the panel layout, this
script re-derives it automatically instead of needing manual constants
updated (unlike the bench-test rig's ruler-measured MEASUREMENT SHEET in
build_bench_scene.py, which genuinely can't be recomputed from a file).

REVISION (2026-08-12, second pass): the first version of this script used
ONLY closed contour loops (231 of 425), filled and stacked as flat extruded
layers matching an assumed laser-cut-and-laminated construction. A visual
comparison against the actual physical model showed that assumption was
wrong on two counts — the 194 excluded open contours (Civil 3D breaks
contours at surface-boundary/TIN-triangle-edges, not real data gaps) turned
out to cover most of the terrain, not just the edges, and the physical
model itself looks like a smooth sculpted surface with fine engraved
contour lines, not a visibly stepped layer-cake. This version instead
builds a proper Delaunay-triangulated surface (TIN) from EVERY contour's
points, open or closed — sidestepping the closed-polygon-fill problem
entirely, since a TIN only needs scattered (x, y, z) samples, not
reconstructed loops.
"""

import json
import math
from pathlib import Path

import ezdxf
import numpy as np
from scipy.spatial import Delaunay

REPO_ROOT = Path(__file__).resolve().parent.parent
DXF_PATH = REPO_ROOT / "cad-source" / "out" / "Site Model (2026-08-12).dxf"
OUT_PATH = REPO_ROOT / "cad-source" / "out" / "site_terrain.json"

TOPO_LAYER = "CG-TOPO-Site Model"
CROP_LAYER = "00 LASER CUT"

# 1 physical inch = 80 real feet (confirmed exactly from the panel-grid
# geometry, digital-twin sourcing notes). Converts real-world feet directly
# to authored meters at the model's physical scale.
FT_TO_MODEL_M = 0.0254 / 80.0

# Per-contour point-chain simplification before triangulation (perpendicular
# distance, in ft) — cuts redundant near-collinear points along each contour
# without touching cross-contour (slope) detail, unlike a naive XY grid-thin
# which would conflate points from different elevations that happen to sit
# close together on a steep slope.
SIMPLIFY_TOLERANCE_FT = 1.5

# Extra margin fed into the triangulation beyond the crop rectangle so
# Delaunay's own convex-hull boundary effects land outside the area we
# actually keep, then triangles are trimmed back to the exact crop below.
PAD_FT = 150.0


def derive_crop_rectangle(msp):
    """Returns (origin_x, origin_y, angle_rad, width_ft, depth_ft, u_sign,
    v_sign) for the panel footprint, read from the 00 LASER CUT layer's 7
    grid lines (3 dividers spanning the depth, 4 spanning the width)
    rather than assumed.

    Origin corner (2026-08-13): confirmed against the reference photo
    (RAMAPO SITE plaque corner) by cross-referencing the real building
    cluster position — the buildings hug the SAME v=0 edge the corner
    below sits on, at the OPPOSITE u end, matching the photo's bare-ridge
    gap on the RAMAPO SITE side vs. the building-covered far end of that
    edge. `u_sign=-1.0` mirrors u only (v is untouched by the origin move
    itself: the origin sits on the same v=0 edge as the panel-grid's
    naturally-derived corner, so every v value is identical either way —
    only which end of that edge is u=0 changes).

    `v_sign=-1.0` (2026-08-18): a SECOND, independent mirror, not related
    to the origin move above. Originally v was 0 at the front edge and
    -depth_ft at the back — correct, but left-handed once combined with
    u_sign's mirror (one axis flipped, not both), which is exactly why
    Blender's standard top-view convention (right-handed: +X screen-right,
    +Y screen-up) rendered front at the TOP with left still on the left —
    a real, confusing-at-a-glance consequence, confirmed by direct
    reasoning with the user rather than guessed. Flipping v as well makes
    two mirrors, which compose into a proper rotation — right-handed again
    — so Blender's top view now puts front at the BOTTOM (v=0, the
    smallest value) and back at the TOP (v=+depth_ft, the largest), with
    left/right and wide/narrow both unaffected, matching how a person
    actually stands in front of the physical model. Neither `u_sign` nor
    `v_sign` can be folded into `angle` (a rotation) since between them
    they mirror only one axis at a time relative to the "natural" DXF
    frame; two independent sign flags are the correct representation, not
    a workaround."""
    lines = [e for e in msp if e.dxftype() == "LINE" and e.dxf.layer == CROP_LAYER]
    if not lines:
        raise RuntimeError(f"no LINE entities on layer {CROP_LAYER!r} — crop rectangle undetectable")

    def length(e):
        s, en = e.dxf.start, e.dxf.end
        return math.hypot(en.x - s.x, en.y - s.y)

    lengths = sorted({round(length(e), 1) for e in lines})
    if len(lengths) != 2:
        raise RuntimeError(f"expected exactly 2 distinct line lengths (width/depth dividers), got {lengths}")
    depth_ft, width_ft = lengths  # shorter = depth (3 dividers), longer = width (4 dividers)

    width_edge = next(e for e in lines if abs(length(e) - width_ft) < 0.5)
    s = width_edge.dxf.start
    dx, dy = width_edge.dxf.end.x - s.x, width_edge.dxf.end.y - s.y
    angle = math.atan2(dy, dx)

    ux, uy = math.cos(angle), math.sin(angle)
    vx, vy = -math.sin(angle), math.cos(angle)
    pts = set()
    for e in lines:
        pts.add((e.dxf.start.x, e.dxf.start.y))
        pts.add((e.dxf.end.x, e.dxf.end.y))
    ref_x, ref_y = next(iter(pts))
    best = min(pts, key=lambda p: ((p[0] - ref_x) * ux + (p[1] - ref_y) * uy,
                                    (p[0] - ref_x) * vx + (p[1] - ref_y) * vy))
    # `best` is the panel-grid corner on the buildings' end of the v=0
    # edge; the RAMAPO SITE corner is the other end of that same edge.
    ox, oy = best[0] + width_ft * ux, best[1] + width_ft * uy
    return ox, oy, angle, width_ft, depth_ft, -1.0, -1.0


def to_local_uv(x, y, ox, oy, angle, u_sign=1.0, v_sign=1.0):
    ux, uy = u_sign * math.cos(angle), u_sign * math.sin(angle)
    vx, vy = v_sign * -math.sin(angle), v_sign * math.cos(angle)
    dx, dy = x - ox, y - oy
    return dx * ux + dy * uy, dx * vx + dy * vy


def douglas_peucker(points, tolerance):
    """Simplifies an open point chain (works fine on closed loops too, just
    treating first/last as the chain's two ends rather than re-closing)."""
    if len(points) < 3:
        return points

    def perp_dist(pt, a, b):
        if a == b:
            return math.hypot(pt[0] - a[0], pt[1] - a[1])
        num = abs((b[0] - a[0]) * (a[1] - pt[1]) - (a[0] - pt[0]) * (b[1] - a[1]))
        den = math.hypot(b[0] - a[0], b[1] - a[1])
        return num / den

    def simplify(pts):
        if len(pts) < 3:
            return pts
        a, b = pts[0], pts[-1]
        idx, dmax = -1, 0.0
        for i in range(1, len(pts) - 1):
            d = perp_dist(pts[i], a, b)
            if d > dmax:
                idx, dmax = i, d
        if dmax > tolerance:
            left = simplify(pts[: idx + 1])
            right = simplify(pts[idx:])
            return left[:-1] + right
        return [a, b]

    return simplify(points)


def main():
    doc = ezdxf.readfile(str(DXF_PATH))
    msp = doc.modelspace()

    ox, oy, angle, width_ft, depth_ft, u_sign, v_sign = derive_crop_rectangle(msp)
    print(f"crop origin (RAMAPO SITE plaque corner): ({ox:.3f}, {oy:.3f})  "
          f"v-axis reference bearing: {math.degrees(angle):.4f} deg  "
          f"u_sign: {u_sign:+.0f}  v_sign: {v_sign:+.0f}  size: {width_ft:.1f} x {depth_ft:.1f} ft")

    proxy = next(e for e in msp if e.dxftype() == "ACAD_PROXY_ENTITY" and e.dxf.layer == TOPO_LAYER)
    virtual = list(proxy.virtual_entities())
    all_polys = [v for v in virtual if v.dxftype() == "POLYLINE"]
    print(f"topo contours: {len(all_polys)} "
          f"({sum(1 for p in all_polys if p.is_closed)} closed, "
          f"{sum(1 for p in all_polys if not p.is_closed)} open — "
          f"ALL used this pass, see revision note in module docstring)")

    # Gather every contour's points (padded region around the crop), each
    # simplified along its own chain before joining the master point cloud.
    raw_points = []  # (u, v, elevation_ft)
    pts_before = pts_after = 0
    for poly in all_polys:
        elev_ft = round(poly.vertices[0].dxf.location.z, 1)
        uv_chain = [to_local_uv(v.dxf.location.x, v.dxf.location.y, ox, oy, angle, u_sign, v_sign) for v in poly.vertices]
        in_padded = [
            (u, v) for u, v in uv_chain
            if -PAD_FT <= u <= width_ft + PAD_FT and -PAD_FT <= v <= depth_ft + PAD_FT
        ]
        if len(in_padded) < 2:
            continue
        pts_before += len(in_padded)
        simplified = douglas_peucker(in_padded, SIMPLIFY_TOLERANCE_FT) if len(in_padded) >= 3 else in_padded
        pts_after += len(simplified)
        raw_points.extend((u, v, elev_ft) for u, v in simplified)

    print(f"points: {pts_before} -> {pts_after} after per-contour simplification "
          f"({100 * (1 - pts_after / pts_before):.0f}% reduction)")

    if len(raw_points) < 4:
        raise RuntimeError("not enough points survived filtering to triangulate")

    pts = np.array(raw_points)  # columns: u, v, elevation_ft
    # Deduplicate coincident (u, v) — Delaunay chokes on exact duplicate
    # input points (which do occur where separate contours happen to share
    # a vertex, e.g. at a saddle).
    _, unique_idx = np.unique(pts[:, :2].round(3), axis=0, return_index=True)
    pts = pts[unique_idx]

    tri = Delaunay(pts[:, :2])
    print(f"triangulated: {len(pts)} points -> {len(tri.simplices)} triangles (pre-crop-clip)")

    # Trim to the exact crop rectangle by triangle centroid — the padding
    # margin above means only the outer fringe of triangles gets cut here,
    # so this stays close to a clean rectangular edge rather than a jagged
    # convex-hull boundary.
    centroids_u = pts[tri.simplices, 0].mean(axis=1)
    centroids_v = pts[tri.simplices, 1].mean(axis=1)
    keep = (centroids_u >= 0) & (centroids_u <= width_ft) & (centroids_v >= 0) & (centroids_v <= depth_ft)
    kept_tris = tri.simplices[keep]
    print(f"kept {len(kept_tris)} of {len(tri.simplices)} triangles inside the exact crop rectangle")

    # Drop unused vertices and remap triangle indices, so the exported mesh
    # doesn't carry the padding-only points nothing references.
    used = np.unique(kept_tris)
    remap = {old: new for new, old in enumerate(used)}
    final_tris = np.vectorize(remap.get)(kept_tris)
    final_pts = pts[used]

    min_elev = final_pts[:, 2].min()
    max_elev = final_pts[:, 2].max()

    out = {
        "source_dxf": DXF_PATH.name,
        "scale_note": "1 model inch = 80 real feet (1:960), confirmed exact from panel-grid geometry",
        "ft_to_model_m": FT_TO_MODEL_M,
        "crop_origin_dwg": [ox, oy],
        "crop_origin_note": "RAMAPO SITE plaque corner (confirmed against reference photo 2026-08-13)",
        "crop_bearing_deg": math.degrees(angle),
        "crop_bearing_note": "v-axis reference angle, NOT the true +u/+v bearing — see u_sign/v_sign",
        "crop_u_sign": u_sign,
        "crop_v_sign": v_sign,
        "crop_v_note": "v=0 at FRONT edge, v=+depth_ft at BACK edge (flipped 2026-08-18 for a right-handed, intuitive frame)",
        "crop_size_ft": [width_ft, depth_ft],
        "min_elevation_ft": float(min_elev),
        "max_elevation_ft": float(max_elev),
        "vertices_m": [
            [round(u * FT_TO_MODEL_M, 6), round(v * FT_TO_MODEL_M, 6), round((z - min_elev) * FT_TO_MODEL_M, 6)]
            for u, v, z in final_pts
        ],
        "triangles": final_tris.tolist(),
    }

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(out))
    print(f"\nfinal mesh: {len(final_pts)} verts, {len(final_tris)} triangles, "
          f"relief {min_elev:.0f}-{max_elev:.0f} ft ({(max_elev - min_elev) * FT_TO_MODEL_M / 0.0254:.3f} in)")
    print(f"wrote {OUT_PATH}")


if __name__ == "__main__":
    main()
