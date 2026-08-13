"""Digital-twin combined scene builder — stage 2, buildings + terrain
(AR_SYSTEM.md §G Phase 3 production-swap design notes). Consumes both
`cad-source/out/site_terrain.json` and `cad-source/out/site_buildings.json`
(from extract_site_terrain.py and extract_site_buildings.py — both must run
first) and authors terrain + buildings together for visual review.

Run headless:

    /Applications/Blender.app/Contents/MacOS/Blender --background \
        --factory-startup --python-exit-code 1 \
        --python tools/build_site_buildings.py

Rebuilds the terrain mesh the same way build_site_terrain.py does (small
enough to duplicate rather than share a module across separate
Blender --python invocations) so this script's output is one combined,
visually-reviewable scene rather than two disconnected files.

Buildings are SEPARATE mesh objects, one per building (not merged into one
mesh) — the point, per this session's request, is that each stays
individually addressable later (visibility/color per-building on an
interaction), which a single merged mesh would rule out. Each carries a
stable `buildingId` custom property (glTF extras -> userData, same
mechanism the Golden Rule already uses for hotspots) so a future hotspot
can reference which building it targets — no hotspots are added yet,
nothing to bind them to until the highlight-on-tap interaction itself is
designed (AR_SYSTEM.md §G design notes).

REVISION (2026-08-12): a real building-height table surfaced and is now
matched against 12 of the 21 footprints (all 10 residences, the parking
garage, and the media building) — those get their actual Ground/Roof MSL,
not a guess. The other 9, including the Office Building/Events Facility
pair (present in the DWG as one merged footprint, not splittable from
geometry alone — see extract_site_buildings.py), stay on the flat
placeholder. Matched buildings render blue, placeholder ones orange, so
the gap is visible at a glance rather than hidden in a properties panel.
Still entirely missing: the raised enclosed pedestrian walkway linking the
residences to the events building — not present in this DWG on any layer,
needs a separate source.

REVISION (2026-08-13): added a placeholder mounting ledge + 4 QR-plaque
markers around the terrain footprint (AR_SYSTEM.md §A/§E four-plaque
design). The physical model has a blank border where the real "RAMAPO
SITE" title block/scale bar sit today (see the reference photo in this
session) and where the 4 real plaques will mount — confirmed this is
fabrication-only information, absent from every DXF layer (only 3 of 16
layers carry any geometry at all: topo, buildings, laser-cut grid; topo
contour data was independently confirmed to reach every crop edge with no
reserved gap). User confirmed the ledge runs uniformly on all 4 sides (so
the equal-width-on-every-side geometry below is real, not a placeholder
assumption) but the exact width is still pending the coworker's answer;
`LEDGE_WIDTH_M` below is a best guess, not a measurement — treat the
ledge/plaque geometry in this file as visual placeholders only, each
flagged with a `placeholder` userData key, and swap `LEDGE_WIDTH_M` (and
re-run) the moment the real number lands.

SCOPE: no hotspots, not wired into the experience manifest — same staging
caveat as build_site_terrain.py.
"""

import json
import sys
from pathlib import Path

import bpy
import bmesh

REPO_ROOT = Path(__file__).resolve().parent.parent
TERRAIN_JSON = REPO_ROOT / "cad-source" / "out" / "site_terrain.json"
BUILDINGS_JSON = REPO_ROOT / "cad-source" / "out" / "site_buildings.json"
GLB_PATH = REPO_ROOT / "cad-source" / "out" / "site-scene.glb"
USDZ_PATH = REPO_ROOT / "cad-source" / "out" / "site-scene.usdz"

TERRAIN_COLOR = (0.55, 0.52, 0.45, 1.0)
BUILDING_COLOR_MATCHED = (0.25, 0.45, 0.85, 1.0)      # real table height
BUILDING_COLOR_PLACEHOLDER = (0.90, 0.55, 0.15, 1.0)  # still estimated

USERDATA_BUILDING_ID_KEY = "buildingId"
USERDATA_HEIGHT_ESTIMATED_KEY = "heightEstimated"
USERDATA_MATCHED_NAME_KEY = "matchedName"

IN_TO_M = 0.0254

# --- Ledge + QR-plaque placeholders (AR_SYSTEM.md §A/§E four-plaque design)
# NOT sourced from the DWG — see the REVISION (2026-08-13) note above. Real
# board material at true physical size, so these are converted straight
# from inches/mm, NOT through FT_TO_MODEL_M (that factor is for the 1:960
# geographic terrain only).
LEDGE_WIDTH_M = 3.0 * IN_TO_M  # best guess from the reference photo — PLACEHOLDER, not measured
LEDGE_THICKNESS_M = 0.01       # visual thickness only; top face sits flush with terrain Z=0

PLAQUE_SIZE_M = 0.05           # reuses build_bench_scene.py's bench-test 50mm plaque convention
PLAQUE_THICKNESS_M = 0.002     # matches build_bench_scene.py's PLAQUE_THICKNESS

LEDGE_COLOR = (0.78, 0.71, 0.58, 1.0)              # lighter than terrain — visually distinct band
PLAQUE_PLACEHOLDER_COLOR = (1.0, 0.05, 0.75, 1.0)  # loud magenta — unmistakably not final artwork

USERDATA_PLACEHOLDER_KEY = "placeholder"
USERDATA_PLAQUE_SIDE_KEY = "plaqueSide"


def link(obj: bpy.types.Object) -> bpy.types.Object:
    bpy.context.scene.collection.objects.link(obj)
    return obj


def make_empty(name: str) -> bpy.types.Object:
    obj = bpy.data.objects.new(name, None)
    obj.empty_display_size = 0.05
    return link(obj)


def make_material(name: str, rgba) -> bpy.types.Material:
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    mat.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = rgba
    return mat


def load_json(path: Path, stage_script: str) -> dict:
    if not path.exists():
        raise RuntimeError(f"{path} not found — run `python3 tools/{stage_script}` first")
    return json.loads(path.read_text())


def build_terrain_mesh(data: dict) -> bpy.types.Object:
    """Same construction as build_site_terrain.py — see that file for the
    meshing rationale (Delaunay TIN over all contour points)."""
    mesh = bpy.data.meshes.new("site_terrain")
    mesh.from_pydata(data["vertices_m"], [], data["triangles"])
    mesh.validate()
    mesh.update()

    bm = bmesh.new()
    bm.from_mesh(mesh)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(mesh)
    bm.free()

    obj = bpy.data.objects.new("site_terrain", mesh)
    obj.data.materials.append(make_material("mat_site_terrain", TERRAIN_COLOR))
    link(obj)
    print(f"  built terrain: {len(mesh.vertices)} verts, {len(mesh.polygons)} faces")
    return obj


def build_buildings(data: dict) -> list:
    """base_z_m comes straight from stage 1 now — either the real Ground
    MSL (table-matched buildings) or a terrain-nearest-vertex sample
    (unmatched ones), both already resolved in extract_site_buildings.py.
    No ground-sampling here anymore, matching build_site_terrain.py's own
    "stage 1 does the geometry, stage 2 just authors/exports" split."""
    group = make_empty("Buildings")
    objects = []
    for b in data["buildings"]:
        footprint = b["footprint_m"]
        base_z = b["base_z_m"]
        height = b["height_m"]

        bm = bmesh.new()
        ring = [bm.verts.new((x, y, base_z)) for x, y in footprint]
        bm.verts.ensure_lookup_table()
        edges = [bm.edges.new((ring[i], ring[(i + 1) % len(ring)])) for i in range(len(ring))]
        fill = bmesh.ops.triangle_fill(bm, use_beauty=True, edges=edges)
        base_faces = [g for g in fill["geom"] if isinstance(g, bmesh.types.BMFace)]
        if base_faces:
            extrude = bmesh.ops.extrude_face_region(bm, geom=base_faces)
            new_verts = [g for g in extrude["geom"] if isinstance(g, bmesh.types.BMVert)]
            bmesh.ops.translate(bm, vec=(0.0, 0.0, height), verts=new_verts)
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)

        mesh = bpy.data.meshes.new(b["id"])
        bm.to_mesh(mesh)
        bm.free()

        color = BUILDING_COLOR_PLACEHOLDER if b["height_estimated"] else BUILDING_COLOR_MATCHED
        obj = bpy.data.objects.new(b["id"], mesh)
        obj.data.materials.append(make_material(f"mat_{b['id']}", color))
        obj.parent = group
        obj[USERDATA_BUILDING_ID_KEY] = b["id"]
        obj[USERDATA_HEIGHT_ESTIMATED_KEY] = b["height_estimated"]
        if b.get("matched_name"):
            obj[USERDATA_MATCHED_NAME_KEY] = b["matched_name"]
        link(obj)
        objects.append(obj)

    matched = sum(1 for b in data["buildings"] if not b["height_estimated"])
    print(f"  built {len(objects)} buildings (separate objects) — "
          f"{matched} with real table heights (blue), "
          f"{len(objects) - matched} on the flat placeholder (orange)")
    return objects


def build_ledge_and_plaques(terrain_data: dict) -> tuple:
    """Placeholder mounting ledge + 4 QR-plaque markers around the terrain
    footprint. Width/thickness/plaque size are all best-guess constants
    (see REVISION 2026-08-13 in the module docstring) pending the
    coworker's real measurement — everything built here carries a
    `placeholder` userData flag so it's unmistakable on later inspection.
    Deliberately does NOT compute manifest-ready originOffsetMeters/
    rotationYawDeg (§E blocks those on the real measurement too; this
    script doesn't get ahead of that)."""
    width_ft, depth_ft = terrain_data["crop_size_ft"]
    ft_to_model_m = terrain_data["ft_to_model_m"]
    width_m = width_ft * ft_to_model_m
    depth_m = depth_ft * ft_to_model_m
    L = LEDGE_WIDTH_M

    # 4 strips tiling the border with no gaps/overlaps: front/back extend
    # past the corners, left/right fill just the remaining depth span.
    strips = {
        "front": ((-L, width_m + L), (0.0, L)),
        "back": ((-L, width_m + L), (-depth_m - L, -depth_m)),
        "left": ((-L, 0.0), (-depth_m, 0.0)),
        "right": ((width_m, width_m + L), (-depth_m, 0.0)),
    }

    bm = bmesh.new()
    base_faces = []
    for (x0, x1), (y0, y1) in strips.values():
        v0 = bm.verts.new((x0, y0, 0.0))
        v1 = bm.verts.new((x1, y0, 0.0))
        v2 = bm.verts.new((x1, y1, 0.0))
        v3 = bm.verts.new((x0, y1, 0.0))
        base_faces.append(bm.faces.new((v0, v1, v2, v3)))
    extrude = bmesh.ops.extrude_face_region(bm, geom=base_faces)
    new_verts = [g for g in extrude["geom"] if isinstance(g, bmesh.types.BMVert)]
    bmesh.ops.translate(bm, vec=(0.0, 0.0, LEDGE_THICKNESS_M), verts=new_verts)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)

    mesh = bpy.data.meshes.new("site_ledge")
    bm.to_mesh(mesh)
    bm.free()

    ledge = bpy.data.objects.new("site_ledge", mesh)
    ledge.data.materials.append(make_material("mat_site_ledge", LEDGE_COLOR))
    ledge[USERDATA_PLACEHOLDER_KEY] = True
    link(ledge)

    # One QR-plaque placeholder centered on each side's ledge strip.
    plaque_group = make_empty("Plaques")
    plaque_centers = {
        "front": (width_m / 2.0, L / 2.0),
        "back": (width_m / 2.0, -depth_m - L / 2.0),
        "left": (-L / 2.0, -depth_m / 2.0),
        "right": (width_m + L / 2.0, -depth_m / 2.0),
    }
    plaques = []
    for side, (cx, cy) in plaque_centers.items():
        pbm = bmesh.new()
        bmesh.ops.create_cube(pbm, size=1.0)
        bmesh.ops.scale(pbm, vec=(PLAQUE_SIZE_M, PLAQUE_SIZE_M, PLAQUE_THICKNESS_M), verts=pbm.verts)
        bmesh.ops.translate(
            pbm, vec=(cx, cy, LEDGE_THICKNESS_M + PLAQUE_THICKNESS_M / 2.0), verts=pbm.verts
        )
        pmesh = bpy.data.meshes.new(f"plaque_{side}")
        pbm.to_mesh(pmesh)
        pbm.free()

        pobj = bpy.data.objects.new(f"plaque_{side}", pmesh)
        pobj.data.materials.append(make_material(f"mat_plaque_{side}", PLAQUE_PLACEHOLDER_COLOR))
        pobj.parent = plaque_group
        pobj[USERDATA_PLACEHOLDER_KEY] = True
        pobj[USERDATA_PLAQUE_SIDE_KEY] = side
        link(pobj)
        plaques.append(pobj)

    print(
        f"  built ledge (width {LEDGE_WIDTH_M / IN_TO_M:.1f} in, PLACEHOLDER) "
        f"+ {len(plaques)} plaque placeholders (one per side, PLACEHOLDER)"
    )
    return ledge, plaque_group


def build_scene() -> None:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.scale_length = 1.0

    terrain_data = load_json(TERRAIN_JSON, "extract_site_terrain.py")
    buildings_data = load_json(BUILDINGS_JSON, "extract_site_buildings.py")
    print(f"loaded terrain ({len(terrain_data['vertices_m'])} verts) and "
          f"{len(buildings_data['buildings'])} buildings")

    origin = make_empty("AR_World_Origin")
    terrain = build_terrain_mesh(terrain_data)
    terrain.parent = origin

    buildings_group = build_buildings(buildings_data)
    if buildings_group:
        buildings_group[0].parent.parent = origin

    ledge, plaque_group = build_ledge_and_plaques(terrain_data)
    ledge.parent = origin
    plaque_group.parent = origin

    bpy.context.view_layer.update()


def export_glb(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.object.select_all(action="SELECT")
    try:
        bpy.ops.export_scene.gltf(
            filepath=str(path), export_format="GLB", export_extras=True, export_yup=True, export_apply=True
        )
    except TypeError:
        bpy.ops.export_scene.gltf(filepath=str(path), export_format="GLB", export_extras=True)
    print(f"exported {path}")


def export_usdz(path: Path) -> None:
    usda_path = path.with_suffix(".usda")
    try:
        bpy.ops.wm.usd_export(
            filepath=str(usda_path),
            export_custom_properties=True,
            convert_orientation=True,
            export_global_up_selection="Y",
            export_global_forward_selection="NEGATIVE_Z",
        )
        header = usda_path.read_bytes()[:8]
        if not header.startswith(b"#usda"):
            raise RuntimeError(f"{usda_path} is not an ASCII usda layer (header {header!r})")
        write_usdz_package(path, usda_path)
        usda_path.unlink()
        print(f"exported {path}")
    except Exception as error:  # noqa: BLE001
        print(f"WARNING: usdz export skipped: {error}", file=sys.stderr)


def write_usdz_package(usdz_path: Path, default_layer: Path) -> None:
    import zipfile

    payload = default_layer.read_bytes()
    name = default_layer.name.encode("utf-8")
    header_end = 30 + len(name)
    pad = (64 - header_end % 64) % 64
    if 0 < pad < 4:
        pad += 64

    info = zipfile.ZipInfo(default_layer.name, date_time=(1980, 1, 1, 0, 0, 0))
    info.compress_type = zipfile.ZIP_STORED
    if pad:
        info.extra = b"\x86\x19" + (pad - 4).to_bytes(2, "little") + b"\x00" * (pad - 4)

    usdz_path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(usdz_path, "w", compression=zipfile.ZIP_STORED) as archive:
        archive.writestr(info, payload)


if __name__ == "__main__":
    build_scene()
    export_glb(GLB_PATH)
    export_usdz(USDZ_PATH)
