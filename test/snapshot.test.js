import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openStore } from '../src/db/store.js';
import { analyze, normalizeIssue, repositoryRow } from '../src/services.js';
import { exportSnapshot, loadSnapshot } from '../src/snapshot.js';
import { ISSUES, REPOS } from './fixtures.js';

test('snapshot round-trips clusters and never carries term vectors', () => {
  const a = openStore(':memory:');
  for (const [name, repo] of Object.entries(REPOS)) {
    a.upsertRepository(repositoryRow(repo, '2026-11-01T00:00:00Z'));
    a.upsertIssues(repo.id, ISSUES[name].filter((i) => !i.pull_request).map(normalizeIssue));
  }
  analyze(a, { now: '2026-11-01T00:00:00Z' });
  const snap = exportSnapshot(a);
  const text = JSON.stringify(snap);
  assert.equal(text.includes('"terms":{'), false, 'no per-issue term vectors');
  assert.equal(text.includes('should-never-be-stored'), false);

  const b = openStore(':memory:');
  loadSnapshot(b, snap);
  assert.deepEqual(exportSnapshot(b), snap);
  assert.equal(b.listClusters({}, 'score', 10, null).total, 3);
});
