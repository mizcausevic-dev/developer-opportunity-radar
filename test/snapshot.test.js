import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openStore } from '../src/db/store.js';
import { analyze, normalizeIssue, repositoryRow } from '../src/services.js';
import { exportSnapshot, loadSnapshot } from '../src/snapshot.js';
import { ISSUES, REPOS } from './fixtures.js';

test('purging a noise issue that is a cluster medoid does not break the next analysis (regression)', () => {
  const st = openStore(':memory:');
  for (const [name, repo] of Object.entries(REPOS)) {
    st.upsertRepository(repositoryRow(repo, '2026-11-01T00:00:00Z'));
    st.upsertIssues(repo.id, ISSUES[name].filter((i) => !i.pull_request).map(normalizeIssue));
  }
  analyze(st, { now: '2026-11-01T00:00:00Z' });
  // Retitle one cluster's medoid to a placeholder, as if the rule had been widened later.
  const medoid = st.db.prepare('SELECT medoid_issue_id AS id FROM clusters LIMIT 1').get().id;
  st.db.prepare("UPDATE issues SET title = '[SPAM]' WHERE id = ?").run(medoid);
  assert.doesNotThrow(() => analyze(st, { now: '2026-11-01T00:00:00Z' }));
  assert.equal(st.db.prepare('SELECT COUNT(*) AS n FROM issues WHERE id = ?').get(medoid).n, 0);
  assert.equal(st.db.prepare('SELECT COUNT(*) AS n FROM clusters WHERE medoid_issue_id = ?').get(medoid).n, 0);
});

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
