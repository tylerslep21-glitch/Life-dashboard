// Simple in-memory rate limiter - no new dependency, and appropriate for a
// single-process, low-traffic app (this is a personal dashboard with an
// invite-gated signup, not a public product under real load). It's a plain
// fixed-window counter per IP per route, not distributed: a Railway restart
// clears every counter, and this wouldn't share state across multiple
// instances if the app were ever scaled horizontally. Both are fine at this
// scale; a shared store (e.g. Redis) would be the fix if that ever changes.

const buckets = new Map(); // "prefix:ip" -> { count, resetAt }

// Deliberately not relying on Express's trust-proxy-derived req.ip here:
// Railway's chain turned out to be 2 hops (confirmed by inspecting the raw
// header in production), and bumping the app-wide `trust proxy` number to
// match would also change req.protocol/req.secure, which WebAuthn's origin
// check already depends on working correctly - not worth the risk of a
// regression there just to fix this. X-Forwarded-For's leftmost entry is,
// by convention, the original client regardless of how many internal hops
// get appended after it, so this reads that directly instead.
function getClientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return xff.split(',')[0].trim();
  return req.ip;
}

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
    const key = `${keyPrefix}:${getClientIp(req)}`;
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
