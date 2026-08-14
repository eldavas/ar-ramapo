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
  carries a `placeholder` custom property. 12 of the 21 buildings (the
  ones with a real matched name) also carry a `hotspot_*` empty with
  `label`/`contentKey`/`buildingId`/`riveArtboard`/`riveStateMachine` —
  the same Marker/Card Rive contract every hotspot in this project binds
  (`docs/asset-authoring-guide.md` §2.4), not a bespoke building UI.
- **`site_terrain.json` / `site_buildings.json`** — the intermediate data
  `tools/build_site_buildings.py` (and `export_handoff_bundle.py`) build
  the scene from. **You don't need the source DWG/DXF to keep working** —
  these two files are enough to re-run the Blender-side build/export
  scripts and iterate on materials, the ledge width, plaque placement, etc.
- **`site-scene.glb` / `site-scene.usdz`** — quick-preview exports (e.g.
  `qlmanage -p` on macOS, or drag into any glTF viewer) without opening
  Blender at all. As of 2026-08-13 these are also copied into
  `/public/assets/` and loaded by the real app: `bench-test`/`8thwall-test`
  (`packages/experience-manifest/manifest.ts`) point their `modelUrl`/
  `usdzUrl` here, still tracking off `bench-test`'s own synthetic 5cm QR —
  unrelated to this scene's 4 placeholder plaque *markers* below. As of
  2026-08-14, `site-front`/`site-back`/`site-left`/`site-right` also point
  here, tracking off the 4 **real** printed plaques instead
  (`tools/plaque/site/`, see below), each independently re-centering the
  whole scene on itself — a MindAR validation harness, not the production
  entry. As of 2026-08-14, manifest entry `'site'` (8th Wall, `targets[]`)
  IS the four-plaque shared-origin production experience (§A/§E) and the
  live production default — its `originOffsetMeters`/`rotationYawDeg` are
  derived from this scene's own `plaque_{front,back,left,right}` mesh
  bounds and edge geometry (`docs/asset-authoring-guide.md` §3.5), so they
  move if this file's "Known open item" (the ledge width) changes and the
  scene is re-exported — swap `LEDGE_WIDTH_M`, re-run
  `export_handoff_bundle.py`, copy the two files into `/public/assets/`
  again, and re-derive the offsets the same way.

  **Two different things are both called "plaque" here, don't conflate
  them:** the 4 magenta boxes described above are placeholder *markers* —
  flat volumes at the model's own scale, standing in for where plaques
  will eventually mount, with no real artwork on their faces. The actual
  printable QR artwork (`tools/plaque/site/plaque-{front,back,left,right}.png`,
  `tools/build_site_plaques.py`) is a separate, independently-scaled
  1024×1024px asset — it doesn't live in this scene at all, and its 50mm
  print size and QR-in-plaque placement are real, current values, not
  placeholders (unlike the markers' *position*, which is ledge-width-
  dependent and still a guess). Full physical dimensions:
  `docs/asset-authoring-guide.md` §3.5.

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
