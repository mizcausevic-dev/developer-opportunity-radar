// Writes data/snapshot.json from the local database (run after `npm run ingest`).
import { writeFileSync } from 'node:fs';
import { loadConfig } from '../src/config.js';
import { openStore } from '../src/db/store.js';
import { exportSnapshot } from '../src/snapshot.js';

const store = openStore(loadConfig().dbPath);
const snap = exportSnapshot(store);
writeFileSync('data/snapshot.json', JSON.stringify(snap) + '\n');
console.log(JSON.stringify({ msg: 'snapshot written', repositories: snap.repositories.length, issues: snap.issues.length, clusters: snap.clusters.length, generated_at: snap.generated_at }));
store.db.close();
