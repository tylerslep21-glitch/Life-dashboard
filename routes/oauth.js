const express = require('express');
const crypto = require('crypto');
const { pool } = require('../db');
const { verifyPassword } = require('../lib/auth');
const { rateLimit } = require('../lib/rateLimit');

// This is a password check (gating a new MCP connector authorization) like
// login/change-password elsewhere, so it gets the same brute-force
// protection - see lib/rateLimit.js.
const oauthAuthorizeLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, keyPrefix: 'oauth-authorize' });

// This connector exists to let Claude push Robinhood/agent-status data (see
// lib/mcp-server.js), which is deliberately tied to the 'tslep' account only
// (see routes/robinhood.js) - so authorizing a new MCP client is gated by
// tslep's password specifically, not "any account on this dashboard".
async function checkPassword(password) {
  const { rows } = await pool.query(
    "SELECT password_hash, password_salt FROM users WHERE username = 'tslep'"
  );
  const user = rows[0];
  if (!user) return false;
  return verifyPassword(password, user.password_hash, user.password_salt);
}

const router = express.Router();

// In-memory only - a code is used within seconds of being issued, during one
// interactive OAuth dance. A server restart mid-flow just means the user retries.
const pendingCodes = new Map(); // code -> { clientId, redirectUri, codeChallenge, expiresAt }
const CODE_TTL_MS = 5 * 60 * 1000;

function origin(req) {
  return `${req.protocol}://${req.get('host')}`;
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

// --- Discovery (RFC 8414 / MCP Authorization spec) --------------------------------

router.get('/.well-known/oauth-protected-resource', (req, res) => {
  res.json({
    resource: `${origin(req)}/mcp`,
    authorization_servers: [origin(req)],
  });
});

router.get('/.well-known/oauth-authorization-server', (req, res) => {
  const iss = origin(req);
  res.json({
    issuer: iss,
    authorization_endpoint: `${iss}/oauth/authorize`,
    token_endpoint: `${iss}/oauth/token`,
    registration_endpoint: `${iss}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
  });
});

// --- Dynamic Client Registration (RFC 7591) ----------------------------------------

router.post('/oauth/register', async (req, res) => {
  const { redirect_uris, client_name } = req.body || {};
  if (!Array.isArray(redirect_uris) || redirect_uris.length === 0) {
    return res.status(400).json({ error: 'invalid_client_metadata', error_description: 'redirect_uris is required' });
  }
  const clientId = randomToken(16);
  await pool.query(
    `INSERT INTO oauth_clients (client_id, redirect_uris, client_name) VALUES ($1, $2, $3)`,
    [clientId, JSON.stringify(redirect_uris), client_name || null]
  );
  res.status(201).json({
    client_id: clientId,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    redirect_uris,
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code'],
    response_types: ['code'],
  });
});

// --- Authorization endpoint - gated by the same dashboard password as everything else,
// not a separate account system (single-user app). -----------------------------------

function renderAuthorizeForm({ error } = {}) {
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Authorize - Overview</title>
<style>body{font-family:system-ui,sans-serif;max-width:360px;margin:80px auto;padding:0 20px}
h1{font-size:1.1rem}input{width:100%;padding:10px;margin:12px 0;box-sizing:border-box;font-size:1rem}
button{width:100%;padding:10px;font-size:1rem;cursor:pointer}.err{color:#c00;font-size:0.9rem}</style>
</head><body>
<h1>Authorize this connection to your Overview account</h1>
<p>Enter your dashboard password to allow this connector access.</p>
${error ? `<p class="err">${error}</p>` : ''}
<form method="POST">
<input type="hidden" name="client_id" value="__CLIENT_ID__">
<input type="hidden" name="redirect_uri" value="__REDIRECT_URI__">
<input type="hidden" name="state" value="__STATE__">
<input type="hidden" name="code_challenge" value="__CODE_CHALLENGE__">
<input type="hidden" name="code_challenge_method" value="__CODE_CHALLENGE_METHOD__">
<input type="password" name="password" placeholder="Dashboard password" autofocus required>
<button type="submit">Authorize</button>
</form>
</body></html>`;
}

router.get('/oauth/authorize', async (req, res) => {
  const { client_id, redirect_uri, state, code_challenge, code_challenge_method, response_type } = req.query;
  if (response_type !== 'code' || !client_id || !redirect_uri || !code_challenge) {
    return res.status(400).send('Missing or invalid OAuth parameters.');
  }
  const { rows } = await pool.query('SELECT redirect_uris FROM oauth_clients WHERE client_id = $1', [client_id]);
  const client = rows[0];
  if (!client || !client.redirect_uris.includes(redirect_uri)) {
    return res.status(400).send('Unknown client or redirect_uri.');
  }
  const html = renderAuthorizeForm()
    .replace('__CLIENT_ID__', client_id)
    .replace('__REDIRECT_URI__', redirect_uri)
    .replace('__STATE__', state || '')
    .replace('__CODE_CHALLENGE__', code_challenge)
    .replace('__CODE_CHALLENGE_METHOD__', code_challenge_method || 'S256');
  res.set('Content-Type', 'text/html').send(html);
});

router.post('/oauth/authorize', express.urlencoded({ extended: false }), oauthAuthorizeLimiter, async (req, res) => {
  const { client_id, redirect_uri, state, code_challenge, code_challenge_method, password } = req.body || {};
  if (!(await checkPassword(password))) {
    const html = renderAuthorizeForm({ error: 'Incorrect password.' })
      .replace('__CLIENT_ID__', client_id || '')
      .replace('__REDIRECT_URI__', redirect_uri || '')
      .replace('__STATE__', state || '')
      .replace('__CODE_CHALLENGE__', code_challenge || '')
      .replace('__CODE_CHALLENGE_METHOD__', code_challenge_method || 'S256');
    return res.status(401).set('Content-Type', 'text/html').send(html);
  }
  const code = randomToken(24);
  pendingCodes.set(code, {
    clientId: client_id,
    redirectUri: redirect_uri,
    codeChallenge: code_challenge,
    expiresAt: Date.now() + CODE_TTL_MS,
  });
  const redirect = new URL(redirect_uri);
  redirect.searchParams.set('code', code);
  if (state) redirect.searchParams.set('state', state);
  res.redirect(redirect.toString());
});

// --- Token endpoint (authorization_code + PKCE) ------------------------------------

router.post('/oauth/token', express.urlencoded({ extended: false }), async (req, res) => {
  const { grant_type, code, redirect_uri, client_id, code_verifier } = req.body || {};
  if (grant_type !== 'authorization_code') {
    return res.status(400).json({ error: 'unsupported_grant_type' });
  }
  const pending = pendingCodes.get(code);
  if (!pending || pending.expiresAt < Date.now()) {
    pendingCodes.delete(code);
    return res.status(400).json({ error: 'invalid_grant', error_description: 'Code expired or unknown' });
  }
  if (pending.clientId !== client_id || pending.redirectUri !== redirect_uri) {
    return res.status(400).json({ error: 'invalid_grant', error_description: 'client_id/redirect_uri mismatch' });
  }
  const computedChallenge = crypto.createHash('sha256').update(code_verifier || '').digest('base64url');
  if (computedChallenge !== pending.codeChallenge) {
    return res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE verification failed' });
  }
  pendingCodes.delete(code); // single use

  const accessToken = randomToken(32);
  await pool.query('INSERT INTO oauth_tokens (token, client_id) VALUES ($1, $2)', [accessToken, client_id]);
  res.json({ access_token: accessToken, token_type: 'Bearer' });
});

module.exports = router;
