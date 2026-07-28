const express = require('express');
const { pool } = require('../db');

const router = express.Router();

// Net worth combines bank + Robinhood (assets) minus cards (liabilities) - computed
// client-side once /api/finance/latest and /api/robinhood/latest have both loaded.

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

router.post('/', async (req, res) => {
  const { bank_balance, cards, income, transactions } = req.body;
  if (typeof bank_balance !== 'number') {
    return res.status(400).json({ error: 'bank_balance (number) is required' });
  }
  const safeCards = Array.isArray(cards) ? cards : [];
  const safeTransactions = Array.isArray(transactions) ? transactions : [];
  const safeIncome = typeof income === 'number' ? income : 0;

  const { rows } = await pool.query(
    `INSERT INTO finance_entries (bank_balance, cards, income, transactions)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [bank_balance, JSON.stringify(safeCards), safeIncome, JSON.stringify(safeTransactions)]
  );
  res.status(201).json(rows[0]);
});

module.exports = router;
