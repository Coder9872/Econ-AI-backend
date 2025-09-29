#!/usr/bin/env node
// Publishes QStash jobs to your locally running server via VERCEL_API_BASE (or VERCEL_URL)
// Requires QSTASH_TOKEN and VERCEL_API_BASE to be set (VERCEL_API_BASE should be a full https URL like an ngrok tunnel)
// Usage: node scripts/run-cron-qstash.js [YYYY-MM-DD]
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Client: QStashClient } = require('@upstash/qstash');

(async () => {
  const arg = process.argv[2];
  const date = arg && /^\d{4}-\d{2}-\d{2}$/.test(arg) ? arg : new Date().toISOString().slice(0,10);
  if (!process.env.QSTASH_TOKEN) throw new Error('Missing QSTASH_TOKEN');
  const rawBase = process.env.VERCEL_API_BASE || process.env.VERCEL_URL;
  if (!rawBase) throw new Error('Missing VERCEL_API_BASE (or VERCEL_URL)');
  const base = rawBase.startsWith('http') ? rawBase : `https://${rawBase}`;
  const client = new QStashClient({ token: process.env.QSTASH_TOKEN });

  // Optionally attach Vercel protection bypass if provided
  const bypass = process.env.VERCEL_PROTECTION_BYPASS_TOKEN;
  const qs = bypass ? `?x-vercel-set-bypass-cookie=true&x-vercel-protection-bypass=${encodeURIComponent(bypass)}` : '';

  const scrapeUrl = `${base}/api/articles/manual-scrape${qs}`;
  const summaryUrl = `${base}/api/daily-summary/generate${qs}`;

  console.log('[run-cron-qstash] publish scrape:', scrapeUrl);
  const s1 = await client.publishJSON({ url: scrapeUrl, body: { from: date, to: date, limit: 150, candidateLimit: 800 }, retries: 3 });
  console.log('[run-cron-qstash] queued scrape:', s1);

  console.log('[run-cron-qstash] publish summary:', summaryUrl);
  const s2 = await client.publishJSON({ url: summaryUrl, body: {}, retries: 3 });
  console.log('[run-cron-qstash] queued summary:', s2);
})().catch(err => {
  console.error('[run-cron-qstash] FAILED:', err?.message || err);
  process.exit(1);
});
