// Transactional email via Resend's plain REST API (no SDK - same "just use
// fetch" pattern as routes/ticker.js/weather.js elsewhere in this app).
// RESEND_API_KEY/FROM_EMAIL are Railway env vars, not committed anywhere.
// Without RESEND_API_KEY configured, sendEmail() logs and no-ops instead of
// throwing - so features that don't strictly require email (the app itself)
// keep working even before that key is set up.

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = process.env.FROM_EMAIL || 'Overview <onboarding@resend.dev>';
// A stable canonical URL for anything embedded in emails - deliberately not
// derived from whichever request happened to trigger the email (req.protocol/
// req.get('host')), since an email is read later, on a different device, and
// should always point at the same place regardless of which hostname
// handled the request that sent it. Update this once a custom domain is set
// up; until then it's the Railway production URL.
const APP_BASE_URL = process.env.APP_BASE_URL || 'https://overview-life-dashboard.up.railway.app';

// Every email gets the same logo header, so callers just pass their own
// message body and don't need to know the logo/branding markup at all.
function wrapEmailHtml(innerHtml) {
  return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 480px; margin: 0 auto;">
      <div style="text-align: center; padding: 28px 0 10px;">
        <img src="${APP_BASE_URL}/logo-email.png" alt="Overview" width="56" height="56" style="display: inline-block; border-radius: 8px;">
        <div style="font-size: 15px; font-weight: 600; color: #4A2E3D; margin-top: 8px;">Overview</div>
      </div>
      <div style="padding: 8px 28px 32px; color: #333333; font-size: 14px; line-height: 1.6;">
        ${innerHtml}
      </div>
    </div>
  `;
}

// Returns { ok: boolean } instead of throwing/swallowing - callers that
// show the user a "check your inbox" message need to know whether that's
// actually true (see routes/me.js's /email and routes/auth.js's signup/
// resend-verification, which all surface a warning instead of claiming
// success when this comes back false).
async function sendEmail(to, subject, html) {
  if (!RESEND_API_KEY) {
    console.warn(`RESEND_API_KEY not configured - skipping email to ${to}: ${subject}`);
    return { ok: false };
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: FROM_EMAIL, to, subject, html: wrapEmailHtml(html) }),
  });
  if (!res.ok) {
    const body = await res.text();
    console.error(`Failed to send email to ${to}: ${res.status} ${body}`);
    return { ok: false };
  }
  return { ok: true };
}

module.exports = { sendEmail, emailConfigured: !!RESEND_API_KEY };
