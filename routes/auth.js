const express = require('express');
const crypto = require('crypto');
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require('@simplewebauthn/server');
const { pool } = require('../db');
const { setSessionCookie, clearSessionCookie, hasValidSession, hashPassword, verifyPassword } = require('../lib/auth');
const { sendEmail } = require('../lib/email');
const { sendVerificationEmail } = require('../lib/verification');
const { rateLimit } = require('../lib/rateLimit');

const router = express.Router();

const INVITE_CODE = process.env.INVITE_CODE;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RESET_TOKEN_TTL_MS = 30 * 60 * 1000; // 30 minutes

// Generous enough that a real person mistyping a password or invite code a
// few times never notices, restrictive enough to make brute-forcing a
// password/invite code or spamming signups/emails impractical. Per IP, not
// per account - see lib/rateLimit.js.
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, keyPrefix: 'login' });
const signupLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 5, keyPrefix: 'signup' });
const forgotPasswordLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 5, keyPrefix: 'forgot-password' });
const resetPasswordLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 10, keyPrefix: 'reset-password' });
const resendVerificationLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 5, keyPrefix: 'resend-verification' });
const changePasswordLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, keyPrefix: 'change-password' });

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

router.post('/signup', signupLimiter, async (req, res) => {
  const { username, email, password, invite_code } = req.body || {};
  if (!INVITE_CODE) {
    return res.status(500).json({ error: 'Signup is not configured' });
  }
  if (invite_code !== INVITE_CODE) {
    return res.status(403).json({ error: 'Invalid invite code' });
  }
  if (typeof username !== 'string' || !/^[a-z0-9_]{3,32}$/i.test(username)) {
    return res.status(400).json({ error: 'Username must be 3-32 letters, numbers, or underscores' });
  }
  if (typeof email !== 'string' || !EMAIL_RE.test(email)) {
    return res.status(400).json({ error: 'A valid email is required (used for password resets)' });
  }
  if (typeof password !== 'string' || password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  const normalizedEmail = email.toLowerCase();
  const { rows: existing } = await pool.query(
    'SELECT username, email FROM users WHERE username = $1 OR email = $2',
    [username.toLowerCase(), normalizedEmail]
  );
  if (existing.some((u) => u.username === username.toLowerCase())) {
    return res.status(409).json({ error: 'That username is taken' });
  }
  if (existing.some((u) => u.email === normalizedEmail)) {
    return res.status(409).json({ error: 'That email is already in use' });
  }

  const { hash, salt } = hashPassword(password);
  // widget_layout starts as an explicit empty array, not left NULL - a fresh
  // account sees a blank dashboard and adds widgets deliberately via the
  // edit-mode gallery, rather than starting with everything already on.
  // NULL still means "no saved layout" for accounts that predate this and
  // keeps defaulting to all-enabled (see resolveWidgetLayout() in
  // dashboard.js) - only new signups get the explicit [] treatment.
  const { rows } = await pool.query(
    "INSERT INTO users (username, email, password_hash, password_salt, widget_layout) VALUES ($1, $2, $3, $4, '[]') RETURNING id",
    [username.toLowerCase(), normalizedEmail, hash, salt]
  );
  setSessionCookie(res, rows[0].id);
  const sendResult = await sendVerificationEmail(rows[0].id, normalizedEmail, username.toLowerCase(), getOrigin(req));
  res.status(201).json({ ok: true, email_send_failed: !sendResult.ok });
});

router.post('/login', loginLimiter, async (req, res) => {
  const { identifier, password } = req.body || {};
  if (typeof identifier !== 'string' || typeof password !== 'string') {
    return res.status(401).json({ error: 'Incorrect username/email or password' });
  }
  const { rows } = await pool.query(
    'SELECT id, password_hash, password_salt FROM users WHERE username = $1 OR email = $1',
    [identifier.toLowerCase()]
  );
  const user = rows[0];
  if (!user || !verifyPassword(password, user.password_hash, user.password_salt)) {
    return res.status(401).json({ error: 'Incorrect username/email or password' });
  }
  setSessionCookie(res, user.id);
  res.json({ ok: true });
});

// Deliberately responds the same way whether or not the email matched an
// account - and only after actually sending (or not) the email, not before -
// so an unauthenticated caller can't use this to test which emails have
// accounts here.
router.post('/forgot-password', forgotPasswordLimiter, async (req, res) => {
  const { email } = req.body || {};
  if (typeof email === 'string' && EMAIL_RE.test(email)) {
    const { rows } = await pool.query('SELECT id, username FROM users WHERE email = $1', [email.toLowerCase()]);
    const user = rows[0];
    if (user) {
      const token = crypto.randomBytes(32).toString('base64url');
      const tokenHash = crypto.createHash('sha256').update(token).digest('base64url');
      await pool.query(
        'INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
        [user.id, tokenHash, new Date(Date.now() + RESET_TOKEN_TTL_MS)]
      );
      const resetUrl = `${getOrigin(req)}/reset-password.html?token=${token}`;
      sendEmail(
        email.toLowerCase(),
        'Reset your Overview password',
        `<p>Hi ${user.username},</p><p><a href="${resetUrl}">Click here to reset your password</a>. This link expires in 30 minutes and can only be used once.</p><p>If you didn't request this, you can ignore this email.</p>`
      ).catch(() => {});
    }
  }
  res.json({ ok: true });
});

router.post('/reset-password', resetPasswordLimiter, async (req, res) => {
  const { token, new_password: newPassword } = req.body || {};
  if (typeof token !== 'string' || !token) {
    return res.status(400).json({ error: 'Missing reset token' });
  }
  if (typeof newPassword !== 'string' || newPassword.length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters' });
  }
  const tokenHash = crypto.createHash('sha256').update(token).digest('base64url');
  const { rows } = await pool.query(
    `SELECT id, user_id FROM password_reset_tokens
     WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()`,
    [tokenHash]
  );
  const record = rows[0];
  if (!record) {
    return res.status(400).json({ error: 'This reset link is invalid or has expired' });
  }
  const { hash, salt } = hashPassword(newPassword);
  await pool.query('UPDATE users SET password_hash = $1, password_salt = $2 WHERE id = $3', [hash, salt, record.user_id]);
  await pool.query('UPDATE password_reset_tokens SET used_at = now() WHERE id = $1', [record.id]);
  res.json({ ok: true });
});

// Hit directly from the emailed link - no session required (confirming an
// email shouldn't need you to still be logged in on the same device/browser
// that requested it). Redirects to a static page rather than returning JSON
// since a real person clicking a link expects a page, not an API response.
router.get('/verify-email', async (req, res) => {
  const { token } = req.query;
  if (typeof token !== 'string' || !token) {
    return res.redirect('/verify-email.html?status=error');
  }
  const tokenHash = crypto.createHash('sha256').update(token).digest('base64url');
  const { rows } = await pool.query(
    `SELECT id, user_id FROM email_verification_tokens
     WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()`,
    [tokenHash]
  );
  const record = rows[0];
  if (!record) {
    return res.redirect('/verify-email.html?status=error');
  }
  await pool.query('UPDATE users SET email_verified = true WHERE id = $1', [record.user_id]);
  await pool.query('UPDATE email_verification_tokens SET used_at = now() WHERE id = $1', [record.id]);
  res.redirect('/verify-email.html?status=success');
});

router.post('/resend-verification', resendVerificationLimiter, async (req, res) => {
  const userId = hasValidSession(req);
  if (!userId) return res.status(401).json({ error: 'Not signed in' });
  const { rows } = await pool.query('SELECT username, email, email_verified FROM users WHERE id = $1', [userId]);
  const user = rows[0];
  if (!user || !user.email) return res.status(400).json({ error: 'No email set yet' });
  if (user.email_verified) return res.json({ ok: true, already_verified: true });
  const sendResult = await sendVerificationEmail(userId, user.email, user.username, getOrigin(req));
  res.json({ ok: true, email_send_failed: !sendResult.ok });
});

router.post('/change-password', changePasswordLimiter, async (req, res) => {
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
    rpName: 'Overview',
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
