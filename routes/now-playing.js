const express = require('express');
const { pool } = require('../db');

const router = express.Router();

// Single-row snapshot pushed by an iPhone Shortcuts Automation (Apple Music has
// no server-side "now playing" API - see life-dashboard-railway memory for why).
// Each POST overwrites the one row; this is a status snapshot, not a log.

router.get('/', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM now_playing WHERE id = 1');
  res.json(rows[0] || null);
});

router.post('/', async (req, res) => {
  const { title, artist, album } = req.body;
  let { artwork_url } = req.body;
  if (!title) return res.status(400).json({ error: 'title is required' });

  // iOS Shortcuts' Base64 Encode wraps output with \r\n every 76 chars (MIME-style
  // line wrapping), which breaks a data URI - strip all whitespace before storing.
  if (artwork_url) artwork_url = artwork_url.replace(/\s+/g, '');

  const { rows } = await pool.query(
    `INSERT INTO now_playing (id, title, artist, album, artwork_url, updated_at)
     VALUES (1, $1, $2, $3, $4, now())
     ON CONFLICT (id) DO UPDATE
       SET title = EXCLUDED.title,
           artist = EXCLUDED.artist,
           album = EXCLUDED.album,
           artwork_url = EXCLUDED.artwork_url,
           updated_at = now()
     RETURNING *`,
    [title, artist || null, album || null, artwork_url || null]
  );
  res.status(201).json(rows[0]);
});

module.exports = router;
