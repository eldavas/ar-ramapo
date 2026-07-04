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

/**
 * Resolves a targetId to its declared experience-manifest entry.
 *
 * Fails loudly (throws ManifestResolutionError) rather than returning
 * undefined/null when the targetId is unknown or an asset URL is malformed —
 * per AR_SYSTEM.md §D: no hardcoded paths, no silent asset-resolution
 * failures.
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
  if (entry.mindTargetUrl !== undefined) {
    assertValidAssetUrl(entry.targetId, 'mindTargetUrl', entry.mindTargetUrl);
  }
  if (entry.trackingImageUrl !== undefined) {
    assertValidAssetUrl(entry.targetId, 'trackingImageUrl', entry.trackingImageUrl);
  }

  // physicalTargetWidthMeters is the sole scale bridge between
  // meter-authored content and the tracking engines (AR_SYSTEM.md §E/§F) —
  // an entry that declares spatial content without it would render at a
  // meaningless scale, so fail resolution instead.
  if (entry.modelUrl !== undefined) {
    const width = entry.physicalTargetWidthMeters;
    if (width === undefined || !Number.isFinite(width) || width <= 0) {
      throw new ManifestResolutionError(
        `experience-manifest entry "${entry.targetId}" declares modelUrl but has an invalid ` +
          `physicalTargetWidthMeters: ${JSON.stringify(width)}. Entries with spatial content must ` +
          'declare the printed tracking-target width as a positive number of meters (AR_SYSTEM.md §E).'
      );
    }
  }

  return entry;
}
