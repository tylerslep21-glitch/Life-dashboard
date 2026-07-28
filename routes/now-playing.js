const express = require('express');

const router = express.Router();

// Live-fetches from Last.fm on every request (same "fetch live on load" pattern as
// /api/calendar) - no database, no Shortcuts push needed. Last.fm gets its data from
// a background scrobbler app (FastScrobbler) running on the phone, which is the only
// realistic bridge since Apple Music itself has no server-side "now playing" API.

router.get('/', async (req, res) => {
  const apiKey = process.env.LASTFM_API_KEY;
  const username = process.env.LASTFM_USERNAME;
  if (!apiKey || !username) {
    return res.json(null);
  }

  try {
    const url = `https://ws.audioscrobbler.com/2.0/?method=user.getrecenttracks&user=${encodeURIComponent(username)}&api_key=${encodeURIComponent(apiKey)}&format=json&limit=1`;
    const response = await fetch(url);
    const data = await response.json();

    const track = data?.recenttracks?.track?.[0];
    const isNowPlaying = track?.['@attr']?.nowplaying === 'true';
    if (!track || !isNowPlaying) {
      return res.json(null); // nothing currently playing - just history, not "now playing"
    }

    const images = track.image || [];
    const artwork = images.find((i) => i.size === 'extralarge') || images.find((i) => i.size === 'large');

    res.json({
      title: track.name,
      artist: track.artist?.['#text'] || null,
      album: track.album?.['#text'] || null,
      artwork_url: artwork && artwork['#text'] ? artwork['#text'] : null,
    });
  } catch (err) {
    res.json(null);
  }
});

module.exports = router;
