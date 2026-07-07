/**
 * External display-content seam (AR_SYSTEM.md §E, Phase 5).
 *
 * A hotspot's userData carries only a stable `contentKey`; the content
 * behind that key (Card title, body copy, image reference) lives in an
 * external source resolved through this interface, routed via the
 * manifest's `contentUrl`. Phase 5 backs it with a Google Sheet; the
 * CMS-era migration is a new implementation of ContentProvider pointed at
 * the CMS endpoint — nothing else in the runtime changes.
 */

export interface CardContent {
  title: string;
  body: string;
  /**
   * Optional image for the Card's `cardImage` slot. Root-relative /public
   * paths are the recommended form (no CORS involved); absolute https URLs
   * work when the host serves CORS headers. Absent/empty = the Card keeps
   * its authored placeholder state.
   */
  imageUrl?: string;
}

export class ContentResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContentResolutionError';
  }
}

export interface ContentProvider {
  /**
   * Resolves a hotspot contentKey to its display content. Throws
   * ContentResolutionError — never returns undefined — when the key is
   * unknown or the source is unreachable/malformed (§C/§D fail-loud rule,
   * mirroring ManifestResolver).
   */
  getContent(contentKey: string): Promise<CardContent>;
}

// The sheet's required header labels (first row, exact strings).
const COLUMN_CONTENT_KEY = 'contentKey';
const COLUMN_TITLE = 'title';
const COLUMN_BODY = 'body';
const COLUMN_IMAGE_URL = 'imageUrl';

/**
 * ContentProvider backed by a Google Sheet, read through the sheet's gviz
 * JSON endpoint (`…/gviz/tq?tqx=out:json`). The sheet needs "anyone with
 * the link can view" sharing — no API key, no publish-to-web step, and
 * edits show up on the next page load, which is the whole point of the
 * Phase 5 test loop.
 *
 * Expected sheet shape: first row is the header — contentKey | title |
 * body | imageUrl — one row per hotspot below it. Column order is free;
 * columns are matched by header label.
 *
 * The gviz response is JSON wrapped in
 * `google.visualization.Query.setResponse(…)`; long-stable but
 * undocumented, so every deviation throws ContentResolutionError with
 * enough context to tell a wrapper change from a sharing/permission
 * problem. Fallback if Google ever breaks it: publish-to-web CSV plus a
 * quote-aware parser (see the Phase 5 plan notes).
 */
export class GoogleSheetContentProvider implements ContentProvider {
  private entriesPromise: Promise<Map<string, CardContent>> | null = null;

  constructor(private readonly contentUrl: string) {}

  /**
   * Starts the sheet fetch without waiting for a tap, so the first Card
   * open doesn't pay the network round-trip. Errors are deferred to the
   * first getContent() await — kicking off a prefetch must not crash
   * startup paths that never end up opening a card.
   */
  prefetch(): void {
    void this.load().catch(() => {
      // Swallowed here only to avoid an unhandled-rejection console error;
      // the memoized rejected promise is re-thrown to the first caller of
      // getContent(), which is the loud path.
    });
  }

  async getContent(contentKey: string): Promise<CardContent> {
    const entries = await this.load();
    const entry = entries.get(contentKey);
    if (!entry) {
      const known = [...entries.keys()].join(', ') || '(none)';
      throw new ContentResolutionError(
        `No content row for contentKey "${contentKey}" in the sheet at ${this.contentUrl}. ` +
          `Known keys: ${known}. The key authored on the hotspot (Blender custom property) and the ` +
          `sheet's ${COLUMN_CONTENT_KEY} column must match exactly.`
      );
    }
    return entry;
  }

  private load(): Promise<Map<string, CardContent>> {
    // Memoized for the session: one fetch serves every hotspot. A page
    // reload is the refresh mechanism, matching the pass criterion
    // "editing a sheet cell changes the card copy on next load".
    if (!this.entriesPromise) {
      this.entriesPromise = this.fetchAndParse();
    }
    return this.entriesPromise;
  }

  private async fetchAndParse(): Promise<Map<string, CardContent>> {
    const url = this.buildFetchUrl();

    let response: Response;
    try {
      response = await fetch(url);
    } catch (cause) {
      throw new ContentResolutionError(
        `Failed to reach the content source at ${this.contentUrl}: ${String(cause)}.`
      );
    }
    if (!response.ok) {
      throw new ContentResolutionError(
        `Content source at ${this.contentUrl} answered HTTP ${response.status}. For a Google Sheet, ` +
          'check that sharing is set to "anyone with the link can view".'
      );
    }

    const text = await response.text();
    const table = this.unwrapGvizTable(text);
    return this.tableToEntries(table);
  }

  private buildFetchUrl(): string {
    // headers=1 pins the first sheet row as the header row (gviz otherwise
    // guesses); the timestamp defeats intermediate response caching so a
    // sheet edit shows up on the very next reload.
    const separator = this.contentUrl.includes('?') ? '&' : '?';
    return `${this.contentUrl}${separator}headers=1&_cb=${Date.now()}`;
  }

  private unwrapGvizTable(text: string): GvizTable {
    const start = text.indexOf('(');
    const end = text.lastIndexOf(')');
    if (start === -1 || end === -1 || end <= start) {
      throw new ContentResolutionError(
        `Content source at ${this.contentUrl} did not return the expected gviz setResponse(…) wrapper. ` +
          'This usually means the URL is not a /gviz/tq?tqx=out:json endpoint, or the sheet is not ' +
          'shared as "anyone with the link can view" (Google returns a sign-in page instead).'
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text.slice(start + 1, end));
    } catch {
      throw new ContentResolutionError(
        `Content source at ${this.contentUrl} returned a gviz wrapper whose payload is not valid JSON.`
      );
    }

    const payload = parsed as { status?: string; errors?: Array<{ detailed_message?: string }>; table?: GvizTable };
    if (payload.status !== 'ok' || !payload.table) {
      const detail = payload.errors?.[0]?.detailed_message ?? 'no error detail provided';
      throw new ContentResolutionError(
        `Google Sheet at ${this.contentUrl} reported status "${payload.status ?? 'unknown'}": ${detail}.`
      );
    }
    return payload.table;
  }

  private tableToEntries(table: GvizTable): Map<string, CardContent> {
    const labels = table.cols.map((col) => (col.label ?? '').trim());
    const keyIndex = this.requireColumn(labels, COLUMN_CONTENT_KEY);
    const titleIndex = this.requireColumn(labels, COLUMN_TITLE);
    const bodyIndex = this.requireColumn(labels, COLUMN_BODY);
    const imageIndex = labels.indexOf(COLUMN_IMAGE_URL); // optional column

    const entries = new Map<string, CardContent>();
    for (const [rowNumber, row] of table.rows.entries()) {
      const key = readCell(row, keyIndex);
      if (key === undefined) continue; // blank/spacer row — skip, not an error

      if (entries.has(key)) {
        throw new ContentResolutionError(
          `Duplicate contentKey "${key}" in the sheet at ${this.contentUrl} (row ${rowNumber + 2}). ` +
            'Each hotspot key must appear exactly once.'
        );
      }

      const title = readCell(row, titleIndex);
      const body = readCell(row, bodyIndex);
      if (title === undefined || body === undefined) {
        throw new ContentResolutionError(
          `Sheet row for contentKey "${key}" (row ${rowNumber + 2}) is missing a ${COLUMN_TITLE} or ` +
            `${COLUMN_BODY} value — both are required.`
        );
      }

      const imageUrl = imageIndex === -1 ? undefined : readCell(row, imageIndex);
      entries.set(key, imageUrl === undefined ? { title, body } : { title, body, imageUrl });
    }
    return entries;
  }

  private requireColumn(labels: string[], label: string): number {
    const index = labels.indexOf(label);
    if (index === -1) {
      const found = labels.filter((candidate) => candidate.length > 0).join(', ') || '(no header labels)';
      throw new ContentResolutionError(
        `Sheet at ${this.contentUrl} has no "${label}" column. Header labels found: ${found}. The first ` +
          `sheet row must contain ${COLUMN_CONTENT_KEY}, ${COLUMN_TITLE}, ${COLUMN_BODY} (and optionally ` +
          `${COLUMN_IMAGE_URL}).`
      );
    }
    return index;
  }
}

// Minimal slice of the gviz response actually consumed here.
interface GvizTable {
  cols: Array<{ label?: string }>;
  rows: Array<GvizRow>;
}

interface GvizRow {
  c: Array<{ v?: unknown } | null>;
}

function readCell(row: GvizRow, index: number): string | undefined {
  const value = row.c[index]?.v;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
