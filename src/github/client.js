// GitHub REST client for the two endpoints the radar needs.
// - Follows RFC 8288 Link pagination (rel="next") instead of guessing page numbers.
// - Sends If-None-Match with the last ETag; a 304 means "nothing changed since last sync".
// - Honours primary rate limits (x-ratelimit-remaining / x-ratelimit-reset) and
//   secondary limits (retry-after), and retries 5xx with exponential backoff and jitter.
// - `fetch` and `sleep` are injectable so the behaviour is unit-testable offline.

export class GitHubError extends Error {
  constructor(status, message, { retryable = false } = {}) {
    super(message);
    this.status = status;
    this.retryable = retryable;
  }
}

const API_VERSION = '2022-11-28';

export class GitHubClient {
  constructor({ token = '', baseUrl = 'https://api.github.com', fetchImpl = globalThis.fetch, sleep, maxRetries = 3, maxWaitMs = 60_000, log = () => {} } = {}) {
    this.token = token;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.fetch = fetchImpl;
    this.sleep = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.maxRetries = maxRetries;
    this.maxWaitMs = maxWaitMs;
    this.log = log;
    /** Last observed primary rate-limit state, exposed for logs and job results. */
    this.rateLimit = null;
  }

  headers(extra = {}) {
    const h = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': API_VERSION,
      'User-Agent': 'developer-opportunity-radar',
      ...extra,
    };
    if (this.token) h.Authorization = `Bearer ${this.token}`;
    return h;
  }

  async request(url, { etag } = {}) {
    const full = url.startsWith('http') ? url : `${this.baseUrl}${url}`;
    if (!full.startsWith(this.baseUrl + '/')) {
      // Never follow a pagination link off the configured API host (and never send the token there).
      throw new GitHubError(502, `Refusing to follow link outside ${this.baseUrl}`);
    }
    for (let attempt = 0; ; attempt++) {
      const res = await this.fetch(full, { headers: this.headers(etag ? { 'If-None-Match': etag } : {}) });
      this.trackRateLimit(res.headers);

      if (res.status === 304) return { status: 304, etag, data: null, next: null };
      if (res.ok) {
        return { status: res.status, etag: res.headers.get('etag'), data: await res.json(), next: nextLink(res.headers.get('link')) };
      }

      const wait = this.retryDelay(res, attempt);
      if (wait == null || attempt >= this.maxRetries) {
        const body = await res.text().catch(() => '');
        throw new GitHubError(res.status, `GitHub ${res.status} for ${new URL(full).pathname}: ${summarise(body)}`, {
          retryable: wait != null,
        });
      }
      this.log({ msg: 'github.retry', status: res.status, attempt: attempt + 1, wait_ms: wait });
      await this.sleep(wait);
    }
  }

  /** @returns {number|null} milliseconds to wait, or null if the error is not retryable */
  retryDelay(res, attempt) {
    const h = res.headers;
    const retryAfter = Number(h.get('retry-after'));
    if ((res.status === 403 || res.status === 429) && Number.isFinite(retryAfter) && retryAfter > 0) {
      return Math.min(retryAfter * 1000, this.maxWaitMs); // secondary rate limit
    }
    if ((res.status === 403 || res.status === 429) && h.get('x-ratelimit-remaining') === '0') {
      const resetMs = Number(h.get('x-ratelimit-reset')) * 1000 - Date.now();
      if (resetMs > this.maxWaitMs) return null; // don't hold a job open for an hour
      return Math.max(1000, resetMs);
    }
    if (res.status === 429) return backoff(attempt);
    if (res.status >= 500) return backoff(attempt);
    return null;
  }

  trackRateLimit(h) {
    const remaining = h.get('x-ratelimit-remaining');
    if (remaining == null) return;
    this.rateLimit = {
      limit: Number(h.get('x-ratelimit-limit')),
      remaining: Number(remaining),
      reset_at: new Date(Number(h.get('x-ratelimit-reset')) * 1000).toISOString(),
    };
  }

  async getRepository(fullName) {
    const { data } = await this.request(`/repos/${encodePath(fullName)}`);
    return data;
  }

  /**
   * Fetch issues (pull requests excluded), newest-updated first, following Link pagination.
   * @param {string} fullName owner/name
   * @param {{since?: string, etag?: string, maxPages?: number}} opts
   * @returns {Promise<{notModified: boolean, etag: string|null, issues: object[], pages: number}>}
   */
  async listIssues(fullName, { since, etag, maxPages = 5 } = {}) {
    const params = new URLSearchParams({ state: 'all', sort: 'updated', direction: 'desc', per_page: '100' });
    if (since) params.set('since', since);
    let url = `/repos/${encodePath(fullName)}/issues?${params}`;
    const issues = [];
    let firstEtag = null;
    let pages = 0;
    while (url && pages < maxPages) {
      const res = await this.request(url, { etag: pages === 0 ? etag : undefined });
      if (res.status === 304) return { notModified: true, etag, issues: [], pages: 1 };
      if (pages === 0) firstEtag = res.etag;
      pages += 1;
      for (const item of res.data) if (!item.pull_request) issues.push(item);
      url = res.next;
    }
    return { notModified: false, etag: firstEtag, issues, pages };
  }
}

export function nextLink(header) {
  if (!header) return null;
  for (const part of header.split(',')) {
    const m = /<([^>]+)>\s*;\s*rel="?([^";]+)"?/.exec(part.trim());
    if (m && m[2].split(/\s+/).includes('next')) return m[1];
  }
  return null;
}

function backoff(attempt) {
  const base = 500 * 2 ** attempt;
  return base + Math.floor(Math.random() * base * 0.25);
}

function encodePath(fullName) {
  return fullName.split('/').map(encodeURIComponent).join('/');
}

function summarise(body) {
  try {
    return JSON.parse(body).message ?? 'error';
  } catch {
    return body.slice(0, 120) || 'error';
  }
}
