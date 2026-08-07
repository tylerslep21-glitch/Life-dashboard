// Tests for lib/crypto.js's field-level encryption (finance_entries.cards_enc/
// transactions_enc, robinhood_snapshots.history_enc). DATA_ENCRYPTION_KEY has to
// be set before lib/crypto.js is required - it reads the env var once at
// module-load time, not per-call.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

process.env.DATA_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
const { encryptJSON, decryptJSON, encryptionConfigured } = require('../lib/crypto');

test('encryptionConfigured is true once DATA_ENCRYPTION_KEY is set', () => {
  assert.equal(encryptionConfigured, true);
});

test('encrypt then decrypt round-trips arrays, objects, and primitives', () => {
  const cases = [
    [],
    [{ label: 'CFP', balance: 931.21 }, { label: 'CSP', balance: 0 }],
    { nested: { a: 1, b: [1, 2, 3] } },
    'a plain string',
    42,
    null,
  ];
  for (const value of cases) {
    const encrypted = encryptJSON(value);
    assert.deepEqual(decryptJSON(encrypted), value);
  }
});

test('encrypting the same value twice produces different ciphertext (random IV)', () => {
  const value = [{ date: '2026-01-01', value: 100 }];
  const a = encryptJSON(value);
  const b = encryptJSON(value);
  assert.notEqual(a, b);
  // ...but both still decrypt back to the same thing.
  assert.deepEqual(decryptJSON(a), value);
  assert.deepEqual(decryptJSON(b), value);
});

test('decrypting a tampered ciphertext fails instead of silently returning garbage', () => {
  const encrypted = encryptJSON({ secret: 'value' });
  const [iv, authTag, data] = encrypted.split(':');
  // Flip the ciphertext - GCM's auth tag should catch this.
  const tamperedData = Buffer.from(data, 'base64');
  tamperedData[0] ^= 0xff;
  const tampered = [iv, authTag, tamperedData.toString('base64')].join(':');
  assert.throws(() => decryptJSON(tampered));
});

test('decrypting with the wrong key fails', () => {
  const encrypted = encryptJSON({ secret: 'value' });
  // Force-reload the module with a different key to simulate a real
  // wrong-key scenario (e.g. DATA_ENCRYPTION_KEY rotated/misconfigured).
  delete require.cache[require.resolve('../lib/crypto')];
  process.env.DATA_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
  const otherCrypto = require('../lib/crypto');
  assert.throws(() => otherCrypto.decryptJSON(encrypted));
});
