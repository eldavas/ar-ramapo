# Asset Authoring Guide — Rive UI & MindAR Targets

Audience: anyone adding or changing the *content* of an experience (the Rive
UI, the tracked image, or a whole new target) without necessarily touching
the TypeScript modules. Read AR_SYSTEM.md first for the architecture rules
this guide operates inside of — this doc is the "how do I actually do the
thing" companion to that "what are the rules" document.

## 1. The mental model

Every AR experience in this project is three pieces glued together by one
manifest entry:

```
┌─────────────────────┐     ┌──────────────────────┐     ┌───────────────────┐
│  MindAR target       │     │  experience-manifest  │     │  Rive UI           │
│  *.mind file          │────▶│  entry (one targetId) │◀────│  *.riv file         │
│  (what the camera     │     │  packages/experience- │     │  (what renders on   │
│   recognizes)         │     │  manifest/manifest.ts │     │   top of it)        │
└─────────────────────┘     └──────────────────────┘     └───────────────────┘
```

Nothing in `src/client/*.ts` should ever reference an asset path directly —
`main.ts` calls `resolveExperience(targetId)`
(`packages/experience-manifest/ManifestResolver.ts`) and gets back the
`riveUrl`/`mindTargetUrl` for that experience. If you're adding content and
find yourself typing a `/assets/...` path into a `.ts` file, stop — it
belongs in the manifest instead (AR_SYSTEM.md §D/§E).

---

## 2. Editing the Rive UI

### 2.1 What this project expects from a `.riv` file

Read from `src/client/RiveController.ts` and `src/client/main.ts` — these
are hard constraints today, not suggestions:

| Constraint | Where it's enforced | What happens if you don't match it |
|---|---|---|
| Must have a **state machine** (not just a timeline animation) | `RiveController` constructs Rive with `stateMachines: <name>` and calls `pointerDown`/`pointerUp` on the state machine instance | Touch input silently does nothing — `RiveController.pointerDown/pointerUp` no-op via `this.stateMachine?.` if the state machine name doesn't match |
| The state machine's exact name must match `STATE_MACHINE_NAME` in `src/client/main.ts:11` | Passed into `new RiveController(riveUrl, STATE_MACHINE_NAME)` | Same as above — Rive fails to find a matching state machine and `RiveController.isReady` never becomes `true` |
| Artboard is rendered into a **512×512** offscreen canvas (`RIVE_CANVAS_SIZE` in `RiveController.ts`) using `Fit.contain` / `Alignment.center` | `RiveController.mapCanvasPointToArtboard()` | A non-square artboard gets letterboxed inside that 512×512 frame, same as any `Fit.contain` layout — design your artboard knowing the touch-mapping math assumes this exact fit/alignment pair. If you change canvas size or fit mode, update both in `RiveController.ts` together, they must stay consistent |
| Pointer input arrives in **artboard-space coordinates**, not canvas pixels | `mapCanvasPointToArtboard()` does the `computeAlignment → invert → mapXY` conversion for you | You don't need to do anything here as an artboard author — just know that any listener/hit area you build in the Rive editor should be positioned in normal artboard coordinates; the coordinate translation is handled entirely on the code side |

### 2.2 Replacing or updating the `.riv` file

1. Open/edit the file in the [Rive editor](https://rive.app/) (desktop or web).
2. Keep (or rename consistently) **one state machine** that receives the
   interaction — if you rename it, update `STATE_MACHINE_NAME` in
   `src/client/main.ts:11` in the same change.
3. Export/download the `.riv` file.
4. Drop it into `public/assets/` (e.g. `public/assets/ui-test.riv` — replace
   in place, or add a new filename if you're building a second experience,
   see §4).
5. If you replaced the file at its existing path, nothing else needs to
   change — the manifest already points `riveUrl` at that path. If you used
   a new filename, update `riveUrl` in
   `packages/experience-manifest/manifest.ts` to match.
6. Rebuild and test locally (§5).

### 2.3 Adding new interactive inputs

If you add new inputs to the state machine beyond simple
pointer down/up (e.g. a number or boolean input driven by AR tracking
state, not touch), you'll need a small addition to `RiveController.ts` — it
currently only exposes `pointerDown`/`pointerUp`. Look at
`RiveController`'s private `stateMachine` field
(`StateMachineInstance` from `@rive-app/canvas-lite/rive_advanced.mjs`) for
the available methods (`inputs()`, numeric/boolean input setters) before
adding a new public method to the class — keep the "no direct access to
Rive internals outside this file" boundary intact (see the `internals()`
cast and its comment at the top of `RiveController.ts` for why that
boundary exists).

---

## 3. Creating or replacing a MindAR tracking target

### 3.1 What makes a good tracking image

MindAR (like most feature-based AR tracking) needs an image with strong,
irregular visual detail — not a design constraint of this codebase, but of
the underlying computer-vision technique:

- **High contrast and fine detail** — logos, photos, and illustrations with
  texture track far better than flat colors or simple shapes.
- **Asymmetric, non-repeating patterns** — avoid grids, checkerboards, or
  anything with repeated tiles; the tracker matches distinctive local
  features, and repetition creates ambiguous matches.
- **Avoid large flat/plain areas** — a mostly-white or mostly-solid-color
  image gives the tracker very little to lock onto.
- **Reasonable aspect ratio** — extremely thin/long images track less
  reliably than something closer to square.

If tracking feels jittery or fails to lock on with a new image, the image
itself — not the code — is almost always the first thing to check.

### 3.2 Compiling the image into a `.mind` file

MindAR doesn't track the raw image directly — it needs the image compiled
into its own descriptor format first. The standard, zero-setup way to do
this:

1. Go to the official MindAR image target compiler:
   `https://hiukim.github.io/mind-ar-js-doc/tools/compile/`
2. Upload your source image (PNG/JPG).
3. Click compile, wait for it to finish, download the resulting `.mind`
   file.

This is an **authoring-time tool you run once per image**, not a runtime
dependency — it doesn't conflict with this project's "no CDN dependency at
runtime" rule (AR_SYSTEM.md §C/§F), since nothing in the deployed app calls
out to it.

> **Programmatic alternative (optional, for scripted/CI compilation):**
> `mind-ar` (already a project dependency) exports a `Compiler` class from
> `mind-ar/dist/mindar-image.prod.js` with `compileImageTargets(images,
> onProgress)` and `exportData()` methods, usable from a plain Node script.
> It needs `canvas` (already in `node_modules` as a transitive dependency of
> `mind-ar`, but its native bindings aren't built by default in this repo —
> run `pnpm approve-builds` and select `canvas` if you want to go this
> route, which additionally requires Cairo/Pango system libraries via
> Homebrew on macOS). Not set up as a script in this repo today — only
> worth the setup cost if you're compiling many targets repeatedly or want
> this step in CI rather than done by hand in a browser.

### 3.3 Multiple targets in one `.mind` file

MindAR's compiler accepts multiple images and bakes them into a single
`.mind` file, indexed in upload order (0, 1, 2, …). This project currently
uses **one target at index 0** —
`ARSessionManager.start(0)` in `src/client/main.ts:33`
(`session.start(0)` → `mindAR.addAnchor(0)`). If you compile a `.mind` file
with more than one image, you must track which index corresponds to which
physical marker and pass the right index to `addAnchor()`/`start()` — there
is no per-target routing built yet (see AR_SYSTEM.md's routing-structure
note in the architecture review; each anchor still needs to be wired up in
`main.ts` by hand today).

### 3.4 Replacing the target file

1. Drop the new `.mind` file into `public/assets/`.
2. Update `mindTargetUrl` in
   `packages/experience-manifest/manifest.ts` to point at it (or replace
   the file in place at the existing path — then no manifest change is
   needed).
3. Rebuild and test locally (§5), ideally by printing the target image and
   pointing a phone camera at the physical printout — testing against a
   photo of the image on a screen behaves differently than a printed
   marker under real lighting.

---

## 4. Registering a new experience in the manifest

`packages/experience-manifest/manifest.ts` is the only place asset paths
are declared. The schema (`ExperienceManifest`, same file):

```ts
type ExperienceManifest = {
  targetId: string;      // unique key you choose, e.g. "product-poster"
  riveUrl: string;       // root-relative path under /public, e.g. "/assets/poster-ui.riv"
  modelUrl?: string;     // reserved for future 3D-model support, optional
  mindTargetUrl?: string;// root-relative path to the compiled .mind file
  version: string;       // bump this whenever the asset bundle changes
};
```

To add a new experience:

1. Add both asset files under `public/assets/` (§2.2, §3.4).
2. Add a new entry to the `experienceManifest` array in `manifest.ts`:
   ```ts
   {
     targetId: 'product-poster',
     riveUrl: '/assets/poster-ui.riv',
     mindTargetUrl: '/assets/poster-target.mind',
     version: '0.1.0',
   }
   ```
3. **Asset URL rules, enforced at runtime** by
   `ManifestResolver.ts`'s validation
   (`ASSET_URL_PATTERN = /^\/\S+$/`): every URL must start with `/` and
   contain no whitespace — i.e. a root-relative path actually served from
   `/public`, never an absolute external URL, a bare filename, or an empty
   string. Get this wrong and `resolveExperience()` throws a
   `ManifestResolutionError` immediately at startup — loudly, not a silent
   404 later — telling you exactly which field and entry is malformed.

### Switching which experience is active

There's no target-selection UI yet — the active experience is a single
constant: `ACTIVE_TARGET_ID` in `src/client/main.ts:17`. To make your new
entry the one that loads, change that constant to your new `targetId` (and
update `STATE_MACHINE_NAME` on line 11 if your new `.riv` file uses a
different state machine name — see §2.1).

---

## 5. Testing locally after any asset change

```
pnpm build     # tsc (server) + vite build (client) — rebuilds public/dist
pnpm start     # boots the server; needs local certs for camera access,
               # see the main README/AR_SYSTEM.md for the mkcert setup
```

Then open `https://<your-lan-ip>:3000` on a phone on the same WiFi network,
grant camera access, and point it at the physical printed target. Things to
actually check, not just assume:

- Does the tracked plane/UI appear when the camera sees the marker, and
  disappear/re-anchor correctly when you move the camera away and back?
- Does touching the on-screen UI trigger the expected state-machine
  transition (not just render — actually respond to touch)?
- Open the browser console (remote-debug the phone from desktop Chrome/
  Safari if possible) and confirm there's no `ManifestResolutionError` or
  Rive/MindAR load error logged by `main()`'s `.catch()` handler.

---

## 6. Common pitfalls

- **State machine name mismatch** between the `.riv` file and
  `STATE_MACHINE_NAME` (`main.ts:11`) — the most common "nothing responds
  to touch" bug. Always change both together.
- **Manifest asset path typo** — caught loudly at startup by
  `ManifestResolver`, so check the console immediately rather than
  assuming a blank screen is a tracking problem.
- **Forgetting the anchor index** when compiling a multi-image `.mind`
  file (§3.3) — the visual target you're pointing the camera at might not
  be index `0`.
- **Non-square Rive artboards** rendering letterboxed — expected behavior
  given the `Fit.contain` layout (§2.1), not a bug, but worth designing
  around rather than being surprised by.
