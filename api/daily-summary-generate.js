// Serverless endpoint (Vercel) fallback for daily summary generation
// Mirrors POST /api/daily-summary/generate from Express mounting.
const { generateDailySummary } = require('../services/daily-summary');
const { verifyQStash } = require('../services/qstashReceiver');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  // Ensure CSP header explicitly sets a non-'none' default and permissive connect-src
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "connect-src 'self' https: wss: http://localhost:4000 http://127.0.0.1:4000",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'self'"
  ].join('; '));
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  let body = req.body;
  if (!body) {
    // Attempt manual parse if raw body string present
    try { body = JSON.parse(req.rawBody || '{}'); } catch (_) { body = {}; }
  }
  const sig = req.headers['upstash-signature'];
  if (sig) {
    const verification = await verifyQStash(req.rawBody || JSON.stringify(body || {}), String(sig));
    if (!verification.valid) {
      return res.status(401).json({ error: 'invalid_qstash_signature', detail: verification.error });
    }
  }
  try {
    const result = await generateDailySummary();
    return res.status(200).json(result);
  } catch (e) {
    return res.status(500).json({ error: e.message || 'summary_failed' });
  }
};
