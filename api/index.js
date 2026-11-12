// Vercel Function entry point: the same request handler as `npm start`, backed by an
// in-memory SQLite database loaded from data/snapshot.json at cold start.
// Read-only by construction: RADAR_API_KEY is never set here, so every write returns 403.
import { readFileSync } from 'node:fs';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { openStore } from '../src/db/store.js';
import { loadSnapshot } from '../src/snapshot.js';

let app;

function build() {
  const config = loadConfig({ ...process.env, RADAR_READ_ONLY: '1', RADAR_API_KEY: '', RADAR_TRUST_PROXY: '1' });
  const store = openStore(':memory:');
  loadSnapshot(store, JSON.parse(readFileSync(new URL('../data/snapshot.json', import.meta.url), 'utf8')));
  return createApp({ config, store, github: null });
}

export default async function handler(req, res) {
  app ??= build();
  await app(req, res);
}
