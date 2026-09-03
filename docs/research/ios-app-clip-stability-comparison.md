# Comparing 8th Wall vs. the native App Clip's ARKit tracking (2026-09-03)

`ar-appclip` (native Swift/ARKit/RealityKit App Clip, already on TestFlight)
last touched 2026-07-03/07 — roughly two months behind the web client's
current state. This analyzes exactly what's stale and what the minimal,
low-risk path is to test it on-device today for a stability comparison
against 8th Wall, before deciding whether a TestFlight update is even
needed for that goal. No code changed by this document.

## The actual gap: manifest schema, not the AR code

`ar-appclip/ARClip/Models/Manifest.swift`'s `ExperienceManifest` is a
**single-target** model: it reads `trackingImageUrl` and
`physicalTargetWidthMeters` as flat, top-level fields on one manifest entry.

The web's production `'site'` entry restructured this in August into
`targets: [{ imageTargetUrl, physicalTargetWidthMeters, originOffsetMeters,
rotationYawDeg }, ...]` — four nested targets, no top-level
`trackingImageUrl`/`physicalTargetWidthMeters` at all on that entry anymore.
Resolving `targetId: "site"` against today's live manifest would throw
`missingNativeField`/`invalidPhysicalWidth` in the Swift resolver — that
entry point is broken for the App Clip as-is.

**But it doesn't need to be fixed to run the comparison.** The individual
`site-tracking-front` / `-back` / `-left` / `-right` manifest entries are
each their OWN top-level, single-target experience (not nested inside
`targets[]`) — exactly the shape `ExperienceManifest` already expects. Swift
`Decodable` silently ignores unknown JSON keys, so the newer `'site'` entry
existing alongside them doesn't break decoding the array; only resolving
`"site"` specifically would fail, and nothing calls that for this test.

**The one thing actually missing:** none of the `site-tracking-*` entries
declare `trackingImageUrl` (the raw plaque bitmap ARKit needs to build an
`ARReferenceImage` — a compiled 8th-Wall-only JSON, `imageTargetUrl`, is
useless to ARKit). Checked: the raw PNG already exists and is already
deployed —

```
public/assets/image-targets/site-tracking-front/site-tracking-front_original.png
```

— just not referenced from the manifest entry. Adding one field fixes this:

```ts
// packages/experience-manifest/manifest.ts, 'site-tracking-front' entry
trackingImageUrl: '/assets/image-targets/site-tracking-front/site-tracking-front_original.png',
```

Additive, one line, doesn't touch anything the web client reads. Same
pattern the older `site-front`/`bench-test` entries already use.

## Everything else checked out already current

- **3D content:** `public/assets/site-scene.usdz` and `site-scene.glb` share
  the exact same mtime and were last touched together in the same commit
  (`86218b1`, the `AR_World_Origin` corner fix) — the usdz is NOT stale, it
  reflects the current geometry.
- **API origin:** `AppConfig.apiBaseURL` already points at the live
  `https://ar-ramapo.onrender.com` — the same server every 8th Wall test
  this whole investigation deployed to. No config change needed.
- **Physical target:** the same already-printed/mounted 30mm Voronoi
  `site-tracking-front` plaque used in every 8th Wall log (log-1 through
  log-11) works as-is — no new printing needed.

## One real caveat, unrelated to tracking stability

`SceneGraphMounter.swift`'s `SceneGraphGlue.usdzToAnchorRotation` (currently
identity) is explicitly documented as **"provisional until the Phase 3
bench-test rig passes on device"** — i.e. never validated on real hardware.
If the model appears in a wrong but *static* orientation, that's this
untested constant, not ARKit's tracking quality — a different, one-constant
fix, and the README's own asymmetry-tell/domino check will make it obvious
immediately. Worth knowing going in so a wrong-but-frozen orientation isn't
mistaken for a stability problem.

## Recommended path: skip TestFlight for this test

Comparing tracking **stability** doesn't require a TestFlight build.
`ar-appclip/README.md` already documents the normal dev loop: run the
**ARRamapo** scheme (the full host app, same AR/tracking code the Clip
target ships) directly on the iPhone via Xcode + USB cable, with the
scheme's `_XCAppClipURL` environment variable set to

```
https://ar-ramapo.onrender.com/?target=site-tracking-front
```

(the README already shows this exact pattern for `bench-test`). This is
instant, needs no signing/provisioning/build-number bump, and exercises the
identical ARKit session code the Clip would use.

**TestFlight would only add value if the goal is different from stability**
— testing the real App-Clip-invocation flow (scanning an actual App Clip
Code / Safari smart banner) or handing a build to someone without Xcode. For
"is ARKit's tracking more stable than 8th Wall's," it adds real cost (a
build visible to every TestFlight tester, a consumed build-number slot, the
one-time credential/signing dependency in `scripts/deploy-testflight.sh`)
for no additional signal.

## Minimal plan, in order

1. Add `trackingImageUrl` to the `site-tracking-front` manifest entry
   (`packages/experience-manifest/manifest.ts`), commit, push (same flow
   used all session — triggers the Render redeploy, so the live manifest
   picks it up).
2. In Xcode, set the ARRamapo scheme's `_XCAppClipURL` to
   `https://ar-ramapo.onrender.com/?target=site-tracking-front`.
3. Run on the iPhone via cable, point at the same physical `site-tracking-front`
   plaque already mounted, and compare against the 8th Wall logs
   (reveal latency, orientation stability, whether scale ever "shrinks into
   the void" the way log-11 showed).
4. Only pursue `scripts/deploy-testflight.sh` afterward, and only if the
   goal shifts to testing the App-Clip-invocation UX itself rather than raw
   tracking stability.

Step 1 is the only code change this plan requires, and it's additive and
low-risk. Nothing here has been implemented yet — pending confirmation.
