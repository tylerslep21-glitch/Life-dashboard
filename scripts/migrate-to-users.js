// One-time migration: two-hardcoded-tenant-database model -> real multi-user
// accounts in one shared database. Run once by hand, after deploying the
// schema+code changes that add users.user_id columns everywhere (they're
// added nullable specifically so that deploy is safe to land before this
// script runs). Requires DASHBOARD_PASSWORD and DASHBOARD_PASSWORD_J (the two
// existing tenant passwords, kept in Railway even though the app itself no
// longer reads them) to be set in the environment this runs in, so the two
// existing logins keep working unchanged as real accounts.
//
//   DASHBOARD_PASSWORD=... DASHBOARD_PASSWORD_J=... DATABASE_URL=... \
//     DATABASE_URL_J=... node scripts/migrate-to-users.js
//
// Idempotent: guarded by an app_meta flag, so re-running after a successful
// run is a safe no-op (prints a message and exits). life_dashboard_j and the
// legacy env vars are left in place afterward, untouched, as a rollback path.

const { pool, poolJ, migrate } = require('../db');
const { hashPassword } = require('../lib/auth');

const USER_TABLES = [
  'finance_entries',
  'subscriptions',
  'robinhood_snapshots',
  'exams',
  'countdowns',
  'agent_status',
  'todos',
  'calendar_sources',
  'webauthn_credentials',
];

async function alreadyDone() {
  const { rows } = await pool.query("SELECT 1 FROM app_meta WHERE key = 'users_migration_done'");
  return rows.length > 0;
}

async function createUser(username, password) {
  const { rows: existing } = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
  if (existing.length) return existing[0].id;
  const { hash, salt } = hashPassword(password);
  const { rows } = await pool.query(
    'INSERT INTO users (username, password_hash, password_salt) VALUES ($1, $2, $3) RETURNING id',
    [username, hash, salt]
  );
  console.log(`Created user '${username}' (id ${rows[0].id})`);
  return rows[0].id;
}

async function backfillDefaultTenant(tslepId) {
  for (const table of USER_TABLES) {
    const { rowCount } = await pool.query(`UPDATE ${table} SET user_id = $1 WHERE user_id IS NULL`, [tslepId]);
    console.log(`  ${table}: backfilled ${rowCount} row(s) to tslep`);
  }
}

async function copyTenantJData(jferraraId) {
  if (!poolJ) {
    console.log('  No DATABASE_URL_J configured - skipping tenant j data copy.');
    return;
  }
  for (const table of USER_TABLES) {
    const { rows } = await poolJ.query(`SELECT * FROM ${table}`);
    let copied = 0;
    for (const row of rows) {
      // Never copy the old `id` - life_dashboard_j and the shared db both
      // started their own SERIAL sequences at 1, so reusing ids verbatim
      // would collide with tslep's existing rows in the same table.
      const { id, ...rest } = row;
      rest.user_id = jferraraId;
      const columns = Object.keys(rest);
      const values = Object.values(rest).map((v) => (v !== null && typeof v === 'object' ? JSON.stringify(v) : v));
      const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
      await pool.query(
        `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`,
        values
      );
      copied++;
    }
    console.log(`  ${table}: copied ${copied} row(s) from life_dashboard_j to jferrara`);
  }
}

async function setNotNull() {
  for (const table of USER_TABLES) {
    await pool.query(`ALTER TABLE ${table} ALTER COLUMN user_id SET NOT NULL`);
  }
  console.log('  user_id set NOT NULL on every table.');
}

// agent_status was keyed by agent_name alone (single-tenant assumption) - now that
// multiple users can each have their own agent of the same name, the primary key
// becomes a surrogate id, with UNIQUE(user_id, agent_name) preserving the old
// upsert-by-name behavior per user (see routes/agent-tracker.js's ON CONFLICT).
async function migrateAgentStatusKey() {
  const { rows } = await pool.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'agent_status' AND column_name = 'id'
  `);
  if (rows.length) {
    console.log('  agent_status already has a surrogate id column - skipping key migration.');
    return;
  }
  await pool.query('ALTER TABLE agent_status DROP CONSTRAINT agent_status_pkey');
  await pool.query('ALTER TABLE agent_status ADD COLUMN id SERIAL PRIMARY KEY');
  await pool.query('ALTER TABLE agent_status ADD CONSTRAINT agent_status_user_agent_unique UNIQUE (user_id, agent_name)');
  console.log('  agent_status: switched primary key to surrogate id + UNIQUE(user_id, agent_name).');
}

async function verify(tslepId, jferraraId) {
  console.log('\nVerification:');
  for (const table of USER_TABLES) {
    const { rows: t } = await pool.query(`SELECT COUNT(*) FROM ${table} WHERE user_id = $1`, [tslepId]);
    const { rows: j } = await pool.query(`SELECT COUNT(*) FROM ${table} WHERE user_id = $1`, [jferraraId]);
    const { rows: nullCount } = await pool.query(`SELECT COUNT(*) FROM ${table} WHERE user_id IS NULL`);
    console.log(`  ${table}: tslep=${t[0].count}, jferrara=${j[0].count}, null=${nullCount[0].count}`);
  }
}

async function main() {
  if (!process.env.DASHBOARD_PASSWORD) {
    console.error('DASHBOARD_PASSWORD env var is required (tslep\'s existing password).');
    process.exit(1);
  }

  await migrate(); // ensure schema (users table, nullable user_id columns) is present

  if (await alreadyDone()) {
    console.log('Migration already completed (app_meta.users_migration_done is set). Nothing to do.');
    await pool.end();
    if (poolJ) await poolJ.end();
    return;
  }

  console.log('Creating accounts...');
  const tslepId = await createUser('tslep', process.env.DASHBOARD_PASSWORD);
  let jferraraId = null;
  if (process.env.DASHBOARD_PASSWORD_J) {
    jferraraId = await createUser('jferrara', process.env.DASHBOARD_PASSWORD_J);
  } else {
    console.log("DASHBOARD_PASSWORD_J not set - skipping 'jferrara' account and tenant j data copy.");
  }

  console.log('\nBackfilling existing shared-database rows to tslep...');
  await backfillDefaultTenant(tslepId);

  if (jferraraId) {
    console.log('\nCopying tenant j data to jferrara...');
    await copyTenantJData(jferraraId);
  }

  console.log('\nSetting user_id NOT NULL...');
  await setNotNull();

  console.log('\nMigrating agent_status primary key...');
  await migrateAgentStatusKey();

  await verify(tslepId, jferraraId);

  await pool.query("INSERT INTO app_meta (key, value) VALUES ('users_migration_done', 'true')");
  console.log('\nMigration complete.');

  await pool.end();
  if (poolJ) await poolJ.end();
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
