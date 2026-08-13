"""Digital-twin terrain builder — stage 2 of 2 (AR_SYSTEM.md §G Phase 3
production-swap design notes). Consumes `cad-source/out/site_terrain.json`
(written by `tools/extract_site_terrain.py`, which must run first) and
authors the terrain mesh directly from its vertex/triangle list, exported
for review.

Run headless:

    /Applications/Blender.app/Contents/MacOS/Blender --background \
        --factory-startup --python-exit-code 1 \
        --python tools/build_site_terrain.py

REVISION (2026-08-12, second pass): stage 1 now does the actual meshing
(Delaunay triangulation over every contour point, open or closed) rather
than handing this script closed polygon loops to fill and extrude — a
visual comparison against the real physical model showed the first pass's
closed-contour-only, stepped-layer approach was both missing most of the
terrain (194 of 425 contours are open — Civil 3D surface-boundary
artifacts, not real gaps — and were wrongly excluded) and visually wrong in
kind (the physical model is a smooth sculpted surface with fine engraved
contour lines, not a visibly stepped layer-cake). This script is now a
thin authoring/export step: build a mesh straight from stage 1's
vertices + triangles, no fill/extrude logic here at all.

SCOPE: terrain only. No buildings (footprint-only DWG data, no height —
separate open sourcing gap per AR_SYSTEM.md §G) and no hotspots (nothing to
bind them to yet). This is a staging export for visual review, not wired
into the experience manifest — promoting it to `public/assets/` and a
manifest entry is a deliberate future step once building data lands and the
four-plaque origin numbers (§A/§E) are computed, not implied by this script
existing.

Origin convention: world (0, 0, 0) is the crop rectangle's own (u=0, v=0)
reference corner (matching the four-plaque design's origin-corner amendment
in AR_SYSTEM.md §A) — NOT a plaque center, unlike build_bench_scene.py's
single-plaque convention. Z = 0 is the lowest elevation point in the
triangulated surface; the 0.5 in base riser measured on the physical model
is structural support below the visible surface and is deliberately not
modeled here.
"""

import json
import sys
from pathlib import Path

import bpy
import bmesh

REPO_ROOT = Path(__file__).resolve().parent.parent
JSON_PATH = REPO_ROOT / "cad-source" / "out" / "site_terrain.json"
GLB_PATH = REPO_ROOT / "cad-source" / "out" / "site-terrain.glb"
USDZ_PATH = REPO_ROOT / "cad-source" / "out" / "site-terrain.usdz"

TERRAIN_COLOR = (0.55, 0.52, 0.45, 1.0)


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


def load_terrain_data() -> dict:
    if not JSON_PATH.exists():
        raise RuntimeError(
            f"{JSON_PATH} not found — run `python3 tools/extract_site_terrain.py` first "
            "(stage 1, needs system Python + ezdxf + scipy, not available inside Blender)"
        )
    return json.loads(JSON_PATH.read_text())


def build_terrain_mesh(data: dict) -> bpy.types.Object:
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


def build_scene() -> None:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.scale_length = 1.0

    data = load_terrain_data()
    print(f"loaded {JSON_PATH.name}: crop {data['crop_size_ft'][0]:.0f}x{data['crop_size_ft'][1]:.0f} ft, "
          f"relief {data['min_elevation_ft']:.0f}-{data['max_elevation_ft']:.0f} ft")

    origin = make_empty("AR_World_Origin")
    terrain = build_terrain_mesh(data)
    terrain.parent = origin

    bpy.context.view_layer.update()
    top_z = max(v.co.z for v in terrain.data.vertices)
    print(f"  terrain height: {top_z:.4f} m ({top_z / 0.0254:.3f} in)")


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
    """Same Y-up / -Z-forward convention as build_bench_scene.py's exporter
    (AR_SYSTEM.md §F), reusing its usdz-packaging technique."""
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
    except Exception as error:  # noqa: BLE001 — report and continue, matches build_bench_scene.py
        print(f"WARNING: usdz export skipped: {error}", file=sys.stderr)


def write_usdz_package(usdz_path: Path, default_layer: Path) -> None:
    """Verbatim copy of build_bench_scene.py's minimal usdz zip writer —
    see that file for the byte-alignment rationale."""
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
