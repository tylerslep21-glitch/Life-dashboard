const express = require('express');

const router = express.Router();

router.get('/', async (req, res) => {
  const { rows } = await req.db.query('SELECT * FROM subscriptions ORDER BY id ASC');
  res.json(rows);
});

router.post('/', async (req, res) => {
  const { name, amount, cadence, purchase_date } = req.body;
  if (!name || typeof amount !== 'number' || !cadence) {
    return res.status(400).json({ error: 'name, amount (number), cadence are required' });
  }
  const { rows } = await req.db.query(
    'INSERT INTO subscriptions (name, amount, cadence, purchase_date) VALUES ($1, $2, $3, $4) RETURNING *',
    [name, amount, cadence, purchase_date || null]
  );
  res.status(201).json(rows[0]);
});

router.delete('/:id', async (req, res) => {
  await req.db.query('DELETE FROM subscriptions WHERE id = $1', [req.params.id]);
  res.status(204).end();
});

module.exports = router;
