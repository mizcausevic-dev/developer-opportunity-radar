import { createHash, timingSafeEqual } from 'node:crypto';
import { ProblemError } from './problem.js';

const digest = (s) => createHash('sha256').update(s).digest();

// Write endpoints require `Authorization: Bearer <RADAR_API_KEY>`.
// Comparing fixed-length digests keeps the check constant-time regardless of input length.
export function requireWriteAccess(req, config) {
  if (config.readOnly) {
    throw new ProblemError(403, 'read-only', 'Write operations are disabled on this deployment. Run the API locally with RADAR_API_KEY set to track repositories and trigger syncs.');
  }
  const header = req.headers.authorization || '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  const ok = match && timingSafeEqual(digest(match[1].trim()), digest(config.apiKey));
  if (!ok) {
    throw new ProblemError(401, 'unauthorized', 'Send a valid API key as `Authorization: Bearer <key>`.', {}, {
      'WWW-Authenticate': 'Bearer realm="developer-opportunity-radar"',
    });
  }
}
