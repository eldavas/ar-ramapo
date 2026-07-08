import type { Request, Response } from 'express';
import { experienceManifest } from '../packages/experience-manifest/manifest.js';

/**
 * GET /api/manifest — the explicit route through which native clients (the
 * future iOS App Clip) resolve assets. Returns the full versioned manifest
 * array in the exact  shape, no more, no less; clients resolve
 * their targetId locally, mirroring ManifestResolver (AR_SYSTEM.md §D, §E).
 *
 * Per the Golden Rule (§E) the payload can never carry UI/hotspot
 * attributes — that data lives inside the referenced assets themselves.
 */
export function manifestHandler(_req: Request, res: Response): void {
  res.json(experienceManifest);
}
