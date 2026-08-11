// Postgres-backed rate limiter (see the rate_limit_buckets table in db.js) - a
// plain fixed-window counter per "prefix:ip", persisted in the same database
// every other route already uses. This app has exactly one shared store
// (Postgres) and no in-memory-only state anywhere else that matters across a
// restart, so limits surviving a redeploy - and being shared if this ever
// runs as more than one instance - comes for free by using it here too,
// without standing up Redis just for this.

const { pool } = require('../db');

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

// A single INSERT ... ON CONFLICT DO UPDATE keeps "increment, or reset-and-
// start-at-1 if the window's passed" atomic under concurrent requests for
// the same key - Postgres serializes conflicting upserts on the same row,
// so two requests from the same IP landing at once can't both read count=0
// and both proceed. reset_at is compared/stamped using the database's own
// clock (now()), not Node's, so this stays correct even if this app is ever
// running as more than one instance with slightly different clocks.
async function pgIncrement(key, windowMs) {
  const { rows } = await pool.query(
    `INSERT INTO rate_limit_buckets (key, count, reset_at)
     VALUES ($1, 1, now() + ($2 * interval '1 millisecond'))
     ON CONFLICT (key) DO UPDATE SET
       count = CASE WHEN rate_limit_buckets.reset_at <= now() THEN 1 ELSE rate_limit_buckets.count + 1 END,
       reset_at = CASE WHEN rate_limit_buckets.reset_at <= now() THEN now() + ($2 * interval '1 millisecond') ELSE rate_limit_buckets.reset_at END
     RETURNING count, reset_at`,
    [key, windowMs]
  );
  return { count: rows[0].count, resetAt: rows[0].reset_at.getTime() };
}

// Prune expired buckets periodically so the table doesn't grow unbounded
// (e.g. from scanning bots that never come back). unref() so this timer
// itself never keeps the process alive; harmless to run redundantly if this
// app is ever more than one instance.
setInterval(() => {
  pool.query("DELETE FROM rate_limit_buckets WHERE reset_at < now() - interval '1 day'")
    .catch((err) => console.error('rate limit bucket cleanup failed:', err.message));
}, 60 * 60 * 1000).unref();

// windowMs/max: e.g. { windowMs: 15*60*1000, max: 10 } = 10 requests per 15
// minutes per IP. keyPrefix scopes the counter to this specific limiter
// instance (each route that calls rateLimit() gets its own bucket space, so
// hammering /login doesn't also burn down someone else's /signup budget).
// `increment` is injectable (defaults to the real Postgres-backed counter
// above) purely so tests can swap in a fast in-memory fake instead of
// requiring a live database.
function rateLimit({ windowMs, max, keyPrefix, increment = pgIncrement }) {
  return async (req, res, next) => {
    const key = `${keyPrefix}:${getClientIp(req)}`;
    try {
      const { count, resetAt } = await increment(key, windowMs);
      if (count > max) {
        res.setHeader('Retry-After', String(Math.max(1, Math.ceil((resetAt - Date.now()) / 1000))));
        return res.status(429).json({ error: 'Too many attempts - try again later' });
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

module.exports = { rateLimit, getClientIp };
