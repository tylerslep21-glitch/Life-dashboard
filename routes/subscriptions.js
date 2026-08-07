const express = require('express');

const router = express.Router();

router.get('/', async (req, res) => {
  const { rows } = await req.db.query('SELECT * FROM subscriptions WHERE user_id = $1 ORDER BY id ASC', [req.userId]);
  res.json(rows);
});

router.post('/', async (req, res) => {
  const { name, amount, cadence, purchase_date } = req.body;
  if (!name || typeof amount !== 'number' || !cadence) {
    return res.status(400).json({ error: 'name, amount (number), cadence are required' });
  }
  const { rows } = await req.db.query(
    'INSERT INTO subscriptions (name, amount, cadence, purchase_date, user_id) VALUES ($1, $2, $3, $4, $5) RETURNING *',
    [name, amount, cadence, purchase_date || null, req.userId]
  );
  res.status(201).json(rows[0]);
});

router.delete('/:id', async (req, res) => {
  await req.db.query('DELETE FROM subscriptions WHERE id = $1 AND user_id = $2', [req.params.id, req.userId]);
  res.status(204).end();
});

module.exports = router;
