const express = require('express');

const router = express.Router();

// Status snapshot per agent - each POST overwrites that agent's row, it's not a log.
// Meant to be pushed by the user's own scheduled agent (or Claude on request), same
// Basic Auth as everything else in this app.

router.get('/', async (req, res) => {
  const onlyRecurring = req.query.recurring === 'true';
  const { rows } = await req.db.query(
    onlyRecurring
      ? 'SELECT * FROM agent_status WHERE user_id = $1 AND recurring = true ORDER BY agent_name ASC'
      : 'SELECT * FROM agent_status WHERE user_id = $1 ORDER BY agent_name ASC',
    [req.userId]
  );
  res.json(rows);
});

router.post('/', async (req, res) => {
  const { agent_name, status_summary, action_taken, recurring, last_run_at, expected_interval_hours } = req.body;
  if (!agent_name || !status_summary) {
    return res.status(400).json({ error: 'agent_name, status_summary are required' });
  }
  const { rows } = await req.db.query(
    `INSERT INTO agent_status (agent_name, status_summary, action_taken, recurring, last_run_at, expected_interval_hours, updated_at, user_id)
     VALUES ($1, $2, $3, COALESCE($4, true), COALESCE($5, now()), $6, now(), $7)
     ON CONFLICT (user_id, agent_name) DO UPDATE
       SET status_summary = EXCLUDED.status_summary,
           action_taken = EXCLUDED.action_taken,
           recurring = EXCLUDED.recurring,
           last_run_at = EXCLUDED.last_run_at,
           -- Most callers won't know about this field yet - don't let an
           -- omitted value wipe out one set earlier (e.g. via the dashboard).
           expected_interval_hours = COALESCE(EXCLUDED.expected_interval_hours, agent_status.expected_interval_hours),
           updated_at = now()
     RETURNING *`,
    [agent_name, status_summary, action_taken || null, recurring, last_run_at || null, expected_interval_hours || null, req.userId]
  );
  res.status(201).json(rows[0]);
});

router.delete('/:agentName', async (req, res) => {
  await req.db.query('DELETE FROM agent_status WHERE agent_name = $1 AND user_id = $2', [req.params.agentName, req.userId]);
  res.status(204).end();
});

module.exports = router;
