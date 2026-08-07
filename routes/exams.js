const express = require('express');

const router = express.Router();

router.get('/', async (req, res) => {
  const { rows } = await req.db.query('SELECT * FROM exams WHERE user_id = $1 ORDER BY event_date ASC', [req.userId]);
  res.json(rows);
});

router.post('/', async (req, res) => {
  const { name, event_date, course } = req.body;
  if (!name || !event_date) {
    return res.status(400).json({ error: 'name, event_date are required' });
  }
  const { rows } = await req.db.query(
    'INSERT INTO exams (name, event_date, course, user_id) VALUES ($1, $2, $3, $4) RETURNING *',
    [name, event_date, course || null, req.userId]
  );
  res.status(201).json(rows[0]);
});

router.delete('/:id', async (req, res) => {
  await req.db.query('DELETE FROM exams WHERE id = $1 AND user_id = $2', [req.params.id, req.userId]);
  res.status(204).end();
});

module.exports = router;
