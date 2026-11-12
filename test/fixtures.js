// Hand-written test fixtures (not real GitHub data). Three themes recur across repositories,
// plus unrelated one-offs that should stay unclustered.

let seq = 1000;
const at = (d) => `2026-${d}T12:00:00Z`;

function issue(repo, number, title, body, { state = 'open', created = '06-01', comments = 2, reactions = 1, pr = false } = {}) {
  seq += 1;
  return {
    id: seq,
    number,
    title,
    body,
    state,
    labels: [{ name: 'bug' }],
    comments,
    reactions: { total_count: reactions },
    created_at: at(created),
    updated_at: at(created),
    closed_at: state === 'closed' ? at(created) : null,
    html_url: `https://github.com/${repo}/issues/${number}`,
    user: { login: 'should-never-be-stored' },
    ...(pr ? { pull_request: { url: 'x' } } : {}),
  };
}

export const REPOS = {
  'acme/alpha': { id: 1, full_name: 'acme/alpha', description: 'Alpha web framework', stargazers_count: 1200, html_url: 'https://github.com/acme/alpha', private: false },
  'acme/beta': { id: 2, full_name: 'acme/beta', description: 'Beta router', stargazers_count: 800, html_url: 'https://github.com/acme/beta', private: false },
  'other/gamma': { id: 3, full_name: 'other/gamma', description: 'Gamma server', stargazers_count: 300, html_url: 'https://github.com/other/gamma', private: false },
};

const cors = 'The browser sends an OPTIONS preflight and the CORS middleware does not answer it, so the Access-Control-Allow-Origin header is missing and the preflight request fails.';
const upload = 'Uploading a file with multipart form data streams the upload but the multipart parser drops the file field when the upload is larger than the limit.';
const types = 'The TypeScript types for the request body are wrong: the typed body generic is inferred as unknown and the TypeScript compiler rejects the handler body type.';

export const ISSUES = {
  'acme/alpha': [
    issue('acme/alpha', 1, 'CORS preflight OPTIONS request not handled by middleware', cors, { created: '05-02', comments: 9, reactions: 14 }),
    issue('acme/alpha', 2, 'Multipart file upload drops field over size limit', upload, { created: '03-10' }),
    issue('acme/alpha', 3, 'TypeScript request body type inferred as unknown', types, { created: '07-01', state: 'closed' }),
    issue('acme/alpha', 4, 'Docs typo in the changelog page', 'There is a spelling mistake in the changelog heading.', { created: '01-15' }),
    issue('acme/alpha', 5, 'Bump dependency in lockfile', 'Automated pull request body', { pr: true }),
  ],
  'acme/beta': [
    issue('acme/beta', 11, 'Preflight CORS OPTIONS missing Access-Control-Allow-Origin header', cors, { created: '06-20', comments: 4, reactions: 6 }),
    issue('acme/beta', 12, 'Large multipart upload loses the file field', upload, { created: '04-04', state: 'closed' }),
    issue('acme/beta', 13, 'Request body TypeScript generic type is unknown', types, { created: '08-11' }),
    issue('acme/beta', 14, 'Logo looks blurry on retina screens', 'The svg logo renders blurry in the hero banner.', { created: '02-02' }),
  ],
  'other/gamma': [
    issue('other/gamma', 21, 'CORS middleware ignores OPTIONS preflight request', cors, { created: '09-01', comments: 3 }),
    issue('other/gamma', 22, 'Multipart parser drops file upload field', upload, { created: '09-05' }),
    issue('other/gamma', 23, 'Handler body TypeScript types rejected by compiler', types, { created: '10-10' }),
    issue('other/gamma', 24, 'Graceful shutdown leaves sockets open on SIGTERM', 'Keep-alive sockets stay open after SIGTERM so the process never exits.', { created: '10-20' }),
  ],
};

/**
 * A fake fetch that behaves like the GitHub REST API for the fixtures: Link pagination
 * (page size 3), ETags, If-None-Match -> 304, and a request log for assertions.
 */
export function fakeGitHub({ pageSize = 3, failFirst = 0 } = {}) {
  const calls = [];
  let failures = failFirst;
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    calls.push({ url: u, headers: init.headers ?? {} });
    const rl = { 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '4999', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600) };
    if (failures > 0) {
      failures -= 1;
      return new Response('{"message":"Server Error"}', { status: 502, headers: rl });
    }
    const m = /^\/repos\/([^/]+)\/([^/]+)(\/issues)?$/.exec(u.pathname);
    const name = m && `${decodeURIComponent(m[1])}/${decodeURIComponent(m[2])}`;
    const key = name && Object.keys(REPOS).find((k) => k.toLowerCase() === name.toLowerCase());
    if (!key) return new Response('{"message":"Not Found"}', { status: 404, headers: rl });
    if (!m[3]) return Response.json(REPOS[key], { headers: rl });

    const since = u.searchParams.get('since');
    const all = ISSUES[key].filter((i) => !since || i.updated_at >= since);
    const pageNo = Number(u.searchParams.get('page') ?? 1);
    const slice = all.slice((pageNo - 1) * pageSize, pageNo * pageSize);
    const etag = `"${key}-${since ?? 'all'}-${pageNo}-${all.length}"`;
    if (init.headers?.['If-None-Match'] === etag) return new Response(null, { status: 304, headers: rl });
    const headers = { ...rl, etag };
    if (pageNo * pageSize < all.length) {
      const next = new URL(u);
      next.searchParams.set('page', String(pageNo + 1));
      headers.link = `<${next}>; rel="next", <${u.origin}${u.pathname}?page=1>; rel="first"`;
    }
    return Response.json(slice, { headers });
  };
  return { fetchImpl, calls };
}
