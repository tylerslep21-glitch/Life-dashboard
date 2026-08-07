const express = require('express');

const router = express.Router();

// Open-Meteo: free, no API key, no signup - both the geocoding and forecast
// endpoints used below are public. Chosen specifically so this widget doesn't
// need a new env var/secret the way a commercial weather API would.
const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';

// WMO weather interpretation codes (the standard Open-Meteo's `weather_code`
// uses) collapsed down to what this widget actually shows.
const WEATHER_CODES = {
  0: { description: 'Clear sky', icon: '☀️' },
  1: { description: 'Mainly clear', icon: '🌤️' },
  2: { description: 'Partly cloudy', icon: '⛅' },
  3: { description: 'Overcast', icon: '☁️' },
  45: { description: 'Fog', icon: '🌫️' },
  48: { description: 'Fog', icon: '🌫️' },
  51: { description: 'Light drizzle', icon: '🌦️' },
  53: { description: 'Drizzle', icon: '🌦️' },
  55: { description: 'Dense drizzle', icon: '🌦️' },
  56: { description: 'Freezing drizzle', icon: '🌧️' },
  57: { description: 'Freezing drizzle', icon: '🌧️' },
  61: { description: 'Light rain', icon: '🌧️' },
  63: { description: 'Rain', icon: '🌧️' },
  65: { description: 'Heavy rain', icon: '🌧️' },
  66: { description: 'Freezing rain', icon: '🌧️' },
  67: { description: 'Freezing rain', icon: '🌧️' },
  71: { description: 'Light snow', icon: '❄️' },
  73: { description: 'Snow', icon: '❄️' },
  75: { description: 'Heavy snow', icon: '❄️' },
  77: { description: 'Snow grains', icon: '❄️' },
  80: { description: 'Rain showers', icon: '🌦️' },
  81: { description: 'Rain showers', icon: '🌦️' },
  82: { description: 'Violent rain showers', icon: '🌧️' },
  85: { description: 'Snow showers', icon: '🌨️' },
  86: { description: 'Snow showers', icon: '🌨️' },
  95: { description: 'Thunderstorm', icon: '⛈️' },
  96: { description: 'Thunderstorm with hail', icon: '⛈️' },
  99: { description: 'Thunderstorm with hail', icon: '⛈️' },
};

function describeCode(code) {
  return WEATHER_CODES[code] || { description: 'Unknown', icon: '🌡️' };
}

router.get('/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json([]);
  try {
    const url = `${GEOCODE_URL}?name=${encodeURIComponent(q)}&count=5&language=en&format=json`;
    const geoRes = await fetch(url);
    const data = await geoRes.json();
    const results = (data.results || []).map((r) => ({
      name: r.name,
      admin1: r.admin1 || null,
      country: r.country || null,
      lat: r.latitude,
      lon: r.longitude,
      label: [r.name, r.admin1, r.country].filter(Boolean).join(', '),
    }));
    res.json(results);
  } catch (err) {
    res.status(502).json({ error: 'Could not search locations right now' });
  }
});

router.get('/', async (req, res) => {
  const { rows } = await req.db.query('SELECT weather_location FROM users WHERE id = $1', [req.userId]);
  const location = rows[0] && rows[0].weather_location;
  if (!location) return res.json(null);

  try {
    const url =
      `${FORECAST_URL}?latitude=${location.lat}&longitude=${location.lon}` +
      '&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m' +
      '&daily=temperature_2m_max,temperature_2m_min,sunrise,sunset,weather_code' +
      '&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=auto&forecast_days=1';
    const wRes = await fetch(url);
    if (!wRes.ok) throw new Error(`Open-Meteo returned ${wRes.status}`);
    const data = await wRes.json();

    res.json({
      label: location.label,
      current: {
        temp: Math.round(data.current.temperature_2m),
        humidity: data.current.relative_humidity_2m,
        wind: Math.round(data.current.wind_speed_10m),
        ...describeCode(data.current.weather_code),
      },
      today: {
        high: Math.round(data.daily.temperature_2m_max[0]),
        low: Math.round(data.daily.temperature_2m_min[0]),
        sunrise: data.daily.sunrise[0],
        sunset: data.daily.sunset[0],
      },
    });
  } catch (err) {
    res.status(502).json({ error: 'Could not fetch weather right now' });
  }
});

module.exports = router;
