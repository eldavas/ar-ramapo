# Comparing 8th Wall vs. the native App Clip's ARKit tracking (2026-09-03)

`ar-appclip` (native Swift/ARKit/RealityKit App Clip, already on TestFlight)
last touched 2026-07-03/07 — roughly two months behind the web client's
current state. This analyzes exactly what's stale and what the minimal,
low-risk path is to test it on-device today for a stability comparison
against 8th Wall, before deciding whether a TestFlight update is even
needed for that goal.

**Update (2026-09-03): implemented and shipped.** Physical testing needs to
be untethered (walking around the physical table), which the Xcode-cable
path below can't do — so this went straight to a TestFlight build instead
of the cable-tethered path originally recommended. Changes made:

- `ar-ramapo`: added `trackingImageUrl` to all four `site-tracking-*`
  manifest entries (not just `-front`), committed and pushed
  (`c2c0652`) — the Render deploy picks it up automatically.
- `ar-appclip`: `AppConfig.fallbackTargetId` switched from `"bench-test"`
  (the old dominos scene) to `"site-tracking-front"`; README's build/testing
  instructions and the deploy script's post-upload reminder updated to
  match (`369815e`).
- Verified locally first: `xcodegen generate` + a Debug `xcodebuild build`
  succeeded (confirms the code compiles and automatic signing/provisioning
  works from this machine) before running the real archive+upload.
- Ran `scripts/deploy-testflight.sh` — archived, uploaded, and Apple's
  processing accepted it (`** EXPORT SUCCEEDED **`, `Upload succeeded`).
  Build number auto-incremented 2→3 (`dc694c8`; local-only repo, no remote
  configured, so this stays a local commit). One benign warning: no dSYM
  bundled for `RiveRuntime.framework` — third-party binary framework
  without shipped debug symbols, doesn't block distribution, only means
  crash symbolication for that framework specifically won't be perfect.

**Still needed, not something code can do:** the App Clip's actual
invocation must be pointed at `?target=site-tracking-front` for physical
testing — either update the registered "Advanced App Clip Experience" URL
in App Store Connect's dashboard, or (faster, no dashboard involved) use
**Settings → Developer → App Clips Testing → Local Experiences** on the
test iPhone once the TestFlight build installs, registering
`https://ar-ramapo.onrender.com/?target=site-tracking-front` there directly
— `ios-app-clip-research.md` already flags this path as "notoriously flaky
— re-register/reboot" if it doesn't take on the first try. Because
`fallbackTargetId` now also defaults to `site-tracking-front`, even a bare
invocation with no `?target=` at all (or a flaky one that drops it) still
lands on the current buildings/markers experience instead of the old
dominos scene.

**Update (2026-09-03, same day): first real hardware capture found a second
bug — not a stability finding, a parser false positive.** Build 3 installed
from TestFlight and the Local Experience registered correctly (per the
export-compliance answer below, that dashboard prompt was answered
separately), but the App Clip failed to load with: *"The usda layer
declares userProperties on two prims both named 'building_15'; prim names
carrying metadata must be unique for hotspot discovery to join on them."*

Also hit along the way, unrelated to tracking: App Store Connect's TestFlight
export-compliance questionnaire for build 3 — answered "None of the
algorithms mentioned above" (the app only performs standard HTTPS via
`URLSession`, no CryptoKit/CommonCrypto/custom crypto anywhere in `ARClip/`,
verified by grep). Also added `INFOPLIST_KEY_ITSAppUsesNonExemptEncryption:
false` to `project.yml` (`288c63e`) so this question is skipped on every
future upload — confirmed present in the generated Info.plist and that the
project still builds.

**Root-caused directly against the shipped asset**, not guessed: unzipped
`public/assets/site-scene.usdz` and grepped its `.usda` text. The "two prims
named building_15" are `def Xform "building_15"` (carries the real
`buildingId`/`heightEstimated` metadata) with a nested `def Mesh
"building_15"` one level inside it (carries only Blender's own
auto-generated `userProperties:blender:data_name` bookkeeping property) —
Blender's completely standard, routine export shape for every single
mesh-bearing object (`Xform "X" { ... Mesh "X" { ... } }`). Confirmed via
`grep -c`/`uniq -c` across the whole file that every `building_*` and
`hotspot_building_*` Xform name is genuinely unique — there was no real
collision anywhere.

The bug was in `ARClip/Services/USDZ/USDASceneMetadata.swift`'s parser: it
threw at prim-**scope-open** time whenever a flat name reopened after
already collecting real metadata, without checking whether the *reopening*
prim (the Mesh child) would itself write anything beyond Blender's own
`blender:`-prefixed bookkeeping — a check that already existed, correctly,
at property-**assignment** time, just not consulted before the premature
throw. This had never been exercised before: the old bench-test dominos
scene's custom properties lived only on separate hotspot Empties (which
Blender never gives a nested Mesh child), not on mesh-bearing objects
directly, so this exact shape only started appearing once the Clip pointed
at `site-scene.usdz`'s buildings for the first time. Fixed by removing the
premature open-time throw and keeping only the property-assignment-time
check (`3b530fe`) — verified compiling, then archived and uploaded as build
4 (`2c7a3c4`), export/upload both succeeded.

**Update (2026-09-03, same day): build 4 ran cleanly and produced real,
usable findings — first-lock speed and 3D render quality both a clear step
up over 8th Wall (visible terrain elevation detail the web GLB path
doesn't show), plus three real problems, all traced to one root cause.**

Reported: (1) the model disappears the instant the plaque leaves the
camera's frustum while walking around; (2) the model renders tilted, and
— more strikingly — appears to MOVE WITH the phone when tilting to view it
from another angle, as if still anchored to the camera rather than the
world; (3) hotspot cards show unwanted transparency, appear to float
disconnected from their markers, and don't respond to taps.

**Root cause for (1) and (2), confirmed by re-reading
`docs/research/ios-app-clip-research.md`'s own pre-implementation notes**
(written before `ARSessionManager` was first built): `AnchorEntity(anchor:
imageAnchor)` — the way content was mounted — is a LIVE binding to ARKit's
own per-frame `ARImageAnchor`. That research document already named this
"the wrong tool" for exactly this reason, before the class existed:
*"`AnchorEntity(.image(...))` hides content whenever the image isn't
actively tracked... Use a manual `ARSessionDelegate`... capture
`imageAnchor.transform` → `AnchorEntity(world:)` → remove the image anchor
(permits re-scan)."* The shipped code never did this — it stayed on the
live binding through the "build 1" world-tracking fix, which addressed a
different symptom (flicker) without changing the anchor's fundamental
shape. A live ARImageAnchor binding degrading toward a camera-relative
pose once `isTracked` goes false explains both symptoms as one bug, not
two.

**Fixed in `ARSessionManager.swift`**, implementing what the research
always prescribed: on first detection, capture `imageAnchor.transform`
into a plain `simd_float4x4`, mount content on a fully detached
`AnchorEntity(world:)`, and remove the raw `ARImageAnchor` immediately —
RealityKit now renders at that fixed world transform regardless of
anything ARKit's per-frame image tracking does afterward, and removing the
anchor re-arms `didAdd` for a later re-scan, which is now treated as a
re-ground opportunity (recompute and reapply the composed transform) — the
same "occasional discrete correction, never continuous re-snapping"
strategy the whole 8th Wall investigation (§25/§26 in
`8th-wall-troubleshooting.md`) took weeks to arrive at, reused here since
there's no reason to assume ARKit's own tracking is drift-free either,
just far less studied on this project so far. `isTrackingActive` no longer
reads `ARImageAnchor.isTracked` at all — content visibility now depends
only on whether something has ever been mounted plus current camera
tracking health, decoupling it from the per-frame image-tracking flicker
entirely.

**(3) was not independently root-caused** — the hypothesis is that it's
downstream of the same anchor instability (a card's screen position and
the occlusion raycast both depend on the anchored geometry's world
position being stable frame to frame), but this wasn't confirmed against
real data before shipping the fix. Instead of guessing further, added
structured logging (see below) at exactly the points needed to confirm or
rule this out on the next capture.

**Multi-target, in the same pass** (the person testing asked explicitly:
"habilita los 4 placas, no solo front"): extended `manifest.ts`'s `'site'`
entry with a `trackingImageUrl`/`imageTargetName` per nested target
(`59f7dec`, web) and rewrote `Manifest.swift`/`ManifestResolver` to decode
the same `targets[]` shape, collapsing a flat single-target entry into a
one-element array with an identity offset/rotation so `ARSessionManager`
only ever handles the multi-target shape. `ARSessionManager` now builds
one `ARReferenceImage` per plaque and composes each detection through the
same math as `ImageTargetAnchorSource.applyPose()` on the web (rotation ×
per-plaque yaw correction, position offset by the plaque's own
`originOffsetMeters` rotated into world space) — a direct Swift port,
using `SceneGraphGlue.usdzToAnchorRotation` (identity) as this pipeline's
equivalent of the web's `TARGET_FRAME_TO_WORLD_FIX`. `AppConfig
.fallbackTargetId` now points at `"site"` instead of the single-plaque
`"site-tracking-front"`.

**Real-time logging added** (the person testing asked for this
explicitly, to stop working from descriptions alone): structured
`os.Logger` output under subsystem `com.ramapo.arclip`, covering every
anchor lifecycle event (first lock / re-ground, with the distance moved),
a periodic camera-vs-anchor diagnostic mirroring the web's
`EightWallSession` camera-position log (position, tracking state,
distance, Euler yaw/pitch/roll — same "does this look tilted" reasoning
as the web's `cameraDiagnosticLine()`), every hotspot's visible/occluded
state transition (not per-frame — only on change, with screen/world
position), and every tap forwarded into a Rive state machine. Viewable
live in Xcode's console over a USB cable (`xcodebuild` + a debug scheme),
or afterward with no cable and no debugger at all via macOS Console.app →
select the connected iPhone → filter by subsystem `com.ramapo.arclip` —
`os_log` persists to the unified logging system and syncs on reconnect,
so a fully untethered walkaround (needed here, since the person testing
has to walk around the physical table) can still be inspected afterward.

**Also hit mid-session, unrelated to AR: the build's own disk footprint.**
Four archive/upload cycles plus repeated Debug builds filled the build
machine's disk to 177 MB free (from a 460 GB volume) before this pass
could even compile — `xcodebuild`'s own DerivedData, the project's local
`build/` output directory, and a temporary file-inspection extraction were
the three disposable, safely-deletable culprits (~2.2 GB combined);
clearing them recovered several GB. Worth keeping an eye on for future
archive cycles on this same machine.

Shipped as build 5 (`b463cb8` code, `ed7c536` build-number bump);
archive/export/upload all succeeded.

**Update (2026-09-03, same day): build 5 tested — world-lock fix confirmed
working, tilt and card/tap symptoms persist, and the captured logs came
back completely empty of our own data.**

Reported from two real captures (`ar-appclip/logs/1.txt`, `2.txt`,
Console.app exports): the anchor now genuinely holds — walked around the
physical table, the model stayed put, no more camera-following drift. That
directly confirms the world-lock rewrite fixed what it was built to fix.
Still open: the model still doesn't sit flush on the table (visible tilt
persists), and the hotspot cards still look like "ghosts" floating above
their markers with unwanted transparency and no tap response.

**But neither log file contained a single line from anything this project
added** — none of the `ARSessionManager`/`HotspotProjector`/`RiveCard*`
`os.Logger` output from the previous pass, only the OS's own
`RFARSessionObserver`/`ARState`-style system noise. Root cause: Apple's
unified logging system only persists `.notice`/`.error`/`.fault` levels to
the store a post-hoc Console.app export or `log show` query can see;
`.debug` is never persisted at all, and `.info` is memory-only unless a
Mac is actively live-streaming the device's log with "Include Info
Messages" on for that exact window. Every call this project added used
`.info` or `.debug` — invisible by construction to the actual workflow
here (walk the test untethered, review the log afterward). Bumped every
one to `.notice` (`a0bcfb1`), which persists automatically with no change
to how the logs get collected.

**Also added, since the tilt persists even with a now-stable anchor:** a
raw-ARKit-vs-composed-rotation Euler comparison logged at every lock/
re-ground. For `site-tracking-front` specifically, `rotationYawDeg: 0` and
`SceneGraphGlue.usdzToAnchorRotation` is identity, so today the composed
rotation is a byte-for-byte copy of ARKit's own raw per-frame detected
image rotation — meaning the persistent tilt is either (a) the physical
plaque genuinely not mounted flat, (b) single-sample noise in ARKit's own
detection with no cross-check applied (unlike the 8th Wall side's §38
pitch/roll plausibility gate — deliberately not ported here yet, pending
real evidence it's needed), or (c) `SceneGraphGlue`'s identity assumption
itself being wrong despite its own "provisional, never validated on
device" status since day one. The next capture's raw-Euler numbers (now
actually persisted) distinguish between these directly instead of
guessing: small raw angles despite a visible tilt points at (c); a large
raw angle points at (a) or (b).

**Card/tap symptom: still not independently root-caused** — no usable
data existed to check the hypothesis from the previous pass against.
Logging for it (per-hotspot visible/occluded transitions, every tap
forwarded to Rive) was already in place; it just wasn't visible in the
export for the same `.info`-persistence reason, so it should actually show
up on the next capture.

Shipped as build 6 (`a0bcfb1` code, `3fb3e33` build-number bump);
archive/export/upload all succeeded.

**Update (2026-09-03, same day): build 6's capture STILL came back with
zero of our own log lines, for a completely different reason than
before — a Console.app search filter, not a build or log-level issue.**
Console.app's search bar had an active `PROCESS: ARRamapo` token left over
from browsing, silently excluding every line from our own code (which,
whether via the host app or the App Clip, still executes under whatever
process is actually foregrounded — the filter just happened to exclude
it). Confirmed by screen-sharing the actual Console.app window. Fixed by
searching `subsystem:com.ramapo.arclip` instead of filtering by process
name — subsystem is a property of the `Logger` call itself, immune to
whichever process ends up hosting it. The resulting export (`logs/4.txt`)
was the first of five captures across two days to actually contain any of
our own data — 995/995 lines matched.

**That data immediately exposed two severe, previously-invisible bugs and
resolved the tilt question:**

1. **"Re-grounded" fired 336 times in one session, ~50ms apart, each move
   3+ meters.** Not occasional correction — a tight, continuous loop. Root
   cause: `ARSessionManager` called `session.remove(anchor: imageAnchor)`
   right after every capture, reasoning that removal "re-arms `didAdd` for
   a future re-scan." While the plaque stayed continuously visible, that
   removal made ARKit notice on the very next frame that the reference
   image had no anchor and immediately create a fresh one — racing itself
   dozens of times a second, which is exactly what "renders a couple
   meters off the table, at a smaller scale" (the person testing's most
   recent report) turned out to be: the position never got a chance to
   settle. ARKit doesn't need the manual nudge — while an image keeps
   tracking, it keeps the SAME `ARImageAnchor` alive and updates it in
   place; `didAdd` naturally fires again, on its own, only after a genuine
   loss-then-refind cycle. Fixed by deleting the manual removal entirely
   and adding `didRemove` purely to log when ARKit itself (not us) decides
   tracking was lost.

2. **Every hotspot logged `occluded=true` 100% of the time (131/131
   samples, zero exceptions)** — directly explaining the reported
   "ghost cards floating over their markers with unwanted transparency."
   A universal, viewing-angle-independent occlusion result is the signature
   of a structural raycast bug, not real geometry. Root cause, confirmed
   against the actual shipped `site-scene.usdz` (the same structure §38's
   USDA-parser investigation already dumped): Blender's export shape is
   `Xform "building_X" { ... Mesh "building_X" {...} }` — the collision
   geometry lives on the **Mesh child**, while each hotspot is parented to
   the **Xform** — siblings, not ancestor/descendant. The occlusion check
   only tested the raycast hit's own identity against the hotspot's
   recorded ancestor set (which only contains the Xform), so a ray to any
   hotspot always hit its own building's mesh first and never recognized
   it as excludable. Fixed by walking the HIT entity's own ancestor chain
   instead of just checking its bare identity.

3. **The tilt is very likely NOT a bug.** The same log's raw ARKit-detected
   Euler angles (pitch ≈ -3°, roll ≈ 6°) were small and — since
   `site-tracking-front`'s glue and yaw correction are both identity —
   identical to the composed values. Both numbers sit comfortably inside
   the range every "good" 8th Wall capture this project has ever logged.
   The severe position instability from bug 1 almost certainly compounded
   the visual impression of a worse tilt than actually exists; worth
   re-checking once 1 and 2 are confirmed fixed, but not chased further on
   its own.

**Also added, per an explicit UX request:** `SearchingHintView` — a
non-blocking coaching overlay ("Point your camera at one of the site's
tracking plaques — get close, they're small.") shown from AR-session-start
until first lock. The AR phase previously had zero on-screen guidance
between "camera is live" and "something appeared" — the same
unexplained-blank-state problem `LoadingStateView`'s own doc comment
already treats as a bug for the pre-AR phases, just never covered once the
AR view itself took over. Mirrors the web's `arStatusStore` 'searching'
phase copy in `main.ts`, adapted for four plaques instead of one.

Shipped as build 7 (`6c7bbd3` code, `bde2390` build-number bump);
archive/export/upload all succeeded. **Next physical test** should show:
a stable anchor with realistic re-ground counts (single digits per
session, not hundreds), hotspot cards at full opacity when nothing is
actually blocking them, and the new search-phase hint on cold start.

The rest of this document is the original pre-implementation analysis,
kept as-is for the reasoning trail.

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
