import { createServer } from 'node:http';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { openStore } from './db/store.js';
import { GitHubClient } from './github/client.js';

const config = loadConfig();
const store = openStore(config.dbPath);
const github = new GitHubClient({ token: config.githubToken, baseUrl: config.githubApiBase });
const app = createApp({ config, store, github });

const server = createServer(app);
server.requestTimeout = 30_000;
server.headersTimeout = 10_000;
server.listen(config.port, () => {
  process.stdout.write(
    JSON.stringify({ ts: new Date().toISOString(), level: 'info', msg: 'listening', port: config.port, read_only: config.readOnly, db: config.dbPath }) + '\n',
  );
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close(() => {
      store.db.close();
      process.exit(0);
    });
  });
}
