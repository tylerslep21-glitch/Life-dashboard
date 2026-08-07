// Transactional email via Resend's plain REST API (no SDK - same "just use
// fetch" pattern as routes/ticker.js/weather.js elsewhere in this app).
// RESEND_API_KEY/FROM_EMAIL are Railway env vars, not committed anywhere.
// Without RESEND_API_KEY configured, sendEmail() logs and no-ops instead of
// throwing - so features that don't strictly require email (the app itself)
// keep working even before that key is set up.

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = process.env.FROM_EMAIL || 'Life Dashboard <onboarding@resend.dev>';

async function sendEmail(to, subject, html) {
  if (!RESEND_API_KEY) {
    console.warn(`RESEND_API_KEY not configured - skipping email to ${to}: ${subject}`);
    return;
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: FROM_EMAIL, to, subject, html }),
  });
  if (!res.ok) {
    const body = await res.text();
    console.error(`Failed to send email to ${to}: ${res.status} ${body}`);
  }
}

module.exports = { sendEmail, emailConfigured: !!RESEND_API_KEY };
