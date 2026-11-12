import { ProblemError } from './problem.js';

// Reads and parses a JSON request body with a hard size cap.
// Returns {} for an empty body so optional-body POSTs work without Content-Type.
export async function readJson(req, maxBytes) {
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > maxBytes) throw tooLarge(maxBytes);

  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw tooLarge(maxBytes);
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks);
  if (raw.length === 0) return { value: {}, raw };

  const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') {
    throw new ProblemError(415, 'unsupported-media-type', 'Request bodies must be sent as application/json.', {}, { 'Accept-Post': 'application/json' });
  }
  try {
    const value = JSON.parse(raw.toString('utf8'));
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('not an object');
    }
    return { value, raw };
  } catch {
    throw new ProblemError(400, 'bad-request', 'The request body must be a JSON object.');
  }
}

function tooLarge(max) {
  return new ProblemError(413, 'payload-too-large', `Request bodies are limited to ${max} bytes.`);
}
