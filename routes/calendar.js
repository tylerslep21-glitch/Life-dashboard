const express = require('express');
const ical = require('node-ical');

const router = express.Router();

async function fetchEvents(source) {
  try {
    const data = await ical.async.fromURL(source.ics_url, { timeout: 15000 });
    const now = Date.now();
    const events = Object.values(data)
      .filter((item) => item.type === 'VEVENT' && item.start)
      .map((item) => ({
        title: item.summary || '(untitled)',
        start: item.start.toISOString(),
        end: item.end ? item.end.toISOString() : null,
      }))
      .filter((e) => new Date(e.start).getTime() >= now - 24 * 60 * 60 * 1000)
      .sort((a, b) => new Date(a.start) - new Date(b.start));
    return { id: source.id, label: source.label, ics_url: source.ics_url, events, error: null };
  } catch (err) {
    return { id: source.id, label: source.label, ics_url: source.ics_url, events: [], error: err.message };
  }
}

router.get('/', async (req, res) => {
  const { rows: sources } = await req.db.query('SELECT * FROM calendar_sources WHERE user_id = $1 ORDER BY id ASC', [req.userId]);
  const results = await Promise.all(sources.map(fetchEvents));
  res.json({ fetched_at: new Date().toISOString(), sources: results });
});

router.get('/sources', async (req, res) => {
  const { rows } = await req.db.query(
    'SELECT id, label, ics_url, created_at FROM calendar_sources WHERE user_id = $1 ORDER BY id ASC',
    [req.userId]
  );
  res.json(rows);
});

router.post('/sources', async (req, res) => {
  const { label, ics_url } = req.body;
  if (!label || !ics_url) {
    return res.status(400).json({ error: 'label, ics_url are required' });
  }
  // A doomed fetch attempt now beats silently saving a broken link that only
  // fails later, invisibly, every time the calendar loads.
  try {
    await ical.async.fromURL(ics_url, { timeout: 15000 });
  } catch (err) {
    return res.status(400).json({ error: 'Could not load that calendar: ' + err.message });
  }
  const { rows } = await req.db.query(
    'INSERT INTO calendar_sources (label, ics_url, user_id) VALUES ($1, $2, $3) RETURNING *',
    [label, ics_url, req.userId]
  );
  res.status(201).json(rows[0]);
});

router.delete('/sources/:id', async (req, res) => {
  await req.db.query('DELETE FROM calendar_sources WHERE id = $1 AND user_id = $2', [req.params.id, req.userId]);
  res.status(204).end();
});

module.exports = router;
