import { createHash } from 'node:crypto';
import { ProblemError } from './problem.js';

// Keyset (cursor) pagination. The cursor is opaque to clients: base64url JSON holding the
// last row's sort key, its id, and a fingerprint of the filters it was issued for.
// Reusing a cursor with different filters is rejected instead of silently returning
// a page from a different result set.

export function fingerprint(obj) {
  return createHash('sha256').update(JSON.stringify(obj)).digest('base64url').slice(0, 12);
}

export function encodeCursor({ k, id, f }) {
  return Buffer.from(JSON.stringify({ k, id, f })).toString('base64url');
}

export function decodeCursor(raw, expectedFingerprint) {
  if (raw == null || raw === '') return null;
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(String(raw), 'base64url').toString('utf8'));
  } catch {
    throw new ProblemError(400, 'invalid-cursor', 'The cursor is not valid. Use the value from a previous `next` link.');
  }
  if (!parsed || typeof parsed !== 'object' || !('id' in parsed) || !('k' in parsed)) {
    throw new ProblemError(400, 'invalid-cursor', 'The cursor is malformed.');
  }
  if (parsed.f !== expectedFingerprint) {
    throw new ProblemError(400, 'invalid-cursor', 'The cursor was issued for a different filter or sort. Restart from the first page.');
  }
  return parsed;
}

export function parseLimit(raw, { def = 25, max = 100 } = {}) {
  if (raw == null || raw === '') return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > max) {
    throw new ProblemError(422, 'validation-failed', 'One or more fields are invalid.', {
      errors: [{ field: 'limit', message: `must be an integer between 1 and ${max}` }],
    });
  }
  return n;
}

/**
 * Build the page envelope plus RFC 8288 links.
 * @param {URL} url the request URL (used to construct sibling links)
 */
export function pageLinks(url, nextCursor) {
  const first = new URL(url);
  first.searchParams.delete('cursor');
  let next = null;
  if (nextCursor) {
    const n = new URL(url);
    n.searchParams.set('cursor', nextCursor);
    next = n;
  }
  return { first: rel(first), next: next && rel(next) };
}

function rel(u) {
  return `${u.pathname}${u.search}`;
}
