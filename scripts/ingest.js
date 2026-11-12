// Track every repository in radar.repos.json, sync its issues, then cluster the corpus.
// Uses the same service functions the API's job endpoints use.
//
//   GITHUB_TOKEN=... npm run ingest            # uses data/radar.db
//   npm run ingest -- --threshold 0.3          # re-cluster with a different cut
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { loadConfig } from '../src/config.js';
import { openStore } from '../src/db/store.js';
import { GitHubClient } from '../src/github/client.js';
import { analyze, repositoryRow, syncRepository } from '../src/services.js';

const { values } = parseArgs({
  options: {
    threshold: { type: 'string' },
    'min-size': { type: 'string' },
    'skip-sync': { type: 'boolean', default: false },
    config: { type: 'string', default: 'radar.repos.json' },
  },
});

const cfg = loadConfig();
const list = JSON.parse(readFileSync(values.config, 'utf8'));
const store = openStore(cfg.dbPath);
const log = (o) => process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), ...o }) + '\n');
const github = new GitHubClient({ token: cfg.githubToken, baseUrl: cfg.githubApiBase, log });

if (!values['skip-sync']) {
  if (!cfg.githubToken) log({ level: 'warn', msg: 'GITHUB_TOKEN not set: unauthenticated limit is 60 requests/hour' });
  for (const fullName of list.repositories) {
    const gh = await github.getRepository(fullName);
    const existing = store.getRepository(gh.full_name);
    store.upsertRepository(repositoryRow(gh, existing?.tracked_at ?? new Date().toISOString()));
    const res = await syncRepository(store, github, gh.full_name, { maxPages: list.max_pages ?? cfg.sync.maxPagesPerRepo });
    log({ msg: 'synced', ...res, github_rate_limit: undefined, rate_remaining: github.rateLimit?.remaining });
  }
}

const opts = {};
if (values.threshold) opts.threshold = Number(values.threshold);
if (values['min-size']) opts.minSize = Number(values['min-size']);
const result = analyze(store, opts);
log({ msg: 'analysed', ...result });
store.db.close();
