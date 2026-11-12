import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GitHubClient, GitHubError, nextLink } from '../src/github/client.js';
import { fakeGitHub } from './fixtures.js';

const BASE = 'https://api.github.test';
const noSleep = async () => {};

test('nextLink parses RFC 8288 headers', () => {
  assert.equal(nextLink('<https://a/b?page=2>; rel="next", <https://a/b?page=5>; rel="last"'), 'https://a/b?page=2');
  assert.equal(nextLink('<https://a/b?page=1>; rel="prev"'), null);
  assert.equal(nextLink(null), null);
});

test('listIssues follows Link pagination and filters out pull requests', async () => {
  const gh = fakeGitHub({ pageSize: 2 });
  const client = new GitHubClient({ token: 't0k', baseUrl: BASE, fetchImpl: gh.fetchImpl, sleep: noSleep });
  const res = await client.listIssues('acme/alpha');
  assert.equal(res.pages, 3);
  assert.equal(res.issues.length, 4); // 5 items, 1 is a PR
  assert.ok(res.issues.every((i) => !i.pull_request));
  assert.equal(gh.calls[0].headers.Authorization, 'Bearer t0k');
  assert.equal(gh.calls[0].headers['X-GitHub-Api-Version'], '2022-11-28');
  assert.equal(gh.calls[0].url.searchParams.get('state'), 'all');
  assert.ok(client.rateLimit.remaining > 0);
});

test('listIssues stops at maxPages', async () => {
  const gh = fakeGitHub({ pageSize: 1 });
  const client = new GitHubClient({ baseUrl: BASE, fetchImpl: gh.fetchImpl, sleep: noSleep });
  const res = await client.listIssues('acme/alpha', { maxPages: 2 });
  assert.equal(res.pages, 2);
  assert.equal(gh.calls.length, 2);
});

test('a matching ETag yields notModified without parsing a body', async () => {
  const gh = fakeGitHub({ pageSize: 10 });
  const client = new GitHubClient({ baseUrl: BASE, fetchImpl: gh.fetchImpl, sleep: noSleep });
  const first = await client.listIssues('acme/beta', { since: '2026-01-01T00:00:00Z' });
  const again = await client.listIssues('acme/beta', { since: '2026-01-01T00:00:00Z', etag: first.etag });
  assert.equal(again.notModified, true);
  assert.equal(gh.calls.at(-1).headers['If-None-Match'], first.etag);
});

test('5xx responses are retried with backoff', async () => {
  const gh = fakeGitHub({ failFirst: 2 });
  const waits = [];
  const client = new GitHubClient({ baseUrl: BASE, fetchImpl: gh.fetchImpl, sleep: async (ms) => waits.push(ms) });
  const repo = await client.getRepository('acme/alpha');
  assert.equal(repo.full_name, 'acme/alpha');
  assert.equal(waits.length, 2);
  assert.ok(waits[1] > waits[0]);
});

test('secondary rate limits honour Retry-After', async () => {
  let n = 0;
  const waits = [];
  const fetchImpl = async () =>
    n++ === 0
      ? new Response('{"message":"You have exceeded a secondary rate limit"}', { status: 403, headers: { 'retry-after': '7' } })
      : Response.json({ full_name: 'a/b' });
  const client = new GitHubClient({ baseUrl: BASE, fetchImpl, sleep: async (ms) => waits.push(ms) });
  await client.getRepository('a/b');
  assert.deepEqual(waits, [7000]);
});

test('an exhausted primary limit with a distant reset fails fast instead of hanging', async () => {
  const reset = String(Math.floor(Date.now() / 1000) + 3600);
  const fetchImpl = async () => new Response('{"message":"API rate limit exceeded"}', { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset } });
  const client = new GitHubClient({ baseUrl: BASE, fetchImpl, sleep: noSleep });
  await assert.rejects(client.getRepository('a/b'), (e) => e instanceof GitHubError && e.status === 403 && /rate limit/.test(e.message));
});

test('404 is not retried and surfaces as GitHubError', async () => {
  const gh = fakeGitHub();
  const client = new GitHubClient({ baseUrl: BASE, fetchImpl: gh.fetchImpl, sleep: noSleep });
  await assert.rejects(client.getRepository('nobody/nothing'), (e) => e.status === 404);
  assert.equal(gh.calls.length, 1);
});

test('pagination links pointing at another host are refused (token never leaves the API host)', async () => {
  const fetchImpl = async () => Response.json([], { headers: { link: '<https://evil.example/steal?page=2>; rel="next"' } });
  const client = new GitHubClient({ token: 'secret', baseUrl: BASE, fetchImpl, sleep: noSleep });
  await assert.rejects(client.listIssues('a/b'), /outside/);
});
