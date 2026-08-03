// Session cookies + WebAuthn (Touch ID / Face ID) helpers for the single shared
// dashboard login. No user accounts - one password, and any number of registered
// platform-authenticator credentials that are equally valid ways in.
//
// Sessions are a stateless signed cookie (HMAC-SHA256), not a DB-backed session table -
// there's nothing to revoke per-session because there's only one shared identity; "log
// out everywhere" is just rotating DASHBOARD_PASSWORD (which also changes the derived
// session secret below, invalidating every outstanding cookie at once).

const crypto = require('crypto');

const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD;
const SESSION_SECRET = crypto.createHash('sha256').update(`${DASHBOARD_PASSWORD}:session`).digest();
const SESSION_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000; // 90 days - "don't ask again" is the point
const COOKIE_NAME = 'dashboard_session';

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlToBuffer(str) {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (str.length % 4)) % 4);
  return Buffer.from(padded, 'base64');
}

function sign(payload) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest();
}

function createSessionToken() {
  const payload = JSON.stringify({ exp: Date.now() + SESSION_MAX_AGE_MS });
  const payloadB64 = base64url(Buffer.from(payload));
  const sig = base64url(sign(payloadB64));
  return `${payloadB64}.${sig}`;
}

function verifySessionToken(token) {
  if (!token || typeof token !== 'string') return false;
  const [payloadB64, sig] = token.split('.');
  if (!payloadB64 || !sig) return false;
  const expectedSig = base64url(sign(payloadB64));
  // Timing-safe compare, and both buffers must be equal length or timingSafeEqual throws.
  const a = Buffer.from(sig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  try {
    const { exp } = JSON.parse(base64urlToBuffer(payloadB64).toString('utf8'));
    return typeof exp === 'number' && Date.now() < exp;
  } catch {
    return false;
  }
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function setSessionCookie(res) {
  const token = createSessionToken();
  const secure = process.env.NODE_ENV !== 'development';
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=${token}; HttpOnly; Path=/; Max-Age=${Math.floor(SESSION_MAX_AGE_MS / 1000)}; SameSite=Lax${secure ? '; Secure' : ''}`
  );
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`);
}

function hasValidSession(req) {
  const cookies = parseCookies(req.headers.cookie);
  return verifySessionToken(cookies[COOKIE_NAME]);
}

// Kept alive for API routes only (never the browser UI) so existing scripted callers -
// e.g. Claude pushing a Robinhood snapshot from a chat session via
// `Authorization: Basic <base64 of "anything:DASHBOARD_PASSWORD">` - don't silently
// break now that the browser-facing login uses sessions/Touch ID instead.
function hasValidBasicAuth(req) {
  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme !== 'Basic' || !encoded) return false;
  const decoded = Buffer.from(encoded, 'base64').toString('utf8');
  const passwordPart = decoded.split(':').slice(1).join(':');
  return checkPassword(passwordPart);
}

function checkPassword(password) {
  if (typeof password !== 'string' || password.length !== DASHBOARD_PASSWORD.length) {
    // Still run a comparison of matching length so a wrong-length guess doesn't
    // return measurably faster than a right-length one.
    crypto.timingSafeEqual(Buffer.from(DASHBOARD_PASSWORD), Buffer.from(DASHBOARD_PASSWORD));
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(password), Buffer.from(DASHBOARD_PASSWORD));
}

module.exports = {
  base64url,
  base64urlToBuffer,
  setSessionCookie,
  clearSessionCookie,
  hasValidSession,
  hasValidBasicAuth,
  checkPassword,
  COOKIE_NAME,
};
