const express = require('express');
const { encryptJSON, decryptJSON } = require('../lib/crypto');

const router = express.Router();

// This app never talks to Robinhood directly - there is no public API for personal
// account data. Claude (in a chat session, using its authorized MCP connector) pulls
// real numbers via get_portfolio/get_equity_historicals and POSTs the snapshot here,
// always as the 'tslep' account (see lib/mcp-server.js).
//
// Every read below is scoped to req.userId like every other route - there is no
// shared/admin bypass. That means anyone other than tslep hitting these endpoints
// simply gets an empty result (their own, nonexistent, Robinhood rows), never
// tslep's real financial data - this is the data-isolation guarantee requested
// specifically for this route.

// history is stored encrypted (history_enc) going forward - see db.js and
// scripts/migrate-to-encrypted.js. Rows from before that migration still
// have their plaintext history, so this falls back to that instead of
// assuming every row has been migrated.
function decorateSnapshot(row) {
  if (!row) return row;
  const { history_enc: historyEnc, ...rest } = row;
  return { ...rest, history: historyEnc ? decryptJSON(historyEnc) : (row.history || []) };
}

router.get('/latest', async (req, res) => {
  const { rows } = await req.db.query(
    `SELECT DISTINCT ON (account_label) *
     FROM robinhood_snapshots
     WHERE user_id = $1
     ORDER BY account_label, logged_at DESC`,
    [req.userId]
  );
  res.json(rows.map(decorateSnapshot));
});

router.get('/history/:label', async (req, res) => {
  const { rows } = await req.db.query(
    'SELECT * FROM robinhood_snapshots WHERE user_id = $1 AND account_label = $2 ORDER BY logged_at ASC',
    [req.userId, req.params.label]
  );
  res.json(rows.map(decorateSnapshot));
});

// Best-effort value per account "as of" a given week (?date=YYYY-MM-DD, defaults today).
// Uses the most recent snapshot pushed at or before that date, then looks inside its
// embedded daily history for the closest date <= the requested one; falls back to the
// snapshot's own total_value if history doesn't reach back that far.
router.get('/as-of', async (req, res) => {
  const asOf = req.query.date ? new Date(req.query.date) : new Date();
  if (isNaN(asOf.getTime())) return res.status(400).json({ error: 'invalid date' });
  // A bare YYYY-MM-DD parses to midnight UTC, which would exclude that same day's
  // own snapshots (logged later in the day) - extend the cutoff to end-of-day.
  if (req.query.date) asOf.setUTCHours(23, 59, 59, 999);

  const { rows: rawRows } = await req.db.query(`
    SELECT DISTINCT ON (account_label) *
    FROM robinhood_snapshots
    WHERE user_id = $1 AND logged_at <= $2
    ORDER BY account_label, logged_at DESC
  `, [req.userId, asOf.toISOString()]);

  const results = rawRows.map(decorateSnapshot).map((snap) => {
    const history = (snap.history || [])
      .filter((h) => new Date(h.date) <= asOf)
      .sort((a, b) => new Date(b.date) - new Date(a.date));
    const value = history.length ? Number(history[0].value) : Number(snap.total_value);
    return { account_label: snap.account_label, value, as_of: asOf.toISOString().slice(0, 10) };
  });

  res.json(results);
});

router.post('/snapshot', async (req, res) => {
  const { account_label, total_value, history } = req.body;
  if (!account_label || typeof total_value !== 'number') {
    return res.status(400).json({ error: 'account_label, total_value (number) are required' });
  }
  const safeHistory = Array.isArray(history) ? history : [];
  const { rows } = await req.db.query(
    `INSERT INTO robinhood_snapshots (account_label, total_value, history_enc, user_id)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [account_label, total_value, encryptJSON(safeHistory), req.userId]
  );
  res.status(201).json(decorateSnapshot(rows[0]));
});

module.exports = router;
