# ar-prototype-8thwall

8th Wall SLAM + GPS geofence + Rive UI spike. See
[AR_SYSTEM.md](./AR_SYSTEM.md) for the tracking-engine decision record and
the implementation plan at
`/Users/davidrivera/.claude/plans/let-s-explore-a-different-reactive-corbato.md`
for the full design.

## Run it

```
pnpm install
pnpm build
node dist/server.js
```

Or during development: `pnpm dev:client` (Vite watch) in one terminal,
`node dist/server.js` (after `pnpm build:server`) in another.

By default the server boots over plain HTTP. Camera and geolocation both
require a secure context on a real device — generate local certs and point
`.env` at them:

```
mkcert localhost <your-lan-ip>
cp .env.example .env
# edit .env: HTTPS_KEY_PATH / HTTPS_CERT_PATH → the generated .pem files
```

## Anchor modes

`bench-park` is anchored to the **printed QR plaque on the fixed
3D-printed model** (`placement: 'image'`): scan the plaque once and SLAM
persists the anchor while you walk around; every later sighting of the
plaque re-aligns the anchor, correcting drift. Flip the manifest entry to
`placement: 'tap'` to demo anywhere without the physical model
(tap-to-place stays fully supported).

### Compiling the image target (one-time, after plaque art changes)

```
npx @8thwall/image-target-cli@latest
# image file:  public/assets/bench-plaque.png
# type:        1 (flat)
# crop:        y (default)
# output:      public/assets/image-targets/bench-plaque
# name:        bench-plaque
```

Then edit the generated `bench-plaque.json`: set `imagePath` to the
root-relative served path
(`/assets/image-targets/bench-plaque/bench-plaque_luminance.png`) — the
engine fetches it via `<img>`, and `ImageTargetLoader` fails loudly if the
path isn't root-relative. The JSON's `name` field is what runtime events
carry; the app reads it from the file, never hardcodes it.

## Site setup: record the geofence

At the installation site, open `https://<host>/?recordgeo=1`, stand at the
model, and let it average GPS fixes for 30 s (accuracy-weighted; fixes
worse than 50 m discarded). Copy the resulting `geo:` literal into
`packages/experience-manifest/manifest.ts`.

## Desk-testing bypasses

8th Wall's SLAM world tracking only runs on real phones — desktop browsers
get "No valid session manager to handle this session." Two query-param
bypasses let you exercise the rest of the pipeline without a device:

- `?fakegeo=1` — skips the real GPS geofence, reports the manifest's fence
  center immediately.
- `?fakear=1` — skips the 8th Wall session entirely; runs
  `DevSimSession.ts`, a plain three.js scene with an orbiting camera and an
  always-tracking anchor at the origin, behind the same `AnchorSource`
  interface the real session uses. Everything downstream (scene loading,
  hotspot projection, Rive markers, the Card, content fetch) runs
  unmodified.

Combine both for a full desk walkthrough: `http://localhost:3000/?fakegeo=1&fakear=1`.

## On-device testing

Neither bypass exercises the real engine. Before trusting tracking
quality, drift, or placement UX, test on an iPhone (Safari) and an Android
phone (Chrome) over LAN HTTPS (`https://<your-lan-ip>:3000`, no query
params). Camera and geolocation permissions must be granted per the OS
prompt; on iOS both chain from the "Start AR" button tap.

## What's real vs. placeholder

- `packages/experience-manifest/manifest.ts` ships **placeholder GPS
  coordinates** (Ramapo College campus center) for the `bench-park` entry.
  Record the real location with `?recordgeo=1` before a field test.
- `physicalTargetWidthMeters: 0.05` matches the parent repo's desk plaque;
  **measure the plaque printed on the actual model** and update. The
  runtime warns when the engine's own meter estimate disagrees by >25%.
- Scene content (`bench-scene.glb`, `bench-ui.riv`) and the content sheet
  URL are copied from the parent repo's `bench-test` experience unchanged.

## On-device checkpoint for the image-target path (first phone run)

With remote devtools attached, point the phone at a printed plaque and
confirm: no configure warnings; `imageloading → imagescanning →
imagefound` fire with name `bench-plaque`; the event payload shape (direct
vs `.detail` — then lock the type in `EightWallSession.emitImage`);
`event.scale ≈ 0.05` once absolute scale converges; and the **axis
check** — the bench scene must stand upright out of a flat-lying plaque.
If it lies flat-wrong, adjust `TARGET_FRAME_TO_WORLD_FIX` in
`src/client/ImageTargetAnchorSource.ts` (candidates: identity, ±90°X;
yaw-only fallback documented there for tilted plaque mounts).
