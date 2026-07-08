import { experienceManifest, type ExperienceManifest } from './manifest.js';

// Loosely validates that an asset URL is a root-relative path (what /public
// serves everything as — see AR_SYSTEM.md §D). Rejects empty strings,
// external URLs snuck in by mistake, and undefined/null masquerading as a
// path.
const ASSET_URL_PATTERN = /^\/\S+$/;

export class ManifestResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManifestResolutionError';
  }
}

function isValidAssetUrl(url: string): boolean {
  return ASSET_URL_PATTERN.test(url);
}

function assertValidAssetUrl(targetId: string, field: string, url: string): void {
  if (!isValidAssetUrl(url)) {
    throw new ManifestResolutionError(
      `experience-manifest entry "${targetId}" has an invalid ${field}: ${JSON.stringify(url)}. ` +
        'Asset URLs must be root-relative paths served from /public (e.g. "/assets/foo.riv").'
    );
  }
}

// contentUrl is the one field allowed to point off-origin (§E Phase 5): an
// external content source is https by definition (Phase 5: the Google Sheet
// gviz endpoint). Root-relative paths stay valid too, so a local stub or a
// same-origin proxy needs no schema change.
const CONTENT_URL_PATTERN = /^(\/\S+|https:\/\/\S+)$/;

function assertValidContentUrl(targetId: string, url: string): void {
  if (!CONTENT_URL_PATTERN.test(url)) {
    throw new ManifestResolutionError(
      `experience-manifest entry "${targetId}" has an invalid contentUrl: ${JSON.stringify(url)}. ` +
        'contentUrl must be a root-relative /public path or an absolute https:// URL (AR_SYSTEM.md §E).'
    );
  }
}

/**
 * Resolves a targetId to its declared experience-manifest entry.
 *
 * Fails loudly (throws ManifestResolutionError) rather than returning
 * undefined/null when the targetId is unknown, an asset URL is malformed,
 * or the placement mode's required fields are missing — per AR_SYSTEM.md
 * §D: no hardcoded paths, no silent asset-resolution failures.
 */
export function resolveExperience(targetId: string): ExperienceManifest {
  const entry = experienceManifest.find((candidate) => candidate.targetId === targetId);

  if (!entry) {
    const known = experienceManifest.map((candidate) => candidate.targetId).join(', ') || '(none registered)';
    throw new ManifestResolutionError(
      `No experience-manifest entry for targetId "${targetId}". Known target IDs: ${known}.`
    );
  }

  assertValidAssetUrl(entry.targetId, 'riveUrl', entry.riveUrl);
  if (entry.modelUrl !== undefined) {
    assertValidAssetUrl(entry.targetId, 'modelUrl', entry.modelUrl);
  }
  if (entry.usdzUrl !== undefined) {
    assertValidAssetUrl(entry.targetId, 'usdzUrl', entry.usdzUrl);
  }
  if (entry.imageTargetUrl !== undefined) {
    assertValidAssetUrl(entry.targetId, 'imageTargetUrl', entry.imageTargetUrl);
  }
  if (entry.trackingImageUrl !== undefined) {
    assertValidAssetUrl(entry.targetId, 'trackingImageUrl', entry.trackingImageUrl);
  }
  if (entry.contentUrl !== undefined) {
    assertValidContentUrl(entry.targetId, entry.contentUrl);
  }

  // Placement-mode invariants: each origin source declares exactly the
  // physical facts it needs, and an entry missing them fails resolution
  // instead of failing later (or worse, silently) at runtime.
  if (entry.placement === 'tap') {
    if (entry.geo === undefined) {
      throw new ManifestResolutionError(
        `experience-manifest entry "${entry.targetId}" declares placement "tap" without a geo fence. ` +
          'Tap-placed experiences are gated by GPS arrival; declare geo { latitude, longitude, radiusMeters }.'
      );
    }
    assertValidGeo(entry.targetId, entry.geo);
  }

  if (entry.placement === 'image') {
    if (entry.imageTargetUrl === undefined) {
      throw new ManifestResolutionError(
        `experience-manifest entry "${entry.targetId}" declares placement "image" without an imageTargetUrl.`
      );
    }
    const width = entry.physicalTargetWidthMeters;
    if (width === undefined || !Number.isFinite(width) || width <= 0) {
      throw new ManifestResolutionError(
        `experience-manifest entry "${entry.targetId}" declares placement "image" but has an invalid ` +
          `physicalTargetWidthMeters: ${JSON.stringify(width)}. Image-anchored entries must declare the ` +
          'printed tracking-target width as a positive number of meters (AR_SYSTEM.md §E).'
      );
    }
    // geo is optional for image placement (a portable demo has no fixed
    // site) but must be well-formed when declared — the arrival gate runs
    // whenever it is present.
    if (entry.geo !== undefined) {
      assertValidGeo(entry.targetId, entry.geo);
    }
  }

  return entry;
}

function assertValidGeo(targetId: string, geo: NonNullable<ExperienceManifest['geo']>): void {
  const latValid = Number.isFinite(geo.latitude) && geo.latitude >= -90 && geo.latitude <= 90;
  const lngValid = Number.isFinite(geo.longitude) && geo.longitude >= -180 && geo.longitude <= 180;
  const radiusValid = Number.isFinite(geo.radiusMeters) && geo.radiusMeters > 0;
  if (!latValid || !lngValid || !radiusValid) {
    throw new ManifestResolutionError(
      `experience-manifest entry "${targetId}" has an invalid geo fence: ${JSON.stringify(geo)}. ` +
        'Expected latitude ∈ [−90, 90], longitude ∈ [−180, 180], radiusMeters > 0.'
    );
  }
}
