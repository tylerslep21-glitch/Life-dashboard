const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway')
    ? { rejectUnauthorized: false }
    : false,
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
  cadence TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS robinhood_snapshots (
  id SERIAL PRIMARY KEY,
  logged_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  account_label TEXT NOT NULL,
  total_value NUMERIC NOT NULL,
  history JSONB NOT NULL DEFAULT '[]'
);
`;

async function migrate() {
  await pool.query(SCHEMA);
}

module.exports = { pool, migrate };
