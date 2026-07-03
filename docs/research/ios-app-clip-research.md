# iOS App Clip + ARKit + RealityKit + rive-ios research (verified July 2026)

Facts for the future native iOS workstream (AR_SYSTEM.md §A/§F: a separate
repo sharing creative assets and the manifest schema, never rendering code).
The workstream has not started and no iOS repo exists yet — this document is
the durable home for these facts until it does. Verified July 2026;
re-verify OS-version-sensitive items when the workstream starts.

- **Size limits:** 15 MB uncompressed for physically-invoked clips (QR/NFC/
  App Clip Codes); the 50 MB tier is digital-invocation-only. Rive iOS
  runtime ≈ 1.67 MB download / 4.66 MB install; ARKit/RealityKit are system
  frameworks (zero cost) → expect ~6–8 MB total.
- **Detect-once-world-lock:** `AnchorEntity(.image(...))` hides content
  whenever the image isn't actively tracked — wrong tool. Use a manual
  `ARSessionDelegate`: `ARWorldTrackingConfiguration` + `detectionImages` +
  `maximumNumberOfTrackedImages = 0`; in `session(_:didAdd:)` capture
  `imageAnchor.transform` → `AnchorEntity(world:)` → remove the image anchor
  (permits re-scan). ARKit needs the ORIGINAL target artwork
  (`tools/plaque/bench-plaque.png` for the bench target) plus the printed
  width in meters (`physicalTargetWidthMeters` from the manifest — fetch it
  via `GET /api/manifest`); a compiled `.mind` file is useless to ARKit.
  `ARImageAnchor` frame: X-east / Y-up / Z-south, meters (locked in
  AR_SYSTEM.md §F).
- **Runtime USDZ:** no remote-URL loading; URLSession download → local file
  (extension must be `.usdz`) → `try await Entity(contentsOf:)`. RealityKit
  does not load glTF (as of iOS 26). Blender exports `.usdz` natively (the
  bench scene's `usdzUrl` asset comes from `tools/build_bench_scene.py`);
  Reality Converter is sunset.
- **rive-ios:** SPM `rive-app/rive-ios` (v6.x in mid-2026);
  `RiveViewModel(fileName:stateMachineName:)`, `.view()` in SwiftUI; touches
  hit state-machine listeners natively; events via
  `RiveStateMachineDelegate`. Same `.riv` files as web. In-scene Rive on 3D
  planes = render to Metal texture + RealityKit `DrawableQueue` (proven
  pattern, deferred to v2; v1 = screen-space overlay, mirroring the web
  runtime's HotspotOverlay approach).
- **Testing without the App Store:** `_XCAppClipURL` scheme env var
  simulates invocation; Settings → Developer → App Clips Testing → Local
  Experiences invokes the real card from a QR (notoriously flaky —
  re-register/reboot). Size check: Archive → App Thinning size report. An
  App Clip cannot ship alone — it needs a parent app. An active Apple
  Developer Program membership is available.
- **TLS:** the production topology (cloud edge, real cert — AR_SYSTEM.md §G
  Phase 2) is the preferred asset-streaming test path. LAN fallback: mkcert
  root installed on the iPhone **with full trust enabled** satisfies ATS;
  App Clip local-network permission to LAN IPs is under-documented (risk);
  `cloudflared tunnel` is the middle option.
- **QR invocation routing:** register the URL as an Advanced App Clip
  Experience → iOS Camera shows the clip card before Safari opens; Android
  cameras open the same URL in Chrome (the web experience). Safari fallback
  = Smart App Banner meta `app-clip-display=card` + AASA file.
