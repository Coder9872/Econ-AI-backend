// Scheduled cron endpoint for Vercel; enqueues a daily scrape job via Upstash QStash.
const { Client: QStashClient } = require('@upstash/qstash');

// Helper to compute default date range (yesterday -> today) in YYYY-MM-DD
function defaultRange() {
  const now = new Date();
  const today = now.toISOString().slice(0,10);
  const yest = new Date(now.getTime() - 24*60*60*1000).toISOString().slice(0,10);
  return { from: yest, to: today };
}

// Vercel Cron cannot set custom headers; allow bypass when ?cron=1 is present via route rewrite.
module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const isCronRewrite = req.query?.cron === '1' || req.query?.cron === 'true';
  const secret = process.env.CRON_SECRET;
  if (!isCronRewrite && secret && req.headers['x-cron-secret'] !== secret) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  // Accept optional overrides via query (?from=YYYY-MM-DD&to=YYYY-MM-DD&limit=75&candidateLimit=800)
  const { from: qFrom, to: qTo, limit: qLimit, candidateLimit: qCand } = req.query || {};
  const body = req.body || {};
  const from = (body.from || qFrom) || defaultRange().from;
  const to = (body.to || qTo) || defaultRange().to;
  const limitNum = body.limit || qLimit;
  const candNum = body.candidateLimit || qCand;
  const limit = limitNum ? parseInt(limitNum, 10) : undefined;
  const candidateLimit = candNum ? parseInt(candNum, 10) : undefined;
  const started = Date.now();
  console.log(`[cron-scrape] START (queue) from=${from} to=${to} limit=${limit||'default'} candidateLimit=${candidateLimit||'default'} isCron=${isCronRewrite}`);

  if (!process.env.QSTASH_TOKEN) {
    return res.status(500).json({ error: 'Missing QSTASH_TOKEN' });
  }
  const rawBase = process.env.VERCEL_URL || process.env.VERCEL_API_BASE;
  if (!rawBase) return res.status(500).json({ error: 'Missing VERCEL_URL (or VERCEL_API_BASE)' });
  // Ensure protocol is included for QStash URL
  const base = rawBase.startsWith('http') ? rawBase : `https://${rawBase}`;
  let client;
  try {
    client = new QStashClient({ token: process.env.QSTASH_TOKEN });
  } catch (initError) {
    console.error('[cron-scrape] QStash client init failed:', initError);
    return res.status(500).json({ error: 'qstash_init_failed', message: initError.message });
  }
  
  const bypassToken = process.env.VERCEL_PROTECTION_BYPASS_TOKEN || process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  const makeTargetUrl = () => new URL(`${base}/api/articles/manual-scrape`).toString();
  const buildHeaders = () => {
    if (!bypassToken) return undefined;
    return {
      'x-vercel-protection-bypass': bypassToken,
      'x-vercel-set-bypass-cookie': 'true',
    };
  };

  const targetUrl = makeTargetUrl();
  try {
    console.log(`[cron-scrape] Publishing to QStash: ${targetUrl}`);
    const publishRes = await client.publishJSON({
      url: targetUrl,
      body: { from, to, limit: limit || null, candidateLimit: candidateLimit || null },
      retries: 3,
      headers: buildHeaders(),
    });
    const dur = Date.now() - started;
    console.log(`[cron-scrape] QUEUED duration_ms=${dur}`);
    return res.status(202).json({ message: 'scheduled_daily_scrape', from, to, limit: limit||null, candidateLimit: candidateLimit||null, publish: publishRes, duration_ms: dur });
  } catch (e) {
    const dur = Date.now() - started;
    console.error('[cron-scrape] ERROR queue', {
      message: e?.message || 'unknown',
      name: e?.name,
      stack: e?.stack?.split('\n').slice(0, 5).join('\n'),
      qstashToken: !!process.env.QSTASH_TOKEN,
      vercelUrl: !!process.env.VERCEL_URL,
      base: base
    });
    return res.status(500).json({ 
      error: e.message || 'queue_failed', 
      from, 
      to, 
      duration_ms: dur,
      debug: {
        hasQstashToken: !!process.env.QSTASH_TOKEN,
        hasVercelUrl: !!process.env.VERCEL_URL,
        targetUrl
      }
    });
  }
};