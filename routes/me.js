const express = require('express');

const router = express.Router();

router.get('/', async (req, res) => {
  const { rows } = await req.db.query(
    'SELECT id, username, widget_layout, custom_themes, weather_location, notes, created_at FROM users WHERE id = $1',
    [req.userId]
  );
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

// { custom_themes: [{ id, name, main, secondary1, secondary2, pattern }, ...] } -
// whole-array replace (create/rename/edit/delete/reorder are all just "send the
// new array back"), same pattern as widget-layout above. Capped at 3 themes.
router.patch('/custom-themes', async (req, res) => {
  const { custom_themes: customThemes } = req.body;
  if (!Array.isArray(customThemes)) {
    return res.status(400).json({ error: 'custom_themes (array) is required' });
  }
  if (customThemes.length > 3) {
    return res.status(400).json({ error: 'Up to 3 custom themes are allowed' });
  }
  for (const theme of customThemes) {
    if (!theme || typeof theme.id !== 'string' || typeof theme.name !== 'string' || !theme.name.trim()) {
      return res.status(400).json({ error: 'Each theme needs an id and a name' });
    }
  }
  const { rows } = await req.db.query(
    'UPDATE users SET custom_themes = $1 WHERE id = $2 RETURNING id, username, custom_themes',
    [JSON.stringify(customThemes), req.userId]
  );
  res.json(rows[0]);
});

// { location: { lat, lon, label } | null } - set from the Weather widget's
// location search (see routes/weather.js's /search proxy). null clears it,
// which makes the widget go back to its "set a location" empty state.
router.patch('/weather-location', async (req, res) => {
  const { location } = req.body;
  if (location !== null && (typeof location !== 'object' || typeof location.lat !== 'number' || typeof location.lon !== 'number')) {
    return res.status(400).json({ error: 'location ({lat, lon, label}) or null is required' });
  }
  const { rows } = await req.db.query(
    'UPDATE users SET weather_location = $1 WHERE id = $2 RETURNING id, username, weather_location',
    [location ? JSON.stringify(location) : null, req.userId]
  );
  res.json(rows[0]);
});

// { notes: "..." } - one freeform text blob per user, not a list of separate
// notes. Whole-value replace, autosaved from the dashboard on a debounce.
router.patch('/notes', async (req, res) => {
  const { notes } = req.body;
  if (typeof notes !== 'string') {
    return res.status(400).json({ error: 'notes (string) is required' });
  }
  const { rows } = await req.db.query(
    'UPDATE users SET notes = $1 WHERE id = $2 RETURNING id, username, notes',
    [notes, req.userId]
  );
  res.json(rows[0]);
});

module.exports = router;
