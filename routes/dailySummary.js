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

router.get('/archive', async (req, res) => {
  try {
    const yearParam = parseInt(String(req.query.year ?? ''), 10);
    const monthParam = parseInt(String(req.query.month ?? ''), 10);
    const hasYear = Number.isFinite(yearParam);
    const hasMonth = Number.isFinite(monthParam);

    if (hasYear && hasMonth) {
      const year = yearParam;
      const month = Math.max(1, Math.min(12, monthParam));
      const start = new Date(Date.UTC(year, month - 1, 1));
      const end = new Date(Date.UTC(year, month, 0));
      const startStr = start.toISOString().slice(0, 10);
      const endStr = end.toISOString().slice(0, 10);
      const { data, error } = await supabase
        .from('DailySummaries')
        .select('id,summary_date,generated_at,overview')
        .gte('summary_date', startStr)
        .lte('summary_date', endStr)
        .order('summary_date', { ascending: false });
      if (error) throw error;
      res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=600');
      return res.status(200).json({ data, year, month });
    }

    const { data, error } = await supabase
      .from('DailySummaries')
      .select('summary_date')
      .order('summary_date', { ascending: false });
    if (error) throw error;

    const yearMap = new Map();
    const rows = Array.isArray(data) ? data : [];
    for (const row of rows) {
      const rawDate = row?.summary_date;
      if (!rawDate) continue;
      const date = new Date(`${rawDate}T00:00:00Z`);
      if (!Number.isFinite(date.getTime())) continue;
      const year = date.getUTCFullYear();
      const month = date.getUTCMonth() + 1;
      const yearEntry = yearMap.get(year) || { year, months: new Map() };
      if (!yearMap.has(year)) yearMap.set(year, yearEntry);
      const monthEntry = yearEntry.months.get(month) || { month, count: 0, latestDate: null };
      monthEntry.count += 1;
      if (!monthEntry.latestDate || rawDate > monthEntry.latestDate) {
        monthEntry.latestDate = rawDate;
      }
      yearEntry.months.set(month, monthEntry);
    }

    const archive = Array.from(yearMap.entries())
      .sort((a, b) => b[0] - a[0])
      .map(([year, entry]) => ({
        year,
        months: Array.from(entry.months.entries())
          .sort((a, b) => b[0] - a[0])
          .map(([month, info]) => ({ month, count: info.count, latestDate: info.latestDate })),
      }));

    const latestDate = rows.length ? rows[0].summary_date : null;
    res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=600');
    return res.status(200).json({ archive, latestDate });
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
