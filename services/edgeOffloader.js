/*
 * Offloads heavy scraping to a Supabase Edge Function to avoid Vercel serverless time limits.
 * Required ENV:
 *   SUPABASE_EDGE_SCRAPE_URL  -> full URL of edge function endpoint
 *   SUPABASE_EDGE_FUNCTION_KEY (optional) -> bearer token if function is protected
 * Optional:
 *   SCRAPE_FROM / SCRAPE_TO   -> default date range when not provided
 */
const fetch = global.fetch || require('node-fetch');

async function triggerEdgeNewsScrape({ from, to, limit, candidateLimit } = {}) {
  const directLocal = process.env.EDGE_DIRECT_LOCAL === '1';
  if (directLocal) {
    console.log('[edgeOffloader] EDGE_DIRECT_LOCAL=1 executing news-scrape locally (bypassing edge)');
    try {
      const { fetchAndStoreNews } = require('./news-scrape');
      const stats = await fetchAndStoreNews(from || process.env.SCRAPE_FROM, to || process.env.SCRAPE_TO, { mode: 'manual', manualLimit: limit, candidateLimit });
      return { ok: true, direct: true, stats };
    } catch (e) {
      console.error('[edgeOffloader] Direct local execution failed', e);
      return { ok: false, direct: true, error: e.message };
    }
  }

  const url = process.env.SUPABASE_EDGE_SCRAPE_URL;
  if (!url) {
    console.error('[edgeOffloader] Missing SUPABASE_EDGE_SCRAPE_URL');
    return { ok: false, error: 'missing_url' };
  }

  const headers = { 'Content-Type': 'application/json' };
  const jwtKey = process.env.SUPABASE_EDGE_FUNCTION_KEY || '';
  const sharedToken = process.env.EDGE_TRIGGER_TOKEN || '';
  if (jwtKey) headers.Authorization = `Bearer ${jwtKey}`;
  if (sharedToken) headers['x-edge-token'] = sharedToken;
  if (!jwtKey && !sharedToken) {
    console.warn('[edgeOffloader] No auth credentials provided; ensure edge function has verify_jwt=false and no token requirement.');
  }

  const payload = {
    from: from || null,
    to: to || null,
    limit: limit || null,
    candidateLimit: candidateLimit || null,
    token: sharedToken || undefined
  };
  const body = JSON.stringify(payload);
  console.log('[edgeOffloader] DISPATCH', { url, hasJwt: Boolean(jwtKey), hasShared: Boolean(sharedToken), payload });

  let res, text;
  try {
    res = await fetch(url, { method: 'POST', headers, body });
    text = await res.text();
  } catch (e) {
    console.error('[edgeOffloader] network_error', e.message);
    return { ok: false, error: 'network_error', detail: e.message };
  }
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) {
    console.error('[edgeOffloader] Non-200 response', res.status, json);
    return { ok: false, status: res.status, data: json };
  }
  return { ok: true, status: res.status, data: json };
}

module.exports = { triggerEdgeNewsScrape };
