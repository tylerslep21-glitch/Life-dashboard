const express = require('express');
const { pool } = require('../db');

const router = express.Router();

// Status snapshot per agent - each POST overwrites that agent's row, it's not a log.
// Meant to be pushed by the user's own scheduled agent (or Claude on request), same
// Basic Auth as everything else in this app.

router.get('/', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM agent_status ORDER BY agent_name ASC');
  res.json(rows);
});

router.post('/', async (req, res) => {
  const { agent_name, status_summary, last_run_at } = req.body;
  if (!agent_name || !status_summary) {
    return res.status(400).json({ error: 'agent_name, status_summary are required' });
  }
  const { rows } = await pool.query(
    `INSERT INTO agent_status (agent_name, status_summary, last_run_at, updated_at)
     VALUES ($1, $2, COALESCE($3, now()), now())
     ON CONFLICT (agent_name) DO UPDATE
       SET status_summary = EXCLUDED.status_summary,
           last_run_at = EXCLUDED.last_run_at,
           updated_at = now()
     RETURNING *`,
    [agent_name, status_summary, last_run_at || null]
  );
  res.status(201).json(rows[0]);
});

router.delete('/:agentName', async (req, res) => {
  await pool.query('DELETE FROM agent_status WHERE agent_name = $1', [req.params.agentName]);
  res.status(204).end();
});

module.exports = router;
