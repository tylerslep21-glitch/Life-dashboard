const express = require('express');
const { pool } = require('../db');
const { logError } = require('../lib/errorLog');

const router = express.Router();

// Server-enforced, not just hidden behind the frontend's adminOnly widget
// convention - error log contents (stack traces, request paths) are
// operational detail only the admin account should be able to read, same
// reasoning as the Robinhood data-isolation elsewhere in this app.
async function requireAdmin(req, res, next) {
  const { rows } = await pool.query('SELECT username FROM users WHERE id = $1', [req.userId]);
  if (!rows[0] || rows[0].username !== 'tslep') {
    return res.status(403).json({ error: 'Admin only' });
  }
  next();
}

router.get('/', requireAdmin, async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const { rows } = await pool.query(
    'SELECT id, source, message, stack, context, occurred_at FROM error_log ORDER BY occurred_at DESC LIMIT $1',
    [limit]
  );
  res.json(rows);
});

router.delete('/', requireAdmin, async (req, res) => {
  await pool.query('DELETE FROM error_log');
  res.status(204).end();
});

// Not admin-gated - any signed-in user's browser can report its own JS
// errors here (that's the point). Only reading the log back is restricted.
router.post('/client', async (req, res) => {
  const { message, stack, url } = req.body || {};
  if (typeof message !== 'string' || !message) {
    return res.status(400).json({ error: 'message is required' });
  }
  await logError('client', message, typeof stack === 'string' ? stack : null, {
    url: typeof url === 'string' ? url : null,
    userId: req.userId,
    userAgent: req.headers['user-agent'] || null,
  });
  res.status(204).end();
});

module.exports = router;
