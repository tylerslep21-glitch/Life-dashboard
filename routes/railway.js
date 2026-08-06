const express = require('express');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
const router = express.Router();

// Personal dashboard, not a generic product - these are this account's actual
// project/environment/service ids, not secrets (the token that grants access
// to them is the secret, and that lives only in RAILWAY_API_TOKEN below).
const SERVICES = [
  { project: 'ad1680c7-3cfb-4ade-8cba-f16638eb7d24', environment: '3571b2a3-a060-4dbf-ad08-179190b6abf6', service: '9c3c4e2d-fdb8-4bec-9746-835a90f44294', name: 'Life-dashboard' },
  { project: 'ad1680c7-3cfb-4ade-8cba-f16638eb7d24', environment: '3571b2a3-a060-4dbf-ad08-179190b6abf6', service: '726573f2-476e-4064-9473-6f392ac64520', name: 'us-app' },
  { project: 'ad1680c7-3cfb-4ade-8cba-f16638eb7d24', environment: '3571b2a3-a060-4dbf-ad08-179190b6abf6', service: '7ce1b0c9-f3fd-4e93-9895-840a5f858e46', name: 'sports-intel' },
  { project: 'ad1680c7-3cfb-4ade-8cba-f16638eb7d24', environment: '3571b2a3-a060-4dbf-ad08-179190b6abf6', service: 'fdd3b057-7044-4f72-b773-81962dfadb88', name: 'Postgres' },
  { project: 'b828dd3c-0f52-4c7c-b9a8-8131cedad877', environment: 'f2662681-7a13-427c-8401-8a273f85b7c5', service: '0e91261a-93a4-4de5-807a-257534133ad3', name: 'fantasy-woj-bot' },
];

// Billing dollars aren't exposed by Railway's public GraphQL API - only the
// CLI itself produces them (internal endpoint or client-side calculation we
// can't safely reimplement without risking it silently drifting from what
// Railway actually charges). Shelling out to the real CLI, authenticated via
// RAILWAY_API_TOKEN (an account-scoped token - see Railway's docs on
// unattended/headless auth), gets the exact same numbers instead of us
// guessing at pricing math.
async function railwayCLI(args) {
  const { stdout } = await execFileAsync('npx', ['--no-install', 'railway'].concat(args), {
    env: Object.assign({}, process.env, { RAILWAY_API_TOKEN: process.env.RAILWAY_API_TOKEN }),
    timeout: 15000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

router.get('/status', async (req, res) => {
  if (!process.env.RAILWAY_API_TOKEN) {
    return res.status(500).json({ error: 'RAILWAY_API_TOKEN is not configured on this service' });
  }

  const services = await Promise.all(SERVICES.map(async (s) => {
    try {
      const deployments = await railwayCLI([
        'deployment', 'list',
        '--project', s.project,
        '--environment', s.environment,
        '--service', s.service,
        '--json',
      ]);
      const latest = deployments[0];
      return {
        name: s.name,
        status: latest ? latest.status : 'NO_DEPLOYS',
        deployedAt: latest ? latest.createdAt : null,
      };
    } catch (err) {
      return { name: s.name, status: 'ERROR', deployedAt: null };
    }
  }));

  let usage = null;
  try {
    usage = await railwayCLI(['usage', '--json']);
  } catch (err) {
    // Leave usage null - service statuses above are the more critical half.
    console.error('railway usage --json failed:', err.stderr || err.message);
  }

  res.json({ services, usage });
});

module.exports = router;
