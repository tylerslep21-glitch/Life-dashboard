// Email confirmation: generates a token, stores only its hash (same
// reasoning as password_reset_tokens - see db.js), and emails a link that
// hits GET /api/auth/verify-email directly (no login required to click it,
// since confirming an email shouldn't require an active session). Shared
// between routes/auth.js (signup, resend) and routes/me.js (changing email)
// so both go through the same token shape and email copy.

const crypto = require('crypto');
const { pool } = require('../db');
const { sendEmail } = require('./email');

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours - no urgency, unlike a password reset

async function sendVerificationEmail(userId, email, username, origin) {
  const token = crypto.randomBytes(32).toString('base64url');
  const tokenHash = crypto.createHash('sha256').update(token).digest('base64url');
  await pool.query(
    'INSERT INTO email_verification_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
    [userId, tokenHash, new Date(Date.now() + TOKEN_TTL_MS)]
  );
  const verifyUrl = `${origin}/api/auth/verify-email?token=${token}`;
  return sendEmail(
    email,
    'Confirm your email - Overview',
    `<p>Hi ${username},</p><p><a href="${verifyUrl}">Click here to confirm your email address</a>. This link expires in 24 hours.</p><p>If you didn't request this, you can ignore it.</p>`
  );
}

module.exports = { sendVerificationEmail };
