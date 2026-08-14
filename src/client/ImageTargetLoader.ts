import type { PlaqueTarget } from '../../packages/experience-manifest/manifest.js';
import type { Xr8ImageTargetDataEntry } from './types/xr8.js';

export interface LoadedImageTargets {
  imageTargetData: Xr8ImageTargetDataEntry[];
  /**
   * `name` of the single primary target — the value image events carry.
   * ImageTargetAnchorSource filters on it, so a renamed compile output can
   * never silently mismatch a hardcoded string.
   */
  primaryName: string;
}

/** One `targets[]` entry, resolved to the tracked-event `name` it fires under. */
export interface ResolvedPlaqueTarget {
  name: string;
  physicalTargetWidthMeters: number;
  originOffsetMeters: { x: number; z: number };
  rotationYawDeg: number;
}

export interface LoadedMultiImageTargets {
  /** Every plaque's image-target data, merged — handed to XrController.configure() as one array. */
  imageTargetData: Xr8ImageTargetDataEntry[];
  /** Resolved per-plaque config, keyed by the same `name` Xr8ImageTrackedEvent carries. */
  targetsByName: Map<string, ResolvedPlaqueTarget>;
}

/**
 * Multi-plaque counterpart to loadImageTargetData() below (§E "Multi-target
 * plaques"): fetches every targets[] entry's own imageTargetUrl in
 * parallel, merges their (possibly multi-entry, see loadImageTargetData's
 * own doc comment) imageTargetData arrays into one, and resolves each to
 * the manifest's originOffsetMeters/rotationYawDeg via `imageTargetName`
 * (explicit) or the compiled target's own `name` (default — the common
 * case, since image-target-cli names the target after its own output
 * folder, which is the manifest's targetId-derived convention).
 */
export async function loadImageTargetDataForTargets(
  targets: readonly PlaqueTarget[]
): Promise<LoadedMultiImageTargets> {
  const imageTargetData: Xr8ImageTargetDataEntry[] = [];
  const targetsByName = new Map<string, ResolvedPlaqueTarget>();

  const loaded = await Promise.all(
    targets.map(async (target, index) => {
      if (target.imageTargetUrl === undefined) {
        throw new ImageTargetLoadError(
          `targets[${index}] has no imageTargetUrl — required for every 8th Wall plaque target.`
        );
      }
      return { target, index, loaded: await loadImageTargetData(target.imageTargetUrl) };
    })
  );

  for (const { target, index, loaded: entryData } of loaded) {
    const name = target.imageTargetName ?? entryData.primaryName;
    if (targetsByName.has(name)) {
      throw new ImageTargetLoadError(
        `targets[${index}] resolves to name "${name}", already used by another entry in this ` +
          'experience — Xr8ImageTrackedEvent.name would be ambiguous between them.'
      );
    }
    targetsByName.set(name, {
      name,
      physicalTargetWidthMeters: target.physicalTargetWidthMeters,
      originOffsetMeters: target.originOffsetMeters,
      rotationYawDeg: target.rotationYawDeg,
    });
    imageTargetData.push(...entryData.imageTargetData);
  }

  return { imageTargetData, targetsByName };
}

export class ImageTargetLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImageTargetLoadError';
  }
}

/**
 * Fetches and validates a CLI-compiled image-target JSON (see README's
 * compilation step). Fail-loud like ManifestResolver: a malformed or
 * mis-pathed target file must surface at load time with an actionable
 * message, never as a silently never-firing imagefound.
 *
 * The CLI's exact output shape is engine-owned; this normalizes a single
 * object or an array of entries, and enforces only what the app depends
 * on: a string `name` (events are filtered on it) and a root-relative
 * `imagePath` (the engine fetches it via <img crossorigin>, so it must be
 * a served same-origin path — the post-compile fixup step).
 */
export async function loadImageTargetData(imageTargetUrl: string): Promise<LoadedImageTargets> {
  const response = await fetch(imageTargetUrl);
  if (!response.ok) {
    throw new ImageTargetLoadError(
      `image-target fetch failed (HTTP ${response.status}): ${imageTargetUrl}`
    );
  }
  const json: unknown = await response.json();
  const rawEntries = Array.isArray(json) ? json : [json];
  if (rawEntries.length === 0) {
    throw new ImageTargetLoadError(`image-target file is an empty array: ${imageTargetUrl}`);
  }

  const entries = rawEntries.map((entry, index) => assertValidEntry(entry, index, imageTargetUrl));
  return { imageTargetData: entries, primaryName: entries[0].name };
}

function assertValidEntry(
  entry: unknown,
  index: number,
  imageTargetUrl: string
): Xr8ImageTargetDataEntry {
  if (typeof entry !== 'object' || entry === null) {
    throw new ImageTargetLoadError(
      `image-target entry ${index} in ${imageTargetUrl} is not an object.`
    );
  }
  const { name, imagePath } = entry as { name?: unknown; imagePath?: unknown };
  if (typeof name !== 'string' || name.length === 0) {
    throw new ImageTargetLoadError(
      `image-target entry ${index} in ${imageTargetUrl} has no string "name".`
    );
  }
  if (typeof imagePath !== 'string' || !imagePath.startsWith('/')) {
    throw new ImageTargetLoadError(
      `image-target entry "${name}" in ${imageTargetUrl} has imagePath ${JSON.stringify(imagePath)}. ` +
        'It must be a root-relative served path (e.g. "/assets/image-targets/bench-plaque/bench-plaque.png") — ' +
        'edit the compiled JSON after running the image-target CLI (see README).'
    );
  }
  return entry as Xr8ImageTargetDataEntry;
}
