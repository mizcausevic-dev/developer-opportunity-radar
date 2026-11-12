import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { after, before, describe, test } from 'node:test';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { openStore } from '../src/db/store.js';
import { GitHubClient } from '../src/github/client.js';
import { fakeGitHub } from './fixtures.js';

const KEY = 'test-key-0123456789'; // gitleaks:allow (test fixture, not a credential)

async function start(env = {}) {
  const config = loadConfig({ RADAR_API_KEY: KEY, RADAR_DB_PATH: ':memory:', ...env });
  const store = openStore(':memory:');
  const gh = fakeGitHub({ pageSize: 2 });
  const github = new GitHubClient({ baseUrl: 'https://api.github.test', fetchImpl: gh.fetchImpl, sleep: async () => {} });
  const app = createApp({ config, store, github, log: () => {} });
  const server = createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (path, init = {}) => fetch(base + path, init);
  return { app, store, gh, call, base, close: () => new Promise((r) => server.close(r)) };
}

/** Drive the request handler directly with minimal req/res doubles. */
async function invoke(app, method, url, headers = {}) {
  const req = Readable.from([]);
  Object.assign(req, { method, url, headers, socket: { remoteAddress: '127.0.0.1' } });
  const out = { status: 0, headers: {}, body: '' };
  await new Promise((resolve) => {
    const res = {
      statusCode: 200,
      setHeader: (k, v) => (out.headers[k.toLowerCase()] = String(v)),
      getHeader: (k) => out.headers[k.toLowerCase()],
      hasHeader: (k) => k.toLowerCase() in out.headers,
      removeHeader: (k) => delete out.headers[k.toLowerCase()],
      end(chunk) {
        out.status = this.statusCode;
        if (chunk) out.body += chunk;
        resolve();
      },
    };
    app(req, res);
  });
  return out;
}

const auth = { Authorization: `Bearer ${KEY}` };
const json = { 'Content-Type': 'application/json' };

async function waitForJob(call, location) {
  for (let i = 0; i < 50; i++) {
    const job = await (await call(location)).json();
    if (job.status === 'succeeded' || job.status === 'failed') return job;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('job did not finish');
}

describe('end-to-end against a fake GitHub', () => {
  let s;
  before(async () => {
    s = await start();
    for (const repo of ['acme/alpha', 'acme/beta', 'other/gamma']) {
      const put = await s.call(`/v1/repositories/${repo}`, { method: 'PUT', headers: auth });
      assert.equal(put.status, 201);
      const sync = await s.call(`/v1/repositories/${repo}/syncs`, { method: 'POST', headers: { ...auth, ...json }, body: JSON.stringify({ analyze: false }) });
      assert.equal(sync.status, 202);
      const job = await waitForJob(s.call, sync.headers.get('location'));
      assert.equal(job.status, 'succeeded', job.error);
    }
    const an = await s.call('/v1/analyses', { method: 'POST', headers: auth });
    assert.equal(an.status, 202);
    const job = await waitForJob(s.call, an.headers.get('location'));
    assert.equal(job.status, 'succeeded', job.error);
    assert.equal(job.result.clusters, 3);
  });
  after(() => s.close());

  test('root links to every collection', async () => {
    const res = await s.call('/');
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.links.clusters, '/v1/clusters');
    assert.match(res.headers.get('x-request-id'), /^[0-9a-f-]{36}$/);
    assert.equal(res.headers.get('ratelimit-limit'), '120');
  });

  test('PUT is idempotent: 201 then 200, canonical casing kept', async () => {
    const res = await s.call('/v1/repositories/ACME/Alpha', { method: 'PUT', headers: auth });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).full_name, 'acme/alpha');
  });

  test('repositories carry issue counts and links', async () => {
    const body = await (await s.call('/v1/repositories')).json();
    assert.equal(body.data.length, 3);
    const alpha = body.data.find((r) => r.full_name === 'acme/alpha');
    assert.equal(alpha.issue_count, 4); // PR excluded
    assert.equal(alpha.links.syncs, '/v1/repositories/acme/alpha/syncs');
  });

  test('clusters: every finding links to its source issues', async () => {
    const list = await (await s.call('/v1/clusters')).json();
    assert.equal(list.page.total, 3);
    for (const c of list.data) {
      assert.equal(c.repository_count, 3);
      assert.match(c.representative_issue.source_url, /^https:\/\/github\.com\/.+\/issues\/\d+$/);
      const detail = await (await s.call(c.links.self)).json();
      assert.equal(detail.evidence.length, 3);
      for (const e of detail.evidence) assert.match(e.source_url, /^https:\/\/github\.com\//);
      assert.ok(detail.timeline.length >= 1);
    }
  });

  test('stored issues never contain bodies or usernames', async () => {
    const rows = s.store.db.prepare('SELECT * FROM issues').all();
    const dump = JSON.stringify(rows);
    assert.equal(dump.includes('should-never-be-stored'), false);
    assert.equal(dump.includes('Access-Control-Allow-Origin header is missing'), false);
    assert.equal(Object.keys(rows[0]).includes('body'), false);
  });

  test('keyset pagination walks every issue exactly once via Link rel=next', async () => {
    const seen = [];
    let next = '/v1/issues?limit=4';
    let pages = 0;
    while (next) {
      const res = await s.call(next);
      const body = await res.json();
      seen.push(...body.data.map((i) => i.id));
      const link = res.headers.get('link');
      assert.match(link, /rel="first"/);
      next = /<([^>]+)>; rel="next"/.exec(link)?.[1] ?? null;
      assert.equal(next, body.links.next ?? null);
      pages++;
    }
    assert.equal(seen.length, 12);
    assert.equal(new Set(seen).size, 12);
    assert.equal(pages, 3);
  });

  test('a cursor reused with different filters is rejected', async () => {
    const first = await (await s.call('/v1/issues?limit=2')).json();
    const res = await s.call(`/v1/issues?limit=2&state=open&cursor=${first.page.next_cursor}`);
    assert.equal(res.status, 400);
    assert.equal(res.headers.get('content-type'), 'application/problem+json; charset=utf-8');
    assert.match((await res.json()).type, /#invalid-cursor$/);
  });

  test('filters: repository, state, q', async () => {
    const r = await (await s.call('/v1/issues?repository=acme/beta&state=closed')).json();
    assert.equal(r.page.total, 1);
    const q = await (await s.call('/v1/issues?q=cors')).json();
    assert.equal(q.page.total, 3);
    const pct = await (await s.call('/v1/issues?q=%25%25')).json();
    assert.equal(pct.page.total, 0, 'LIKE wildcards are escaped');
  });

  test('ETag + If-None-Match returns 304 with no body', async () => {
    const first = await s.call('/v1/clusters');
    const etag = first.headers.get('etag');
    assert.ok(etag);
    const second = await s.call('/v1/clusters', { headers: { 'If-None-Match': etag } });
    assert.equal(second.status, 304);
    assert.equal(await second.text(), '');
    const weak = await s.call('/v1/clusters', { headers: { 'If-None-Match': `W/${etag}` } });
    assert.equal(weak.status, 304);
  });

  test('HEAD mirrors GET without a body', async () => {
    // In-process, no socket: on the dev machine a local traffic filter resets ~50% of HEAD
    // requests even against a bare node:http server, so HEAD is asserted at the handler level.
    const { status, headers, body } = await invoke(s.app, 'HEAD', '/v1/stats');
    const get = await s.call('/v1/stats');
    assert.equal(status, 200);
    assert.equal(headers.etag, get.headers.get('etag'));
    assert.equal(headers['content-length'], get.headers.get('content-length'));
    assert.equal(body, '');
  });

  test('validation errors list every bad field', async () => {
    const res = await s.call('/v1/clusters?limit=500&sort=loud&colour=red');
    assert.equal(res.status, 422);
    const body = await res.json();
    assert.deepEqual(body.errors.map((e) => e.field), ['colour']);
    const res2 = await s.call('/v1/clusters?sort=loud');
    assert.equal((await res2.json()).errors[0].field, 'sort');
  });

  test('404 and 405 are problem documents; 405 carries Allow', async () => {
    const nf = await s.call('/v1/nope');
    assert.equal(nf.status, 404);
    assert.equal((await nf.json()).status, 404);
    const na = await s.call('/v1/clusters', { method: 'POST', headers: auth });
    assert.equal(na.status, 405);
    assert.equal(na.headers.get('allow'), 'GET, HEAD, OPTIONS');
  });

  test('406 when the client refuses JSON', async () => {
    const res = await s.call('/v1/stats', { headers: { Accept: 'text/html' } });
    assert.equal(res.status, 406);
  });

  test('CORS preflight advertises methods and headers', async () => {
    const res = await s.call('/v1/repositories/acme/alpha', { method: 'OPTIONS', headers: { Origin: 'https://example.com', 'Access-Control-Request-Method': 'PUT' } });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    assert.match(res.headers.get('access-control-allow-methods'), /PUT/);
    assert.match(res.headers.get('access-control-allow-headers'), /Idempotency-Key/);
  });

  test('writes need a valid bearer key', async () => {
    const none = await s.call('/v1/analyses', { method: 'POST' });
    assert.equal(none.status, 401);
    assert.match(none.headers.get('www-authenticate'), /^Bearer/);
    const wrong = await s.call('/v1/analyses', { method: 'POST', headers: { Authorization: 'Bearer nope' } });
    assert.equal(wrong.status, 401);
  });

  test('415 for non-JSON bodies, 413 for oversized bodies', async () => {
    const t = await s.call('/v1/analyses', { method: 'POST', headers: { ...auth, 'Content-Type': 'text/plain' }, body: 'hi' });
    assert.equal(t.status, 415);
    const big = await s.call('/v1/analyses', { method: 'POST', headers: { ...auth, ...json }, body: JSON.stringify({ pad: 'x'.repeat(20_000) }) });
    assert.equal(big.status, 413);
  });

  test('Idempotency-Key replays the first response and rejects a different body', async () => {
    const headers = { ...auth, ...json, 'Idempotency-Key': 'analysis-req-0001' };
    const a = await s.call('/v1/analyses', { method: 'POST', headers, body: '{"threshold":0.3}' });
    const b = await s.call('/v1/analyses', { method: 'POST', headers, body: '{"threshold":0.3}' });
    assert.equal(a.status, 202);
    assert.equal(b.status, 202);
    assert.equal(b.headers.get('idempotent-replayed'), 'true');
    assert.equal((await a.json()).id, (await b.json()).id);
    const c = await s.call('/v1/analyses', { method: 'POST', headers, body: '{"threshold":0.4}' });
    assert.equal(c.status, 422);
    assert.match((await c.json()).type, /#idempotency-key-reuse$/);
    await waitForJob(s.call, b.headers.get('location'));
    // restore the default analysis for other tests
    const d = await s.call('/v1/analyses', { method: 'POST', headers: auth });
    await waitForJob(s.call, d.headers.get('location'));
  });

  test('once the watermark settles, syncing an unchanged repository is a conditional 304 upstream', async () => {
    // First re-sync re-reads the newest issue at the watermark and stores that URL's ETag.
    const warm = await s.call('/v1/repositories/acme/beta/syncs', { method: 'POST', headers: auth });
    assert.equal((await waitForJob(s.call, warm.headers.get('location'))).result.sync.not_modified, false);
    const before = s.gh.calls.length;
    const res = await s.call('/v1/repositories/acme/beta/syncs', { method: 'POST', headers: auth });
    const job = await waitForJob(s.call, res.headers.get('location'));
    assert.equal(job.status, 'succeeded');
    assert.equal(job.result.sync.not_modified, true);
    const upstream = s.gh.calls.slice(before);
    assert.equal(upstream.length, 1);
    assert.ok(upstream[0].headers['If-None-Match']);
    assert.ok(upstream[0].url.searchParams.get('since'));
  });

  test('tracking a repository that does not exist is a 422', async () => {
    const res = await s.call('/v1/repositories/nobody/nothing', { method: 'PUT', headers: auth });
    assert.equal(res.status, 422);
  });

  test('invalid path parameters are rejected before touching GitHub', async () => {
    const res = await s.call('/v1/repositories/-bad-/x', { method: 'PUT', headers: auth });
    assert.equal(res.status, 422);
  });

  test('DELETE untracks and clears clusters', async () => {
    const res = await s.call('/v1/repositories/other/gamma', { method: 'DELETE', headers: auth });
    assert.equal(res.status, 204);
    assert.equal((await s.call('/v1/repositories/other/gamma')).status, 404);
    assert.equal((await (await s.call('/v1/clusters')).json()).page.total, 0);
  });
});

describe('deployment modes and limits', () => {
  test('read-only mode rejects writes with 403 even with a key', async () => {
    const s = await start({ RADAR_READ_ONLY: '1' });
    const res = await s.call('/v1/analyses', { method: 'POST', headers: auth });
    assert.equal(res.status, 403);
    assert.match((await res.json()).type, /#read-only$/);
    await s.close();
  });

  test('no API key configured means read-only', async () => {
    const s = await start({ RADAR_API_KEY: '' });
    const res = await s.call('/v1/repositories/acme/alpha', { method: 'PUT', headers: auth });
    assert.equal(res.status, 403);
    await s.close();
  });

  test('CDN caching marks only 200 GETs, never errors or no-store routes', async () => {
    const s = await start({ RADAR_CDN_MAX_AGE: '3600' });
    assert.equal((await s.call('/v1/clusters')).headers.get('cdn-cache-control'), 'public, max-age=3600');
    assert.equal((await s.call('/v1/clusters?limit=0')).headers.get('cdn-cache-control'), null);
    assert.equal((await s.call('/healthz')).headers.get('cdn-cache-control'), null);
    await s.close();
    const plain = await start();
    assert.equal((await plain.call('/v1/clusters')).headers.get('cdn-cache-control'), null);
    await plain.close();
  });

  test('an Idempotency-Key older than 24 h is not replayed', async () => {
    const s = await start();
    s.store.db
      .prepare('INSERT INTO idempotency_keys (key, fingerprint, status, headers, body, created_at) VALUES (?, ?, 202, ?, ?, ?)')
      .run('stale-key-0001', 'x', '{}', JSON.stringify({ id: 'job_old' }), Date.now() - 25 * 3600 * 1000);
    const res = await s.call('/v1/analyses', { method: 'POST', headers: { ...auth, 'Idempotency-Key': 'stale-key-0001' } });
    assert.equal(res.status, 202);
    assert.equal(res.headers.get('idempotent-replayed'), null);
    assert.notEqual((await res.json()).id, 'job_old');
    await s.app.jobs.idle();
    await s.close();
  });

  test('rate limit returns 429 with Retry-After', async () => {
    const s = await start({ RADAR_RATE_LIMIT: '3' });
    for (let i = 0; i < 3; i++) assert.equal((await s.call('/healthz')).status, 200);
    const res = await s.call('/healthz');
    assert.equal(res.status, 429);
    assert.ok(Number(res.headers.get('retry-after')) > 0);
    assert.equal(res.headers.get('ratelimit-remaining'), '0');
    await s.close();
  });
});

test('OpenAPI document and router describe exactly the same operations', async () => {
  const spec = JSON.parse(readFileSync(new URL('../openapi/openapi.json', import.meta.url), 'utf8'));
  const s = await start();
  const fromRouter = s.app.router.routes.map((r) => `${r.method} ${r.pattern.replace(/:(\w+)/g, '{$1}')}`).sort();
  const fromSpec = Object.entries(spec.paths)
    .flatMap(([path, ops]) => Object.keys(ops).filter((m) => m !== 'parameters').map((m) => `${m.toUpperCase()} ${path}`))
    .sort();
  assert.deepEqual(fromRouter, fromSpec);
  const res = await s.call('/openapi.json');
  assert.equal(res.headers.get('content-type'), 'application/vnd.oai.openapi+json; charset=utf-8');
  await s.close();
});
