import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS repositories (
  id              INTEGER PRIMARY KEY,           -- GitHub repository id
  full_name       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  description     TEXT,
  stars           INTEGER NOT NULL DEFAULT 0,
  html_url        TEXT NOT NULL,
  tracked_at      TEXT NOT NULL,
  last_synced_at  TEXT,
  issues_since    TEXT,                           -- watermark: max updated_at seen, sent as ?since=
  issues_etag     TEXT                            -- ETag for the request URL built from that watermark
);

CREATE TABLE IF NOT EXISTS issues (
  id             INTEGER PRIMARY KEY,            -- GitHub issue id
  repository_id  INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  number         INTEGER NOT NULL,
  title          TEXT NOT NULL,                  -- truncated to <= 15 words at ingest
  state          TEXT NOT NULL CHECK (state IN ('open','closed')),
  labels         TEXT NOT NULL DEFAULT '[]',     -- JSON array of label names
  comments       INTEGER NOT NULL DEFAULT 0,
  reactions      INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  closed_at      TEXT,
  html_url       TEXT NOT NULL,
  terms          TEXT NOT NULL DEFAULT '{}',     -- JSON {stem: weightedCount}; derived, never the body
  UNIQUE (repository_id, number)
);
CREATE INDEX IF NOT EXISTS issues_repo_created ON issues (repository_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS issues_created ON issues (created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS analyses (
  id             TEXT PRIMARY KEY,
  created_at     TEXT NOT NULL,
  params         TEXT NOT NULL,
  issue_count    INTEGER NOT NULL,
  cluster_count  INTEGER NOT NULL,
  duration_ms    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS clusters (
  id                TEXT PRIMARY KEY,
  analysis_id       TEXT NOT NULL REFERENCES analyses(id) ON DELETE CASCADE,
  label             TEXT NOT NULL,
  terms             TEXT NOT NULL,                -- JSON array of top terms
  size              INTEGER NOT NULL,
  repo_count        INTEGER NOT NULL,
  open_count        INTEGER NOT NULL,
  engagement        INTEGER NOT NULL,             -- comments + reactions across members
  score             REAL NOT NULL,
  score_components  TEXT NOT NULL,                -- JSON breakdown so every score is explainable
  cohesion          REAL NOT NULL,
  medoid_issue_id   INTEGER NOT NULL REFERENCES issues(id),
  first_seen        TEXT NOT NULL,
  last_seen         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS clusters_score ON clusters (score DESC, id DESC);
CREATE INDEX IF NOT EXISTS clusters_size ON clusters (size DESC, id DESC);
CREATE INDEX IF NOT EXISTS clusters_recent ON clusters (last_seen DESC, id DESC);

CREATE TABLE IF NOT EXISTS cluster_members (
  cluster_id  TEXT NOT NULL REFERENCES clusters(id) ON DELETE CASCADE,
  issue_id    INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  similarity  REAL NOT NULL,                      -- cosine similarity to the cluster medoid
  PRIMARY KEY (cluster_id, issue_id)
);
CREATE INDEX IF NOT EXISTS cluster_members_issue ON cluster_members (issue_id);

CREATE TABLE IF NOT EXISTS jobs (
  id           TEXT PRIMARY KEY,
  type         TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','failed')),
  params       TEXT NOT NULL,
  result       TEXT,
  error        TEXT,
  created_at   TEXT NOT NULL,
  started_at   TEXT,
  finished_at  TEXT
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key          TEXT PRIMARY KEY,
  fingerprint  TEXT NOT NULL,                     -- method + path + body hash
  status       INTEGER,                           -- NULL while the first request is in flight
  headers      TEXT,
  body         TEXT,
  created_at   INTEGER NOT NULL
);
`;

export const IDEMPOTENCY_TTL_MS = 24 * 3600 * 1000;

export function openStore(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  return new Store(db);
}

const json = (s, fallback) => {
  if (s == null) return fallback;
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
};

export class Store {
  constructor(db) {
    this.db = db;
  }

  tx(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  // ---------- repositories ----------
  upsertRepository(r) {
    this.db
      .prepare(
        `INSERT INTO repositories (id, full_name, description, stars, html_url, tracked_at)
         VALUES ($id, $full_name, $description, $stars, $html_url, $tracked_at)
         ON CONFLICT(id) DO UPDATE SET full_name = excluded.full_name,
           description = excluded.description, stars = excluded.stars, html_url = excluded.html_url`,
      )
      .run({ $description: null, ...prefix(r) });
    return this.getRepository(r.full_name);
  }

  getRepository(fullName) {
    return this.db
      .prepare(
        `SELECT r.*, (SELECT COUNT(*) FROM issues i WHERE i.repository_id = r.id) AS issue_count,
                (SELECT COUNT(*) FROM issues i WHERE i.repository_id = r.id AND i.state = 'open') AS open_issue_count
         FROM repositories r WHERE r.full_name = ?`,
      )
      .get(fullName);
  }

  listRepositories() {
    return this.db
      .prepare(
        `SELECT r.*, COUNT(i.id) AS issue_count, SUM(i.state = 'open') AS open_issue_count
         FROM repositories r LEFT JOIN issues i ON i.repository_id = r.id
         GROUP BY r.id ORDER BY r.full_name COLLATE NOCASE`,
      )
      .all();
  }

  deleteRepository(fullName) {
    return this.tx(() => {
      const repo = this.getRepository(fullName);
      if (!repo) return false;
      // Clusters reference member issues; they are rebuilt by the next analysis.
      this.db.exec('DELETE FROM clusters');
      this.db.prepare('DELETE FROM repositories WHERE id = ?').run(repo.id);
      return true;
    });
  }

  markSynced(repoId, { at, etag, since }) {
    this.db
      .prepare(
        `UPDATE repositories SET last_synced_at = ?, issues_etag = COALESCE(?, issues_etag),
           issues_since = COALESCE(?, issues_since) WHERE id = ?`,
      )
      .run(at, etag ?? null, since ?? null, repoId);
  }

  // ---------- issues ----------
  upsertIssues(repoId, issues) {
    const stmt = this.db.prepare(
      `INSERT INTO issues (id, repository_id, number, title, state, labels, comments, reactions,
                           created_at, updated_at, closed_at, html_url, terms)
       VALUES ($id, $repository_id, $number, $title, $state, $labels, $comments, $reactions,
               $created_at, $updated_at, $closed_at, $html_url, $terms)
       ON CONFLICT(id) DO UPDATE SET title = excluded.title, state = excluded.state,
         labels = excluded.labels, comments = excluded.comments, reactions = excluded.reactions,
         updated_at = excluded.updated_at, closed_at = excluded.closed_at, terms = excluded.terms`,
    );
    this.tx(() => {
      for (const i of issues) {
        stmt.run(
          prefix({
            ...i,
            repository_id: repoId,
            labels: JSON.stringify(i.labels),
            terms: JSON.stringify(i.terms),
          }),
        );
      }
    });
    return issues.length;
  }

  deleteIssues(ids) {
    const del = this.db.prepare('DELETE FROM issues WHERE id = ?');
    const unlink = this.db.prepare('DELETE FROM cluster_members WHERE issue_id = ?');
    this.tx(() => {
      for (const id of ids) {
        unlink.run(id);
        del.run(id);
      }
    });
  }

  issueCorpus() {
    return this.db
      .prepare(
        `SELECT i.id, i.state, i.comments, i.reactions, i.created_at, i.terms, r.full_name AS repository
         FROM issues i JOIN repositories r ON r.id = i.repository_id ORDER BY i.id`,
      )
      .all()
      .map((row) => ({ ...row, terms: json(row.terms, {}) }));
  }

  getIssue(id) {
    const row = this.db
      .prepare(
        `SELECT i.*, r.full_name AS repository, cm.cluster_id, cm.similarity
         FROM issues i JOIN repositories r ON r.id = i.repository_id
         LEFT JOIN cluster_members cm ON cm.issue_id = i.id
         WHERE i.id = ?`,
      )
      .get(id);
    return row ? hydrateIssue(row) : null;
  }

  /**
   * Keyset-paginated issue listing, newest first.
   * @param {{repository?:string,state?:string,label?:string,cluster?:string,q?:string}} f
   */
  listIssues(f, limit, after) {
    const where = [];
    const params = {};
    if (f.repository) (where.push('r.full_name = $repo'), (params.$repo = f.repository));
    if (f.state) (where.push('i.state = $state'), (params.$state = f.state));
    if (f.label) (where.push('EXISTS (SELECT 1 FROM json_each(i.labels) WHERE value = $label)'), (params.$label = f.label));
    if (f.cluster) (where.push('cm.cluster_id = $cluster'), (params.$cluster = f.cluster));
    if (f.q) (where.push("i.title LIKE $q ESCAPE '\\'"), (params.$q = `%${f.q.replace(/[\\%_]/g, (c) => '\\' + c)}%`));
    const countSql = `SELECT COUNT(*) AS n FROM issues i JOIN repositories r ON r.id = i.repository_id
      LEFT JOIN cluster_members cm ON cm.issue_id = i.id ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`;
    const total = this.db.prepare(countSql).get(params).n;
    if (after) {
      where.push('(i.created_at < $k OR (i.created_at = $k AND i.id < $after_id))');
      params.$k = String(after.k);
      params.$after_id = Number(after.id);
    }
    const rows = this.db
      .prepare(
        `SELECT i.*, r.full_name AS repository, cm.cluster_id, cm.similarity
         FROM issues i JOIN repositories r ON r.id = i.repository_id
         LEFT JOIN cluster_members cm ON cm.issue_id = i.id
         ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
         ORDER BY i.created_at DESC, i.id DESC LIMIT $limit`,
      )
      .all({ ...params, $limit: limit + 1 });
    return { rows: rows.slice(0, limit).map(hydrateIssue), hasMore: rows.length > limit, total };
  }

  // ---------- clusters ----------
  replaceClusters(analysis, clusters) {
    this.tx(() => {
      this.db.exec('DELETE FROM clusters');
      this.db
        .prepare(
          `INSERT INTO analyses (id, created_at, params, issue_count, cluster_count, duration_ms)
           VALUES ($id, $created_at, $params, $issue_count, $cluster_count, $duration_ms)`,
        )
        .run(prefix({ ...analysis, params: JSON.stringify(analysis.params) }));
      const ins = this.db.prepare(
        `INSERT INTO clusters (id, analysis_id, label, terms, size, repo_count, open_count, engagement,
           score, score_components, cohesion, medoid_issue_id, first_seen, last_seen)
         VALUES ($id, $analysis_id, $label, $terms, $size, $repo_count, $open_count, $engagement,
           $score, $score_components, $cohesion, $medoid_issue_id, $first_seen, $last_seen)`,
      );
      const mem = this.db.prepare('INSERT INTO cluster_members (cluster_id, issue_id, similarity) VALUES (?, ?, ?)');
      for (const c of clusters) {
        const { members, ...row } = c; // node:sqlite rejects unknown named parameters
        ins.run(
          prefix({
            ...row,
            analysis_id: analysis.id,
            terms: JSON.stringify(c.terms),
            score_components: JSON.stringify(c.score_components),
          }),
        );
        for (const m of members) mem.run(c.id, m.issue_id, m.similarity);
      }
    });
  }

  latestAnalysis() {
    const row = this.db.prepare('SELECT * FROM analyses ORDER BY created_at DESC, id DESC LIMIT 1').get();
    return row ? { ...row, params: json(row.params, {}) } : null;
  }

  static CLUSTER_SORTS = {
    score: { col: 'c.score', type: 'num' },
    size: { col: 'c.size', type: 'num' },
    recent: { col: 'c.last_seen', type: 'text' },
  };

  listClusters(f, sort, limit, after) {
    const s = Store.CLUSTER_SORTS[sort];
    const where = [];
    const params = {};
    if (f.min_repos) (where.push('c.repo_count >= $min_repos'), (params.$min_repos = f.min_repos));
    if (f.min_size) (where.push('c.size >= $min_size'), (params.$min_size = f.min_size));
    if (f.repository) {
      where.push(`EXISTS (SELECT 1 FROM cluster_members m JOIN issues i ON i.id = m.issue_id
        JOIN repositories r ON r.id = i.repository_id WHERE m.cluster_id = c.id AND r.full_name = $repo)`);
      params.$repo = f.repository;
    }
    const base = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const total = this.db.prepare(`SELECT COUNT(*) AS n FROM clusters c ${base}`).get(params).n;
    if (after) {
      where.push(`(${s.col} < $k OR (${s.col} = $k AND c.id < $after_id))`);
      params.$k = s.type === 'num' ? Number(after.k) : String(after.k);
      params.$after_id = String(after.id);
    }
    const rows = this.db
      .prepare(
        `SELECT c.* FROM clusters c ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
         ORDER BY ${s.col} DESC, c.id DESC LIMIT $limit`,
      )
      .all({ ...params, $limit: limit + 1 });
    return { rows: rows.slice(0, limit).map((r) => this.hydrateCluster(r)), hasMore: rows.length > limit, total };
  }

  getCluster(id) {
    const row = this.db.prepare('SELECT * FROM clusters WHERE id = ?').get(id);
    return row ? this.hydrateCluster(row) : null;
  }

  hydrateCluster(row) {
    const repos = this.db
      .prepare(
        `SELECT r.full_name AS repository, COUNT(*) AS issues FROM cluster_members m
         JOIN issues i ON i.id = m.issue_id JOIN repositories r ON r.id = i.repository_id
         WHERE m.cluster_id = ? GROUP BY r.full_name ORDER BY issues DESC, r.full_name`,
      )
      .all(row.id);
    return {
      ...row,
      terms: json(row.terms, []),
      score_components: json(row.score_components, {}),
      repositories: repos.map((r) => ({ ...r })),
    };
  }

  clusterEvidence(id, limit) {
    return this.db
      .prepare(
        `SELECT i.*, r.full_name AS repository, m.cluster_id, m.similarity FROM cluster_members m
         JOIN issues i ON i.id = m.issue_id JOIN repositories r ON r.id = i.repository_id
         WHERE m.cluster_id = ? ORDER BY m.similarity DESC, i.id DESC LIMIT ?`,
      )
      .all(id, limit)
      .map(hydrateIssue);
  }

  clusterTimeline(id) {
    return this.db
      .prepare(
        `SELECT substr(i.created_at, 1, 7) AS month, COUNT(*) AS issues FROM cluster_members m
         JOIN issues i ON i.id = m.issue_id WHERE m.cluster_id = ? GROUP BY month ORDER BY month`,
      )
      .all(id)
      .map((r) => ({ ...r }));
  }

  // ---------- stats ----------
  stats() {
    const one = (sql) => this.db.prepare(sql).get();
    const counts = one(`SELECT
        (SELECT COUNT(*) FROM repositories) AS repositories,
        (SELECT COUNT(*) FROM issues) AS issues,
        (SELECT COUNT(*) FROM issues WHERE state = 'open') AS open_issues,
        (SELECT COUNT(*) FROM clusters) AS clusters,
        (SELECT COUNT(*) FROM clusters WHERE repo_count >= 2) AS cross_repo_clusters,
        (SELECT COUNT(*) FROM cluster_members) AS clustered_issues`);
    const monthly = this.db
      .prepare(
        `SELECT substr(created_at, 1, 7) AS month, COUNT(*) AS opened,
                SUM(state = 'open') AS still_open
         FROM issues GROUP BY month ORDER BY month`,
      )
      .all()
      .map((r) => ({ ...r }));
    return { counts: { ...counts }, monthly };
  }

  // ---------- jobs ----------
  createJob(job) {
    this.db
      .prepare(`INSERT INTO jobs (id, type, status, params, created_at) VALUES ($id, $type, 'queued', $params, $created_at)`)
      .run(prefix({ ...job, params: JSON.stringify(job.params) }));
  }

  updateJob(id, fields) {
    const sets = Object.keys(fields).map((k) => `${k} = $${k}`);
    const vals = prefix(
      Object.fromEntries(
        Object.entries(fields).map(([k, v]) => [k, v !== null && typeof v === 'object' ? JSON.stringify(v) : v]),
      ),
    );
    this.db.prepare(`UPDATE jobs SET ${sets.join(', ')} WHERE id = $id`).run({ ...vals, $id: id });
  }

  getJob(id) {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
    return row ? { ...row, params: json(row.params, {}), result: json(row.result, null) } : null;
  }

  // ---------- idempotency ----------
  idempotencyGet(key, now) {
    // Expired keys are invisible even before the next reserve sweeps them.
    const row = this.db
      .prepare('SELECT * FROM idempotency_keys WHERE key = ? AND created_at >= ?')
      .get(key, now - IDEMPOTENCY_TTL_MS);
    return row ? { ...row, headers: json(row.headers, {}) } : null;
  }

  idempotencyReserve(key, fp, now) {
    this.db.prepare('DELETE FROM idempotency_keys WHERE created_at < ?').run(now - IDEMPOTENCY_TTL_MS);
    const res = this.db
      .prepare('INSERT OR IGNORE INTO idempotency_keys (key, fingerprint, created_at) VALUES (?, ?, ?)')
      .run(key, fp, now);
    return res.changes === 1;
  }

  idempotencyComplete(key, status, headers, body) {
    this.db
      .prepare('UPDATE idempotency_keys SET status = ?, headers = ?, body = ? WHERE key = ?')
      .run(status, JSON.stringify(headers), JSON.stringify(body), key);
  }

  idempotencyRelease(key) {
    this.db.prepare('DELETE FROM idempotency_keys WHERE key = ? AND status IS NULL').run(key);
  }
}

// Callers pass objects whose keys match the statement's named parameters exactly;
// node:sqlite throws on unknown names, which keeps column drift loud.
function prefix(obj) {
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k.startsWith('$') ? k : `$${k}`, v ?? null]));
}

function hydrateIssue(row) {
  const { terms, repository_id, ...rest } = row;
  return { ...rest, labels: json(row.labels, []) };
}
