const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { z } = require('zod');
const { pool } = require('../db');

// This lets Claude Code cloud routines (which have no raw outbound network access -
// confirmed by direct testing, see robinhood-agentic-trading memory) push data to this
// app anyway, the same way they already reach the Robinhood/Drive/Gmail MCP connectors -
// those go through Anthropic's own connector infrastructure, not the sandboxed proxy
// that blocks arbitrary curl/fetch calls. A regular REST endpoint can't be reached from
// that sandbox at all; an MCP connector can.
//
// Single-user personal app, so auth is a secret URL path segment (MCP_SECRET) rather
// than full OAuth - the connector URL itself is the credential, same trust model as an
// unguessable webhook URL. Mounted at /mcp/:secret in server.js, which checks the path
// param against MCP_SECRET before this handler ever runs.

// Robinhood snapshots and agent status are pushed by Claude on tslep's behalf only
// (see routes/robinhood.js for the read-side isolation this pairs with) - resolved
// once by username lookup rather than hardcoding an id, so it survives a fresh
// database. Cached after the first successful lookup since it never changes.
let tslepUserIdCache = null;
async function getTslepUserId() {
  if (tslepUserIdCache) return tslepUserIdCache;
  const { rows } = await pool.query("SELECT id FROM users WHERE username = 'tslep'");
  if (!rows[0]) throw new Error("No 'tslep' user found - run scripts/migrate-to-users.js first");
  tslepUserIdCache = rows[0].id;
  return tslepUserIdCache;
}

function buildMcpServer() {
  const server = new McpServer({ name: 'life-dashboard', version: '1.0.0' });

  server.registerTool(
    'post_robinhood_snapshot',
    {
      title: 'Post Robinhood account snapshot',
      description:
        'Records a Robinhood account value snapshot (current total + optional daily history) for the Life Dashboard. Each call inserts a new row - call once per account per sync.',
      inputSchema: {
        account_label: z.enum(['Agentic', 'Individual']).describe('Dashboard-facing label only - never a real account number'),
        total_value: z.number().describe('Current real total_value from get_portfolio - the one authoritative number for today'),
        history: z
          .array(z.object({ date: z.string(), value: z.number() }))
          .optional()
          .describe('Reconstructed daily history, oldest to newest. Optional - omit or send empty for a snapshot with no history backfill.'),
      },
    },
    async ({ account_label, total_value, history }) => {
      const userId = await getTslepUserId();
      const safeHistory = Array.isArray(history) ? history : [];
      const { rows } = await pool.query(
        `INSERT INTO robinhood_snapshots (account_label, total_value, history, user_id)
         VALUES ($1, $2, $3, $4) RETURNING id, account_label, total_value, logged_at`,
        [account_label, total_value, JSON.stringify(safeHistory), userId]
      );
      return {
        content: [{ type: 'text', text: `Snapshot recorded: ${JSON.stringify(rows[0])}` }],
      };
    }
  );

  server.registerTool(
    'post_agent_status',
    {
      title: 'Post scheduled-agent status',
      description:
        "Upserts a scheduled agent's status card on the Life Dashboard's Agent Tracker (keyed by agent_name - re-posting the same name overwrites its row, this is a status snapshot not a log).",
      inputSchema: {
        agent_name: z.string(),
        status_summary: z.string().describe('e.g. "Active", "Paused", "Error"'),
        action_taken: z.string().optional().describe('Short phrase for what happened, e.g. "3 candidates shortlisted"'),
        recurring: z.boolean().optional().describe('false for manual-only agents - the dashboard hides non-recurring agents. Defaults true.'),
        last_run_at: z.string().optional().describe('ISO timestamp of the run this status reflects. Defaults to now.'),
      },
    },
    async ({ agent_name, status_summary, action_taken, recurring, last_run_at }) => {
      const userId = await getTslepUserId();
      const { rows } = await pool.query(
        `INSERT INTO agent_status (agent_name, status_summary, action_taken, recurring, last_run_at, updated_at, user_id)
         VALUES ($1, $2, $3, COALESCE($4, true), COALESCE($5, now()), now(), $6)
         ON CONFLICT (user_id, agent_name) DO UPDATE
           SET status_summary = EXCLUDED.status_summary,
               action_taken = EXCLUDED.action_taken,
               recurring = EXCLUDED.recurring,
               last_run_at = EXCLUDED.last_run_at,
               updated_at = now()
         RETURNING agent_name, status_summary, recurring, last_run_at`,
        [agent_name, status_summary, action_taken || null, recurring, last_run_at || null, userId]
      );
      return {
        content: [{ type: 'text', text: `Agent status upserted: ${JSON.stringify(rows[0])}` }],
      };
    }
  );

  return server;
}

// Bearer token issued by the OAuth flow in routes/oauth.js - checked against the DB
// (not in-memory) so it survives Railway redeploys/restarts.
async function hasValidBearerToken(req) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) return false;
  const { rows } = await pool.query('SELECT 1 FROM oauth_tokens WHERE token = $1', [token]);
  return rows.length > 0;
}

// Stateless mode: a fresh transport per request, no session store to manage across
// Railway's possibly-multiple/restarting instances.
async function handleMcpRequest(req, res) {
  if (!(await hasValidBearerToken(req))) {
    res.status(401).set('WWW-Authenticate', `Bearer resource_metadata="${req.protocol}://${req.get('host')}/.well-known/oauth-protected-resource"`);
    return res.json({ error: 'invalid_token' });
  }
  const server = buildMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    transport.close();
    server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}

module.exports = { handleMcpRequest };
