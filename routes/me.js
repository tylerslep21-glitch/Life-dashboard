const express = require('express');

const router = express.Router();

router.get('/', async (req, res) => {
  const { rows } = await req.db.query('SELECT id, username, widget_layout, created_at FROM users WHERE id = $1', [req.userId]);
  if (!rows.length) return res.status(404).json({ error: 'not found' });
  res.json(rows[0]);
});

// { widget_layout: [{ id, enabled }, ...] } - ordered top-to-bottom, matching
// data-widget-id values in index.html. Widgets missing from a saved layout
// (e.g. a new one shipped after the user last saved) default to enabled,
// appended at the end - see applyWidgetLayout() in dashboard.js.
router.patch('/widget-layout', async (req, res) => {
  const { widget_layout } = req.body;
  if (!Array.isArray(widget_layout)) {
    return res.status(400).json({ error: 'widget_layout (array) is required' });
  }
  const { rows } = await req.db.query(
    'UPDATE users SET widget_layout = $1 WHERE id = $2 RETURNING id, username, widget_layout',
    [JSON.stringify(widget_layout), req.userId]
  );
  res.json(rows[0]);
});

module.exports = router;
