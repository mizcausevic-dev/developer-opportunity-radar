import { ProblemError } from './problem.js';

// Minimal segment router. Patterns look like `/v1/repositories/:owner/:name`.
// A path that matches with the wrong method yields 405 with an Allow header (RFC 9110 §15.5.6).
export class Router {
  constructor() {
    /** @type {{method:string, segments:string[], handler:Function, pattern:string, meta:object}[]} */
    this.routes = [];
  }

  add(method, pattern, handler, meta = {}) {
    this.routes.push({ method, pattern, segments: split(pattern), handler, meta });
    return this;
  }

  /** @returns {{route: object, params: Record<string,string>}} */
  match(method, pathname) {
    const parts = split(pathname);
    const allowed = new Set();
    for (const route of this.routes) {
      const params = matchSegments(route.segments, parts);
      if (!params) continue;
      if (route.method === method || (method === 'HEAD' && route.method === 'GET')) {
        return { route, params };
      }
      allowed.add(route.method);
      if (route.method === 'GET') allowed.add('HEAD');
    }
    if (allowed.size === 0) {
      throw new ProblemError(404, 'not-found', `No resource at ${pathname}.`);
    }
    allowed.add('OPTIONS');
    const allow = [...allowed].sort().join(', ');
    if (method === 'OPTIONS') return { route: { options: true, allow }, params: {} };
    throw new ProblemError(405, 'method-not-allowed', `${method} is not supported on ${pathname}.`, {}, { Allow: allow });
  }
}

function split(path) {
  return path.split('/').filter(Boolean);
}

function matchSegments(pattern, parts) {
  if (pattern.length !== parts.length) return null;
  const params = {};
  for (let i = 0; i < pattern.length; i++) {
    const p = pattern[i];
    if (p.startsWith(':')) {
      let value;
      try {
        value = decodeURIComponent(parts[i]);
      } catch {
        return null;
      }
      params[p.slice(1)] = value;
    } else if (p !== parts[i]) {
      return null;
    }
  }
  return params;
}
