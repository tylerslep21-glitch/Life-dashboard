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

// Top-level ESPN "group" id for D1 (basketball) / FBS (football) within
// each college league - confirmed live against
// .../scoreboard/conferences (each conference entry's parentGroupId points
// back to this same id). Passing ?groups=<this> to the scoreboard endpoint
// is what keeps FCS/D2/D3 opponents out of the college widgets, per-league
// conference filtering below just swaps in a conference's own groupId
// instead.
const COLLEGE_D1_GROUP = { ncaaf: '80', ncaambb: '50', ncaawbb: '50' };

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

// ESPN's schedule/scoreboard competitor.score is an object
// ({value, displayValue}), not a plain string/number - stringifying it
// directly (as this used to) is where the "[object Object]" scores came
// from.
function scoreValue(score) {
  if (score == null) return null;
  if (typeof score === 'object') return score.displayValue != null ? score.displayValue : score.value;
  return score;
}

// The per-team "schedule" endpoint returns a logos[] array; the league-wide
// "scoreboard" endpoint (used by the 7 per-league widgets) instead returns
// a single logo string - checking only logos[] left every league widget's
// team logo blank.
function teamLogo(team) {
  if (team.logos && team.logos[0] && team.logos[0].href) return team.logos[0].href;
  return team.logo || null;
}

function mapTeam(competitor) {
  return {
    id: competitor.team.id,
    name: competitor.team.shortDisplayName || competitor.team.displayName,
    logo: teamLogo(competitor.team),
    score: scoreValue(competitor.score),
    winner: !!competitor.winner,
  };
}

function mapEvent(event) {
  const comp = event.competitions[0];
  const home = comp.competitors.find((c) => c.homeAway === 'home');
  const away = comp.competitors.find((c) => c.homeAway === 'away');
  return {
    id: event.id,
    date: event.date,
    status: describeStatus(comp.status),
    home: mapTeam(home),
    away: mapTeam(away),
  };
}

// One favorite team's recent + upcoming games, straight from its own ESPN
// schedule endpoint (the full-league scoreboard would mean fetching every
// league a user has any favorite in and filtering client-side for no
// benefit - this is exactly the data needed, per team).
router.get('/scores', async (req, res) => {
  const { rows: favorites } = await req.db.query(
    'SELECT league, team_id, team_name, team_logo FROM favorite_teams WHERE user_id = $1 ORDER BY created_at ASC',
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
      // Prefer whatever logo ESPN's own schedule data has for this team
      // right now (it appears as home or away depending on the game) over
      // the possibly-stale one cached on the favorite_teams row at add-time.
      const anyEvent = events[0];
      const liveLogo = anyEvent && (anyEvent.home.id === fav.team_id ? anyEvent.home.logo : anyEvent.away.logo);
      return { league: fav.league, teamId: fav.team_id, teamName: fav.team_name, teamLogo: liveLogo || fav.team_logo, upcoming, recent };
    } catch (err) {
      return { league: fav.league, teamId: fav.team_id, teamName: fav.team_name, teamLogo: fav.team_logo, upcoming: [], recent: [], error: true };
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

// Conference list for a college league, used to populate each college
// widget's filter dropdown - only the conferences directly under the D1/FBS
// group (excludes the "FBS"/"NCAA Division I" umbrella entry itself, which
// is what "all D1/FBS" already means with no filter).
router.get('/:league/conferences', async (req, res) => {
  const leagueKey = req.params.league;
  const d1Group = COLLEGE_D1_GROUP[leagueKey];
  const league = LEAGUES[leagueKey];
  if (!league || !d1Group) return res.status(400).json({ error: 'Not a college league' });
  try {
    const espnRes = await fetch(`https://site.api.espn.com/apis/site/v2/sports/${league.sport}/${league.league}/scoreboard/conferences`);
    if (!espnRes.ok) throw new Error(`ESPN returned ${espnRes.status}`);
    const data = await espnRes.json();
    const conferences = (data.conferences || [])
      .filter((c) => c.parentGroupId === d1Group)
      .map((c) => ({ id: c.groupId, name: c.shortName || c.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
    res.json(conferences);
  } catch (err) {
    res.status(502).json({ error: 'Could not fetch conferences right now' });
  }
});

// League-wide upcoming + recent games (not filtered to any user's favorite
// teams - this backs the 7 per-league widgets, distinct from /scores which
// is favorites-only). `filter` query param, college leagues only:
// 'top25' (nationally ranked teams only), a conference groupId (from
// /:league/conferences above), or omitted/'all' for every D1/FBS team.
router.get('/:league/scoreboard', async (req, res) => {
  const leagueKey = req.params.league;
  const league = LEAGUES[leagueKey];
  if (!league) return res.status(400).json({ error: 'Unknown league' });
  const filter = req.query.filter || 'all';
  const d1Group = COLLEGE_D1_GROUP[leagueKey];

  try {
    const today = new Date();
    const start = new Date(today); start.setDate(start.getDate() - 4);
    const end = new Date(today); end.setDate(end.getDate() + 10);
    const fmt = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');
    let url = `https://site.api.espn.com/apis/site/v2/sports/${league.sport}/${league.league}/scoreboard?dates=${fmt(start)}-${fmt(end)}&limit=300`;

    let rankedIds = null;
    if (d1Group) {
      if (filter === 'top25') {
        const rankRes = await fetch(`https://site.api.espn.com/apis/site/v2/sports/${league.sport}/${league.league}/rankings`);
        if (rankRes.ok) {
          const rankData = await rankRes.json();
          const polls = rankData.rankings || [];
          const poll = polls.find((p) => p.name === 'AP Top 25') || polls[0];
          rankedIds = new Set(((poll && poll.ranks) || []).map((r) => r.team.id));
        }
        url += `&groups=${d1Group}`;
      } else if (filter && filter !== 'all') {
        url += `&groups=${filter}`;
      } else {
        url += `&groups=${d1Group}`;
      }
    }

    const espnRes = await fetch(url);
    if (!espnRes.ok) throw new Error(`ESPN returned ${espnRes.status}`);
    const data = await espnRes.json();
    let events = (data.events || []).map(mapEvent);
    if (rankedIds && rankedIds.size) {
      events = events.filter((e) => rankedIds.has(e.home.id) || rankedIds.has(e.away.id));
    }
    events.sort((a, b) => new Date(a.date) - new Date(b.date));
    const now = Date.now();
    const upcoming = events.filter((e) => e.status.state !== 'final' && new Date(e.date).getTime() >= now).slice(0, 25);
    const recent = events.filter((e) => e.status.state === 'final').slice(-15).reverse();
    res.json({ upcoming, recent });
  } catch (err) {
    res.status(502).json({ error: 'Could not fetch scoreboard right now' });
  }
});

module.exports = router;
