const express = require('express');

const router = express.Router();

// ESPN's public "site" API - free, no key/signup, widely relied on by
// hobbyist projects even though it's undocumented/unofficial. Same "no new
// account needed" reasoning as Open-Meteo for the Weather widget. sport/
// league are exactly the URL segments ESPN itself uses.
const LEAGUES = {
  nfl: { sport: 'football', league: 'nfl', label: 'NFL' },
  mlb: { sport: 'baseball', league: 'mlb', label: 'MLB' },
  nhl: { sport: 'hockey', league: 'nhl', label: 'NHL' },
  nba: { sport: 'basketball', league: 'nba', label: 'NBA' },
  ncaaf: { sport: 'football', league: 'college-football', label: 'NCAA Football' },
  ncaambb: { sport: 'basketball', league: 'mens-college-basketball', label: "NCAA Men's Basketball" },
  ncaawbb: { sport: 'basketball', league: 'womens-college-basketball', label: "NCAA Women's Basketball" },
};
const MAX_FAVORITES = 20;

router.get('/leagues', (req, res) => {
  res.json(Object.entries(LEAGUES).map(([key, l]) => ({ key, label: l.label })));
});

router.get('/:league/teams', async (req, res) => {
  const league = LEAGUES[req.params.league];
  if (!league) return res.status(400).json({ error: 'Unknown league' });
  try {
    const espnRes = await fetch(`https://site.api.espn.com/apis/site/v2/sports/${league.sport}/${league.league}/teams?limit=200`);
    if (!espnRes.ok) throw new Error(`ESPN returned ${espnRes.status}`);
    const data = await espnRes.json();
    const teams = ((data.sports && data.sports[0] && data.sports[0].leagues && data.sports[0].leagues[0].teams) || [])
      .map((t) => ({ id: t.team.id, name: t.team.displayName, logo: (t.team.logos && t.team.logos[0] && t.team.logos[0].href) || null }));
    const q = (req.query.q || '').toLowerCase().trim();
    res.json(q ? teams.filter((t) => t.name.toLowerCase().includes(q)) : teams);
  } catch (err) {
    res.status(502).json({ error: 'Could not fetch teams right now' });
  }
});

router.get('/favorites', async (req, res) => {
  const { rows } = await req.db.query(
    'SELECT id, league, team_id, team_name, team_logo FROM favorite_teams WHERE user_id = $1 ORDER BY created_at ASC',
    [req.userId]
  );
  res.json(rows);
});

router.post('/favorites', async (req, res) => {
  const { league, team_id: teamId, team_name: teamName, team_logo: teamLogo } = req.body || {};
  if (!LEAGUES[league] || !teamId || !teamName) {
    return res.status(400).json({ error: 'league, team_id, team_name are required' });
  }
  const { rows: countRows } = await req.db.query('SELECT COUNT(*) FROM favorite_teams WHERE user_id = $1', [req.userId]);
  if (Number(countRows[0].count) >= MAX_FAVORITES) {
    return res.status(400).json({ error: `Up to ${MAX_FAVORITES} favorite teams are allowed` });
  }
  const { rows } = await req.db.query(
    `INSERT INTO favorite_teams (user_id, league, team_id, team_name, team_logo) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id, league, team_id) DO NOTHING RETURNING id, league, team_id, team_name, team_logo`,
    [req.userId, league, teamId, teamName, teamLogo || null]
  );
  res.status(201).json(rows[0] || null);
});

router.delete('/favorites/:id', async (req, res) => {
  await req.db.query('DELETE FROM favorite_teams WHERE id = $1 AND user_id = $2', [req.params.id, req.userId]);
  res.status(204).end();
});

function describeStatus(status) {
  const state = status && status.type && status.type.state; // 'pre' | 'in' | 'post'
  const detail = status && status.type && status.type.shortDetail;
  if (state === 'in') return { state: 'live', detail };
  if (state === 'post') return { state: 'final', detail };
  return { state: 'scheduled', detail };
}

function mapEvent(event) {
  const comp = event.competitions[0];
  const home = comp.competitors.find((c) => c.homeAway === 'home');
  const away = comp.competitors.find((c) => c.homeAway === 'away');
  return {
    id: event.id,
    date: event.date,
    status: describeStatus(comp.status),
    home: { id: home.team.id, name: home.team.shortDisplayName || home.team.displayName, score: home.score, winner: !!home.winner },
    away: { id: away.team.id, name: away.team.shortDisplayName || away.team.displayName, score: away.score, winner: !!away.winner },
  };
}

// One favorite team's recent + upcoming games, straight from its own ESPN
// schedule endpoint (the full-league scoreboard would mean fetching every
// league a user has any favorite in and filtering client-side for no
// benefit - this is exactly the data needed, per team).
router.get('/scores', async (req, res) => {
  const { rows: favorites } = await req.db.query(
    'SELECT league, team_id, team_name FROM favorite_teams WHERE user_id = $1 ORDER BY created_at ASC',
    [req.userId]
  );
  const results = await Promise.all(favorites.map(async (fav) => {
    const league = LEAGUES[fav.league];
    if (!league) return null;
    try {
      const espnRes = await fetch(`https://site.api.espn.com/apis/site/v2/sports/${league.sport}/${league.league}/teams/${fav.team_id}/schedule`);
      if (!espnRes.ok) throw new Error(`ESPN returned ${espnRes.status}`);
      const data = await espnRes.json();
      const events = (data.events || []).map(mapEvent);
      const now = Date.now();
      const upcoming = events.filter((e) => e.status.state !== 'final' && new Date(e.date).getTime() >= now).slice(0, 3);
      const recent = events.filter((e) => e.status.state === 'final').slice(-3).reverse();
      return { league: fav.league, teamId: fav.team_id, teamName: fav.team_name, upcoming, recent };
    } catch (err) {
      return { league: fav.league, teamId: fav.team_id, teamName: fav.team_name, upcoming: [], recent: [], error: true };
    }
  }));
  res.json(results.filter(Boolean));
});

router.get('/standings/:league', async (req, res) => {
  const league = LEAGUES[req.params.league];
  if (!league) return res.status(400).json({ error: 'Unknown league' });
  try {
    const espnRes = await fetch(`https://site.api.espn.com/apis/v2/sports/${league.sport}/${league.league}/standings`);
    if (!espnRes.ok) throw new Error(`ESPN returned ${espnRes.status}`);
    const data = await espnRes.json();

    function flatten(node) {
      if (node.standings && node.standings.entries) {
        return node.standings.entries.map((e) => {
          const stat = (name) => {
            const found = e.stats.find((s) => s.name === name);
            return found ? found.displayValue : null;
          };
          return {
            teamId: e.team.id,
            teamName: e.team.displayName,
            record: stat('overall') || `${stat('wins') || 0}-${stat('losses') || 0}`,
            winPercent: stat('winPercent'),
          };
        });
      }
      return (node.children || []).flatMap(flatten);
    }

    res.json({ groups: (data.children || []).map((g) => ({ name: g.name, teams: flatten(g) })) });
  } catch (err) {
    res.status(502).json({ error: 'Could not fetch standings right now' });
  }
});

module.exports = router;
