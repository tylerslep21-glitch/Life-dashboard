// One-time migration: imports the existing local finances.json (subscriptions +
// weekly entries) into Postgres so nothing already logged in the Claude-artifact
// era is lost. Run once after DATABASE_URL is available:
//   DATABASE_URL=... node scripts/seed-from-json.js /path/to/finances.json

const fs = require('fs');
const { pool, migrate } = require('../db');

async function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error('Usage: node scripts/seed-from-json.js /path/to/finances.json');
    process.exit(1);
  }
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

  await migrate();

  if (data.subscriptions && Array.isArray(data.subscriptions.items)) {
    for (const item of data.subscriptions.items) {
      await pool.query(
        'INSERT INTO subscriptions (name, amount, cadence) VALUES ($1, $2, $3)',
        [item.name, item.amount, item.cadence]
      );
      console.log(`Seeded subscription: ${item.name}`);
    }
  }

  if (Array.isArray(data.weeks)) {
    for (const week of data.weeks) {
      const cards = (week.accounts_snapshot && week.accounts_snapshot.cards) || [];
      const bankBalance = (week.accounts_snapshot && week.accounts_snapshot.bank_balance) || 0;
      const transactions = Object.entries(week.spending_by_category || {}).map(
        ([category, amount]) => ({ category, amount })
      );
      await pool.query(
        `INSERT INTO finance_entries (logged_at, bank_balance, cards, income, transactions)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          week.logged_at || week.week_of,
          bankBalance,
          JSON.stringify(cards),
          week.income || 0,
          JSON.stringify(transactions),
        ]
      );
      console.log(`Seeded finance entry for week of ${week.week_of}`);
    }
  }

  await pool.end();
  console.log('Seed complete.');
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
