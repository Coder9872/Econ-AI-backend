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
  const url = process.env.SUPABASE_EDGE_SCRAPE_URL;
  if (!url) {
    console.error('[edgeOffloader] Missing SUPABASE_EDGE_SCRAPE_URL');
    return { ok: false, error: 'missing_url' };
  }
  const headers = { 'Content-Type': 'application/json' };
  const token = process.env.SUPABASE_EDGE_FUNCTION_KEY || '';
  if (token) {
    headers.Authorization = `Bearer ${token}`;
    headers['x-edge-token'] = token; // send both styles
  }
  const body = JSON.stringify({
    from: from || process.env.SCRAPE_FROM || null,
    to: to || process.env.SCRAPE_TO || null,
    limit: limit || null,
    candidateLimit: candidateLimit || process.env.CANDIDATE_FETCH_LIMIT_CRON || null,
    token: token || undefined,
  });
  try {
    const res = await fetch(url, { method: 'POST', headers, body });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = { raw: text }; }
    if (!res.ok) {
      console.error('[edgeOffloader] Non-200 response', res.status, json);
      return { ok: false, status: res.status, data: json };
    }
    return { ok: true, data: json };
  } catch (e) {
    console.error('[edgeOffloader] Error calling edge function:', e);
    return { ok: false, error: e.message };
  }
}

module.exports = { triggerEdgeNewsScrape };
