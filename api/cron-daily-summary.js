// Queues generation of prior day daily summary via QStash
const { Client: QStashClient } = require('@upstash/qstash');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  const started = Date.now();
  const secret = process.env.CRON_SECRET;
  const isCronRewrite = req.query?.cron === '1' || req.query?.cron === 'true';
  if (!isCronRewrite && secret && req.headers['x-cron-secret'] !== secret) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  if (!process.env.QSTASH_TOKEN) return res.status(500).json({ error: 'Missing QSTASH_TOKEN' });
  const rawBase = process.env.VERCEL_URL || process.env.VERCEL_API_BASE;
  if (!rawBase) return res.status(500).json({ error: 'Missing VERCEL_URL (or VERCEL_API_BASE)' });
  // Ensure protocol is included for QStash URL
  const base = rawBase.startsWith('http') ? rawBase : `https://${rawBase}`;
  const client = new QStashClient({ token: process.env.QSTASH_TOKEN, baseUrl: process.env.QSTASH_URL });
  const bypassToken = process.env.VERCEL_PROTECTION_BYPASS_TOKEN || process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  const makeTargetUrl = () => new URL(`${base}/api/daily-summary/generate`).toString();
  const buildHeaders = () => {
    if (!bypassToken) return undefined;
    return {
      'x-vercel-protection-bypass': bypassToken,
      'x-vercel-set-bypass-cookie': 'true',
    };
  };
  const now = new Date();
  const target = new Date(now.getTime() - 24*60*60*1000).toISOString().slice(0,10);
  try {
    const targetUrl = makeTargetUrl();
    const publishRes = await client.publishJSON({
      url: targetUrl,
      body: { date: target },
      retries: 3,
      headers: buildHeaders(),
    });
    const dur = Date.now() - started;
    return res.status(202).json({ message: 'scheduled_daily_summary', date: target, publish: publishRes, duration_ms: dur });
  } catch (e) {
    const dur = Date.now() - started;
    return res.status(500).json({ error: e.message || 'queue_failed', duration_ms: dur });
  }
};
