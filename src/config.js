// Runtime configuration, read once from the environment.
// Every value has a safe default so `npm start` works with no setup.

const int = (value, fallback) => {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export function loadConfig(env = process.env) {
  return {
    port: int(env.PORT, 8080),
    dbPath: env.RADAR_DB_PATH || 'data/radar.db',
    // Write endpoints stay disabled unless an API key is set AND read-only mode is off.
    apiKey: env.RADAR_API_KEY || '',
    readOnly: env.RADAR_READ_ONLY === '1' || !env.RADAR_API_KEY,
    githubToken: env.GITHUB_TOKEN || '',
    githubApiBase: env.GITHUB_API_BASE || 'https://api.github.com',
    // Trust X-Forwarded-For only behind a proxy you control (Vercel sets it).
    trustProxy: env.RADAR_TRUST_PROXY === '1',
    rateLimit: {
      limit: int(env.RADAR_RATE_LIMIT, 120),
      windowSeconds: int(env.RADAR_RATE_WINDOW, 60),
    },
    maxBodyBytes: 16 * 1024,
    publicBaseUrl: env.RADAR_PUBLIC_BASE_URL || '',
    docsBaseUrl: 'https://mizcausevic-dev.github.io/developer-opportunity-radar',
    sync: {
      maxPagesPerRepo: int(env.RADAR_MAX_PAGES, 5),
    },
  };
}
