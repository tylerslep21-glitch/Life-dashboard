// Tests for lib/rateLimit.js's in-memory fixed-window limiter.
const test = require('node:test');
const assert = require('node:assert/strict');
const { rateLimit } = require('../lib/rateLimit');

// Minimal fake req/res good enough to exercise the middleware without an
// actual Express app or HTTP server.
function fakeReqRes(ip) {
  const req = { ip: ip || '1.2.3.4' };
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

test('allows requests under the limit', () => {
  const limiter = rateLimit({ windowMs: 60000, max: 3, keyPrefix: 'test-under-' + Date.now() });
  for (let i = 0; i < 3; i++) {
    const { req, res } = fakeReqRes();
    let nextCalled = false;
    limiter(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
    assert.equal(res.statusCode, null);
  }
});

test('blocks requests once the limit is exceeded, with a 429 and Retry-After', () => {
  const limiter = rateLimit({ windowMs: 60000, max: 2, keyPrefix: 'test-over-' + Date.now() });
  const ip = '9.9.9.9';
  for (let i = 0; i < 2; i++) {
    const { req, res } = fakeReqRes(ip);
    limiter(req, res, () => {});
  }
  const { req, res } = fakeReqRes(ip);
  let nextCalled = false;
  limiter(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 429);
  assert.ok(res.headers['Retry-After']);
});

test('tracks different IPs independently', () => {
  const limiter = rateLimit({ windowMs: 60000, max: 1, keyPrefix: 'test-ips-' + Date.now() });
  const a = fakeReqRes('1.1.1.1');
  const b = fakeReqRes('2.2.2.2');
  limiter(a.req, a.res, () => {});
  let bNextCalled = false;
  limiter(b.req, b.res, () => { bNextCalled = true; });
  assert.equal(bNextCalled, true);
  assert.equal(b.res.statusCode, null);
});

test('different keyPrefixes do not share a budget for the same IP', () => {
  const ip = '3.3.3.3';
  const limiterA = rateLimit({ windowMs: 60000, max: 1, keyPrefix: 'test-prefix-a-' + Date.now() });
  const limiterB = rateLimit({ windowMs: 60000, max: 1, keyPrefix: 'test-prefix-b-' + Date.now() });
  const first = fakeReqRes(ip);
  limiterA(first.req, first.res, () => {});
  const second = fakeReqRes(ip);
  let nextCalled = false;
  limiterB(second.req, second.res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
});

test('resets after the window elapses', () => {
  const limiter = rateLimit({ windowMs: 10, max: 1, keyPrefix: 'test-reset-' + Date.now() });
  const ip = '4.4.4.4';
  const first = fakeReqRes(ip);
  limiter(first.req, first.res, () => {});
  return new Promise((resolve) => {
    setTimeout(() => {
      const second = fakeReqRes(ip);
      let nextCalled = false;
      limiter(second.req, second.res, () => { nextCalled = true; });
      assert.equal(nextCalled, true);
      resolve();
    }, 20);
  });
});
