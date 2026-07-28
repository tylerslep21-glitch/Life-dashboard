# Life Dashboard

A small self-hosted personal dashboard: calendar (Canvas + personal Google Calendar,
fetched live on every page load), net worth, spending, subscriptions, and Robinhood
account snapshots. Runs as a Node/Express app with Postgres storage.

## What this replaces

Previously this dashboard was a Claude-hosted static page, manually redeployed by
asking Claude to refresh it. This version runs on its own and fetches calendar data
live every time the page loads. Robinhood still has no public personal-account API,
so those numbers are pushed in by Claude (via its authorized Robinhood connector)
whenever you ask for a refresh in a chat session — see "Robinhood" below.

## Local development

```bash
npm install
cp .env.example .env   # fill in the values, see below
node server.js
```

Requires a reachable Postgres for `DATABASE_URL` — either a local Postgres install,
or point it at your Railway Postgres add-on's connection string during development.

## Environment variables

| Variable | Where to get it |
|---|---|
| `DASHBOARD_PASSWORD` | Pick any password. The whole app is behind HTTP Basic Auth using this single shared password (no separate username needed). |
| `DATABASE_URL` | Railway injects this automatically once you attach the Postgres add-on. |
| `CANVAS_ICS_URL` | Canvas → Account → Settings → scroll to **Calendar Feed**, copy the `.ics` URL. |
| `PERSONAL_ICS_URL` | Google Calendar → Settings (gear icon) → click your calendar's name → **Integrate calendar** → **Secret address in iCal format**. Do **not** use the public `.../ical/{your-email}/public/basic.ics` pattern — that only works because the calendar's sharing is set to public, which means anyone who guesses that URL (just your email address) can read your full event history. Use the real secret address instead, and turn public sharing back off in that calendar's permissions. |

## Deploying to Railway

1. Push this folder to a new GitHub repo.
2. Railway dashboard → **New Project** → **Deploy from GitHub repo** → pick the repo.
3. In the project, click **+ New** → **Database** → **Add PostgreSQL**. Railway wires
   `DATABASE_URL` into your app service automatically — nothing to copy by hand.
4. In your app service's **Variables** tab, add `DASHBOARD_PASSWORD`, `CANVAS_ICS_URL`,
   `PERSONAL_ICS_URL`.
5. Railway builds and deploys automatically (it detects Node via `package.json`).
   It gives you a public `*.up.railway.app` domain — the app is still protected by
   the Basic Auth password, so that's expected and fine.
6. One-time only, to bring over anything already logged in the old
   `~/Documents/Life Dashboard/finances.json`:
   ```bash
   DATABASE_URL="<paste Railway's Postgres connection string>" \
     node scripts/seed-from-json.js "/Users/tylerslep/Documents/Life Dashboard/finances.json"
   ```
   Run this from your own machine (it just needs network access to Railway's Postgres,
   which Railway's dashboard shows you a connection string for under the Postgres
   service's **Connect** tab).

## Robinhood

There's no public Robinhood API for personal account data, so this app never talks to
Robinhood directly — building that would mean storing real brokerage login credentials
on a server, which isn't something to do. Instead, whenever you want fresh Robinhood
numbers on the dashboard, ask Claude (in a normal chat session, using its authorized
Robinhood connector) to push a refresh. Claude POSTs to:

```
POST /api/robinhood/snapshot
Authorization: Basic <base64 of "anything:DASHBOARD_PASSWORD">
Content-Type: application/json

{
  "account_label": "Agentic",
  "total_value": 318.99,
  "history": [{"date": "2026-07-01", "value": 340.26}, ...]
}
```

one call per account (`Agentic`, `Individual`). The app just stores and displays
whatever it's given.

## Adding financial info

Click **"+ Add financial info"** on the dashboard (bottom-right). Enter your current
bank total, each card's balance, income for the period, and a list of transactions
(category + amount each). Net worth, the spending-by-category chart, and the bank
trend chart all update from this immediately — no need to ask Claude for anything.
