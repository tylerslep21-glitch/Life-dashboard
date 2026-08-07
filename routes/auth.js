const express = require('express');
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require('@simplewebauthn/server');
const { pool } = require('../db');
const { setSessionCookie, clearSessionCookie, hasValidSession, hashPassword, verifyPassword } = require('../lib/auth');

const router = express.Router();

const INVITE_CODE = process.env.INVITE_CODE;

// Single in-flight ceremony at a time is fine - two people, not a real
// multi-tenant service. A fresh options call always overwrites whatever
// challenge preceded it.
let pendingRegistrationChallenge = null;
let pendingAuthChallenge = null;

function getRpID(req) {
  return req.hostname;
}
function getOrigin(req) {
  return `${req.protocol}://${req.get('host')}`;
}

// This whole router is mounted before the global session-gate middleware in
// server.js (login/signup have to be reachable pre-auth), so unlike the rest
// of the app it can't rely on that middleware to have already set req.userId.

router.get('/session', (req, res) => {
  res.json({ authenticated: !!hasValidSession(req) });
});

router.post('/signup', async (req, res) => {
  const { username, password, invite_code } = req.body || {};
  if (!INVITE_CODE) {
    return res.status(500).json({ error: 'Signup is not configured' });
  }
  if (invite_code !== INVITE_CODE) {
    return res.status(403).json({ error: 'Invalid invite code' });
  }
  if (typeof username !== 'string' || !/^[a-z0-9_]{3,32}$/i.test(username)) {
    return res.status(400).json({ error: 'Username must be 3-32 letters, numbers, or underscores' });
  }
  if (typeof password !== 'string' || password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  const { rows: existing } = await pool.query('SELECT 1 FROM users WHERE username = $1', [username.toLowerCase()]);
  if (existing.length) {
    return res.status(409).json({ error: 'That username is taken' });
  }

  const { hash, salt } = hashPassword(password);
  const { rows } = await pool.query(
    'INSERT INTO users (username, password_hash, password_salt) VALUES ($1, $2, $3) RETURNING id',
    [username.toLowerCase(), hash, salt]
  );
  setSessionCookie(res, rows[0].id);
  res.status(201).json({ ok: true });
});

router.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string') {
    return res.status(401).json({ error: 'Incorrect username or password' });
  }
  const { rows } = await pool.query(
    'SELECT id, password_hash, password_salt FROM users WHERE username = $1',
    [username.toLowerCase()]
  );
  const user = rows[0];
  if (!user || !verifyPassword(password, user.password_hash, user.password_salt)) {
    return res.status(401).json({ error: 'Incorrect username or password' });
  }
  setSessionCookie(res, user.id);
  res.json({ ok: true });
});

router.post('/change-password', async (req, res) => {
  const userId = hasValidSession(req);
  if (!userId) return res.status(401).json({ error: 'Not signed in' });
  const { current_password: currentPassword, new_password: newPassword } = req.body || {};
  if (typeof newPassword !== 'string' || newPassword.length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters' });
  }
  const { rows } = await pool.query('SELECT password_hash, password_salt FROM users WHERE id = $1', [userId]);
  const user = rows[0];
  if (!user || !verifyPassword(currentPassword, user.password_hash, user.password_salt)) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }
  const { hash, salt } = hashPassword(newPassword);
  await pool.query('UPDATE users SET password_hash = $1, password_salt = $2 WHERE id = $3', [hash, salt, userId]);
  res.json({ ok: true });
});

router.post('/logout', (req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

// --- Touch ID / Face ID registration - requires an existing session, i.e. you log in
// with the password once and then bind a device from inside the app. -----------------

router.get('/webauthn/registration-options', async (req, res) => {
  const userId = hasValidSession(req);
  if (!userId) return res.status(401).json({ error: 'Not signed in' });
  const { rows: userRows } = await pool.query('SELECT username FROM users WHERE id = $1', [userId]);
  const { rows } = await pool.query('SELECT credential_id FROM webauthn_credentials WHERE user_id = $1', [userId]);
  const options = await generateRegistrationOptions({
    rpName: 'Life Dashboard',
    rpID: getRpID(req),
    userName: userRows[0] ? userRows[0].username : 'dashboard',
    attestationType: 'none',
    excludeCredentials: rows.map((r) => ({ id: r.credential_id })),
    authenticatorSelection: {
      residentKey: 'preferred',
      userVerification: 'required',
      authenticatorAttachment: 'platform',
    },
  });
  pendingRegistrationChallenge = options.challenge;
  res.json(options);
});

router.post('/webauthn/registration-verify', async (req, res) => {
  const userId = hasValidSession(req);
  if (!userId) return res.status(401).json({ error: 'Not signed in' });
  if (!pendingRegistrationChallenge) return res.status(400).json({ error: 'No registration in progress' });

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: req.body,
      expectedChallenge: pendingRegistrationChallenge,
      expectedOrigin: getOrigin(req),
      expectedRPID: getRpID(req),
    });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  pendingRegistrationChallenge = null;
  if (!verification.verified) return res.status(400).json({ error: 'Verification failed' });

  const { credential } = verification.registrationInfo;
  const publicKeyB64 = Buffer.from(credential.publicKey).toString('base64url');
  const deviceLabel = req.body.deviceLabel || 'Unnamed device';
  await pool.query(
    `INSERT INTO webauthn_credentials (credential_id, public_key, counter, device_label, user_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [credential.id, publicKeyB64, credential.counter, deviceLabel, userId]
  );
  res.json({ ok: true });
});

router.get('/webauthn/credentials', async (req, res) => {
  const userId = hasValidSession(req);
  if (!userId) return res.status(401).json({ error: 'Not signed in' });
  const { rows } = await pool.query(
    'SELECT id, device_label, created_at, last_used_at FROM webauthn_credentials WHERE user_id = $1 ORDER BY created_at DESC',
    [userId]
  );
  res.json(rows);
});

router.delete('/webauthn/credentials/:id', async (req, res) => {
  const userId = hasValidSession(req);
  if (!userId) return res.status(401).json({ error: 'Not signed in' });
  await pool.query('DELETE FROM webauthn_credentials WHERE id = $1 AND user_id = $2', [req.params.id, userId]);
  res.status(204).end();
});

// --- Touch ID / Face ID sign-in - deliberately public (no session required), since the
// whole point is signing in without one yet. No user is known going in, so this checks
// the single shared credentials table (scoped by whichever user_id the matched row
// carries) rather than looping per-tenant databases like the old two-tenant model did. --

router.get('/webauthn/authentication-options', async (req, res) => {
  const { rows } = await pool.query('SELECT credential_id FROM webauthn_credentials');
  if (!rows.length) return res.status(404).json({ error: 'No Touch ID / Face ID device registered yet' });
  const options = await generateAuthenticationOptions({
    rpID: getRpID(req),
    allowCredentials: rows.map((r) => ({ id: r.credential_id })),
    userVerification: 'required',
  });
  pendingAuthChallenge = options.challenge;
  res.json(options);
});

router.post('/webauthn/authentication-verify', async (req, res) => {
  if (!pendingAuthChallenge) return res.status(400).json({ error: 'No authentication in progress' });

  const { rows } = await pool.query('SELECT * FROM webauthn_credentials WHERE credential_id = $1', [req.body.id]);
  const stored = rows[0];
  if (!stored) return res.status(400).json({ error: 'Unrecognized credential' });

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: req.body,
      expectedChallenge: pendingAuthChallenge,
      expectedOrigin: getOrigin(req),
      expectedRPID: getRpID(req),
      credential: {
        id: stored.credential_id,
        publicKey: new Uint8Array(Buffer.from(stored.public_key, 'base64url')),
        counter: Number(stored.counter),
      },
    });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  pendingAuthChallenge = null;
  if (!verification.verified) return res.status(400).json({ error: 'Verification failed' });

  await pool.query('UPDATE webauthn_credentials SET counter = $1, last_used_at = now() WHERE id = $2', [
    verification.authenticationInfo.newCounter,
    stored.id,
  ]);
  setSessionCookie(res, stored.user_id);
  res.json({ ok: true });
});

module.exports = router;
