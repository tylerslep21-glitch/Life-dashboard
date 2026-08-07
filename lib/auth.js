// Session cookies + password hashing for real multi-user accounts (replacing the old
// two-hardcoded-tenant model - see db.js for the users table and migrate-to-users.js
// for how the two original logins became real accounts).
//
// Sessions are a stateless signed cookie (HMAC-SHA256) carrying { user_id, exp } -
// there's nothing to revoke per-session since there's no server-side session store;
// "log out everywhere" for everyone at once would mean rotating SESSION_SECRET
// (invalidating every outstanding cookie for every user), which isn't exposed as a
// per-user action since it isn't scoped to one.

const crypto = require('crypto');

const SESSION_SECRET = process.env.SESSION_SECRET;
const SESSION_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000; // 90 days - "don't ask again" is the point
const COOKIE_NAME = 'dashboard_session';
const SCRYPT_KEYLEN = 64;

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

function createSessionToken(userId) {
  const payload = JSON.stringify({ exp: Date.now() + SESSION_MAX_AGE_MS, user_id: userId });
  const payloadB64 = base64url(Buffer.from(payload));
  const sig = base64url(sign(payloadB64));
  return `${payloadB64}.${sig}`;
}

// Returns the numeric user_id if the token is valid, otherwise null.
function verifySessionToken(token) {
  if (!token || typeof token !== 'string') return null;
  const [payloadB64, sig] = token.split('.');
  if (!payloadB64 || !sig) return null;
  let payload;
  try {
    payload = JSON.parse(base64urlToBuffer(payloadB64).toString('utf8'));
  } catch {
    return null;
  }
  const { exp, user_id: userId } = payload;
  if (typeof userId !== 'number') return null;
  const expectedSig = base64url(sign(payloadB64));
  const a = Buffer.from(sig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  if (typeof exp !== 'number' || Date.now() >= exp) return null;
  return userId;
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

function setSessionCookie(res, userId) {
  const token = createSessionToken(userId);
  const secure = process.env.NODE_ENV !== 'development';
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=${token}; HttpOnly; Path=/; Max-Age=${Math.floor(SESSION_MAX_AGE_MS / 1000)}; SameSite=Lax${secure ? '; Secure' : ''}`
  );
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`);
}

// Returns the authenticated user_id, or null if there's no valid session.
function hasValidSession(req) {
  const cookies = parseCookies(req.headers.cookie);
  return verifySessionToken(cookies[COOKIE_NAME]);
}

// scrypt (Node core, no new dependency) instead of bcrypt/argon2.
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex');
  return { hash, salt };
}

function verifyPassword(password, hash, salt) {
  if (typeof password !== 'string' || !password) return false;
  const candidate = crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
  const expected = Buffer.from(hash, 'hex');
  if (candidate.length !== expected.length) return false;
  return crypto.timingSafeEqual(candidate, expected);
}

// Kept alive for API routes only (never the browser UI) so scripted callers - e.g.
// Claude pushing a Robinhood snapshot from a chat session via
// `Authorization: Basic <base64 of "anything:password">` - don't need a session
// cookie. Deliberately checks only against the 'tslep' account (not every user):
// Robinhood data and the MCP push path are tied specifically to that account for
// data-isolation reasons (see routes/robinhood.js), so this is the one password
// that's meaningful here regardless of who else signs up. Returns tslep's user_id,
// or null.
async function hasValidBasicAuth(req, pool) {
  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme !== 'Basic' || !encoded) return null;
  const decoded = Buffer.from(encoded, 'base64').toString('utf8');
  const passwordPart = decoded.split(':').slice(1).join(':');
  const { rows } = await pool.query(
    "SELECT id, password_hash, password_salt FROM users WHERE username = 'tslep'"
  );
  const user = rows[0];
  if (!user) return null;
  if (!verifyPassword(passwordPart, user.password_hash, user.password_salt)) return null;
  return user.id;
}

module.exports = {
  base64url,
  base64urlToBuffer,
  setSessionCookie,
  clearSessionCookie,
  hasValidSession,
  hasValidBasicAuth,
  hashPassword,
  verifyPassword,
  createSessionToken,
  verifySessionToken,
  COOKIE_NAME,
};
