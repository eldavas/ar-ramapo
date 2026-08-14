/**
 * Minimal test for GoogleSheetContentProvider's empty-cell tolerance vs.
 * real-error contract (AR_SYSTEM.md §E content pipeline). No test framework
 * in this repo — uses Node's built-in test runner/assert only, same "plain
 * script, no dependency" pattern as tools/*.mjs. Run via `npm test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GoogleSheetContentProvider, ContentResolutionError } from './ContentProvider.js';

const CONTENT_URL = 'https://docs.google.com/fake-sheet/gviz/tq?tqx=out:json';

// Mirrors the real gviz wrapper shape (verified against a live sheet
// response): empty cells are `null`, not `{v:""}`.
function gvizResponse(rows: Array<Record<string, string | null>>): string {
  const cols = [
    { id: 'A', label: 'contentKey', type: 'string' },
    { id: 'B', label: 'title', type: 'string' },
    { id: 'C', label: 'subtitle', type: 'string' },
    { id: 'D', label: 'body', type: 'string' },
    { id: 'E', label: 'imageUrl', type: 'string' },
  ];
  const table = {
    cols,
    rows: rows.map((row) => ({
      c: cols.map((col) => {
        const value = row[col.label];
        return value === null || value === undefined ? null : { v: value };
      }),
    })),
  };
  return `)]}'\ngoogle.visualization.Query.setResponse(${JSON.stringify({ status: 'ok', table })});`;
}

function stubFetch(body: string, ok = true, status = 200): void {
  globalThis.fetch = (async () =>
    ({
      ok,
      status,
      text: async () => body,
    }) as Response) as typeof fetch;
}

function stubFetchRejects(error: Error): void {
  globalThis.fetch = (async () => {
    throw error;
  }) as typeof fetch;
}

test('complete row (title + body + imageUrl) resolves valid content', async () => {
  stubFetch(
    gvizResponse([
      { contentKey: 'k1', title: 'Title 1', subtitle: null, body: 'Body 1', imageUrl: 'https://x/1.jpg' },
    ])
  );
  const provider = new GoogleSheetContentProvider(CONTENT_URL);
  const content = await provider.getContent('k1');
  assert.deepEqual(content, { title: 'Title 1', body: 'Body 1', imageUrl: 'https://x/1.jpg' });
});

test('blank title cell resolves without throwing, title absent from the result', async () => {
  stubFetch(gvizResponse([{ contentKey: 'k1', title: null, subtitle: null, body: 'Body 1', imageUrl: null }]));
  const provider = new GoogleSheetContentProvider(CONTENT_URL);
  const content = await provider.getContent('k1');
  assert.equal(content.title, undefined);
  assert.equal(content.body, 'Body 1');
});

test('blank body cell resolves without throwing, body absent from the result', async () => {
  stubFetch(gvizResponse([{ contentKey: 'k1', title: 'Title 1', subtitle: null, body: null, imageUrl: null }]));
  const provider = new GoogleSheetContentProvider(CONTENT_URL);
  const content = await provider.getContent('k1');
  assert.equal(content.title, 'Title 1');
  assert.equal(content.body, undefined);
});

test('blank imageUrl cell resolves without throwing, imageUrl absent from the result', async () => {
  stubFetch(gvizResponse([{ contentKey: 'k1', title: 'Title 1', subtitle: null, body: 'Body 1', imageUrl: null }]));
  const provider = new GoogleSheetContentProvider(CONTENT_URL);
  const content = await provider.getContent('k1');
  assert.equal(content.imageUrl, undefined);
});

test('every editorial field blank resolves without throwing (contentKey-only row)', async () => {
  stubFetch(gvizResponse([{ contentKey: 'k1', title: null, subtitle: null, body: null, imageUrl: null }]));
  const provider = new GoogleSheetContentProvider(CONTENT_URL);
  const content = await provider.getContent('k1');
  assert.deepEqual(content, {});
});

test('unknown contentKey still throws ContentResolutionError (typo protection)', async () => {
  stubFetch(gvizResponse([{ contentKey: 'k1', title: 'Title 1', subtitle: null, body: 'Body 1', imageUrl: null }]));
  const provider = new GoogleSheetContentProvider(CONTENT_URL);
  await assert.rejects(() => provider.getContent('does-not-exist'), ContentResolutionError);
});

test('network failure still throws ContentResolutionError, not an empty state', async () => {
  stubFetchRejects(new Error('simulated network failure'));
  const provider = new GoogleSheetContentProvider(CONTENT_URL);
  await assert.rejects(() => provider.getContent('k1'), ContentResolutionError);
});

test('HTTP error response still throws ContentResolutionError', async () => {
  stubFetch('', false, 403);
  const provider = new GoogleSheetContentProvider(CONTENT_URL);
  await assert.rejects(() => provider.getContent('k1'), ContentResolutionError);
});

test('a structurally missing required column (title) still throws — not the same as a blank cell', async () => {
  const body = `)]}'\ngoogle.visualization.Query.setResponse(${JSON.stringify({
    status: 'ok',
    table: {
      cols: [
        { id: 'A', label: 'contentKey' },
        { id: 'B', label: 'body' },
      ],
      rows: [{ c: [{ v: 'k1' }, { v: 'Body 1' }] }],
    },
  })});`;
  stubFetch(body);
  const provider = new GoogleSheetContentProvider(CONTENT_URL);
  await assert.rejects(() => provider.getContent('k1'), ContentResolutionError);
});
