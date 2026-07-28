const express = require('express');
const { pool } = require('../db');

const router = express.Router();

router.get('/', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM exams ORDER BY event_date ASC');
  res.json(rows);
});

router.post('/', async (req, res) => {
  const { name, event_date, course } = req.body;
  if (!name || !event_date) {
    return res.status(400).json({ error: 'name, event_date are required' });
  }
  const { rows } = await pool.query(
    'INSERT INTO exams (name, event_date, course) VALUES ($1, $2, $3) RETURNING *',
    [name, event_date, course || null]
  );
  res.status(201).json(rows[0]);
});

router.delete('/:id', async (req, res) => {
  await pool.query('DELETE FROM exams WHERE id = $1', [req.params.id]);
  res.status(204).end();
});

module.exports = router;
