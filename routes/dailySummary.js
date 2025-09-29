const express = require('express');
const router = express.Router();
const { generateDailySummary } = require('../services/daily-summary');
const { verifyQStash } = require('../services/qstashReceiver');
const { supabase } = require('../models/supabaseClient');

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
    const targetDate = req.body && typeof req.body.date === 'string' ? req.body.date : undefined;
    const result = await generateDailySummary(targetDate);
    return res.status(200).json(result);
  } catch (e) {
    return res.status(500).json({ error: e.message || 'summary_failed' });
  }
});

// GET /api/daily-summary/recent?limit=14 -> list recent summaries for index
router.get('/recent', async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(60, parseInt(String(req.query.limit || '14'), 10) || 14));
    const { data, error } = await supabase
      .from('DailySummaries')
      .select('id,summary_date,generated_at,overview')
      .order('summary_date', { ascending: false })
      .limit(limit);
    if (error) throw error;
    res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=600');
    return res.status(200).json({ data });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'fetch_failed' });
  }
});

// GET /api/daily-summary/latest -> newest summary by summary_date
router.get('/latest', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('DailySummaries')
      .select('*')
      .order('summary_date', { ascending: false })
      .order('generated_at', { ascending: false })
      .limit(1)
      .maybeSingle?.();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'not_found' });
    res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=600');
    return res.status(200).json(data);
  } catch (e) {
    return res.status(500).json({ error: e.message || 'fetch_failed' });
  }
});

// GET /api/daily-summary/:date -> fetch by YYYY-MM-DD (accepts YYYY-M-D and normalizes)
router.get('/:date', async (req, res) => {
  try {
    const raw = String(req.params.date || '').trim();
    // Accept both zero-padded and non-padded month/day, normalize to YYYY-MM-DD
    const m = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (!m) return res.status(400).json({ error: 'invalid_date' });
    const [_, y, mo, d] = m;
    const yyyy = y;
    const mm = String(Math.max(1, Math.min(12, parseInt(mo, 10)))).padStart(2, '0');
    const dd = String(Math.max(1, Math.min(31, parseInt(d, 10)))).padStart(2, '0');
    const date = `${yyyy}-${mm}-${dd}`;
    const { data, error } = await supabase
      .from('DailySummaries')
      .select('*')
      .eq('summary_date', date)
      .maybeSingle?.();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'not_found' });
    res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=600');
    return res.status(200).json(data);
  } catch (e) {
    return res.status(500).json({ error: e.message || 'fetch_failed' });
  }
});

module.exports = router;
