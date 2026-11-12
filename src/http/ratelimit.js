// Fixed-window limiter keyed by client address. In-memory, so on serverless each warm
// instance counts separately; that is documented as a limit of the demo deployment.
// Emits RateLimit-Limit / RateLimit-Remaining / RateLimit-Reset (seconds) on every
// response, and Retry-After on 429.

export class RateLimiter {
  constructor({ limit, windowSeconds, now = () => Date.now() }) {
    this.limit = limit;
    this.windowMs = windowSeconds * 1000;
    this.now = now;
    this.buckets = new Map();
  }

  take(key) {
    const t = this.now();
    let b = this.buckets.get(key);
    if (!b || t >= b.resetAt) {
      b = { count: 0, resetAt: t + this.windowMs };
      this.buckets.set(key, b);
      if (this.buckets.size > 10_000) this.sweep(t);
    }
    b.count += 1;
    const allowed = b.count <= this.limit;
    return {
      allowed,
      limit: this.limit,
      remaining: Math.max(0, this.limit - b.count),
      resetSeconds: Math.max(1, Math.ceil((b.resetAt - t) / 1000)),
    };
  }

  sweep(t) {
    for (const [k, b] of this.buckets) if (t >= b.resetAt) this.buckets.delete(k);
  }
}

export function clientKey(req, trustProxy) {
  if (trustProxy) {
    // Vercel sets x-vercel-forwarded-for / x-forwarded-for itself; prefer its own header.
    const vercel = req.headers['x-vercel-forwarded-for'];
    if (typeof vercel === 'string' && vercel.length) return vercel.split(',')[0].trim();
    const fwd = req.headers['x-forwarded-for'];
    if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  }
  return req.socket?.remoteAddress || 'unknown';
}
