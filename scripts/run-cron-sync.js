#!/usr/bin/env node
// Runs a local cron scrape + daily summary synchronously (no QStash), for a given date (UTC)
// Usage: node scripts/run-cron-sync.js [YYYY-MM-DD]
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { fetchAndStoreNews } = require('../services/news-scrape');
const { generateDailySummary } = require('../services/daily-summary');

(async () => {
  const arg = process.argv[2];
  const date = arg && /^\d{4}-\d{2}-\d{2}$/.test(arg) ? arg : new Date().toISOString().slice(0,10);
  console.log(`[run-cron-sync] Starting for ${date}`);
  const stats = await fetchAndStoreNews(date, date, { mode: 'cron', candidateLimit: parseInt(process.env.CANDIDATE_FETCH_LIMIT_CRON||'800',10) });
  console.log('[run-cron-sync] scrape stats:', JSON.stringify(stats, null, 2));
  const summary = await generateDailySummary(date);
  console.log('[run-cron-sync] daily summary:', JSON.stringify(summary, null, 2));
})().catch(err => {
  console.error('[run-cron-sync] FAILED:', err?.message || err);
  process.exit(1);
});
