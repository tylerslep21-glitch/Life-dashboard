const express = require('express');

const router = express.Router();
const MAX_PHOTOS = 5;

router.get('/', async (req, res) => {
  const { rows } = await req.db.query(
    'SELECT id, image, position, created_at FROM slideshow_photos WHERE user_id = $1 ORDER BY position ASC, id ASC',
    [req.userId]
  );
  res.json(rows);
});

router.post('/', async (req, res) => {
  const { image } = req.body;
  if (typeof image !== 'string' || !image.startsWith('data:image/')) {
    return res.status(400).json({ error: 'image (data URI) is required' });
  }
  const { rows: countRows } = await req.db.query('SELECT COUNT(*) FROM slideshow_photos WHERE user_id = $1', [req.userId]);
  if (Number(countRows[0].count) >= MAX_PHOTOS) {
    return res.status(400).json({ error: `Up to ${MAX_PHOTOS} photos are allowed` });
  }
  const { rows: maxRows } = await req.db.query(
    'SELECT COALESCE(MAX(position), -1) AS max_pos FROM slideshow_photos WHERE user_id = $1',
    [req.userId]
  );
  const position = Number(maxRows[0].max_pos) + 1;
  const { rows } = await req.db.query(
    'INSERT INTO slideshow_photos (image, position, user_id) VALUES ($1, $2, $3) RETURNING id, image, position, created_at',
    [image, position, req.userId]
  );
  res.status(201).json(rows[0]);
});

router.delete('/:id', async (req, res) => {
  await req.db.query('DELETE FROM slideshow_photos WHERE id = $1 AND user_id = $2', [req.params.id, req.userId]);
  res.status(204).end();
});

module.exports = router;
