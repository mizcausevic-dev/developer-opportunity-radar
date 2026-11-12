import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { after, before, describe, test } from 'node:test';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { openStore } from '../src/db/store.js';
import { GitHubClient } from '../src/github/client.js';
import { acceptsAny, parseAccept } from '../src/http/negotiate.js';
import { analyze, repositoryRow, syncRepository } from '../src/services.js';
import { fakeGitHub, REPOS } from './fixtures.js';
import { makeValidator } from './schema.js';

const spec = JSON.parse(readFileSync(new URL('../openapi/openapi.json', import.meta.url), 'utf8'));
const { validate, responseSchema } = makeValidator(spec);

describe('responses match the OpenAPI schemas field for field', () => {
  let base, close, ids;
  before(async () => {
    const store = openStore(':memory:');
    const gh = fakeGitHub({ pageSize: 2 });
    const github = new GitHubClient({ baseUrl: 'https://api.github.test', fetchImpl: gh.fetchImpl, sleep: async () => {} });
    for (const [name, repo] of Object.entries(REPOS)) {
      store.upsertRepository(repositoryRow(repo, '2026-11-01T00:00:00Z'));
      await syncRepository(store, github, name, { maxPages: 5 });
    }
    analyze(store, { now: '2026-11-01T00:00:00Z' });
    const app = createApp({ config: loadConfig({ RADAR_DB_PATH: ':memory:' }), store, github, log: () => {} });
    const server = createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
    close = () => new Promise((r) => server.close(r));
    const clusters = await (await fetch(base + '/v1/clusters')).json();
    const issues = await (await fetch(base + '/v1/issues?limit=1')).json();
    ids = { cluster: clusters.data[0].id, issue: issues.data[0].id };
  });
  after(() => close());

  const cases = () => [
    ['/', '/'],
    ['/v1/stats', '/v1/stats'],
    ['/v1/repositories', '/v1/repositories'],
    ['/v1/repositories/acme/alpha', '/v1/repositories/{owner}/{name}'],
    ['/v1/issues?limit=3', '/v1/issues'],
    [`/v1/issues/${ids.issue}`, '/v1/issues/{id}'],
    ['/v1/clusters?limit=2', '/v1/clusters'],
    [`/v1/clusters/${ids.cluster}`, '/v1/clusters/{id}'],
    [`/v1/clusters/${ids.cluster}/issues`, '/v1/clusters/{id}/issues'],
    ['/v1/clusters?limit=500', '/v1/clusters'], // 422 problem
    ['/v1/clusters/cl_nope', '/v1/clusters/{id}'], // 404 problem
  ];

  test('every sampled response validates against its documented schema', async () => {
    for (const [url, template] of cases()) {
      const res = await fetch(base + url);
      const body = await res.json();
      const schema = responseSchema('GET', template, res.status, res.headers.get('content-type'));
      const errors = validate(schema, body);
      assert.deepEqual(errors, [], `${url} (${res.status}):\n  ${errors.join('\n  ')}`);
    }
  });

  test('the validator fails on drift (an undocumented field, a wrong type)', async () => {
    const body = await (await fetch(`${base}/v1/clusters/${ids.cluster}`)).json();
    const schema = responseSchema('GET', '/v1/clusters/{id}', 200, 'application/json');
    assert.match(validate(schema, { ...body, surprise: 1 }).join(), /undocumented field "surprise"/);
    assert.match(validate(schema, { ...body, score: '72' }).join(), /score: expected number/);
  });

  test('stats report per-repository sample coverage', async () => {
    const s = await (await fetch(base + '/v1/stats')).json();
    for (const r of s.repositories_detail) {
      assert.equal(typeof r.sample.covers_days, 'number');
      assert.equal(r.sample.momentum_window_complete, r.sample.covers_days >= 180);
    }
  });

  test('clusters carry the opened-in-window count', async () => {
    const c = await (await fetch(`${base}/v1/clusters/${ids.cluster}`)).json();
    assert.equal(c.recent.window_days, 180);
    assert.ok(c.recent.opened >= 0 && c.recent.opened <= c.size);
  });

  test('Allow is exposed to browsers', async () => {
    const res = await fetch(base + '/v1/stats');
    assert.match(res.headers.get('access-control-expose-headers'), /\bAllow\b/);
  });
});

describe('Accept negotiation with q-values', () => {
  const offered = ['application/json', 'application/problem+json'];
  test('wildcards and explicit JSON are accepted', () => {
    for (const h of [undefined, '', '*/*', 'application/*', 'application/json', 'text/html, application/json;q=0.5', 'garbage, */*']) {
      assert.equal(acceptsAny(h, offered), true, String(h));
    }
  });
  test('the most specific range wins, so q=0 refuses JSON even next to */*', () => {
    assert.equal(acceptsAny('application/json;q=0, application/problem+json;q=0, */*', offered), false);
    assert.equal(acceptsAny('text/html', offered), false);
    assert.equal(acceptsAny('application/*;q=0, */*', offered), false);
  });
  test('q values are clamped and parsed per range', () => {
    assert.deepEqual(parseAccept('text/html;q=0.3, application/json;q=9'), [
      { type: 'text', subtype: 'html', q: 0.3 },
      { type: 'application', subtype: 'json', q: 1 },
    ]);
  });
});
