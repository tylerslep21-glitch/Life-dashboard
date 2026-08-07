const { Pool } = require('pg');

// Railway's private network Postgres connection (host ends in .railway.internal)
// does not use SSL - forcing it hangs the connection instead of failing cleanly.
// Railway's public proxy connection (host contains rlwy.net, e.g. DATABASE_PUBLIC_URL
// used by local scripts) does need SSL. Any other host (e.g. a local dev Postgres)
// defaults to no SSL.
function makePool(connectionString) {
  const needsSSL = connectionString.includes('rlwy.net') && !connectionString.includes('.railway.internal');
  return new Pool({
    connectionString,
    ssl: needsSSL ? { rejectUnauthorized: false } : false,
    connectionTimeoutMillis: 10000,
  });
}

const pool = makePool(process.env.DATABASE_URL);

// Second tenant ("j") sharing this same running app/service but with its own
// database on the same Postgres instance - a second login that never sees
// the first tenant's data. Set up as a second full pool, not a second
// connection on the same one, and not a schema/table prefix within the same
// database: full logical separation, same as if it were a wholly separate
// deployment, just cheaper (no second Railway service needed). Only created
// if DATABASE_URL_J is actually configured - a deployment without a second
// tenant just runs single-tenant as before.
const poolJ = process.env.DATABASE_URL_J ? makePool(process.env.DATABASE_URL_J) : null;

const POOLS = { default: pool };
if (poolJ) POOLS.j = poolJ;

function getPool(tenant) {
  return POOLS[tenant] || null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS finance_entries (
  id SERIAL PRIMARY KEY,
  logged_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  bank_balance NUMERIC NOT NULL,
  cards JSONB NOT NULL DEFAULT '[]',
  income NUMERIC NOT NULL DEFAULT 0,
  transactions JSONB NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  amount NUMERIC NOT NULL,
  cadence TEXT NOT NULL,
  purchase_date DATE
);

CREATE TABLE IF NOT EXISTS robinhood_snapshots (
  id SERIAL PRIMARY KEY,
  logged_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  account_label TEXT NOT NULL,
  total_value NUMERIC NOT NULL,
  history JSONB NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS exams (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  event_date DATE NOT NULL,
  course TEXT
);

CREATE TABLE IF NOT EXISTS countdowns (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  target_date DATE NOT NULL,
  image_url TEXT
);

-- One row per agent, overwritten each update - a status snapshot, not a log.
-- status_summary holds the current status/KPI (e.g. "Active"); action_taken is a
-- short phrase for what happened on the last run (e.g. "one sale, one purchase").
CREATE TABLE IF NOT EXISTS agent_status (
  agent_name TEXT PRIMARY KEY,
  status_summary TEXT NOT NULL,
  action_taken TEXT,
  recurring BOOLEAN NOT NULL DEFAULT true,
  last_run_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS todos (
  id SERIAL PRIMARY KEY,
  text TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  checked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS purchase_date DATE;
ALTER TABLE agent_status ADD COLUMN IF NOT EXISTS action_taken TEXT;
ALTER TABLE agent_status ADD COLUMN IF NOT EXISTS recurring BOOLEAN NOT NULL DEFAULT true;
-- How often this agent is actually expected to run, e.g. 24 for daily, 720 for
-- monthly - lets the dashboard's stale-agent warning use a threshold matching
-- each agent's real cadence instead of one blanket number. NULL (unset by
-- whatever pushes this agent's status) falls back to a dashboard-side default.
ALTER TABLE agent_status ADD COLUMN IF NOT EXISTS expected_interval_hours NUMERIC;
ALTER TABLE countdowns ADD COLUMN IF NOT EXISTS image_url TEXT;

-- Now Playing feature was scrapped (2026-07-28) - iOS background execution limits
-- meant it could never be truly real-time, and that was the whole point. Dropping
-- the unused table rather than leaving dead schema around.
DROP TABLE IF EXISTS now_playing;

-- Touch ID / Face ID sign-in (WebAuthn). Single shared dashboard, so credentials aren't
-- scoped to a user account - any registered device credential can sign in. counter guards
-- against cloned authenticators (should only ever increase); device_label is whatever the
-- browser reports at registration time (e.g. "Touch ID"), shown in the credential manager
-- UI so multiple registered devices are distinguishable.
CREATE TABLE IF NOT EXISTS webauthn_credentials (
  id SERIAL PRIMARY KEY,
  credential_id TEXT UNIQUE NOT NULL,
  public_key TEXT NOT NULL,
  counter BIGINT NOT NULL DEFAULT 0,
  device_label TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ
);

-- Minimal OAuth 2.1 + dynamic client registration (RFC 7591) so the MCP endpoint at
-- /mcp can be added as a custom connector in claude.ai - its connector setup performs
-- real OAuth discovery/registration, not just "hit this URL with a secret". Single-user
-- app: the /oauth/authorize step is gated by the same DASHBOARD_PASSWORD as everything
-- else, not a separate account system. Authorization codes are short-lived and kept
-- in-memory only (the whole code->token exchange happens within one interactive OAuth
-- dance, a mid-flight restart just means retrying); issued access tokens are persisted
-- here since they need to survive redeploys.
CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id TEXT PRIMARY KEY,
  redirect_uris JSONB NOT NULL,
  client_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS oauth_tokens (
  token TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- User-managed calendar feeds (label + ICS URL), added/removed from the
-- Calendar module's own "+" button instead of being fixed at deploy time via
-- CANVAS_ICS_URL/PERSONAL_ICS_URL env vars - each tenant's own database means
-- these are naturally per-tenant with no extra work, e.g. tenant j can add
-- their own "Bright Space" feed without touching this tenant's Canvas one.
CREATE TABLE IF NOT EXISTS calendar_sources (
  id SERIAL PRIMARY KEY,
  label TEXT NOT NULL,
  ics_url TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One-off migration bookkeeping - see seedLegacyCalendarSources() below.
CREATE TABLE IF NOT EXISTS app_meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
`;

// One-time carry-over of the old env-var calendar config into the new
// self-service table, for the default tenant only (CANVAS_ICS_URL/
// PERSONAL_ICS_URL were only ever this tenant's values - seeding tenant j's
// database with them too would leak the default tenant's calendars into a
// separate account). Guarded by a permanent flag in app_meta rather than
// "does calendar_sources currently have rows" - the latter would silently
// re-add both feeds if the user ever deleted them on purpose.
async function seedLegacyCalendarSources() {
  const { rows } = await pool.query("SELECT 1 FROM app_meta WHERE key = 'legacy_calendar_seeded'");
  if (rows.length) return;
  const seeds = [];
  if (process.env.CANVAS_ICS_URL) seeds.push(['Canvas', process.env.CANVAS_ICS_URL]);
  if (process.env.PERSONAL_ICS_URL) seeds.push(['Personal', process.env.PERSONAL_ICS_URL]);
  for (const [label, url] of seeds) {
    await pool.query('INSERT INTO calendar_sources (label, ics_url) VALUES ($1, $2)', [label, url]);
  }
  await pool.query("INSERT INTO app_meta (key, value) VALUES ('legacy_calendar_seeded', 'true')");
}

async function migrate() {
  await Promise.all(Object.values(POOLS).map((p) => p.query(SCHEMA)));
  await seedLegacyCalendarSources();
}

module.exports = { pool, poolJ, getPool, migrate };
