// Self-hosted error monitoring - logs to the error_log table (see db.js)
// instead of a third-party service like Sentry, so this doesn't need its own
// signup/API key. Deliberately best-effort: a failure to log an error must
// never itself crash the request or the process, so every call here swallows
// its own errors after a console.error.

const { pool } = require('../db');

const MAX_ROWS = 200; // trial-plan DB storage isn't unlimited - keep this bounded

async function logError(source, message, stack, context) {
  try {
    await pool.query(
      'INSERT INTO error_log (source, message, stack, context) VALUES ($1, $2, $3, $4)',
      [source, String(message).slice(0, 2000), stack ? String(stack).slice(0, 8000) : null, context ? JSON.stringify(context) : null]
    );
    // Prune in the same call rather than a separate cron - this table is
    // low-write-volume enough that a DELETE on every insert is cheap, and it
    // guarantees the row count never drifts unbounded between deploys.
    await pool.query(
      'DELETE FROM error_log WHERE id NOT IN (SELECT id FROM error_log ORDER BY occurred_at DESC LIMIT $1)',
      [MAX_ROWS]
    );
  } catch (err) {
    console.error('Failed to write to error_log:', err);
  }
}

module.exports = { logError };
