"""Packages the digital-twin Blender scene for handoff to a collaborator who
doesn't have (and doesn't need) the proprietary source DWG — see AR_SYSTEM.md
§G Phase 3 production-swap design notes and the digital-twin sourcing memory.

Writes to `cad-source/handoff/`, the one subfolder of the otherwise-gitignored
`cad-source/` tree that IS tracked in git (see .gitignore):

  site-scene.blend    editable scene, materials/objects intact
  site_terrain.json   extract_site_terrain.py's output — re-run
  site_buildings.json extract_site_buildings.py's output — build_site_buildings.py
                       directly against these two, no DXF needed
  site-scene.glb/usdz quick-preview exports, same as cad-source/out/

Deliberately excludes the source DWG/DXF (client-proprietary, ~30-140MB) —
the collaborator already has the DWG since they're the one who sent it; if
they need to redo the extraction step itself (e.g. a new crop/scale), they
run extract_site_terrain.py / extract_site_buildings.py against their own
copy, same as this session did.

Run headless (rebuilds the scene the same way build_site_buildings.py does,
then saves a .blend on top of that instead of/in addition to exporting):

    /Applications/Blender.app/Contents/MacOS/Blender --background \
        --factory-startup --python-exit-code 1 \
        --python tools/export_handoff_bundle.py
"""

import shutil
import sys
from pathlib import Path

import bpy

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_site_buildings as bsb  # noqa: E402 — needs sys.path set first

HANDOFF_DIR = bsb.REPO_ROOT / "cad-source" / "handoff"
BLEND_PATH = HANDOFF_DIR / "site-scene.blend"


def main() -> None:
    bsb.build_scene()
    bsb.export_glb(bsb.GLB_PATH)
    bsb.export_usdz(bsb.USDZ_PATH)

    HANDOFF_DIR.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=str(BLEND_PATH))
    print(f"saved {BLEND_PATH}")

    for src in (bsb.TERRAIN_JSON, bsb.BUILDINGS_JSON, bsb.GLB_PATH, bsb.USDZ_PATH):
        dest = HANDOFF_DIR / src.name
        shutil.copy2(src, dest)
        print(f"copied {src.name} -> {dest}")


if __name__ == "__main__":
    main()
