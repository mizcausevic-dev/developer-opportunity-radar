import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { requireWriteAccess } from './http/auth.js';
import { readJson } from './http/body.js';
import { acceptsAny } from './http/negotiate.js';
import { decodeCursor, encodeCursor, fingerprint, pageLinks, parseLimit } from './http/pagination.js';
import { ProblemError, problemBody, problems } from './http/problem.js';
import { clientKey, RateLimiter } from './http/ratelimit.js';
import { linkHeader, sendEmpty, sendJson } from './http/respond.js';
import { Router } from './http/router.js';
import { GitHubError } from './github/client.js';
import { JobRunner } from './jobs/runner.js';
import { analyze, repositoryRow, syncRepository } from './services.js';

const PKG = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const OPENAPI = readFileSync(new URL('../openapi/openapi.json', import.meta.url));

const NAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/; // GitHub owner rules
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;

const EXPOSED = ['Allow', 'ETag', 'Link', 'Location', 'Retry-After', 'RateLimit-Limit', 'RateLimit-Remaining', 'RateLimit-Reset', 'X-Request-Id', 'Idempotent-Replayed'];

/**
 * Build the request handler.
 * @param {{config: ReturnType<import('./config.js').loadConfig>, store: import('./db/store.js').Store,
 *          github?: import('./github/client.js').GitHubClient, log?: (o: object) => void}} deps
 */
export function createApp({ config, store, github, log = defaultLog }) {
  const limiter = new RateLimiter(config.rateLimit);
  const jobs = new JobRunner(store, log);
  const router = new Router();

  // ---------------------------------------------------------------- representations
  const repoRepr = (r) => {
    const self = `/v1/repositories/${r.full_name}`;
    return {
      id: r.full_name,
      full_name: r.full_name,
      description: r.description,
      stars: r.stars,
      html_url: r.html_url,
      tracked_at: r.tracked_at,
      last_synced_at: r.last_synced_at,
      issue_count: r.issue_count ?? 0,
      open_issue_count: r.open_issue_count ?? 0,
      links: {
        self,
        issues: `/v1/issues?repository=${encodeURIComponent(r.full_name)}`,
        clusters: `/v1/clusters?repository=${encodeURIComponent(r.full_name)}`,
        syncs: `${self}/syncs`,
      },
    };
  };

  const issueRepr = (i) => ({
    id: `iss_${i.id}`,
    repository: i.repository,
    number: i.number,
    title: i.title,
    state: i.state,
    labels: i.labels,
    comments: i.comments,
    reactions: i.reactions,
    created_at: i.created_at,
    updated_at: i.updated_at,
    closed_at: i.closed_at,
    source_url: i.html_url,
    cluster: i.cluster_id ? { id: i.cluster_id, similarity: i.similarity, href: `/v1/clusters/${i.cluster_id}` } : null,
    links: { self: `/v1/issues/iss_${i.id}`, source: i.html_url },
  });

  const clusterRepr = (c) => {
    const medoid = store.getIssue(c.medoid_issue_id);
    return {
      id: c.id,
      label: c.label,
      terms: c.terms,
      size: c.size,
      repository_count: c.repo_count,
      repositories: c.repositories.map((r) => ({ full_name: r.repository, issues: r.issues })),
      open_issues: c.open_count,
      engagement: c.engagement,
      score: c.score,
      score_components: c.score_components,
      cohesion: c.cohesion,
      recent: { window_days: recentDays(), opened: c.recent_opened ?? 0 },
      first_seen: c.first_seen,
      last_seen: c.last_seen,
      representative_issue: medoid ? { id: `iss_${medoid.id}`, repository: medoid.repository, number: medoid.number, title: medoid.title, source_url: medoid.html_url } : null,
      links: { self: `/v1/clusters/${c.id}`, issues: `/v1/clusters/${c.id}/issues` },
    };
  };

  // The momentum window of the latest analysis (180 days unless an analysis said otherwise).
  const recentDays = () => store.latestAnalysis()?.params?.recent_days ?? 180;

  const jobRepr = (j) => ({
    id: j.id,
    type: j.type,
    status: j.status,
    params: j.params,
    result: j.result,
    error: j.error,
    created_at: j.created_at,
    started_at: j.started_at,
    finished_at: j.finished_at,
    links: { self: `/v1/jobs/${j.id}` },
  });

  // ---------------------------------------------------------------- helpers
  const repoParams = ({ owner, name }) => {
    const errors = [];
    if (!NAME_RE.test(owner)) errors.push({ field: 'owner', message: 'must be a valid GitHub user or organisation name' });
    if (!REPO_RE.test(name) || name === '.' || name === '..') errors.push({ field: 'name', message: 'must be a valid GitHub repository name' });
    if (errors.length) throw problems.validation(errors);
    return `${owner}/${name}`;
  };

  const repoFilter = (raw) => {
    if (raw == null) return undefined;
    const [owner = '', name = '', extra] = raw.split('/');
    if (extra !== undefined || !NAME_RE.test(owner) || !REPO_RE.test(name)) {
      throw problems.validation([{ field: 'repository', message: 'must look like owner/name' }]);
    }
    return raw;
  };

  const enumParam = (field, raw, allowed, def) => {
    if (raw == null) return def;
    if (!allowed.includes(raw)) throw problems.validation([{ field, message: `must be one of: ${allowed.join(', ')}` }]);
    return raw;
  };

  const intParam = (field, raw, min, max) => {
    if (raw == null) return undefined;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) throw problems.validation([{ field, message: `must be an integer between ${min} and ${max}` }]);
    return n;
  };

  const page = (url, rows, hasMore, total, limit, cursorOf, fp) => {
    const next = hasMore ? encodeCursor({ ...cursorOf(rows[rows.length - 1]), f: fp }) : null;
    const links = pageLinks(url, next);
    return {
      body: { data: rows, page: { limit, total, next_cursor: next, has_more: hasMore }, links },
      headers: { Link: linkHeader(links) },
    };
  };

  const accepted = (job) => ({
    status: 202,
    body: jobRepr(job),
    headers: { Location: `/v1/jobs/${job.id}`, 'Retry-After': '2' },
  });

  const upstream = (err) => {
    if (err instanceof GitHubError) {
      return new ProblemError(502, 'upstream-error', err.message, { upstream_status: err.status });
    }
    return err;
  };

  // ---------------------------------------------------------------- routes
  router.add('GET', '/', () => ({
    status: 200,
    body: {
      name: 'Developer Opportunity Radar API',
      version: PKG.version,
      description: PKG.description,
      read_only: config.readOnly,
      documentation: `${config.docsBaseUrl}/api.html`,
      links: {
        openapi: '/openapi.json',
        health: '/healthz',
        stats: '/v1/stats',
        repositories: '/v1/repositories',
        clusters: '/v1/clusters',
        issues: '/v1/issues',
        analyses: '/v1/analyses',
      },
    },
  }));

  router.add('GET', '/healthz', () => {
    store.db.prepare('SELECT 1').get();
    return { status: 200, body: { status: 'ok' }, cache: 'no-store' };
  });

  router.add('GET', '/openapi.json', () => ({ status: 200, raw: OPENAPI, contentType: 'application/vnd.oai.openapi+json; charset=utf-8' }));

  router.add('GET', '/v1/stats', () => {
    const s = store.stats();
    const a = store.latestAnalysis();
    return {
      status: 200,
      body: {
        ...s.counts,
        repositories_detail: store.listRepositories().map((r) => {
          // The corpus holds each repository's most recently UPDATED issues. Every issue opened
          // in the last N days has updated_at >= created_at, so an N-day window is complete
          // exactly when the sample reaches further back than N days.
          const asOf = Date.parse(a?.created_at ?? new Date().toISOString());
          const coversDays = r.oldest_updated_at ? Math.floor((asOf - Date.parse(r.oldest_updated_at)) / 86_400_000) : 0;
          return {
            full_name: r.full_name,
            issues: r.issue_count,
            open_issues: r.open_issue_count ?? 0,
            last_synced_at: r.last_synced_at,
            sample: {
              oldest_updated_at: r.oldest_updated_at ?? null,
              oldest_created_at: r.oldest_created_at ?? null,
              covers_days: coversDays,
              momentum_window_complete: coversDays >= recentDays(),
            },
          };
        }),
        monthly: s.monthly,
        latest_analysis: a && { id: a.id, created_at: a.created_at, params: a.params, issue_count: a.issue_count, cluster_count: a.cluster_count, duration_ms: a.duration_ms },
      },
    };
  });

  router.add('GET', '/v1/repositories', () => {
    const rows = store.listRepositories().map(repoRepr);
    return { status: 200, body: { data: rows, page: { limit: rows.length, total: rows.length, next_cursor: null, has_more: false } } };
  });

  router.add('GET', '/v1/repositories/:owner/:name', ({ params }) => {
    const r = store.getRepository(repoParams(params));
    if (!r) throw problems.notFound(`Repository ${params.owner}/${params.name} is not tracked.`);
    return { status: 200, body: repoRepr(r) };
  });

  // PUT: the client names the resource, so tracking is naturally idempotent (201 then 200).
  router.add('PUT', '/v1/repositories/:owner/:name', async ({ req, params }) => {
    requireWriteAccess(req, config);
    const fullName = repoParams(params);
    await readJson(req, config.maxBodyBytes); // body is optional and ignored, but must be valid if sent
    const existing = store.getRepository(fullName);
    let gh;
    try {
      gh = await github.getRepository(fullName);
    } catch (err) {
      if (err instanceof GitHubError && err.status === 404) {
        throw problems.validation([{ field: 'name', message: `${fullName} does not exist on GitHub or is not public` }]);
      }
      throw upstream(err);
    }
    if (gh.private) throw problems.validation([{ field: 'name', message: 'only public repositories can be tracked' }]);
    const row = store.upsertRepository(repositoryRow(gh, existing?.tracked_at ?? new Date().toISOString()));
    return {
      status: existing ? 200 : 201,
      body: repoRepr(row),
      headers: existing ? {} : { Location: `/v1/repositories/${row.full_name}` },
    };
  });

  router.add('DELETE', '/v1/repositories/:owner/:name', ({ req, params }) => {
    requireWriteAccess(req, config);
    const fullName = repoParams(params);
    if (!store.deleteRepository(fullName)) throw problems.notFound(`Repository ${fullName} is not tracked.`);
    return { status: 204 };
  });

  router.add(
    'POST',
    '/v1/repositories/:owner/:name/syncs',
    async ({ req, params, body }) => {
      requireWriteAccess(req, config);
      const fullName = repoParams(params);
      const repo = store.getRepository(fullName);
      if (!repo) throw problems.notFound(`Repository ${fullName} is not tracked. PUT it first.`);
      const maxPages = intParam('max_pages', body.max_pages, 1, 10) ?? config.sync.maxPagesPerRepo;
      if (body.analyze !== undefined && typeof body.analyze !== 'boolean') {
        throw problems.validation([{ field: 'analyze', message: 'must be a boolean' }]);
      }
      const runAnalysis = body.analyze ?? true;
      const job = jobs.enqueue('sync', { repository: repo.full_name, max_pages: maxPages, analyze: runAnalysis }, async () => {
        const sync = await syncRepository(store, github, repo.full_name, { maxPages });
        const analysis = runAnalysis && !sync.not_modified ? analyze(store) : null;
        return { sync, analysis };
      });
      return accepted(job);
    },
    { idempotent: true, body: true },
  );

  router.add(
    'POST',
    '/v1/analyses',
    async ({ req, body }) => {
      requireWriteAccess(req, config);
      const errors = [];
      const threshold = body.threshold ?? 0.24;
      if (typeof threshold !== 'number' || threshold < 0.1 || threshold > 0.6) errors.push({ field: 'threshold', message: 'must be a number between 0.1 and 0.6' });
      const minSize = body.min_size ?? 3;
      if (!Number.isInteger(minSize) || minSize < 2 || minSize > 20) errors.push({ field: 'min_size', message: 'must be an integer between 2 and 20' });
      if (errors.length) throw problems.validation(errors);
      const job = jobs.enqueue('analysis', { threshold, min_size: minSize }, async () => analyze(store, { threshold, minSize }));
      return accepted(job);
    },
    { idempotent: true, body: true },
  );

  router.add('GET', '/v1/jobs/:id', ({ params }) => {
    const job = store.getJob(params.id);
    if (!job) throw problems.notFound(`Job ${params.id} does not exist.`);
    const done = job.status === 'succeeded' || job.status === 'failed';
    return { status: 200, body: jobRepr(job), headers: done ? {} : { 'Retry-After': '2' }, cache: 'no-store' };
  });

  router.add(
    'GET',
    '/v1/issues',
    ({ url, query }) => {
      const f = {
        repository: repoFilter(query.repository),
        state: enumParam('state', query.state, ['open', 'closed'], undefined),
        label: query.label,
        cluster: query.cluster,
        q: query.q,
      };
      if (f.q !== undefined && (f.q.length < 2 || f.q.length > 100)) throw problems.validation([{ field: 'q', message: 'must be 2 to 100 characters' }]);
      const limit = parseLimit(query.limit);
      const fp = fingerprint(['issues', f]);
      const after = decodeCursor(query.cursor, fp);
      const { rows, hasMore, total } = store.listIssues(f, limit, after);
      const out = page(url, rows.map(issueRepr), hasMore, total, limit, (last) => ({ k: last.created_at, id: Number(last.id.slice(4)) }), fp);
      return { status: 200, ...out };
    },
    { query: ['repository', 'state', 'label', 'cluster', 'q', 'limit', 'cursor'] },
  );

  router.add('GET', '/v1/issues/:id', ({ params }) => {
    const m = /^iss_(\d{1,15})$/.exec(params.id);
    const issue = m && store.getIssue(Number(m[1]));
    if (!issue) throw problems.notFound(`Issue ${params.id} does not exist.`);
    return { status: 200, body: issueRepr(issue) };
  });

  router.add(
    'GET',
    '/v1/clusters',
    ({ url, query }) => {
      const sort = enumParam('sort', query.sort, ['score', 'size', 'recent'], 'score');
      const f = {
        repository: repoFilter(query.repository),
        min_repos: intParam('min_repos', query.min_repos, 1, 100),
        min_size: intParam('min_size', query.min_size, 1, 10_000),
      };
      const limit = parseLimit(query.limit);
      const fp = fingerprint(['clusters', sort, f]);
      const after = decodeCursor(query.cursor, fp);
      const { rows, hasMore, total } = store.listClusters(f, sort, limit, after);
      const key = { score: 'score', size: 'size', recent: 'last_seen' }[sort];
      const out = page(url, rows.map(clusterRepr), hasMore, total, limit, (last) => ({ k: last[key], id: last.id }), fp);
      const a = store.latestAnalysis();
      out.body.meta = { sort, analysis: a && { id: a.id, created_at: a.created_at, params: a.params } };
      return { status: 200, ...out };
    },
    { query: ['sort', 'repository', 'min_repos', 'min_size', 'limit', 'cursor'] },
  );

  router.add(
    'GET',
    '/v1/clusters/:id',
    ({ params, query }) => {
      const c = store.getCluster(params.id);
      if (!c) throw problems.notFound(`Cluster ${params.id} does not exist in the latest analysis.`);
      const evidenceLimit = intParam('evidence', query.evidence, 1, 50) ?? 10;
      return {
        status: 200,
        body: {
          ...clusterRepr(c),
          evidence: store.clusterEvidence(c.id, evidenceLimit).map(issueRepr),
          timeline: store.clusterTimeline(c.id),
        },
      };
    },
    { query: ['evidence'] },
  );

  router.add(
    'GET',
    '/v1/clusters/:id/issues',
    ({ url, params, query }) => {
      if (!store.getCluster(params.id)) throw problems.notFound(`Cluster ${params.id} does not exist in the latest analysis.`);
      const limit = parseLimit(query.limit);
      const f = { cluster: params.id };
      const fp = fingerprint(['issues', f]);
      const after = decodeCursor(query.cursor, fp);
      const { rows, hasMore, total } = store.listIssues(f, limit, after);
      const out = page(url, rows.map(issueRepr), hasMore, total, limit, (last) => ({ k: last.created_at, id: Number(last.id.slice(4)) }), fp);
      return { status: 200, ...out };
    },
    { query: ['limit', 'cursor'] },
  );

  // ---------------------------------------------------------------- pipeline
  const idempotent = async (req, key, ctx, handler) => {
    if (!/^[\x21-\x7e]{8,128}$/.test(key)) {
      throw problems.validation([{ field: 'Idempotency-Key', message: 'must be 8-128 visible ASCII characters' }]);
    }
    const fp = createHash('sha256').update(`${req.method} ${ctx.url.pathname}\n`).update(ctx.rawBody).digest('base64url');
    const prior = store.idempotencyGet(key, Date.now());
    if (prior) {
      if (prior.fingerprint !== fp) throw new ProblemError(422, 'idempotency-key-reuse', 'This Idempotency-Key was already used with a different request.');
      if (prior.status == null) throw new ProblemError(409, 'conflict', 'A request with this Idempotency-Key is still being processed.', {}, { 'Retry-After': '1' });
      return { status: prior.status, body: JSON.parse(prior.body), headers: { ...prior.headers, 'Idempotent-Replayed': 'true' } };
    }
    if (!store.idempotencyReserve(key, fp, Date.now())) {
      throw new ProblemError(409, 'conflict', 'A request with this Idempotency-Key is still being processed.', {}, { 'Retry-After': '1' });
    }
    try {
      const out = await handler(ctx);
      store.idempotencyComplete(key, out.status, out.headers ?? {}, out.body ?? null);
      return out;
    } catch (err) {
      store.idempotencyRelease(key); // failed requests may be retried with the same key
      throw err;
    }
  };

  handle.jobs = jobs;
  handle.router = router;
  return handle;

  async function handle(req, res) {
    const started = process.hrtime.bigint();
    const incomingId = req.headers['x-request-id'];
    const requestId = typeof incomingId === 'string' && /^[\w.-]{1,64}$/.test(incomingId) ? incomingId : randomUUID();
    res.setHeader('X-Request-Id', requestId);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Expose-Headers', EXPOSED.join(', '));
    // Accept changes the response (200 JSON vs 406), so shared caches must key on it too.
    // Found live: without it the CDN served a cached 200 to a client that refused JSON.
    res.setHeader('Vary', 'Origin, Accept');

    let url;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      url = new URL('http://localhost/');
    }
    try {
      const rl = limiter.take(clientKey(req, config.trustProxy));
      res.setHeader('RateLimit-Limit', rl.limit);
      res.setHeader('RateLimit-Remaining', rl.remaining);
      res.setHeader('RateLimit-Reset', rl.resetSeconds);
      if (!rl.allowed) {
        throw new ProblemError(429, 'rate-limited', `Rate limit of ${rl.limit} requests per ${config.rateLimit.windowSeconds}s exceeded.`, {}, { 'Retry-After': String(rl.resetSeconds) });
      }

      // A success body can only be sent if its own media type is acceptable: application/json,
      // or for the contract, the OpenAPI type. Accepting only problem+json (or `*/*` next to
      // `application/json;q=0`) does not count. The 406 itself is sent as problem+json.
      const successTypes = url.pathname === '/openapi.json' ? ['application/vnd.oai.openapi+json', 'application/json'] : ['application/json'];
      if (!acceptsAny(req.headers.accept, successTypes)) {
        throw new ProblemError(406, 'not-acceptable', 'This API only produces application/json (errors as application/problem+json).');
      }

      const { route, params } = router.match(req.method, url.pathname);
      if (route.options) {
        sendEmpty(res, 204, {
          Allow: route.allow,
          'Access-Control-Allow-Methods': route.allow,
          'Access-Control-Allow-Headers': 'Authorization, Content-Type, Idempotency-Key, If-None-Match, X-Request-Id',
          'Access-Control-Max-Age': '600',
        });
        return;
      }

      const query = {};
      for (const [k, v] of url.searchParams) {
        if (k in query) throw problems.validation([{ field: k, message: 'must not be repeated' }]);
        query[k] = v;
      }
      const allowedQuery = route.meta.query ?? [];
      const unknown = Object.keys(query).filter((k) => !allowedQuery.includes(k));
      if (unknown.length) {
        throw problems.validation(unknown.map((k) => ({ field: k, message: 'is not a supported query parameter' })));
      }

      const ctx = { req, res, params, url, query, body: {}, rawBody: Buffer.alloc(0) };
      let out;
      if (route.meta.body) {
        requireWriteAccess(req, config); // authenticate before reading any body bytes
        const { value, raw } = await readJson(req, config.maxBodyBytes);
        ctx.body = value;
        ctx.rawBody = raw;
      }
      const key = req.headers['idempotency-key'];
      if (route.meta.idempotent && typeof key === 'string') {
        out = await idempotent(req, key, ctx, route.handler);
      } else {
        out = await route.handler(ctx);
      }

      if (out.raw) {
        res.setHeader('Content-Type', out.contentType);
        res.setHeader('Cache-Control', 'public, max-age=300');
        res.statusCode = out.status;
        res.end(req.method === 'HEAD' ? undefined : out.raw);
      } else if (out.status === 204) {
        sendEmpty(res, 204, out.headers);
      } else {
        sendJson(req, res, out.status, out.body, { headers: out.headers, cache: out.cache, cdnMaxAge: config.cdnMaxAge });
      }
    } catch (caught) {
      const err = upstream(caught);
      if (err instanceof ProblemError) {
        for (const [k, v] of Object.entries(err.headers)) res.setHeader(k, v);
        sendJson(req, res, err.status, problemBody(err, url.pathname), { contentType: 'application/problem+json; charset=utf-8' });
      } else {
        log({ level: 'error', msg: 'unhandled', request_id: requestId, error: String(err?.stack ?? err) });
        const p = new ProblemError(500, 'internal', `Unexpected error. Quote request id ${requestId} when reporting it.`);
        sendJson(req, res, 500, problemBody(p, url.pathname), { contentType: 'application/problem+json; charset=utf-8' });
      }
    } finally {
      log({
        level: 'info',
        msg: 'request',
        request_id: requestId,
        method: req.method,
        path: url.pathname,
        status: res.statusCode,
        duration_ms: Number((process.hrtime.bigint() - started) / 1000n) / 1000,
      });
    }
  }
}

function defaultLog(entry) {
  process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
}

export { JobRunner };
