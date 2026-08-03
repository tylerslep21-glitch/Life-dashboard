const express = require('express');
const { pool } = require('../db');

const router = express.Router();

// Net worth combines bank + Robinhood (assets) minus cards (liabilities) - computed
// client-side once /api/finance/latest and /api/robinhood/latest have both loaded.

// Monday 00:00 UTC of the week containing the given date.
function weekStart(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay(); // 0 = Sunday
  const diff = (day === 0 ? -6 : 1) - day; // shift back to Monday
  d.setUTCDate(d.getUTCDate() + diff);
  return d;
}

router.get('/latest', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM finance_entries ORDER BY logged_at DESC LIMIT 1'
  );
  if (rows.length === 0) return res.json(null);
  res.json(rows[0]);
});

router.get('/history', async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 52, 200);
  const { rows } = await pool.query(
    'SELECT * FROM finance_entries ORDER BY logged_at ASC LIMIT $1',
    [limit]
  );
  res.json(rows);
});

// Aggregates all entries falling in the Mon-Sun week containing ?date=YYYY-MM-DD
// (defaults to today). Flows (income, transactions) are summed across every entry
// that week; point-in-time figures (bank_balance, cards) use the most recent entry.
router.get('/week', async (req, res) => {
  const anchor = req.query.date ? new Date(req.query.date) : new Date();
  if (isNaN(anchor.getTime())) {
    return res.status(400).json({ error: 'invalid date' });
  }
  const start = weekStart(anchor);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 7);

  const { rows } = await pool.query(
    'SELECT * FROM finance_entries WHERE logged_at >= $1 AND logged_at < $2 ORDER BY logged_at ASC',
    [start.toISOString(), end.toISOString()]
  );

  if (rows.length === 0) {
    return res.json({ week_of: start.toISOString().slice(0, 10), entry_count: 0, bank_balance: null, cards: [], income: 0, transactions: [] });
  }

  const latest = rows[rows.length - 1];
  const income = rows.reduce((sum, r) => sum + Number(r.income), 0);
  const transactions = rows.flatMap((r) => r.transactions || []);

  res.json({
    week_of: start.toISOString().slice(0, 10),
    entry_count: rows.length,
    bank_balance: Number(latest.bank_balance),
    cards: latest.cards || [],
    income,
    transactions,
    logged_at: latest.logged_at,
  });
});

// Raw entries (with ids) for a given week - lets the frontend locate a specific
// transaction (which entry it lives in) so it can be edited or deleted.
router.get('/entries-in-week', async (req, res) => {
  const anchor = req.query.date ? new Date(req.query.date) : new Date();
  if (isNaN(anchor.getTime())) return res.status(400).json({ error: 'invalid date' });
  const start = weekStart(anchor);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 7);

  const { rows } = await pool.query(
    'SELECT id, logged_at, transactions FROM finance_entries WHERE logged_at >= $1 AND logged_at < $2 ORDER BY logged_at ASC',
    [start.toISOString(), end.toISOString()]
  );
  res.json(rows);
});

// Replaces one entry's transactions array wholesale - used to edit or delete a
// single transaction (frontend sends back the whole modified array).
router.patch('/:id/transactions', async (req, res) => {
  const { transactions } = req.body;
  if (!Array.isArray(transactions)) {
    return res.status(400).json({ error: 'transactions (array) is required' });
  }
  const { rows } = await pool.query(
    'UPDATE finance_entries SET transactions = $1 WHERE id = $2 RETURNING *',
    [JSON.stringify(transactions), req.params.id]
  );
  if (rows.length === 0) return res.status(404).json({ error: 'not found' });
  res.json(rows[0]);
});

// Earliest week that has any data, so the frontend can disable "prev" past it.
router.get('/earliest-week', async (req, res) => {
  const { rows } = await pool.query('SELECT MIN(logged_at) AS min_date FROM finance_entries');
  if (!rows[0].min_date) return res.json(null);
  res.json({ week_of: weekStart(new Date(rows[0].min_date)).toISOString().slice(0, 10) });
});

router.post('/', async (req, res) => {
  const { bank_balance, cards, income, transactions, logged_at } = req.body;
  if (typeof bank_balance !== 'number') {
    return res.status(400).json({ error: 'bank_balance (number) is required' });
  }
  const safeCards = Array.isArray(cards) ? cards : [];
  const safeTransactions = Array.isArray(transactions) ? transactions : [];
  const safeIncome = typeof income === 'number' ? income : 0;

  // logged_at lets the dashboard backfill a forgotten entry into a past week
  // (attributed to that week's bucket in /week) instead of always "now".
  let loggedAt = new Date();
  if (logged_at) {
    const parsed = new Date(logged_at);
    if (isNaN(parsed.getTime())) return res.status(400).json({ error: 'invalid logged_at' });
    loggedAt = parsed;
  }

  const { rows } = await pool.query(
    `INSERT INTO finance_entries (bank_balance, cards, income, transactions, logged_at)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [bank_balance, JSON.stringify(safeCards), safeIncome, JSON.stringify(safeTransactions), loggedAt.toISOString()]
  );
  res.status(201).json(rows[0]);
});

module.exports = router;
