const express = require('express');
const Parser = require('rss-parser');

const router = express.Router();
const rssParser = new Parser({ timeout: 8000 });

const FEEDS = [
  { url: 'http://feeds.bbci.co.uk/news/world/rss.xml', source: 'BBC' },
  { url: 'https://feeds.npr.org/1001/rss.xml', source: 'NPR' },
  { url: 'https://www.espn.com/espn/rss/news', source: 'ESPN' },
  { url: 'http://feeds.bbci.co.uk/sport/rss.xml', source: 'BBC Sport' },
];

const INDICES = [
  { symbol: '^GSPC', label: 'S&P 500' },
  { symbol: '^DJI', label: 'Dow' },
  { symbol: '^IXIC', label: 'Nasdaq' },
];

async function fetchHeadlines(feed) {
  try {
    const parsed = await rssParser.parseURL(feed.url);
    return (parsed.items || []).slice(0, 4).map((item) => ({
      type: 'headline',
      source: feed.source,
      text: item.title,
      link: item.link || null,
    }));
  } catch (err) {
    return [];
  }
}

async function fetchIndex(index) {
  try {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(index.symbol)}`,
      { headers: { 'User-Agent': 'Mozilla/5.0' } }
    );
    const data = await res.json();
    const meta = data.chart.result[0].meta;
    const price = meta.regularMarketPrice;
    const prevClose = meta.previousClose ?? meta.chartPreviousClose;
    const changePct = ((price - prevClose) / prevClose) * 100;
    return {
      type: 'index',
      label: index.label,
      price,
      changePct,
      link: `https://finance.yahoo.com/quote/${encodeURIComponent(index.symbol)}`,
    };
  } catch (err) {
    return null;
  }
}

router.get('/', async (req, res) => {
  const [headlineGroups, indexResults] = await Promise.all([
    Promise.all(FEEDS.map(fetchHeadlines)),
    Promise.all(INDICES.map(fetchIndex)),
  ]);

  const headlines = headlineGroups.flat();
  const indices = indexResults.filter(Boolean);

  res.json({ fetched_at: new Date().toISOString(), headlines, indices });
});

module.exports = router;
