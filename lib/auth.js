// Session cookies + WebAuthn (Touch ID / Face ID) helpers, now supporting two
// independent logins ("tenants") sharing this one running app: 'default' (the
// original dashboard) and 'j' (a second person's own data, own password, own
// database - see db.js). Neither is a real multi-user account system: each
// tenant is still a single shared password, same as before, just two of them
// instead of one.
//
// Sessions are a stateless signed cookie (HMAC-SHA256), not a DB-backed session
// table - there's nothing to revoke per-session because each tenant only has
// one shared identity; "log out everywhere" is rotating that tenant's password
// env var (which also changes its derived session secret below, invalidating
// every outstanding cookie for that tenant at once - the other tenant's
// sessions are unaffected, since each tenant's secret is derived only from its
// own password).

const crypto = require('crypto');

const TENANT_PASSWORDS = { default: process.env.DASHBOARD_PASSWORD };
if (process.env.DASHBOARD_PASSWORD_J) TENANT_PASSWORDS.j = process.env.DASHBOARD_PASSWORD_J;

const SESSION_SECRETS = {};
for (const [tenant, password] of Object.entries(TENANT_PASSWORDS)) {
  SESSION_SECRETS[tenant] = crypto.createHash('sha256').update(`${password}:session:${tenant}`).digest();
}

const SESSION_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000; // 90 days - "don't ask again" is the point
const COOKIE_NAME = 'dashboard_session';

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlToBuffer(str) {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (str.length % 4)) % 4);
  return Buffer.from(padded, 'base64');
}

function sign(payload, tenant) {
  return crypto.createHmac('sha256', SESSION_SECRETS[tenant]).update(payload).digest();
}

function createSessionToken(tenant) {
  const payload = JSON.stringify({ exp: Date.now() + SESSION_MAX_AGE_MS, tenant });
  const payloadB64 = base64url(Buffer.from(payload));
  const sig = base64url(sign(payloadB64, tenant));
  return `${payloadB64}.${sig}`;
}

// Returns the tenant string if the token is valid, otherwise null. The
// tenant claimed inside the payload is untrusted until the signature check
// below (keyed on that same claimed tenant) actually passes - a token can't
// be forged as tenant A using tenant B's secret, since verifying re-derives
// the expected signature from whichever tenant the payload itself claims,
// and that tenant's secret is derived only from that tenant's own password.
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
  const { exp, tenant } = payload;
  if (!SESSION_SECRETS[tenant]) return null;
  const expectedSig = base64url(sign(payloadB64, tenant));
  const a = Buffer.from(sig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  if (typeof exp !== 'number' || Date.now() >= exp) return null;
  return tenant;
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

function setSessionCookie(res, tenant) {
  const token = createSessionToken(tenant);
  const secure = process.env.NODE_ENV !== 'development';
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=${token}; HttpOnly; Path=/; Max-Age=${Math.floor(SESSION_MAX_AGE_MS / 1000)}; SameSite=Lax${secure ? '; Secure' : ''}`
  );
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`);
}

// Returns the authenticated tenant string, or null if there's no valid
// session. Callers that only need a yes/no check can still just test
// truthiness - existing call sites like `if (hasValidSession(req))` keep
// working unchanged; ones that need to route to the right database (see
// server.js) use the returned tenant.
function hasValidSession(req) {
  const cookies = parseCookies(req.headers.cookie);
  return verifySessionToken(cookies[COOKIE_NAME]);
}

// Kept alive for API routes only (never the browser UI) so existing scripted callers -
// e.g. Claude pushing a Robinhood snapshot from a chat session via
// `Authorization: Basic <base64 of "anything:DASHBOARD_PASSWORD">` - don't silently
// break now that the browser-facing login uses sessions/Touch ID instead. Returns the
// matched tenant string, or null.
function hasValidBasicAuth(req) {
  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme !== 'Basic' || !encoded) return null;
  const decoded = Buffer.from(encoded, 'base64').toString('utf8');
  const passwordPart = decoded.split(':').slice(1).join(':');
  return identifyTenant(passwordPart);
}

// Compares against every configured tenant password (not just the first
// match with an early return) so a guess's timing doesn't hint at which
// tenant, if any, it's closer to.
function identifyTenant(password) {
  let matched = null;
  for (const [tenant, tenantPassword] of Object.entries(TENANT_PASSWORDS)) {
    if (typeof password === 'string' && password.length === tenantPassword.length) {
      if (crypto.timingSafeEqual(Buffer.from(password), Buffer.from(tenantPassword))) matched = tenant;
    } else {
      // Still run a same-shape comparison so a wrong-length guess doesn't
      // return measurably faster than a right-length one.
      crypto.timingSafeEqual(Buffer.from(tenantPassword), Buffer.from(tenantPassword));
    }
  }
  return matched;
}

module.exports = {
  base64url,
  base64urlToBuffer,
  setSessionCookie,
  clearSessionCookie,
  hasValidSession,
  hasValidBasicAuth,
  identifyTenant,
  COOKIE_NAME,
};
