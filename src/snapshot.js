// A snapshot is the published, read-only form of the database: repositories, issue metadata,
// the latest analysis and its clusters. It deliberately omits each issue's term vector, so the
// public artifact holds nothing derived from issue bodies.

export function exportSnapshot(store) {
  const db = store.db;
  const analysis = store.latestAnalysis();
  const plain = (rows) => rows.map((r) => ({ ...r }));
  return {
    format: 'developer-opportunity-radar/snapshot@1',
    generated_at: analysis?.created_at ?? new Date().toISOString(),
    source: 'GitHub REST API (public issues; titles truncated to 15 words; bodies and usernames not stored)',
    analysis,
    repositories: plain(db.prepare('SELECT id, full_name, description, stars, html_url, tracked_at, last_synced_at FROM repositories ORDER BY full_name').all()),
    issues: plain(
      db
        .prepare(
          `SELECT i.id, r.full_name AS repository, i.number, i.title, i.state, i.labels, i.comments, i.reactions,
                  i.created_at, i.updated_at, i.closed_at, i.html_url
           FROM issues i JOIN repositories r ON r.id = i.repository_id ORDER BY i.id`,
        )
        .all(),
    ).map((i) => ({ ...i, labels: JSON.parse(i.labels) })),
    clusters: plain(db.prepare('SELECT * FROM clusters ORDER BY score DESC, id').all()).map((c) => ({
      ...c,
      terms: JSON.parse(c.terms),
      score_components: JSON.parse(c.score_components),
      members: plain(db.prepare('SELECT issue_id, similarity FROM cluster_members WHERE cluster_id = ? ORDER BY similarity DESC, issue_id').all(c.id)),
    })),
  };
}

export function loadSnapshot(store, snap) {
  if (snap.format !== 'developer-opportunity-radar/snapshot@1') throw new Error(`Unknown snapshot format: ${snap.format}`);
  const repoIds = new Map();
  for (const r of snap.repositories) {
    store.upsertRepository({ id: r.id, full_name: r.full_name, description: r.description, stars: r.stars, html_url: r.html_url, tracked_at: r.tracked_at });
    store.markSynced(r.id, { at: r.last_synced_at });
    repoIds.set(r.full_name, r.id);
  }
  const byRepo = new Map();
  for (const i of snap.issues) {
    const { repository, ...rest } = i;
    byRepo.set(repository, [...(byRepo.get(repository) ?? []), { ...rest, terms: {} }]);
  }
  for (const [repo, issues] of byRepo) store.upsertIssues(repoIds.get(repo), issues);
  if (snap.analysis) {
    // replaceClusters re-attaches each cluster to snap.analysis.id
    store.replaceClusters(snap.analysis, snap.clusters.map(({ analysis_id: _ignored, ...c }) => c));
  }
}
