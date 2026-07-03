# WebXR AR platform landscape (verified July 2026)

What works where, and why the iPhone is excluded — the factual basis for
AR_SYSTEM.md §A/§F's "WebXR is an optional enhancement, never a dependency"
rule and for iOS being a native App Clip workstream. Verified via web
research on 2026-07-02; re-verify before relying on it much later.

- **iOS has no WebXR `immersive-ar` in any browser.** Safari 18+ ships WebXR
  but the AR module is stubbed behind a non-functional flag. Chrome, Firefox
  and Edge on iOS are WebKit wrappers (Apple requirement), so they inherit
  the same limitation — "use Chrome on iPhone" does not help. Even under the
  EU DMA / BrowserEngineKit (March 2024), no vendor has shipped a non-WebKit
  engine to users as of mid-2026.
- **Android Chrome** supports `immersive-ar` (requires Google Play Services
  for AR / ARCore).
- **WebXR Raw Camera Access** (`camera-access` feature;
  `XRWebGLBinding.getCameraImage(view.camera)`): Chrome-on-Android only,
  dev-trial behind `chrome://flags/#webxr-incubations`, not shipped stable.
  The camera texture is only valid within the rAF callback; the spec
  guarantees the image is aligned with the XRView.
- **WebXR Image Tracking module**: stuck behind Chrome's WebXR Incubations
  flag for years, never shipped (chromestatus feature 6548327782940672).
- **iOS escape hatches** for WebXR-style AR: Variant Launch (App Clip
  wrapper polyfilling WebXR, no App Store install), 8th Wall (paid SLAM, no
  WebXR needed), or degrade to MindAR-only.

**Architectural corollary** (why this matters to any future Android WebXR
track): a sequential MindAR→WebXR handoff is impossible — WebXR establishes
its world origin at session start, and the camera restarts between the two.
Any marker-calibrated WebXR pipeline must start the XR session *first* and
run image tracking on frames pulled from inside the session (raw camera
access — see [mindar-controller-api.md](mindar-controller-api.md) for how to
feed MindAR external frames), then compose target pose × viewer pose.

Sources: testmuai.com WebXR 2026 guide,
developer.apple.com/forums/thread/756850,
immersive-web.github.io/raw-camera-access,
chromestatus.com/feature/5759984304390144.
