const express = require('express');
const ical = require('node-ical');

const router = express.Router();

async function fetchEvents(url, sourceLabel) {
  if (!url) return { source: sourceLabel, events: [], error: 'not configured' };
  try {
    const data = await ical.async.fromURL(url, { timeout: 15000 });
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
    return { source: sourceLabel, events, error: null };
  } catch (err) {
    return { source: sourceLabel, events: [], error: err.message };
  }
}

router.get('/', async (req, res) => {
  const [canvas, personal] = await Promise.all([
    fetchEvents(process.env.CANVAS_ICS_URL, 'canvas'),
    fetchEvents(process.env.PERSONAL_ICS_URL, 'personal'),
  ]);
  res.json({ fetched_at: new Date().toISOString(), canvas, personal });
});

module.exports = router;
