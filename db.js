const { Pool } = require('pg');

// Railway's private network Postgres connection (host ends in .railway.internal)
// does not use SSL - forcing it hangs the connection instead of failing cleanly.
// Railway's public proxy connection (host contains rlwy.net, e.g. DATABASE_PUBLIC_URL
// used by local scripts) does need SSL. Any other host (e.g. a local dev Postgres)
// defaults to no SSL.
const url = process.env.DATABASE_URL || '';
const needsSSL = url.includes('rlwy.net') && !url.includes('.railway.internal');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: needsSSL ? { rejectUnauthorized: false } : false,
  connectionTimeoutMillis: 10000,
});

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
ALTER TABLE countdowns ADD COLUMN IF NOT EXISTS image_url TEXT;

-- Now Playing feature was scrapped (2026-07-28) - iOS background execution limits
-- meant it could never be truly real-time, and that was the whole point. Dropping
-- the unused table rather than leaving dead schema around.
DROP TABLE IF EXISTS now_playing;
`;

async function migrate() {
  await pool.query(SCHEMA);
}

module.exports = { pool, migrate };
