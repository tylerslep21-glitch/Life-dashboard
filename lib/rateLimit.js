// Simple in-memory rate limiter - no new dependency, and appropriate for a
// single-process, low-traffic app (this is a personal dashboard with an
// invite-gated signup, not a public product under real load). It's a plain
// fixed-window counter per IP per route, not distributed: a Railway restart
// clears every counter, and this wouldn't share state across multiple
// instances if the app were ever scaled horizontally. Both are fine at this
// scale; a shared store (e.g. Redis) would be the fix if that ever changes.

const buckets = new Map(); // "prefix:ip" -> { count, resetAt }

// Prune expired entries periodically so this doesn't grow unbounded over a
// long-running process. unref() so this timer itself never keeps the
// process alive.
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}, 5 * 60 * 1000).unref();

// windowMs/max: e.g. { windowMs: 15*60*1000, max: 10 } = 10 requests per 15
// minutes per IP. keyPrefix scopes the counter to this specific limiter
// instance (each route that calls rateLimit() gets its own bucket space, so
// hammering /login doesn't also burn down someone else's /signup budget).
function rateLimit({ windowMs, max, keyPrefix }) {
  return (req, res, next) => {
    const key = `${keyPrefix}:${req.ip}`;
    console.log(`[rateLimit debug] key=${key} xff=${req.headers['x-forwarded-for']} ips=${JSON.stringify(req.ips)}`);
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }
    bucket.count++;
    if (bucket.count > max) {
      res.setHeader('Retry-After', String(Math.ceil((bucket.resetAt - now) / 1000)));
      return res.status(429).json({ error: 'Too many attempts - try again later' });
    }
    next();
  };
}

module.exports = { rateLimit };
