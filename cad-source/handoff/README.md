# Digital-twin handoff bundle

Everything here is generated, checked in on purpose — this is the one
subfolder of `cad-source/` that isn't gitignored (see `../../.gitignore`).
Regenerate all of it with:

```
/Applications/Blender.app/Contents/MacOS/Blender --background \
    --factory-startup --python-exit-code 1 \
    --python ../../tools/export_handoff_bundle.py
```

## What's here and why

- **`site-scene.blend`** — the authored scene, open directly in Blender.
  Terrain + 21 buildings + a placeholder mounting ledge + 4 placeholder
  QR-plaque markers (magenta boxes, one per side). Everything placeholder
  carries a `placeholder` custom property.
- **`site_terrain.json` / `site_buildings.json`** — the intermediate data
  `tools/build_site_buildings.py` (and `export_handoff_bundle.py`) build
  the scene from. **You don't need the source DWG/DXF to keep working** —
  these two files are enough to re-run the Blender-side build/export
  scripts and iterate on materials, the ledge width, plaque placement, etc.
- **`site-scene.glb` / `site-scene.usdz`** — exported for quick preview
  (e.g. `qlmanage -p` on macOS, or drag into any glTF viewer) without
  opening Blender at all.

## What's NOT here, on purpose

The original DWG/DXF (client-proprietary, ~30-140MB) is deliberately not
in git — see `.gitignore` and the digital-twin sourcing project notes. If
you need to redo the CAD extraction step itself (e.g. the panel-cut layout
changes again, or the crop rectangle needs to move), run
`tools/extract_site_terrain.py` / `tools/extract_site_buildings.py`
against your own copy of the DWG (converted to DXF via ODA File Converter,
see the module docstrings in those two scripts for the exact CLI
invocation) — that regenerates `site_terrain.json`/`site_buildings.json`
from scratch, and everything downstream re-derives from those.

## Known open item

The mounting ledge width (`LEDGE_WIDTH_M` in `tools/build_site_buildings.py`)
is currently a 3-inch **guess**, not a measurement — the real number is
pending confirmation from the fabricator. The ledge running uniformly on
all 4 sides of the panel IS confirmed. Swap that one constant and re-run
`export_handoff_bundle.py` once the real width lands.

See `AR_SYSTEM.md` §A/§E (repo root) for the full four-plaque design this
scene is working toward, and the `project-digital-twin-sourcing` memory
for the session-by-session history of how the CAD decode got here.
