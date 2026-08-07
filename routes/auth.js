const express = require('express');
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require('@simplewebauthn/server');
const { getPool } = require('../db');
const { setSessionCookie, clearSessionCookie, hasValidSession, identifyTenant } = require('../lib/auth');

const router = express.Router();

// Single in-flight ceremony at a time is fine - one shared dashboard, not a multi-user
// service. A fresh options call always overwrites whatever challenge preceded it.
let pendingRegistrationChallenge = null;
let pendingAuthChallenge = null;

function getRpID(req) {
  return req.hostname;
}
function getOrigin(req) {
  return `${req.protocol}://${req.get('host')}`;
}

// This whole router is mounted before the global session-gate middleware in
// server.js (login has to be reachable pre-auth), so unlike the rest of the
// app it can't rely on that middleware to have already set req.tenant/req.db -
// each handler below resolves its own tenant from whatever signal it has
// (password, existing session cookie, or - for WebAuthn sign-in, which by
// definition happens before any tenant is known - by checking every tenant's
// own credentials table for a match).
const TENANTS = ['default', 'j'].filter((t) => getPool(t));

router.get('/session', (req, res) => {
  res.json({ authenticated: !!hasValidSession(req) });
});

router.post('/login', (req, res) => {
  const { password } = req.body || {};
  const tenant = identifyTenant(password);
  if (!tenant) {
    return res.status(401).json({ error: 'Incorrect password' });
  }
  setSessionCookie(res, tenant);
  res.json({ ok: true });
});

router.post('/logout', (req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

// --- Touch ID / Face ID registration - requires an existing session, i.e. you log in
// with the password once and then bind a device from inside the app. -----------------

router.get('/webauthn/registration-options', async (req, res) => {
  const tenant = hasValidSession(req);
  if (!tenant) return res.status(401).json({ error: 'Not signed in' });
  const { rows } = await getPool(tenant).query('SELECT credential_id FROM webauthn_credentials');
  const options = await generateRegistrationOptions({
    rpName: 'Life Dashboard',
    rpID: getRpID(req),
    userName: 'dashboard',
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
  const tenant = hasValidSession(req);
  if (!tenant) return res.status(401).json({ error: 'Not signed in' });
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
  await getPool(tenant).query(
    `INSERT INTO webauthn_credentials (credential_id, public_key, counter, device_label)
     VALUES ($1, $2, $3, $4)`,
    [credential.id, publicKeyB64, credential.counter, deviceLabel]
  );
  res.json({ ok: true });
});

router.get('/webauthn/credentials', async (req, res) => {
  const tenant = hasValidSession(req);
  if (!tenant) return res.status(401).json({ error: 'Not signed in' });
  const { rows } = await getPool(tenant).query(
    'SELECT id, device_label, created_at, last_used_at FROM webauthn_credentials ORDER BY created_at DESC'
  );
  res.json(rows);
});

router.delete('/webauthn/credentials/:id', async (req, res) => {
  const tenant = hasValidSession(req);
  if (!tenant) return res.status(401).json({ error: 'Not signed in' });
  await getPool(tenant).query('DELETE FROM webauthn_credentials WHERE id = $1', [req.params.id]);
  res.status(204).end();
});

// --- Touch ID / Face ID sign-in - deliberately public (no session required), since the
// whole point is signing in without one yet. No tenant is known going in, so both steps
// below check every tenant's own credentials table and use whichever one matches. -------

router.get('/webauthn/authentication-options', async (req, res) => {
  const perTenantRows = await Promise.all(TENANTS.map((t) => getPool(t).query('SELECT credential_id FROM webauthn_credentials')));
  const rows = perTenantRows.flatMap((r) => r.rows);
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

  let tenant = null;
  let stored = null;
  for (const t of TENANTS) {
    const { rows } = await getPool(t).query('SELECT * FROM webauthn_credentials WHERE credential_id = $1', [req.body.id]);
    if (rows[0]) {
      tenant = t;
      stored = rows[0];
      break;
    }
  }
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

  await getPool(tenant).query('UPDATE webauthn_credentials SET counter = $1, last_used_at = now() WHERE id = $2', [
    verification.authenticationInfo.newCounter,
    stored.id,
  ]);
  setSessionCookie(res, tenant);
  res.json({ ok: true });
});

module.exports = router;
