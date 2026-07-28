const express = require('express');
const { pool } = require('../db');

const router = express.Router();

router.get('/', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM countdowns ORDER BY target_date ASC');
  res.json(rows);
});

router.post('/', async (req, res) => {
  const { name, target_date } = req.body;
  if (!name || !target_date) {
    return res.status(400).json({ error: 'name, target_date are required' });
  }
  const { rows } = await pool.query(
    'INSERT INTO countdowns (name, target_date) VALUES ($1, $2) RETURNING *',
    [name, target_date]
  );
  res.status(201).json(rows[0]);
});

router.delete('/:id', async (req, res) => {
  await pool.query('DELETE FROM countdowns WHERE id = $1', [req.params.id]);
  res.status(204).end();
});

module.exports = router;
