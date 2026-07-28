const express = require('express');
const { pool } = require('../db');

const router = express.Router();

// This app never talks to Robinhood directly - there is no public API for personal
// account data. Claude (in a chat session, using its authorized MCP connector) pulls
// real numbers via get_portfolio/get_equity_historicals and POSTs the snapshot here.

router.get('/latest', async (req, res) => {
  const { rows } = await pool.query(`
    SELECT DISTINCT ON (account_label) *
    FROM robinhood_snapshots
    ORDER BY account_label, logged_at DESC
  `);
  res.json(rows);
});

router.get('/history/:label', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM robinhood_snapshots WHERE account_label = $1 ORDER BY logged_at ASC',
    [req.params.label]
  );
  res.json(rows);
});

router.post('/snapshot', async (req, res) => {
  const { account_label, total_value, history } = req.body;
  if (!account_label || typeof total_value !== 'number') {
    return res.status(400).json({ error: 'account_label, total_value (number) are required' });
  }
  const safeHistory = Array.isArray(history) ? history : [];
  const { rows } = await pool.query(
    `INSERT INTO robinhood_snapshots (account_label, total_value, history)
     VALUES ($1, $2, $3) RETURNING *`,
    [account_label, total_value, JSON.stringify(safeHistory)]
  );
  res.status(201).json(rows[0]);
});

module.exports = router;
