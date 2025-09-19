const express = require('express');
const router = express.Router();
const { triggerEdgeNewsScrape } = require('../services/edgeOffloader');

// POST /api/offload/news-scrape
// Body (optional): { from, to, limit, candidateLimit }
// Security (optional): set OFFLOAD_SECRET env var; require header x-offload-secret
router.post('/news-scrape', async (req, res) => {
  const secret = process.env.OFFLOAD_SECRET;
  if (secret && req.headers['x-offload-secret'] !== secret) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const { from, to, limit, candidateLimit } = req.body || {};
  const started = Date.now();
  console.log(`[offload-proxy] START from=${from||'auto'} to=${to||'auto'} limit=${limit||'default'} candidateLimit=${candidateLimit||'default'}`);
  try {
    const result = await triggerEdgeNewsScrape({ from, to, limit, candidateLimit });
    const dur = Date.now() - started;
    console.log(`[offload-proxy] COMPLETE ok=${result.ok} duration_ms=${dur}`);
    return res.status(result.ok ? 202 : (result.status || 500)).json({
      message: result.ok ? 'edge_offload_triggered' : 'edge_offload_failed',
      from: from || null,
      to: to || null,
      limit: limit || null,
      candidateLimit: candidateLimit || null,
      duration_ms: dur,
      edge: result
    });
  } catch (e) {
    const dur = Date.now() - started;
    console.error('[offload-proxy] ERROR', e?.message || e);
    return res.status(500).json({ error: e.message || 'offload_error', duration_ms: dur });
  }
});

module.exports = router;
