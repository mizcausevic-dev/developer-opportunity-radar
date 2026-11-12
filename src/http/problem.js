// RFC 9457 Problem Details. Every error leaves the API as application/problem+json
// with a stable `type` URI that resolves to human documentation.

export const PROBLEM_DOCS = 'https://mizcausevic-dev.github.io/developer-opportunity-radar/problems.html';

const TITLES = {
  'bad-request': 'Bad request',
  'validation-failed': 'Validation failed',
  unauthorized: 'Authentication required',
  'read-only': 'This deployment is read-only',
  'not-found': 'Resource not found',
  'method-not-allowed': 'Method not allowed',
  'not-acceptable': 'Not acceptable',
  conflict: 'Conflict',
  'idempotency-key-reuse': 'Idempotency key reused with a different request',
  'payload-too-large': 'Payload too large',
  'unsupported-media-type': 'Unsupported media type',
  'invalid-cursor': 'Invalid pagination cursor',
  'rate-limited': 'Too many requests',
  'upstream-error': 'Upstream GitHub API error',
  internal: 'Internal server error',
};

export class ProblemError extends Error {
  /**
   * @param {number} status HTTP status
   * @param {keyof typeof TITLES} slug problem type slug
   * @param {string} detail human-readable, request-specific explanation
   * @param {object} [extensions] extra members (e.g. `errors` for validation)
   * @param {object} [headers] extra response headers (e.g. Allow, Retry-After)
   */
  constructor(status, slug, detail, extensions = {}, headers = {}) {
    super(detail);
    this.status = status;
    this.slug = slug;
    this.extensions = extensions;
    this.headers = headers;
  }
}

export function problemBody(err, instance) {
  return {
    type: `${PROBLEM_DOCS}#${err.slug}`,
    title: TITLES[err.slug] ?? 'Error',
    status: err.status,
    detail: err.message,
    instance,
    ...err.extensions,
  };
}

export const problems = {
  badRequest: (detail, ext) => new ProblemError(400, 'bad-request', detail, ext),
  validation: (errors) =>
    new ProblemError(422, 'validation-failed', 'One or more fields are invalid.', { errors }),
  notFound: (detail) => new ProblemError(404, 'not-found', detail),
  conflict: (detail) => new ProblemError(409, 'conflict', detail),
};

export { TITLES as PROBLEM_TITLES };
