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

ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS purchase_date DATE;
`;

async function migrate() {
  await pool.query(SCHEMA);
}

module.exports = { pool, migrate };
