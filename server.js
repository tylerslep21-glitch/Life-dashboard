const express = require('express');
const path = require('path');
const { migrate } = require('./db');
const { hasValidSession, hasValidBasicAuth } = require('./lib/auth');
const { handleMcpRequest } = require('./lib/mcp-server');

const app = express();
const PORT = process.env.PORT || 3000;
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD;

if (!DASHBOARD_PASSWORD) {
  console.error('FATAL: DASHBOARD_PASSWORD env var is not set. Refusing to start unprotected.');
  process.exit(1);
}

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
]);
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.use((req, res, next) => {
  if (PUBLIC_FILES.has(req.path)) return next();
  if (hasValidSession(req)) return next();
  // API calls always get a plain 401 the client can react to (a fetch() with no
  // Accept header - which is the common case - can't be reliably told apart from a
  // page navigation by Accept alone, so this keys off path instead). They also accept
  // the old Basic Auth password as an alternate credential - scripted callers (e.g.
  // Claude pushing a Robinhood snapshot from a chat session) never got a session cookie
  // and shouldn't have to.
  if (req.path.startsWith('/api/')) {
    if (hasValidBasicAuth(req)) return next();
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

// Lets a second deployment of this exact codebase (same repo, different
// service/database/env vars) hide widgets that don't apply to it - e.g. a
// dashboard for someone without a Robinhood account or without this
// project's own Railway/AI-agent infra - without forking the code.
app.get('/api/config', (req, res) => {
  const disabledWidgets = (process.env.DISABLED_WIDGETS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  res.json({ disabledWidgets });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

withTimeout(migrate(), 15000, 'DB migration')
  .then(() => {
    app.listen(PORT, () => console.log(`Life Dashboard listening on :${PORT}`));
  })
  .catch((err) => {
    console.error('Failed to run DB migration on boot:', err);
    process.exit(1);
  });
