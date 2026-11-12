# Changelog

## 1.1.0 (2026-11-12)

Added
- `recent: { window_days, opened }` on every cluster: member issues opened in the 180-day momentum window, as a count.
- `sample` on each `/v1/stats` repository: `oldest_updated_at`, `oldest_created_at`, `covers_days`, `momentum_window_complete`.
- Response-schema contract test: real responses from every read endpoint are validated against the OpenAPI schemas, and undocumented fields fail.
- Dashboard: sort the ranking by any score component (legend chips and table headers); markdown brief export per cluster; request builder generated from `openapi.json`; 180-day counts in the explorer.

Changed
- First sync keeps paging (up to 30 pages) until each repository's sample covers the 180-day window. nestjs/nest previously reached back only 83 days, which understated its momentum. Snapshot refreshed: 1,995 issues, 204 clusters.
- `Accept` negotiation parses q-values; `application/json;q=0, */*` now gets 406.
- Noise filter catches bracketed placeholders such as `[SPAM]`, and every analysis re-applies it to stored issues.
- Responses carry `Vary: Origin, Accept`. Found on the live deploy: the CDN served a cached 200 to a client that refused JSON.
- `Allow` is exposed to browsers via `Access-Control-Expose-Headers`.

Not changed
- No velocity percentages: with a median cluster of 3 issues they would be noise. See the README's sampling notes.

## 1.0.0 (2026-11-12)

First public release.
