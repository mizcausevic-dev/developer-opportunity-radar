// Live contract smoke test against a deployed (read-only) instance.
//   node scripts/smoke.js https://developer-opportunity-radar.vercel.app
// Exits non-zero on the first broken expectation. Runs in CI on a schedule and on demand.
const base = (process.argv[2] || process.env.RADAR_SMOKE_BASE || '').replace(/\/$/, '');
if (!/^https?:\/\//.test(base)) {
  console.error('usage: node scripts/smoke.js <base-url>');
  process.exit(2);
}
const ORIGIN = 'https://mizcausevic-dev.github.io';
let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures += 1;
};
const get = (path, headers = {}) => fetch(base + path, { headers: { Origin: ORIGIN, ...headers }, redirect: 'manual' });

const root = await get('/');
const rootBody = await root.json();
check('GET / is 200 and read-only', root.status === 200 && rootBody.read_only === true, `status ${root.status}`);

const list = await get('/v1/clusters?min_repos=3&limit=2');
const listBody = await list.json();
const etag = list.headers.get('etag');
check('clusters list 200 with data', list.status === 200 && listBody.data.length === 2);
check('clusters list has ETag', Boolean(etag), etag ?? 'missing');
check('clusters list has Link rel="next"', /rel="next"/.test(list.headers.get('link') ?? ''));
check('CORS allow-origin on 200', list.headers.get('access-control-allow-origin') === '*');
check('RateLimit headers present', list.headers.has('ratelimit-limit') && list.headers.has('ratelimit-remaining'));
check('every finding links to a GitHub issue', listBody.data.every((c) => /^https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/\d+$/.test(c.representative_issue?.source_url ?? '')));

const cond = await get('/v1/clusters?min_repos=3&limit=2', { 'If-None-Match': etag });
check('If-None-Match returns 304', cond.status === 304, `status ${cond.status}`);
check('CORS allow-origin on 304 (browser conditional requests)', cond.headers.get('access-control-allow-origin') === '*', cond.headers.get('access-control-allow-origin') ?? 'missing');

const pre = await fetch(base + '/v1/stats', { method: 'OPTIONS', headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'if-none-match' } });
check('CORS preflight allows If-None-Match', pre.status === 204 && /if-none-match/i.test(pre.headers.get('access-control-allow-headers') ?? ''));

const next = /<([^>]+)>; rel="next"/.exec(list.headers.get('link') ?? '')?.[1];
if (next) {
  const page2 = await (await get(next)).json();
  check('next page continues without overlap', page2.data.length > 0 && !page2.data.some((c) => listBody.data.some((d) => d.id === c.id)));
}

const id = listBody.data[0].id;
const detail = await (await get(`/v1/clusters/${id}?evidence=3`)).json();
check('cluster detail embeds evidence with source URLs', detail.evidence?.length === 3 && detail.evidence.every((e) => e.source_url.startsWith('https://github.com/')));

const bad = await get('/v1/clusters?limit=500');
check('validation error is RFC 9457 problem+json 422', bad.status === 422 && (bad.headers.get('content-type') ?? '').startsWith('application/problem+json'));

const write = await fetch(base + '/v1/analyses', { method: 'POST', headers: { Origin: ORIGIN } });
check('writes are refused (403 read-only)', write.status === 403);

for (const p of ['/src/app.js', '/package.json', '/data/snapshot.json', '/api/index.js', '/vercel.json']) {
  const r = await get(p);
  check(`source path not served: ${p}`, r.status === 404 && (r.headers.get('content-type') ?? '').startsWith('application/problem+json'), `status ${r.status}`);
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
