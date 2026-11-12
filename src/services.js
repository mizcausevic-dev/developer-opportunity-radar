import { randomBytes } from 'node:crypto';
import { clusterIssues, DEFAULTS } from './analysis/cluster.js';
import { issueTerms, truncateTitle } from './analysis/text.js';

export const newId = (prefix) => `${prefix}_${randomBytes(9).toString('base64url')}`;

const NOISE_LABELS = new Set(['spam', 'invalid']);

/** Spam and test posts are not problems anyone has; keep them out of the corpus. */
export function isNoise(item) {
  const labels = (item.labels ?? []).map((l) => String(typeof l === 'string' ? l : l.name).toLowerCase());
  if (labels.some((l) => NOISE_LABELS.has(l))) return true;
  // whole-title placeholders, optionally bracketed: "SPAM", "[SPAM]", "(test)"
  return /^\s*[[(]?\s*(spam|test|testing|asdf+)\s*[\])]?\s*$/i.test(item.title ?? '');
}

/** Map a GitHub issue payload to the stored shape. Drops the body and every personal field. */
export function normalizeIssue(item) {
  return {
    id: item.id,
    number: item.number,
    title: truncateTitle(item.title),
    state: item.state === 'closed' ? 'closed' : 'open',
    labels: (item.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name)).filter(Boolean),
    comments: item.comments ?? 0,
    reactions: item.reactions?.total_count ?? 0,
    created_at: item.created_at,
    updated_at: item.updated_at,
    closed_at: item.closed_at ?? null,
    html_url: item.html_url,
    terms: issueTerms(item.title, item.body),
  };
}

export function repositoryRow(gh, trackedAt) {
  return {
    id: gh.id,
    full_name: gh.full_name,
    description: gh.description ?? null,
    stars: gh.stargazers_count ?? 0,
    html_url: gh.html_url,
    tracked_at: trackedAt,
  };
}

/**
 * Incremental sync. The watermark is the newest `updated_at` already stored, so when nothing
 * changed the request URL is identical to last time and GitHub answers 304 to If-None-Match.
 */
export async function syncRepository(store, github, fullName, { maxPages = 5, coverDays = DEFAULTS.recentDays, hardMaxPages = 30 } = {}) {
  const repo = store.getRepository(fullName);
  if (!repo) throw new Error(`Repository ${fullName} is not tracked.`);
  const started = Date.now();
  const res = await github.listIssues(repo.full_name, {
    since: repo.issues_since ?? undefined,
    etag: repo.issues_since ? repo.issues_etag ?? undefined : undefined,
    maxPages,
    // First sync: keep paging until the momentum window is fully sampled (see README, sampling).
    coverUntil: new Date(Date.now() - coverDays * 86_400_000).toISOString(),
    hardMaxPages,
  });
  const at = new Date().toISOString();
  if (res.notModified) {
    store.markSynced(repo.id, { at });
    return { repository: repo.full_name, not_modified: true, upserted: 0, pages: res.pages, duration_ms: Date.now() - started, github_rate_limit: github.rateLimit };
  }
  const noise = res.issues.filter(isNoise);
  const issues = res.issues.filter((i) => !isNoise(i)).map(normalizeIssue);
  const skipped = noise.length;
  // An issue relabelled as spam after an earlier sync is removed, not left in the corpus.
  if (noise.length) store.deleteIssues(noise.map((i) => i.id));
  store.upsertIssues(repo.id, issues);
  const watermark = issues.reduce((m, i) => (i.updated_at > m ? i.updated_at : m), repo.issues_since ?? '');
  // An ETag is only reusable for the exact same URL. Keep it only when the watermark (and so
  // the next request's `since`) did not move; otherwise the next sync is a plain request.
  const sameUrlNextTime = Boolean(repo.issues_since) && watermark === repo.issues_since;
  store.markSynced(repo.id, { at, etag: sameUrlNextTime ? res.etag : null, since: watermark || null });
  if (!sameUrlNextTime) store.db.prepare('UPDATE repositories SET issues_etag = NULL WHERE id = ?').run(repo.id);
  return {
    repository: repo.full_name,
    not_modified: false,
    upserted: issues.length,
    skipped_as_noise: skipped,
    pages: res.pages,
    window_covered: res.covered,
    duration_ms: Date.now() - started,
    github_rate_limit: github.rateLimit,
  };
}

export function analyze(store, { threshold = DEFAULTS.threshold, minSize = DEFAULTS.minSize, now } = {}) {
  const started = Date.now();
  const createdAt = now ?? new Date().toISOString();
  // Re-apply the noise rules to stored issues, so a rule fix takes effect without a refetch.
  const noise = store.db.prepare('SELECT id, title, labels FROM issues').all()
    .filter((r) => isNoise({ title: r.title, labels: JSON.parse(r.labels) }))
    .map((r) => r.id);
  if (noise.length) store.deleteIssues(noise);
  const corpus = store.issueCorpus();
  const { clusters, stats } = clusterIssues(corpus, { threshold, minSize, now: createdAt });
  const analysis = {
    id: newId('an'),
    created_at: createdAt,
    params: { threshold, min_size: minSize, weights: DEFAULTS.weights, recent_days: DEFAULTS.recentDays },
    issue_count: corpus.length,
    cluster_count: clusters.length,
    duration_ms: Date.now() - started,
  };
  store.replaceClusters(analysis, clusters);
  return { analysis_id: analysis.id, ...stats, clusters: clusters.length, duration_ms: analysis.duration_ms };
}
