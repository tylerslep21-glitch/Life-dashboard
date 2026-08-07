const express = require('express');

const router = express.Router();

// Checked items disappear an hour after being checked - swept on every read
// rather than needing a separate cron job.
async function sweepExpired(db, userId) {
  await db.query(
    "DELETE FROM todos WHERE user_id = $1 AND checked_at IS NOT NULL AND checked_at < now() - interval '1 hour'",
    [userId]
  );
}

router.get('/', async (req, res) => {
  await sweepExpired(req.db, req.userId);
  const { rows } = await req.db.query('SELECT * FROM todos WHERE user_id = $1 ORDER BY position ASC, id ASC', [req.userId]);
  res.json(rows);
});

router.post('/', async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'text is required' });
  const { rows: maxRows } = await req.db.query('SELECT COALESCE(MAX(position), -1) AS max_pos FROM todos WHERE user_id = $1', [req.userId]);
  const position = Number(maxRows[0].max_pos) + 1;
  const { rows } = await req.db.query(
    'INSERT INTO todos (text, position, user_id) VALUES ($1, $2, $3) RETURNING *',
    [text, position, req.userId]
  );
  res.status(201).json(rows[0]);
});

// { checked: true|false }
router.patch('/:id/check', async (req, res) => {
  const { checked } = req.body;
  const { rows } = await req.db.query(
    'UPDATE todos SET checked_at = $1 WHERE id = $2 AND user_id = $3 RETURNING *',
    [checked ? new Date() : null, req.params.id, req.userId]
  );
  if (rows.length === 0) return res.status(404).json({ error: 'not found' });
  res.json(rows[0]);
});

// { order: [id, id, id, ...] } in the new top-to-bottom order
router.patch('/reorder', async (req, res) => {
  const { order } = req.body;
  if (!Array.isArray(order)) return res.status(400).json({ error: 'order (array) is required' });
  const client = await req.db.connect();
  try {
    await client.query('BEGIN');
    for (let i = 0; i < order.length; i++) {
      await client.query('UPDATE todos SET position = $1 WHERE id = $2 AND user_id = $3', [i, order[i], req.userId]);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  res.status(204).end();
});

router.delete('/:id', async (req, res) => {
  await req.db.query('DELETE FROM todos WHERE id = $1 AND user_id = $2', [req.params.id, req.userId]);
  res.status(204).end();
});

module.exports = router;
