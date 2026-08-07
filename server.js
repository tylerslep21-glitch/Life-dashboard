const express = require('express');
const path = require('path');
const { migrate, pool } = require('./db');
const { hasValidSession, hasValidBasicAuth } = require('./lib/auth');
const { handleMcpRequest } = require('./lib/mcp-server');
const { logError } = require('./lib/errorLog');

const app = express();
const PORT = process.env.PORT || 3000;

if (!process.env.SESSION_SECRET) {
  console.error('FATAL: SESSION_SECRET env var is not set. Refusing to start unprotected.');
  process.exit(1);
}
if (!process.env.DATA_ENCRYPTION_KEY) {
  console.error('FATAL: DATA_ENCRYPTION_KEY env var is not set - finance/Robinhood writes would fail at runtime.');
  process.exit(1);
}

// Self-hosted error monitoring (see lib/errorLog.js, routes/errors.js, and the
// admin-only Errors widget on the dashboard). Most routes in this app are
// `async (req, res) => {...}` without their own try/catch, and Express 4
// doesn't route a rejected promise from an async handler to error-handling
// middleware on its own - it surfaces here, at the process level, instead.
// That means a request whose handler throws will still hang without a
// response (a pre-existing behavior this doesn't change), but the error
// itself is now captured for visibility instead of silently vanishing into
// the Railway logs.
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  logError('server', err.message, err.stack);
});
process.on('unhandledRejection', (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  console.error('Unhandled rejection:', err);
  logError('server', err.message, err.stack);
});

// Railway terminates TLS and forwards plain HTTP internally - without trusting the proxy,
// req.protocol always reports 'http', which breaks WebAuthn's strict origin check (it
// requires an exact https:// match) even though the browser is really on https.
app.set('trust proxy', 1);

app.use(express.json({ limit: '6mb' })); // room for a base64-encoded countdown photo

// MCP endpoint for Claude Code cloud routines - lets them push data here without any
// raw outbound network access, which they structurally don't have (see lib/mcp-server.js
// for why). Registered as a custom connector at claude.ai/customize/connectors; that
// setup flow does real OAuth discovery + dynamic client registration (see routes/oauth.js)
// rather than a static shared secret, so this - and the OAuth routes below - must run
// before the session/API auth gate, and are unauthenticated at the Express-route level
// (auth happens per-request via the Bearer token, checked inside handleMcpRequest).
app.use(require('./routes/oauth'));
app.post('/mcp', (req, res, next) => handleMcpRequest(req, res).catch(next));

// Auth endpoints (password login, Touch ID/Face ID registration+sign-in, session check)
// are deliberately unauthenticated - that's the whole point of a login flow.
app.use('/api/auth', require('./routes/auth'));

// A handful of static assets have to be reachable before sign-in: the login page itself,
// its script, the shared stylesheet (so it isn't unstyled), and PWA icons/manifest.
const PUBLIC_FILES = new Set([
  '/login.html',
  '/webauthn.js',
  '/styles.css',
  '/manifest.json',
  '/apple-touch-icon.png',
  '/icon-192.png',
  '/icon-512.png',
  '/favicon.png',
  '/favicon-64.png',
  '/logo-email.png', // fetched unauthenticated by email clients rendering account emails
  '/terms.html',
  '/privacy.html',
  '/reset-password.html',
  '/verify-email.html',
]);
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.use(async (req, res, next) => {
  if (PUBLIC_FILES.has(req.path)) return next();
  // hasValidSession/hasValidBasicAuth return the authenticated user's id (or
  // null) - attach it plus the single shared DB pool to the request, so every
  // route downstream scopes its own queries by req.userId.
  const sessionUserId = hasValidSession(req);
  if (sessionUserId) {
    req.userId = sessionUserId;
    req.db = pool;
    return next();
  }
  // API calls always get a plain 401 the client can react to (a fetch() with no
  // Accept header - which is the common case - can't be reliably told apart from a
  // page navigation by Accept alone, so this keys off path instead). They also accept
  // Basic Auth as an alternate credential - scripted callers (e.g. Claude pushing a
  // Robinhood snapshot from a chat session) never got a session cookie and shouldn't
  // have to. Basic Auth only ever authenticates as the 'tslep' account (see
  // lib/auth.js) - that's intentional, not a bug.
  if (req.path.startsWith('/api/')) {
    const basicUserId = await hasValidBasicAuth(req, pool);
    if (basicUserId) {
      req.userId = basicUserId;
      req.db = pool;
      return next();
    }
    return res.status(401).json({ error: 'Not signed in' });
  }
  res.redirect('/login');
});

// no-cache (not no-store) so the browser still keeps a local copy but must
// revalidate with the server (via ETag) on every load instead of trusting a
// cached copy for some heuristic amount of time. Without this, iOS treats a
// home-screen/standalone PWA - what this dashboard is meant to run as - far
// more aggressively than a normal browser tab, and a plain in-app reload can
// keep serving JS/CSS from days ago even after a fresh deploy.
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
}));

app.use('/api/calendar', require('./routes/calendar'));
app.use('/api/finance', require('./routes/finance'));
app.use('/api/subscriptions', require('./routes/subscriptions'));
app.use('/api/robinhood', require('./routes/robinhood'));
app.use('/api/exams', require('./routes/exams'));
app.use('/api/countdowns', require('./routes/countdowns'));
app.use('/api/agent-tracker', require('./routes/agent-tracker'));
app.use('/api/railway', require('./routes/railway'));
app.use('/api/todos', require('./routes/todos'));
app.use('/api/ticker', require('./routes/ticker'));
app.use('/api/me', require('./routes/me'));
app.use('/api/slideshow', require('./routes/slideshow'));
app.use('/api/weather', require('./routes/weather'));
app.use('/api/errors', require('./routes/errors'));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Catches synchronous throws and explicit next(err) calls (the
// process-level handlers above are what catch async/rejected-promise
// errors - see the comment near the top of this file). Must be registered
// after every other app.use()/route - Express identifies error middleware
// by its 4-argument signature, not by where next() sends it.
app.use((err, req, res, next) => {
  console.error('Request error:', err);
  logError('server', err.message, err.stack, { path: req.path, method: req.method });
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Internal server error' });
});

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

withTimeout(migrate(), 15000, 'DB migration')
  .then(() => {
    app.listen(PORT, () => console.log(`Overview listening on :${PORT}`));
  })
  .catch((err) => {
    console.error('Failed to run DB migration on boot:', err);
    process.exit(1);
  });
