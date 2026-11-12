// Accept header negotiation (RFC 9110 §12.5.1) for the media types this API produces.
// Each offered type gets the q-value of the MOST SPECIFIC matching media range, so
// `application/json;q=0, */*` refuses JSON while `*/*` alone accepts it.

/** @returns {{type: string, subtype: string, q: number}[]} */
export function parseAccept(header) {
  if (header == null || String(header).trim() === '') return [{ type: '*', subtype: '*', q: 1 }];
  const out = [];
  for (const part of String(header).split(',')) {
    const [range, ...params] = part.trim().split(';');
    const m = /^([\w.+*-]+)\/([\w.+*-]+)$/.exec(range.trim().toLowerCase());
    if (!m) continue; // ignore malformed ranges rather than failing the request
    let q = 1;
    for (const p of params) {
      const [k, v] = p.split('=').map((s) => s.trim().toLowerCase());
      if (k === 'q') {
        const n = Number(v);
        q = Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 1;
      }
    }
    out.push({ type: m[1], subtype: m[2], q });
  }
  return out.length ? out : [{ type: '*', subtype: '*', q: 1 }];
}

function qualityFor(ranges, mediaType) {
  const [type, subtype] = mediaType.split('/');
  let best = null;
  for (const r of ranges) {
    const spec = r.type === type && r.subtype === subtype ? 3 : r.type === type && r.subtype === '*' ? 2 : r.type === '*' && r.subtype === '*' ? 1 : 0;
    if (spec && (!best || spec > best.spec)) best = { spec, q: r.q };
  }
  return best ? best.q : 0;
}

/** True if the client accepts at least one of the offered media types with q > 0. */
export function acceptsAny(header, offered) {
  const ranges = parseAccept(header);
  return offered.some((t) => qualityFor(ranges, t) > 0);
}
