# Security

## Reporting

Please report vulnerabilities privately through GitHub's **Report a vulnerability** button on this repository (Security tab), not in a public issue.

## Design notes

- **Writes need a key.** Every write endpoint requires `Authorization: Bearer <RADAR_API_KEY>`, compared as SHA-256 digests with `timingSafeEqual`. With no key configured, or with `RADAR_READ_ONLY=1`, the API is read-only.
- **The public demo is read-only by construction.** `api/index.js` forces `RADAR_READ_ONLY=1` and blanks the key, so no environment variable on the host can enable writes.
- **The GitHub token never leaves the API host.** The client refuses to follow a pagination `Link` that points outside the configured API base, so a hostile `Link` header cannot redirect the bearer token.
- **Inputs are bounded.** Path parameters are matched against GitHub's naming rules, unknown or repeated query parameters return 422, bodies are capped at 16 KB and must be `application/json`, `LIKE` wildcards in search are escaped, and every SQL statement is parameterised.
- **Rate limited.** A fixed window per client address (default 120 requests per 60 s). On serverless each warm instance keeps its own window, so treat it as abuse damping, not a quota.
- **No personal data stored.** Issue bodies, usernames, avatars and comment text are never persisted. See `state/data-rights/api.github.com.json` for the source-rights record.
- **No runtime dependencies.** The server uses only Node.js built-ins (`node:http`, `node:sqlite`, `node:crypto`), so there is no third-party package supply chain to audit.
- **CI is pinned.** GitHub Actions are pinned to commit SHAs, the workflow token is read-only, and checkout does not persist credentials.
