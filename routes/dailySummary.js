const express = require('express');
const router = express.Router();
const { generateDailySummary } = require('../services/daily-summary');
const { verifyQStash } = require('../services/qstashReceiver');

router.get('/ping', (req, res) => res.json({ ok: true, route: 'daily-summary', time: new Date().toISOString() }));

// POST /api/daily-summary/generate
// Ignores any provided date; always generates (or skips) for today using top globally relevant articles.
router.post('/generate', async (req, res) => {
  const sig = req.headers['upstash-signature'];
  if (sig) {
    const verification = await verifyQStash(req.rawBody || JSON.stringify(req.body || {}), String(sig));
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
});

module.exports = router;
