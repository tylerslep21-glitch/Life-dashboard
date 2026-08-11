// Tests for lib/rateLimit.js's fixed-window limiter.
//
// The middleware logic (threshold, Retry-After, per-IP/per-prefix isolation,
// window reset) is exercised against an injected in-memory fake store so
// these run fast with no database required. A separate group at the bottom
// exercises the real Postgres-backed increment() this app actually runs in
// production - only enabled when DATABASE_URL is set, since that needs a
// live database.
const test = require('node:test');
const assert = require('node:assert/strict');
const { rateLimit } = require('../lib/rateLimit');

// Minimal fake req/res good enough to exercise the middleware without an
// actual Express app or HTTP server.
function fakeReqRes(ip) {
  // getClientIp() prefers X-Forwarded-For (see lib/rateLimit.js for why -
  // Railway's own req.ip isn't reliably stable across requests), so these
  // fakes need a headers object too, not just req.ip.
  const resolvedIp = ip || '1.2.3.4';
  const req = { ip: resolvedIp, headers: { 'x-forwarded-for': resolvedIp } };
  const res = {
    statusCode: null,
    headers: {},
    body: null,
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  return { req, res };
}

// Same fixed-window semantics as pgIncrement() in lib/rateLimit.js, but
// in-process - stands in for the database so the middleware tests below
// don't need one.
function fakeStore() {
  const buckets = new Map();
  return async function increment(key, windowMs) {
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }
    bucket.count++;
    return { count: bucket.count, resetAt: bucket.resetAt };
  };
}

function runMiddleware(limiter, req, res) {
  return new Promise((resolve, reject) => {
    let nextCalled = false;
    Promise.resolve(limiter(req, res, () => { nextCalled = true; resolve(nextCalled); }))
      .then(() => { if (!nextCalled) resolve(nextCalled); })
      .catch(reject);
  });
}

test('allows requests under the limit', async () => {
  const limiter = rateLimit({ windowMs: 60000, max: 3, keyPrefix: 'test-under', increment: fakeStore() });
  for (let i = 0; i < 3; i++) {
    const { req, res } = fakeReqRes();
    const nextCalled = await runMiddleware(limiter, req, res);
    assert.equal(nextCalled, true);
    assert.equal(res.statusCode, null);
  }
});

test('blocks requests once the limit is exceeded, with a 429 and Retry-After', async () => {
  const limiter = rateLimit({ windowMs: 60000, max: 2, keyPrefix: 'test-over', increment: fakeStore() });
  const ip = '9.9.9.9';
  for (let i = 0; i < 2; i++) {
    const { req, res } = fakeReqRes(ip);
    await runMiddleware(limiter, req, res);
  }
  const { req, res } = fakeReqRes(ip);
  const nextCalled = await runMiddleware(limiter, req, res);
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 429);
  assert.ok(res.headers['Retry-After']);
});

test('tracks different IPs independently', async () => {
  const limiter = rateLimit({ windowMs: 60000, max: 1, keyPrefix: 'test-ips', increment: fakeStore() });
  const a = fakeReqRes('1.1.1.1');
  const b = fakeReqRes('2.2.2.2');
  await runMiddleware(limiter, a.req, a.res);
  const bNextCalled = await runMiddleware(limiter, b.req, b.res);
  assert.equal(bNextCalled, true);
  assert.equal(b.res.statusCode, null);
});

test('different keyPrefixes do not share a budget for the same IP', async () => {
  const ip = '3.3.3.3';
  const store = fakeStore();
  const limiterA = rateLimit({ windowMs: 60000, max: 1, keyPrefix: 'test-prefix-a', increment: store });
  const limiterB = rateLimit({ windowMs: 60000, max: 1, keyPrefix: 'test-prefix-b', increment: store });
  const first = fakeReqRes(ip);
  await runMiddleware(limiterA, first.req, first.res);
  const second = fakeReqRes(ip);
  const nextCalled = await runMiddleware(limiterB, second.req, second.res);
  assert.equal(nextCalled, true);
});

test('resets after the window elapses', async () => {
  const limiter = rateLimit({ windowMs: 10, max: 1, keyPrefix: 'test-reset', increment: fakeStore() });
  const ip = '4.4.4.4';
  const first = fakeReqRes(ip);
  await runMiddleware(limiter, first.req, first.res);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const second = fakeReqRes(ip);
  const nextCalled = await runMiddleware(limiter, second.req, second.res);
  assert.equal(nextCalled, true);
});

test('a store error is passed to next(err) instead of throwing', async () => {
  const boom = new Error('boom');
  const limiter = rateLimit({
    windowMs: 60000,
    max: 1,
    keyPrefix: 'test-error',
    increment: async () => { throw boom; },
  });
  const { req, res } = fakeReqRes();
  const err = await new Promise((resolve) => {
    limiter(req, res, resolve);
  });
  assert.equal(err, boom);
});

// ---- integration tests against the real Postgres-backed increment() ----
// Only run when a database is actually reachable - these confirm the SQL in
// lib/rateLimit.js's pgIncrement() is correct (atomic increment, window
// reset, concurrent requests for the same key), not just the middleware
// wrapper around it.
const describeDb = process.env.DATABASE_URL ? test : test.skip;

describeDb('pgIncrement: real Postgres-backed counting', async (t) => {
  const { migrate, pool } = require('../db');
  const { rateLimit } = require('../lib/rateLimit');
  await migrate();
  await pool.query("DELETE FROM rate_limit_buckets WHERE key LIKE 'itest-%'");

  await t.test('increments across calls and blocks over the limit', async () => {
    const limiter = rateLimit({ windowMs: 60000, max: 2, keyPrefix: 'itest-basic' });
    const ip = '5.5.5.5';
    for (let i = 0; i < 2; i++) {
      const { req, res } = fakeReqRes(ip);
      const nextCalled = await runMiddleware(limiter, req, res);
      assert.equal(nextCalled, true);
    }
    const { req, res } = fakeReqRes(ip);
    const nextCalled = await runMiddleware(limiter, req, res);
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 429);
  });

  await t.test('concurrent requests for the same key never exceed the limit by more than the burst', async () => {
    const limiter = rateLimit({ windowMs: 60000, max: 5, keyPrefix: 'itest-concurrent' });
    const ip = '6.6.6.6';
    const results = await Promise.all(
      Array.from({ length: 10 }, () => {
        const { req, res } = fakeReqRes(ip);
        return runMiddleware(limiter, req, res).then(() => res.statusCode);
      })
    );
    const allowed = results.filter((code) => code === null).length;
    const blocked = results.filter((code) => code === 429).length;
    assert.equal(allowed, 5);
    assert.equal(blocked, 5);
  });

  await t.test('resets the bucket once reset_at has passed', async () => {
    const limiter = rateLimit({ windowMs: 50, max: 1, keyPrefix: 'itest-reset' });
    const ip = '7.7.7.7';
    const first = fakeReqRes(ip);
    await runMiddleware(limiter, first.req, first.res);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const second = fakeReqRes(ip);
    const nextCalled = await runMiddleware(limiter, second.req, second.res);
    assert.equal(nextCalled, true);
  });

  await pool.query("DELETE FROM rate_limit_buckets WHERE key LIKE 'itest-%'");
});
