// Tests for lib/auth.js's password hashing and session token signing.
// SESSION_SECRET has to be set before lib/auth.js is required - it reads the
// env var once at module-load time, not per-call.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

process.env.SESSION_SECRET = crypto.randomBytes(32).toString('base64');
const {
  hashPassword,
  verifyPassword,
  createSessionToken,
  verifySessionToken,
} = require('../lib/auth');

test('hashPassword + verifyPassword round-trip', () => {
  const { hash, salt } = hashPassword('correct horse battery staple');
  assert.equal(verifyPassword('correct horse battery staple', hash, salt), true);
});

test('verifyPassword rejects a wrong password', () => {
  const { hash, salt } = hashPassword('correct horse battery staple');
  assert.equal(verifyPassword('wrong password', hash, salt), false);
});

test('verifyPassword rejects non-string input instead of throwing', () => {
  const { hash, salt } = hashPassword('correct horse battery staple');
  assert.equal(verifyPassword(undefined, hash, salt), false);
  assert.equal(verifyPassword(null, hash, salt), false);
  assert.equal(verifyPassword('', hash, salt), false);
});

test('two hashes of the same password use different salts', () => {
  const a = hashPassword('same password');
  const b = hashPassword('same password');
  assert.notEqual(a.salt, b.salt);
  assert.notEqual(a.hash, b.hash);
});

test('createSessionToken + verifySessionToken round-trips the user id', () => {
  const token = createSessionToken(42);
  assert.equal(verifySessionToken(token), 42);
});

test('verifySessionToken rejects a tampered payload', () => {
  const token = createSessionToken(42);
  const [payloadB64, sig] = token.split('.');
  const payload = JSON.parse(Buffer.from(payloadB64.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  payload.user_id = 999; // try to impersonate a different account
  const tamperedPayloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const tampered = `${tamperedPayloadB64}.${sig}`;
  assert.equal(verifySessionToken(tampered), null);
});

test('verifySessionToken rejects an expired token', () => {
  // createSessionToken always sets a 90-day expiry - simulate an expired one
  // directly rather than waiting 90 days.
  const crypto2 = require('node:crypto');
  const base64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const payloadB64 = base64url(Buffer.from(JSON.stringify({ exp: Date.now() - 1000, user_id: 1 })));
  const sig = base64url(crypto2.createHmac('sha256', process.env.SESSION_SECRET).update(payloadB64).digest());
  assert.equal(verifySessionToken(`${payloadB64}.${sig}`), null);
});

test('verifySessionToken rejects garbage input', () => {
  assert.equal(verifySessionToken(''), null);
  assert.equal(verifySessionToken(null), null);
  assert.equal(verifySessionToken('not-a-real-token'), null);
  assert.equal(verifySessionToken('a.b'), null);
});
