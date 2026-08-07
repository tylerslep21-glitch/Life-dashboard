const express = require('express');

const router = express.Router();

router.get('/', async (req, res) => {
  const { rows } = await req.db.query('SELECT * FROM countdowns WHERE user_id = $1 ORDER BY target_date ASC', [req.userId]);
  res.json(rows);
});

router.post('/', async (req, res) => {
  const { name, target_date, image_url } = req.body;
  if (!name || !target_date) {
    return res.status(400).json({ error: 'name, target_date are required' });
  }
  const { rows } = await req.db.query(
    'INSERT INTO countdowns (name, target_date, image_url, user_id) VALUES ($1, $2, $3, $4) RETURNING *',
    [name, target_date, image_url || null, req.userId]
  );
  res.status(201).json(rows[0]);
});

router.delete('/:id', async (req, res) => {
  await req.db.query('DELETE FROM countdowns WHERE id = $1 AND user_id = $2', [req.params.id, req.userId]);
  res.status(204).end();
});

module.exports = router;
