import type { Request, Response } from 'express';

/**
 * GET /.well-known/apple-app-site-association — Apple's domain-verification
 * file for App Clip invocation (AR_SYSTEM.md §G Phase 4). Apple's CDN
 * fetches this extensionless path when the App Clip's associated domain
 * (`appclips:ar-ramapo.onrender.com`) is validated; without a 200 +
 * `application/json` response here, QR/Safari invocations never reach the
 * native client.
 *
 * Served as an explicit route, not a static file: §D forbids reaching
 * anything outside /public via static serving, and an extensionless file
 * under /public would be served with the wrong Content-Type anyway. The
 * payload is Apple platform configuration — deployment identity, not an
 * AR asset — so it lives here with the server, not in the manifest (§E).
 */

/** Apple Developer Team ID + the App Clip's bundle identifier. */
const APP_CLIP_APPLICATION_IDENTIFIER = '9UA6B7PXV2.com.daniels.arengine.Clip';

const APPLE_APP_SITE_ASSOCIATION = {
  appclips: {
    apps: [APP_CLIP_APPLICATION_IDENTIFIER],
  },
} as const;

export function appleAppSiteAssociationHandler(_req: Request, res: Response): void {
  // Explicit Content-Type: Apple requires application/json, and Express
  // would otherwise have nothing to infer it from on an extensionless path.
  res.type('application/json').json(APPLE_APP_SITE_ASSOCIATION);
}
