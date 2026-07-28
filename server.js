const express = require('express');
const path = require('path');
const { migrate } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD;

if (!DASHBOARD_PASSWORD) {
  console.error('FATAL: DASHBOARD_PASSWORD env var is not set. Refusing to start unprotected.');
  process.exit(1);
}

// Basic Auth on every route - single shared password, no username check.
app.use((req, res, next) => {
  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme === 'Basic' && encoded) {
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const passwordPart = decoded.split(':').slice(1).join(':');
    if (passwordPart === DASHBOARD_PASSWORD) {
      return next();
    }
  }
  res.set('WWW-Authenticate', 'Basic realm="Life Dashboard"');
  res.status(401).send('Authentication required.');
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api/calendar', require('./routes/calendar'));
app.use('/api/finance', require('./routes/finance'));
app.use('/api/subscriptions', require('./routes/subscriptions'));
app.use('/api/robinhood', require('./routes/robinhood'));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

migrate()
  .then(() => {
    app.listen(PORT, () => console.log(`Life Dashboard listening on :${PORT}`));
  })
  .catch((err) => {
    console.error('Failed to run DB migration on boot:', err);
    process.exit(1);
  });
