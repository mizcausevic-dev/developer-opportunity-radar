import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clusterIssues, nnChain } from '../src/analysis/cluster.js';
import { cleanMarkdown, issueTerms, tokenize, truncateTitle } from '../src/analysis/text.js';
import { isNoise, normalizeIssue } from '../src/services.js';
import { ISSUES } from './fixtures.js';

const corpus = () =>
  Object.entries(ISSUES).flatMap(([repo, items]) =>
    items.filter((i) => !i.pull_request).map((i) => {
      const n = normalizeIssue(i);
      return { id: n.id, repository: repo, state: n.state, comments: n.comments, reactions: n.reactions, created_at: n.created_at, terms: n.terms };
    }),
  );

test('cleanMarkdown removes template comments, code fences, URLs and stack frames', () => {
  const out = cleanMarkdown('<!-- template -->\nreal words\n```js\nsecret()\n```\nsee https://x.y/z\n    at foo (/a/b.js:1:2)');
  assert.match(out, /real words/);
  assert.doesNotMatch(out, /template|secret|https|foo/);
});

test('tokenize keeps meaningful words and drops stopwords and numbers', () => {
  const t = tokenize('The CORS middleware fails with 404 in v5 using res.json');
  assert.deepEqual(Object.keys(t).sort(), ['cors', 'fails', 'json', 'middleware', 'res']);
});

test('tokenize splits long camelCase identifiers but keeps product names whole', () => {
  const t = tokenize('http2.createSecureServer breaks TypeScript and WebSocket types');
  assert.ok(t.create && t.secure && t.server);
  assert.ok(t.typescript && t.websocket && t.types);
  assert.equal(t.script, undefined);
});

test('raw HTML tags are stripped before tokenising', () => {
  const t = tokenize('<img width="200" height="80" alt="logo" src="x.png"> sponsor image broken');
  assert.equal(t.width, undefined);
  assert.equal(t.height, undefined);
  assert.ok(t.sponsor);
});

test('words that collide with Object.prototype are counted, not corrupted (regression)', () => {
  const t = issueTerms('constructor injection fails', 'the constructor and __proto__ and valueOf hasOwnProperty');
  assert.equal(t.constructor, 4);
  assert.equal(t.proto, 1);
  assert.equal(t.valueof, 1);
  assert.equal(t.property, 1); // hasOwnProperty has three humps, so it is split
  assert.ok(Object.values(t).every(Number.isFinite));
  const doc = (id, terms) => ({ id, repository: 'a/b', state: 'open', comments: 0, reactions: 0, created_at: '2026-01-01T00:00:00Z', terms });
  const corpusWithNoise = [1, 2, 3].map((id) => doc(id, { ...t })).concat([4, 5, 6, 7, 8].map((id) => doc(id, { [`noise${id}`]: 3 })));
  const { clusters } = clusterIssues(corpusWithNoise, { now: '2026-02-01T00:00:00Z' });
  assert.equal(clusters.length, 1);
  assert.deepEqual(clusters[0].members.map((m) => m.issue_id).sort(), [1, 2, 3]);
});

test('issueTerms weights the title three times', () => {
  const t = issueTerms('cors preflight', 'cors');
  assert.equal(t.cors, 4);
  assert.equal(t.preflight, 3);
});

test('truncateTitle caps titles at 15 words', () => {
  assert.equal(truncateTitle('a b c'), 'a b c');
  const long = Array.from({ length: 20 }, (_, i) => `w${i}`).join(' ');
  assert.equal(truncateTitle(long).split(' ').length, 16); // 15 words + ellipsis
});

test('isNoise drops spam/invalid labels and placeholder titles only', () => {
  assert.equal(isNoise({ title: 'SPAM', labels: [] }), true);
  assert.equal(isNoise({ title: '[SPAM]', labels: [] }), true); // regression: bracketed placeholder slipped through
  assert.equal(isNoise({ title: '(test)', labels: [] }), true);
  assert.equal(isNoise({ title: 'Why was this marked as spam?', labels: [] }), false);
  assert.equal(isNoise({ title: 'Real problem', labels: [{ name: 'Invalid' }] }), true);
  assert.equal(isNoise({ title: 'Spam filter middleware drops valid requests', labels: [] }), false);
  assert.equal(isNoise({ title: 'Duplicate of #12', labels: [{ name: 'duplicate' }] }), false);
});

test('normalizeIssue drops the body and personal fields', () => {
  const n = normalizeIssue(ISSUES['acme/alpha'][0]);
  assert.equal('body' in n, false);
  assert.equal('user' in n, false);
  assert.equal(JSON.stringify(n).includes('should-never-be-stored'), false);
  assert.equal(n.reactions, 14);
  assert.deepEqual(n.labels, ['bug']);
});

test('recurring themes cluster across repositories; one-offs stay out', () => {
  const { clusters } = clusterIssues(corpus(), { now: '2026-11-01T00:00:00Z' });
  assert.equal(clusters.length, 3, clusters.map((c) => c.label).join(' | '));
  for (const c of clusters) {
    assert.equal(c.size, 3);
    assert.equal(c.repo_count, 3);
    assert.equal(c.score_components.spread, 1);
  }
  const labels = clusters.map((c) => c.label).join(' ');
  assert.match(labels, /cors|preflight/);
  assert.match(labels, /multipart|upload/);
  assert.match(labels, /typescript|types/);
  const all = clusters.flatMap((c) => c.members.map((m) => m.issue_id));
  assert.equal(new Set(all).size, all.length, 'an issue belongs to at most one cluster');
});

test('clustering is deterministic and independent of input order', () => {
  const a = clusterIssues(corpus(), { now: '2026-11-01T00:00:00Z' });
  const b = clusterIssues(corpus().reverse(), { now: '2026-11-01T00:00:00Z' });
  assert.deepEqual(a, b);
});

test('scores are bounded and every component is in [0, 1]', () => {
  const { clusters } = clusterIssues(corpus(), { now: '2026-11-01T00:00:00Z' });
  for (const c of clusters) {
    assert.ok(c.score >= 0 && c.score <= 100);
    for (const v of Object.values(c.score_components)) assert.ok(v >= 0 && v <= 1);
  }
  assert.deepEqual([...clusters].sort((x, y) => y.score - x.score), clusters);
});

test('nnChain produces the same merge heights as naive average linkage', () => {
  // Deterministic pseudo-random similarity matrix
  let seed = 42;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const n = 12;
  const S = new Float32Array(n * n);
  for (let i = 0; i < n; i++) {
    S[i * n + i] = 1;
    for (let j = i + 1; j < n; j++) S[i * n + j] = S[j * n + i] = rand();
  }
  const heights = nnChain(n, S.slice()).map((m) => m[2]).sort((x, y) => x - y);

  // naive O(n^3) reference: repeatedly merge the closest pair by average similarity
  let groups = Array.from({ length: n }, (_, i) => [i]);
  const ref = [];
  const avg = (A, B) => A.reduce((s, a) => s + B.reduce((t, b) => t + S[a * n + b], 0), 0) / (A.length * B.length);
  while (groups.length > 1) {
    let best = [-1, -1, -Infinity];
    for (let i = 0; i < groups.length; i++) for (let j = i + 1; j < groups.length; j++) {
      const s = avg(groups[i], groups[j]);
      if (s > best[2]) best = [i, j, s];
    }
    ref.push(1 - best[2]);
    const merged = [...groups[best[0]], ...groups[best[1]]];
    groups = groups.filter((_, k) => k !== best[0] && k !== best[1]).concat([merged]);
  }
  ref.sort((x, y) => x - y);
  assert.equal(heights.length, ref.length);
  heights.forEach((h, i) => assert.ok(Math.abs(h - ref[i]) < 1e-5, `merge ${i}: ${h} vs ${ref[i]}`));
});
