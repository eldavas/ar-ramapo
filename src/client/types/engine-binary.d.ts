// Ambient module declaration for the untyped @8thwall/engine-binary npm
// shim. Kept import-free at top level so TypeScript treats this file as a
// script and the declaration registers globally (a top-level import would
// turn it into a module and demote `declare module` to an augmentation of
// a package that has no types to augment).
declare module '@8thwall/engine-binary' {
  import type { Xr8 } from './xr8.js';
  /**
   * Resolves with the global XR8 once /xr/xr.js (loaded via plain script
   * tag in index.html — never bundled) fires its `xrloaded` event. The
   * shim is hosting-location agnostic; it only watches window.XR8.
   */
  export const XR8Promise: Promise<Xr8>;
}
