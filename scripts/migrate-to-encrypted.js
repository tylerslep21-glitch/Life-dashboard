// One-time migration: encrypts existing plaintext finance_entries.cards/
// transactions and robinhood_snapshots.history into the new cards_enc/
// transactions_enc/history_enc columns (see db.js and lib/crypto.js). Run
// once by hand after deploying the schema+code changes that add those
// columns and DATA_ENCRYPTION_KEY.
//
//   DATA_ENCRYPTION_KEY=... DATABASE_URL=... node scripts/migrate-to-encrypted.js
//
// Idempotent: only touches rows where the *_enc column is still NULL, so
// re-running (e.g. after adding more data) just encrypts whatever's new.
// The plaintext columns are left in place afterward, untouched, as a
// rollback safety net - same pattern as life_dashboard_j and
// migrate-to-users.js elsewhere in this project.

const { pool, migrate } = require('../db');
const { encryptJSON } = require('../lib/crypto');

async function migrateFinanceEntries() {
  const { rows } = await pool.query(
    "SELECT id, cards, transactions FROM finance_entries WHERE cards_enc IS NULL OR transactions_enc IS NULL"
  );
  for (const row of rows) {
    await pool.query(
      'UPDATE finance_entries SET cards_enc = $1, transactions_enc = $2 WHERE id = $3',
      [encryptJSON(row.cards || []), encryptJSON(row.transactions || []), row.id]
    );
  }
  console.log(`finance_entries: encrypted ${rows.length} row(s)`);
}

async function migrateRobinhoodSnapshots() {
  const { rows } = await pool.query(
    'SELECT id, history FROM robinhood_snapshots WHERE history_enc IS NULL'
  );
  for (const row of rows) {
    await pool.query(
      'UPDATE robinhood_snapshots SET history_enc = $1 WHERE id = $2',
      [encryptJSON(row.history || []), row.id]
    );
  }
  console.log(`robinhood_snapshots: encrypted ${rows.length} row(s)`);
}

async function main() {
  if (!process.env.DATA_ENCRYPTION_KEY) {
    console.error('DATA_ENCRYPTION_KEY env var is required.');
    process.exit(1);
  }

  await migrate(); // ensure the *_enc columns exist

  await migrateFinanceEntries();
  await migrateRobinhoodSnapshots();

  console.log('\nEncryption migration complete.');
  await pool.end();
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
