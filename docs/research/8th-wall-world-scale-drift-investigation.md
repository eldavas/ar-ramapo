# 8th Wall world-scale/world-coordinate drift — investigation (2026-09-03)

Deep-dive requested after `docs/log-11.txt` (§39 in `8th-wall-troubleshooting.md`)
showed the model shrinking progressively after a correct reveal — "como
cayendo en el vacío" — while the pose-plausibility/rotation-consensus gates
(§37/§38) were confirmed working correctly. This document is diagnosis-only,
no code changed. It supersedes nothing in the numbered troubleshooting log;
it's the expanded version of §39's finding, kept separate because of its
length and because it leans heavily on external sources.

## 1. Diagnosis confirmed

**This is (B) World Tracking Drift — a continuous, gradual re-estimation of
the engine's ground plane (Y=0) — not (A) an individual bad pose sample and
not (C) an explicit reset/relocalization event.**

Direct evidence from `docs/log-11.txt`: throughout the entire collapse
(+41.6s to the end of the session), `trackingStatus` stayed `NORMAL` without
a single change — `RELOCALIZING` never appeared. **`trackingStatus=NORMAL`
coexisted with a massive, sustained scale/position drift for the rest of the
session.** NORMAL describes per-frame rotation+position tracking confidence;
it says nothing about whether the absolute-scale/ground-plane estimate is
stable over time.

## 2. What 8th Wall documents officially

Sourced from 8th Wall's own docs and forum (staff replies), via web search —
their docs site is a client-rendered SPA that couldn't be fetched directly
for full-page content, so these are the officially indexed statements, cited
with URLs below.

- **World Tracking is floor-based only**, continuously recalculating a
  single horizontal plane (Y=0) from the most stable set of feature points
  visible **at any moment** — not a one-time convergence.
- **"If the surface is too uniform or lacks distinct features, tracking can
  be lost or the floor may be redefined incorrectly."** This is an official,
  verbatim confirmation of the matte-tablecloth hypothesis already raised in
  §36/§39 — no longer a guess, a documented failure mode.
- **Official recovery mechanism:** point the camera at a feature-rich
  surface for a few seconds, or call `XR8.XrController.recenter()` — resets
  tracking to the current camera view, "without reloading the page."
- **Absolute Scale's Y is tied to live ground-height estimation**, not
  independently placed — the camera's Y at start "effectively determines the
  scale of virtual content on a surface." This means scale drift and
  world-coordinate drift are **the same root cause** (the re-estimated floor
  plane), not two separate problems.
- **8th Wall staff have admitted a related bug**: changing device
  orientation can cause absolute scale to be "lost," and their own
  recommended workaround in that case is a full page reload — i.e. even 8th
  Wall doesn't always have a graceful in-session fix.
- The official Coaching Overlay's whole purpose is estimating **camera
  height** via forward/backward motion — confirming Absolute Scale is
  fundamentally a height-estimation technique, not full stereo/depth metric
  SLAM.

Sources:
- [World Tracking Issues | 8th Wall](https://www.8thwall.com/docs/studio/troubleshooting/world-tracking-issues/)
- [XR8.XrController.recenter() | 8th Wall](https://8thwall.org/docs/api/engine/xrcontroller/recenter)
- [Introducing Absolute Scale | 8th Wall](https://www.8thwall.com/blog/post/69357938708/introducing-absolute-scale)
- [Coaching Overlay | 8th Wall](https://www.8thwall.com/docs/legacy/guides/advanced-topics/coaching-overlays/)
- [Device orientation resetting object locations with absolute scale enabled — 8th Wall Forum](https://forum.8thwall.com/t/device-orientation-resetting-object-locations-with-absolute-scale-enabled/335)
- [World tracking issues — 8th Wall Forum](https://forum.8thwall.com/t/world-tracking-issues/2910)

## 3. Our own implementation audited — not the cause

Read in full: `EightWallSession.ts`, `ImageTargetAnchorSource.ts`, `main.ts`,
`AnchorSource.ts`, `manifest.ts`.

- `XrController.configure({scale:'absolute', ...})` is called exactly once.
- `camera.position.set(0, 1.6, 0)` / `updateCameraProjectionMatrix(...)` run
  exactly once, at `onStart` — Y is non-zero, matching 8th Wall's own stated
  requirement.
- `EightWallSession.recenter()` exists but `grep` confirms it is **never
  called anywhere in the app** — unused.
- `anchorScaleForEvent()` always returns `1` — the anchor never self-scales.
- The §37/§38 gates demonstrably never re-applied a pose after +41.6s in
  log-11 — every subsequent re-detection was rejected for scale mismatch.
- `main.ts` has zero references to camera/scale/recenter outside comments.

**Our code is correctly freezing the anchor while the engine changes the
world frame underneath it — not causing the change.**

## 4. `physicalTargetWidthMeters` verified — not a mismatch

`packages/experience-manifest/manifest.ts` (`site-tracking-front` and
siblings) and `tools/build_site_tracking_targets.py`
(`TARGET_SIZE_MM = 30.0`) agree exactly: 30mm, consistently, since the
2026-08-25 Voronoi-artwork swap. No code/manifest/asset inconsistency found.
The one thing code can't verify: whether the physically printed artifact
really measures 30mm. Worth a quick ruler check, but a print error would
produce a **constant** offset from the start, not a progressive collapse —
so it doesn't explain log-11's pattern.

## 5. Official recovery mechanisms available

| Mechanism | API | UX cost | Destroys content? | Needs new camera permission? | Needs re-detection after? | No reload needed? |
|---|---|---|---|---|---|---|
| Recenter | `XR8.XrController.recenter()` (already exposed, unused, in `EightWallSession.recenter()`) | Low | Not directly, but the frozen anchor is now stale relative to the new frame | No | Yes, recommended | Yes |
| Re-point at rich-feature surface | none (passive engine behavior) | Minimal | No | No | Not necessarily | Yes |
| Full page reload | N/A | High — full state loss | Yes | Yes | Yes | No — this IS the reload |

No official API found for resetting *only* scale without also touching
position/orientation — `recenter()` is the one real lever, and it acts on
the whole frame.

## 6. Current re-detection strategy vs. world drift

Necessary but not sufficient. It can permanently stall exactly as seen in
log-11: once the ground-plane drift is large enough, no future re-detection
will ever land back inside ±25% of the *original* calibration, so the system
waits forever for a confirmation that can't come — the anchor stays
"protected from corruption" but visually irrelevant. We don't currently
distinguish "momentary bad tracking" (already handled well) from "world
coordinate system has drifted" — the only available proxy today is repeated
scale-implausible rejections whose ratios don't even agree with each other,
sustained over several seconds, which is exactly what log-11 shows and which
nothing currently counts or surfaces.

## 7. Proposed AR health model (conceptual only)

```
IDLE → STARTING → SEARCHING → CONVERGING → STABLE
                                              │
              (N consecutive scale-implausible rejections,
               each a DIFFERENT ratio, over a time window,
               while trackingStatus stays NORMAL)
                                              ▼
                                        SUSPECT_DRIFT
                                              │
                 (user re-points at a plaque, optionally
                  after an app-triggered recenter())
                                              ▼
                                          RECOVERING
                                              │
                    (one sample confirmed by the
                     §37 rotation-consensus gate)
                                              ▼
                                           STABLE
```

The distinguishing signal between "momentary loss" and "world drift" is
available today without new instrumentation: a single rejection resolves
itself the moment a good sample lands (already true); a *drift* episode
shows several rejections in a row with **mutually inconsistent** ratios.

## 8. Recovery UX (conceptual only)

If `SUSPECT_DRIFT` is detected: hide the now-unreliable content, show a
clear hint ("we lost the reference — point at one of the plaques again"),
and only re-reveal once the consensus gate confirms a new sample — the same
pattern already built for cold start (§35/§36), extended to run post-reveal
too.

## 9. Hard recovery (conceptual only)

Technically possible — `EightWallSession.stop()`/`start()` already exist as
separate methods. Cost is high: possible camera-permission re-prompt on some
browsers, full scene-state loss, and the same 15–40s cold start already
measured this session. Given 8th Wall documents `recenter()` specifically as
the lightweight alternative ("without reloading the page"), a full session
restart should be the last resort, not the first response.

## 10. Classifying the three failure modes

- **(A) Image Target Pose Error** — solved by §37/§38, confirmed on real
  hardware in log-10/log-11.
- **(B) World Tracking Drift** — what log-11 shows: floor-plane
  re-estimation, confirmed by official docs + our own telemetry
  (`trackingStatus` never changed; camera height climbed ~0.5m→~5m; rejected
  ratios don't agree with each other).
- **(C) World Tracking Reset/Relocalization** — did NOT occur in log-11; no
  `RELOCALIZING` reason ever fired. The drift was silent — no public signal
  flagged it, which is precisely what makes it hard to detect today.

## 11. Yaw — kept separate, on purpose

Yaw (-28.9° on the final log-11 pose) is unrelated to the floor-plane
mechanism above. Floor drift affects height/scale (since absolute scale is
derived from camera height relative to the tracked floor); yaw drift is the
separate, already-documented (§35) lack of an absolute heading reference. No
action recommended on yaw beyond what §37 already does — a real fix would
need an independent compass/`DeviceOrientationEvent` source, a materially
different and larger effort, out of scope here.

## 12–13. Recommendation

**D — a small AR health/recovery state machine (§7) combined with actually
using the already-exposed, already-unused `recenter()` — not a full session
restart as the first response.**

Justification: the pose gate already works (A is solved). The gap is that
nothing today detects or reacts to a *silent* world-drift episode under a
`trackingStatus` that keeps reporting NORMAL. The signal needed
(inconsistent, repeated scale rejections over time) is already logged, just
uncounted. `recenter()` is 8th Wall's own documented fix for exactly this
scenario and costs far less than a full restart.

**Proposed file-by-file plan (not implemented):**
- `ImageTargetAnchorSource.ts`: track consecutive scale-implausible
  rejections and whether their ratios diverge from each other; expose a
  `SUSPECT_DRIFT` signal when the pattern holds for a time window.
- `EightWallSession.ts`: wire that signal to `recenter()` (already present,
  unused).
- `main.ts`: new post-reveal coaching state ("we lost the reference, point
  at a plaque again"), hiding content until the consensus gate confirms a
  fresh sample.
- `arStatusStore`: a new phase for the UI to render the same way it renders
  the existing phases.
