"""Phase 3 bench-test digital twin builder (AR_SYSTEM.md §G).

Programmatically authors the 1:1 mock scene for the spatial bench-test rig
and exports it to the paths the experience manifest declares for the
`bench-test` target. Run headless:

    /Applications/Blender.app/Contents/MacOS/Blender --background \
        --factory-startup --python-exit-code 1 \
        --python tools/build_bench_scene.py

Coordinate frames
-----------------
The MEASUREMENT SHEET below is in the frame the rig was ruler-measured in:
  * X/Y origin: bottom-left corner of the box cover (top-down view).
  * Z origin: the box cover's TOP surface — every object resting on the
    cover has a Z-center equal to half its own height, and the box body
    extends downward (Z in [-BOX_DIMS.z, 0]).

The AUTHORED scene is re-origined per the §A invariant: the exact center
of the QR plaque's printed (top) face is world (0, 0, 0). The measured
coordinates are kept verbatim as child transforms inside
Physical_Model_Offset_Group; the group's single translation performs the
re-origin, so this file stays auditable against the measurement sheet.

Hierarchy (per §G authoring scope):
  AR_World_Origin (empty, world origin)
  ├── ar_launch_plaque          (5×5 cm plate; printed face centered at 0,0,0)
  └── Physical_Model_Offset_Group (empty at -plaque_top_center)
      ├── game_box
      └── domino_1..4
          └── hotspot_domino_N  (empty; label/riveStateMachine custom props)

Hotspots are EMPTIES, not proxy meshes: §G specifies empties, glTF has no
"invisible mesh" flag, and SceneGraphLoader treats every mesh as an
occluder while HotspotProjector only excludes a hotspot's ancestors — a
co-located hotspot mesh would permanently occlude itself.
"""

import math
import sys
from pathlib import Path

import bpy
import bmesh
from mathutils import Vector

# --------------------------------------------------------------------------
# MEASUREMENT SHEET — box-cover-corner frame, meters (see module docstring).
# --------------------------------------------------------------------------

BOX_DIMS = Vector((0.382, 0.308, 0.072))

# Plaque: 5×5 cm plate, PHYSICAL_TARGET_WIDTH_METERS in the manifest must
# match PLAQUE_SIZE. Center of its footprint, measured on the box cover.
PLAQUE_SIZE = 0.05
PLAQUE_THICKNESS = 0.002
PLAQUE_CENTER_XY = Vector((0.18, 0.04))

# Dominoes: dims are LOCAL (pre-rotation) extents; rot_z_deg is applied as
# the object's Z rotation, per the measurement sheet's own convention.
# riveStateMachine is set on two of the four so the bench-test exercises
# both HotspotOverlay card variants (label-only and label+Rive).
DOMINOES = [
    dict(
        name="domino_1",
        dims=(0.010, 0.025, 0.050),
        location=(0.086, 0.238, 0.025),
        rot_z_deg=90.0,
        label="Domino 1 · standing on end",
        rive_state_machine="State Machine 1",
        color=(0.80, 0.15, 0.15, 1.0),
    ),
    dict(
        name="domino_2",
        dims=(0.050, 0.025, 0.010),
        location=(0.296, 0.1865, 0.005),
        rot_z_deg=0.0,
        label="Domino 2 · lying flat",
        rive_state_machine=None,
        color=(0.15, 0.60, 0.20, 1.0),
    ),
    dict(
        name="domino_3",
        dims=(0.050, 0.010, 0.025),
        location=(0.155, 0.128, 0.0125),
        rot_z_deg=0.0,
        label="Domino 3 · on long side",
        rive_state_machine=None,
        color=(0.15, 0.30, 0.80, 1.0),
    ),
    dict(
        name="domino_4",
        dims=(0.025, 0.050, 0.020),
        location=(0.2835, 0.064, 0.010),
        rot_z_deg=90.0,
        label="Domino 4 · double stack",
        rive_state_machine="State Machine 1",
        color=(0.85, 0.65, 0.10, 1.0),
    ),
]

# Semi-transparent proxies so the physical rig stays visible through the
# virtual overlay during the §G alignment checks.
BOX_COLOR = (0.45, 0.30, 0.15, 1.0)
BOX_ALPHA = 0.40
DOMINO_ALPHA = 0.55

REPO_ROOT = Path(__file__).resolve().parents[1]
GLB_PATH = REPO_ROOT / "public" / "assets" / "bench-scene.glb"  # manifest modelUrl
USDZ_PATH = REPO_ROOT / "public" / "assets" / "bench-scene.usdz"

# Runtime contract (src/client/SceneGraphLoader.ts / HotspotOverlay.ts).
HOTSPOT_PREFIX = "hotspot_"
USERDATA_LABEL_KEY = "label"
USERDATA_STATE_MACHINE_KEY = "riveStateMachine"


def link(obj: bpy.types.Object) -> bpy.types.Object:
    bpy.context.scene.collection.objects.link(obj)
    return obj


def make_empty(name: str) -> bpy.types.Object:
    obj = bpy.data.objects.new(name, None)
    obj.empty_display_size = 0.02
    return link(obj)


def make_material(name: str, rgba, alpha: float = 1.0) -> bpy.types.Material:
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = rgba
    bsdf.inputs["Alpha"].default_value = alpha
    if alpha < 1.0:
        # Property names differ across Blender versions; the glTF exporter
        # maps whichever exists to alphaMode: BLEND.
        if hasattr(mat, "surface_render_method"):
            mat.surface_render_method = "BLENDED"
        if hasattr(mat, "blend_method"):
            mat.blend_method = "BLEND"
    return mat


def make_box_object(name: str, dims, material=None, uv_unwrap: bool = False) -> bpy.types.Object:
    """Cuboid with geometry centered on its own origin (volumetric center),
    dimensions baked into the vertices so object scale stays (1,1,1)."""
    mesh = bpy.data.meshes.new(name)
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    for v in bm.verts:
        v.co.x *= dims[0]
        v.co.y *= dims[1]
        v.co.z *= dims[2]

    if uv_unwrap:
        # Position-based box projection. The +Z (printed) face maps to the
        # full 0–1 UV square with u→+X (east), v→+Y (north), so the QR
        # artwork lands upright and full-bleed.
        uv_layer = bm.loops.layers.uv.new("UVMap")
        for face in bm.faces:
            n = face.normal
            for loop in face.loops:
                co = loop.vert.co
                if abs(n.z) > 0.5:
                    uv = (co.x / dims[0] + 0.5, co.y / dims[1] + 0.5)
                elif abs(n.x) > 0.5:
                    uv = (co.y / dims[1] + 0.5, co.z / dims[2] + 0.5)
                else:
                    uv = (co.x / dims[0] + 0.5, co.z / dims[2] + 0.5)
                loop[uv_layer].uv = uv

    bm.to_mesh(mesh)
    bm.free()
    obj = bpy.data.objects.new(name, mesh)
    if material is not None:
        obj.data.materials.append(material)
    return link(obj)


def build_scene() -> None:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.scale_length = 1.0

    # World (0,0,0) = center of the plaque's printed top face (§A).
    plaque_top_center = Vector((PLAQUE_CENTER_XY.x, PLAQUE_CENTER_XY.y, PLAQUE_THICKNESS))

    origin = make_empty("AR_World_Origin")

    plaque = make_box_object(
        "ar_launch_plaque",
        (PLAQUE_SIZE, PLAQUE_SIZE, PLAQUE_THICKNESS),
        material=make_material("mat_qr_plaque", (0.95, 0.95, 0.95, 1.0)),
        uv_unwrap=True,
    )
    plaque.parent = origin
    plaque.location = (0.0, 0.0, -PLAQUE_THICKNESS / 2.0)

    group = make_empty("Physical_Model_Offset_Group")
    group.parent = origin
    group.location = -plaque_top_center

    box = make_box_object("game_box", BOX_DIMS, make_material("mat_game_box", BOX_COLOR, BOX_ALPHA))
    box.parent = group
    # Cover corner at frame origin, cover top surface at frame Z = 0.
    box.location = (BOX_DIMS.x / 2.0, BOX_DIMS.y / 2.0, -BOX_DIMS.z / 2.0)

    for spec in DOMINOES:
        domino = make_box_object(
            spec["name"],
            spec["dims"],
            make_material(f"mat_{spec['name']}", spec["color"], DOMINO_ALPHA),
        )
        domino.parent = group
        domino.location = spec["location"]
        domino.rotation_euler = (0.0, 0.0, math.radians(spec["rot_z_deg"]))

        hotspot = make_empty(f"{HOTSPOT_PREFIX}{spec['name']}")
        hotspot.parent = domino
        hotspot.location = (0.0, 0.0, 0.0)
        hotspot[USERDATA_LABEL_KEY] = spec["label"]
        if spec["rive_state_machine"] is not None:
            hotspot[USERDATA_STATE_MACHINE_KEY] = spec["rive_state_machine"]

    bpy.context.view_layer.update()
    report_and_verify(plaque_top_center)


def report_and_verify(plaque_top_center: Vector) -> None:
    print("\n=== bench-scene placement report (world, Z-up meters) ===")
    for obj in sorted(bpy.data.objects, key=lambda o: o.name):
        t = obj.matrix_world.translation
        kind = "empty" if obj.data is None else "mesh"
        props = {k: obj[k] for k in (USERDATA_LABEL_KEY, USERDATA_STATE_MACHINE_KEY) if k in obj}
        print(f"  {obj.name:32s} {kind:5s} ({t.x:+.4f}, {t.y:+.4f}, {t.z:+.4f}) {props or ''}")

    # §A invariant: plaque printed-face center must sit exactly at origin.
    plaque = bpy.data.objects["ar_launch_plaque"]
    top = plaque.matrix_world.translation + Vector((0, 0, PLAQUE_THICKNESS / 2.0))
    assert top.length < 1e-9, f"plaque printed face not at origin: {top}"

    # Measured coordinates must survive the re-origin verbatim.
    for spec in DOMINOES:
        world = bpy.data.objects[spec["name"]].matrix_world.translation
        expected = Vector(spec["location"]) - plaque_top_center
        assert (world - expected).length < 1e-9, f"{spec['name']}: {world} != {expected}"

    print("  invariants OK: plaque face at (0,0,0); measured offsets preserved.\n")


def export_glb(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    kwargs = dict(
        filepath=str(path),
        export_format="GLB",
        export_extras=True,   # custom properties → glTF extras → userData
        export_yup=True,      # SceneGraphLoader's §F glue expects Y-up glTF
        export_apply=True,
    )
    try:
        bpy.ops.export_scene.gltf(**kwargs)
    except TypeError:
        # Arg set varies slightly across exporter versions; extras is the
        # one that is non-negotiable.
        bpy.ops.export_scene.gltf(
            filepath=str(path), export_format="GLB", export_extras=True
        )
    print(f"exported {path}")


def export_usdz(path: Path) -> None:
    """USDZ for the future iOS workstream (§E: same scene, different
    export). Non-fatal: the web bench-test only needs the GLB."""
    try:
        try:
            bpy.ops.wm.usd_export(filepath=str(path), export_custom_properties=True)
        except TypeError:
            bpy.ops.wm.usd_export(filepath=str(path))
        print(f"exported {path}")
    except Exception as error:  # noqa: BLE001 — report and continue
        print(f"WARNING: usdz export skipped: {error}", file=sys.stderr)


if __name__ == "__main__":
    build_scene()
    export_glb(GLB_PATH)
    export_usdz(USDZ_PATH)
