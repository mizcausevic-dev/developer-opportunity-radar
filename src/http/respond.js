import { createHash } from 'node:crypto';

// Strong validator over the exact bytes sent. Same body => same ETag, across instances.
export function etagFor(buf) {
  return `"${createHash('sha256').update(buf).digest('base64url').slice(0, 27)}"`;
}

// RFC 9110 §13.1.2: If-None-Match uses weak comparison and may list several tags or "*".
export function ifNoneMatchHits(header, etag) {
  if (!header) return false;
  if (header.trim() === '*') return true;
  const strip = (t) => t.trim().replace(/^W\//, '');
  const target = strip(etag);
  return header.split(',').some((t) => strip(t) === target);
}

/**
 * Send a JSON response. GET/HEAD 2xx responses get an ETag and honour If-None-Match.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 */
export function sendJson(req, res, status, body, opts = {}) {
  const { headers = {}, contentType = 'application/json; charset=utf-8', cache, cdnMaxAge = 0 } = opts;
  const buf = Buffer.from(JSON.stringify(body, null, 2) + '\n');
  for (const [k, v] of Object.entries(headers)) if (v !== undefined) res.setHeader(k, v);
  res.setHeader('Content-Type', contentType);

  const cacheable = (req.method === 'GET' || req.method === 'HEAD') && status === 200;
  if (cacheable) {
    const etag = etagFor(buf);
    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', cache ?? 'public, max-age=60, stale-while-revalidate=300');
    // Immutable deployments (the snapshot-backed demo) let the CDN absorb repeat reads, so a
    // distributed client can't fan out across function instances. Only 200s are marked, so
    // errors and 429s are never cached. Skipped when the route asked for no-store.
    if (cdnMaxAge > 0 && !String(cache ?? '').includes('no-store')) {
      res.setHeader('CDN-Cache-Control', `public, max-age=${cdnMaxAge}`);
    }
    if (ifNoneMatchHits(req.headers['if-none-match'], etag)) {
      res.removeHeader('Content-Type');
      res.statusCode = 304;
      res.end();
      return;
    }
  } else if (!res.hasHeader('Cache-Control')) {
    res.setHeader('Cache-Control', 'no-store');
  }

  res.statusCode = status;
  res.setHeader('Content-Length', buf.length); // for HEAD, the length GET would have sent
  res.end(req.method === 'HEAD' ? undefined : buf);
}

export function sendEmpty(res, status, headers = {}) {
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.setHeader('Cache-Control', 'no-store');
  res.statusCode = status;
  res.end();
}

/** RFC 8288 Link header from {rel: url}. */
export function linkHeader(links) {
  return Object.entries(links)
    .filter(([, url]) => url)
    .map(([rel, url]) => `<${url}>; rel="${rel}"`)
    .join(', ');
}
