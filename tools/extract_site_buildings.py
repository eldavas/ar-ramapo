"""Digital-twin building extraction — stage 1 of 2, buildings
(AR_SYSTEM.md §G Phase 3 production-swap design notes). Companion to
extract_site_terrain.py; run with system Python3 (ezdxf), AFTER
extract_site_terrain.py (reads its output for the shared elevation
baseline):

    python3 tools/extract_site_buildings.py

Reads the `A-BLDG-OUTL` layer (flat footprints only — the DWG itself
carries no height/volume data) and writes `cad-source/out/site_buildings.json`
for `build_site_buildings.py` (stage 2, Blender) to extrude.

FILTERING: 81 raw footprints on this layer are a mix of real buildings and
small site furniture (light poles, signage, etc.) sharing the same layer
with no other distinguishing attribute. Area gives a clean, data-driven
split — sorted by footprint area, there is a sharp natural gap between
2362 sqft and 817 sqft (vs. a gradual slope elsewhere in the distribution),
so >= 2000 sqft is the real-building threshold: 21 footprints.

HEIGHT DATA (2026-08-12 revision): a building-height table surfaced with
per-building Ground MSL / Roof MSL / footprint Side A x Side B for 14 named
buildings (Res. Parking Garage, Residence 01-10, Events Facility, Office
Building, Media Building). Matched against the 21 extracted footprints by
oriented-bounding-box dimensions, not by name (the table has no
DWG-entity link):

  - Media Building: unique dimension match (589.9x386.4 vs. table's
    584.92x360 — some slop expected, an OBB approximation vs. an as-built
    rectangle aren't identical).
  - Res. Parking Garage: unique, near-exact dimension match (256.0x123.0).
  - The 10 Residences: footprint widths are uniformly ~88.4 ft where the
    table's Side B is uniformly 65 ft — a consistent ~23 ft offset,
    almost certainly an attached deck/patio the DWG footprint includes and
    the table's core building envelope doesn't. Lengths group cleanly into
    three dimension clusters matching the table's Side A value AND count
    exactly: 224 ft x4, 195 ft x4, 167 ft x2. Within each group the
    specific footprint <-> specific "Residence NN" pairing isn't
    determinable from dimensions alone (all four/four/two are
    dimensionally identical) — paired by terrain-sampled ground elevation
    order against the table's Ground MSL order instead, on the reasonable
    assumption a hillside residence arc steps up monotonically. If that
    assumption is wrong, at most two same-dimension, same-height-ish units
    swap identities — a labeling nuance, not a visible defect (heights
    within a group differ by <1 ft).
  - Office Building + Events Facility: the table lists these as two
    buildings (68 ft and 28 ft respectively — a big difference), but only
    ONE footprint exists at a plausible combined size (123826 sqft,
    738.6x278.4 OBB) — they are almost certainly drawn as one continuous,
    physically-connected outline in this layer. NOT SPLIT by this script
    (no defensible way to divide the footprint from bbox geometry alone
    without guessing a boundary) — left as a placeholder height and
    flagged loudly. Needs either a real split line from the source
    drawing or manual correction.
  - The remaining 8 kept footprints (32785 down to 2362 sqft) don't match
    any table row — real buildings/structures, just not covered by this
    table. Stay on the placeholder height, flagged individually.

KNOWN GAP, not extractable from this file at all: the user identified a
raised enclosed pedestrian walkway linking the residences to the events
building. This DWG has exactly 3 layers total (00 LASER CUT, A-BLDG-OUTL,
CG-TOPO-Site Model — confirmed by direct inspection) and none of the small
excluded footprints are positioned/shaped like a connector between the two
areas. It is not hiding in this file under a name this script didn't
check — it needs a separate source (the coworker, or another drawing).
"""

import json
import math
from pathlib import Path

import ezdxf

REPO_ROOT = Path(__file__).resolve().parent.parent
DXF_PATH = REPO_ROOT / "cad-source" / "out" / "Site Model (2026-08-12).dxf"
TERRAIN_JSON = REPO_ROOT / "cad-source" / "out" / "site_terrain.json"
OUT_PATH = REPO_ROOT / "cad-source" / "out" / "site_buildings.json"

BLDG_LAYER = "A-BLDG-OUTL"
CROP_LAYER = "00 LASER CUT"
REAL_BUILDING_MIN_AREA_SQFT = 2000.0
PLACEHOLDER_HEIGHT_FT = 28.0
FT_TO_MODEL_M = 0.0254 / 80.0
DIM_TOLERANCE_FT = 40.0

# name, side_a_ft, side_b_ft, height_ft, ground_msl_ft, roof_msl_ft
HEIGHT_TABLE = [
    ("Res. Parking Garage", 256.00, 123.00, 36.00, 655.00, 691.00),
    ("Residence 03", 195.00, 65.00, 57.50, 699.00, 756.50),
    ("Residence 02", 167.00, 65.00, 57.40, 697.00, 754.40),
    ("Residence 01", 224.00, 65.00, 57.50, 695.00, 752.50),
    ("Residence 06", 195.00, 65.00, 57.50, 710.50, 768.00),
    ("Residence 05", 195.00, 65.00, 57.50, 708.50, 766.00),
    ("Residence 04", 224.00, 65.00, 57.50, 706.50, 764.00),
    ("Residence 07", 195.00, 65.00, 58.00, 718.00, 776.00),
    ("Residence 08", 224.00, 65.00, 57.50, 720.00, 777.50),
    ("Residence 09", 224.00, 65.00, 57.50, 722.00, 779.50),
    ("Residence 10", 167.00, 65.00, 57.50, 724.00, 781.50),
    ("Events Facility (EF)", 136.30, 301.00, 28.00, 710.00, 738.00),
    ("Office Building", 285.00, 280.00, 68.00, 710.00, 778.00),
    ("Media Building (AV)", 584.92, 360.00, 55.00, 710.00, 765.00),
]


def derive_crop_rectangle(msp):
    lines = [e for e in msp if e.dxftype() == "LINE" and e.dxf.layer == CROP_LAYER]
    if not lines:
        raise RuntimeError(f"no LINE entities on layer {CROP_LAYER!r} — crop rectangle undetectable")

    def length(e):
        s, en = e.dxf.start, e.dxf.end
        return math.hypot(en.x - s.x, en.y - s.y)

    lengths = sorted({round(length(e), 1) for e in lines})
    depth_ft, width_ft = lengths
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
    return best[0], best[1], angle, width_ft, depth_ft


def to_local_uv(x, y, ox, oy, angle):
    ux, uy = math.cos(angle), math.sin(angle)
    vx, vy = -math.sin(angle), math.cos(angle)
    dx, dy = x - ox, y - oy
    return dx * ux + dy * uy, dx * vx + dy * vy


def shoelace_area(pts):
    n = len(pts)
    return abs(sum(pts[i][0] * pts[(i + 1) % n][1] - pts[(i + 1) % n][0] * pts[i][1] for i in range(n))) / 2.0


def obb_dims(pts):
    """Oriented bbox via rotating-calipers-lite: try each edge direction as
    a candidate axis, keep the one with minimum bbox area."""
    best = None
    n = len(pts)
    for i in range(n):
        ax, ay = pts[(i + 1) % n][0] - pts[i][0], pts[(i + 1) % n][1] - pts[i][1]
        edge_len = math.hypot(ax, ay)
        if edge_len < 1e-6:
            continue
        ux, uy = ax / edge_len, ay / edge_len
        vx, vy = -uy, ux
        us = [p[0] * ux + p[1] * uy for p in pts]
        vs = [p[0] * vx + p[1] * vy for p in pts]
        w, h = max(us) - min(us), max(vs) - min(vs)
        if best is None or w * h < best[0]:
            best = (w * h, w, h)
    return best[1], best[2]


def nearest_terrain_z_m(terrain_verts_m, x_m, y_m):
    best_z, best_d2 = 0.0, float("inf")
    for vx, vy, vz in terrain_verts_m:
        d2 = (vx - x_m) ** 2 + (vy - y_m) ** 2
        if d2 < best_d2:
            best_d2, best_z = d2, vz
    return best_z


def main():
    doc = ezdxf.readfile(str(DXF_PATH))
    msp = doc.modelspace()
    ox, oy, angle, width_ft, depth_ft = derive_crop_rectangle(msp)

    terrain = json.loads(TERRAIN_JSON.read_text())
    min_elev_ft = terrain["min_elevation_ft"]
    terrain_verts_m = terrain["vertices_m"]

    raw = [e for e in msp if e.dxftype() == "LWPOLYLINE" and e.dxf.layer == BLDG_LAYER]
    candidates = []
    for e in raw:
        pts_dwg = [(p[0], p[1]) for p in e.get_points()]
        if len(pts_dwg) < 3:
            continue
        area = shoelace_area(pts_dwg)
        if area < REAL_BUILDING_MIN_AREA_SQFT:
            continue
        dim_a, dim_b = obb_dims(pts_dwg)
        if dim_a < dim_b:
            dim_a, dim_b = dim_b, dim_a
        uv = [to_local_uv(x, y, ox, oy, angle) for x, y in pts_dwg]
        centroid_u = sum(u for u, _ in uv) / len(uv)
        centroid_v = sum(v for _, v in uv) / len(uv)
        centroid_m = (centroid_u * FT_TO_MODEL_M, centroid_v * FT_TO_MODEL_M)
        candidates.append({
            "area_sqft": area, "dim_a": dim_a, "dim_b": dim_b,
            "footprint_uv": uv, "centroid_uv": (centroid_u, centroid_v), "centroid_m": centroid_m,
            "ground_z_m_sampled": nearest_terrain_z_m(terrain_verts_m, *centroid_m),
            "matched_name": None,
        })

    def dim_distance(c, side_a, side_b):
        # Table dimension order isn't consistently larger-first (Events
        # Facility lists 136.3 x 301.0 — shorter side first), so compare
        # both orderings against the candidate's own normalized (a>=b) pair.
        d1 = abs(c["dim_a"] - side_a) + abs(c["dim_b"] - side_b)
        d2 = abs(c["dim_a"] - side_b) + abs(c["dim_b"] - side_a)
        return min(d1, d2)

    unmatched_table_rows = list(HEIGHT_TABLE)
    matches = {}  # id(candidate) -> table row

    # Pass 1: uniquely-dimensioned buildings (Media, Parking Garage, Office,
    # Events Facility) — nearest by combined dimension distance, not "any
    # hit within tolerance" (a loose tolerance let a same-ballpark but
    # genuinely different footprint match ambiguously alongside the real
    # one; nearest-fit with a tight absolute cutoff avoids that).
    for row in list(unmatched_table_rows):
        name, side_a, side_b, height_ft, ground_msl, roof_msl = row
        if name.startswith("Residence"):
            continue
        pool = [c for c in candidates if id(c) not in matches]
        if not pool:
            continue
        best = min(pool, key=lambda c: dim_distance(c, side_a, side_b))
        dist = dim_distance(best, side_a, side_b)
        if dist < DIM_TOLERANCE_FT:
            matches[id(best)] = row
            unmatched_table_rows.remove(row)
            print(f"  matched '{name}': footprint {best['area_sqft']:.0f} sqft "
                  f"({best['dim_a']:.1f}x{best['dim_b']:.1f}) vs table {side_a}x{side_b} "
                  f"(combined offset {dist:.1f} ft)")
        else:
            print(f"  no dimension match found for '{name}' ({side_a}x{side_b}, "
                  f"closest was {dist:.1f} ft off) — stays on placeholder")

    # Pass 2: residences, grouped by Side A only (dimension groups of
    # matching count) — Side B is deliberately NOT compared here, since
    # every residence footprint runs ~23 ft wider than the table's Side B
    # (an attached deck/patio the table's core envelope excludes, not a
    # match failure). Paired to footprints by ground-elevation order within
    # group (see module docstring for the assumption this rests on).
    residence_rows = [r for r in unmatched_table_rows if r[0].startswith("Residence")]
    for side_a_key in sorted(set(r[1] for r in residence_rows), reverse=True):
        group_rows = sorted((r for r in residence_rows if r[1] == side_a_key), key=lambda r: r[4])  # by ground_msl
        group_candidates = sorted(
            (c for c in candidates if id(c) not in matches and abs(c["dim_a"] - side_a_key) < 5.0),
            key=lambda c: c["ground_z_m_sampled"],
        )
        if len(group_candidates) != len(group_rows):
            print(f"  WARNING: residence group Side A={side_a_key} expected {len(group_rows)} footprints, "
                  f"found {len(group_candidates)} — skipping this group's table match")
            continue
        for c, row in zip(group_candidates, group_rows):
            matches[id(c)] = row
            unmatched_table_rows.remove(row)
        names = ", ".join(r[0] for r in group_rows)
        print(f"  matched residence group Side A={side_a_key}: {len(group_rows)} footprints <-> [{names}] "
              f"(paired by ascending terrain elevation vs. ascending Ground MSL)")

    if unmatched_table_rows:
        print(f"  UNMATCHED TABLE ROWS (no footprint found): "
              f"{[r[0] for r in unmatched_table_rows]}")

    buildings = []
    for c in candidates:
        row = matches.get(id(c))
        entry = {
            "area_sqft": round(c["area_sqft"], 1),
            "footprint_m": [[round(u * FT_TO_MODEL_M, 6), round(v * FT_TO_MODEL_M, 6)] for u, v in c["footprint_uv"]],
            "centroid_m": [round(c["centroid_m"][0], 6), round(c["centroid_m"][1], 6)],
        }
        if row:
            name, side_a, side_b, height_ft, ground_msl, roof_msl = row
            entry["matched_name"] = name
            entry["height_estimated"] = False
            entry["base_z_m"] = round((ground_msl - min_elev_ft) * FT_TO_MODEL_M, 6)
            entry["height_m"] = round((roof_msl - ground_msl) * FT_TO_MODEL_M, 6)
        else:
            entry["matched_name"] = None
            entry["height_estimated"] = True
            entry["base_z_m"] = round(c["ground_z_m_sampled"], 6)
            entry["height_m"] = round(PLACEHOLDER_HEIGHT_FT * FT_TO_MODEL_M, 6)
        buildings.append(entry)

    buildings.sort(key=lambda b: -b["area_sqft"])
    for i, b in enumerate(buildings):
        b["id"] = f"building_{i:02d}"

    out = {
        "source_dxf": DXF_PATH.name,
        "real_building_min_area_sqft": REAL_BUILDING_MIN_AREA_SQFT,
        "placeholder_height_ft": PLACEHOLDER_HEIGHT_FT,
        "ft_to_model_m": FT_TO_MODEL_M,
        "known_gap": "raised enclosed pedestrian walkway (residences <-> events building) — "
                      "not present in this DWG on any layer, needs a separate source",
        "buildings": buildings,
    }

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(out, indent=2))
    matched_count = sum(1 for b in buildings if not b["height_estimated"])
    print(f"\n{len(buildings)} buildings total: {matched_count} with real table heights, "
          f"{len(buildings) - matched_count} still on the {PLACEHOLDER_HEIGHT_FT:.0f} ft placeholder")
    print(f"wrote {OUT_PATH}")


if __name__ == "__main__":
    main()
