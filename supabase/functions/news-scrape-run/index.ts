// @ts-nocheck
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
// Supabase Edge Function: news-scrape-run
// Purpose: Heavy scrape + summarization offload invoked by Vercel cron (or manual trigger)
// Strategy: Reuse your deployed API's internal logic by calling the manual scrape endpoint OR
// directly implement minimal fetch + summarize pipeline (shown here streamlined).
// NOTE: Because the existing logic relies on Node-specific packages, the simplest robust
// approach is to call back into your Vercel API endpoint which already hosts the logic.
// Pros: single source of truth, less duplication. Cons: double network hop.
// If latency becomes an issue, port the core logic (fetchAndStoreNews) into a shared module
// that is isomorphic (no Node-only APIs) and import it here.

// Deno Edge runtime.
// Use a strict allow-list of env vars.

// Expected Env Vars (configure in Supabase dashboard):
//  - VERCEL_API_BASE : base URL of deployed Vercel project (e.g. https://your-app.vercel.app)
//  - EDGE_TRIGGER_TOKEN (optional) : shared secret to restrict invocation
//  - CRON_SECRET (optional) : if your Vercel endpoint expects an auth header
//  - OVERRIDE_FROM / OVERRIDE_TO (optional) : default date range if not provided in request body
//  - CANDIDATE_FETCH_LIMIT_CRON (optional) : override candidate scanning count
//  - TOP_ARTICLE_LIMIT_CRON (optional) : override top insertion count

interface IncomingPayload {
  from?: string;
  to?: string;
  candidateLimit?: number;
  limit?: number; // top ranked limit
  token?: string; // optional invocation token
}

function jsonResponse(body: any, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'content-type, authorization, x-edge-token'
    }
  });
}



Deno.serve(async (req: Request) => {
  const start = Date.now();
  const method = req.method;
  if (method === 'OPTIONS') return jsonResponse({ ok: true });

  let payload: IncomingPayload = {};
  try { payload = await req.json(); } catch (_) { /* ignore */ }

  const authHeader = req.headers.get('authorization') || '';
  const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  const headerToken = req.headers.get('x-edge-token') || '';
  const invocationToken = payload.token || headerToken || bearer || '';
  const requiredToken = Deno.env.get('EDGE_TRIGGER_TOKEN') || '';
  if (requiredToken && invocationToken !== requiredToken) {
    return jsonResponse({ ok: false, error: 'Forbidden' }, 403);
  }

  // Determine date range. If not provided, fallback to env overrides or yesterday->today.
  const now = new Date();
  const defaultTo = now.toISOString().slice(0,10);
  const defaultFromDate = new Date(now.getTime() - 24*60*60*1000); // minus 1 day
  const defaultFrom = defaultFromDate.toISOString().slice(0,10);

  const from = payload.from || Deno.env.get('OVERRIDE_FROM') || defaultFrom;
  const to = payload.to || Deno.env.get('OVERRIDE_TO') || defaultTo;
  const candidateLimit = payload.candidateLimit || Number(Deno.env.get('CANDIDATE_FETCH_LIMIT_CRON')) || undefined;
  const topLimit = payload.limit || Number(Deno.env.get('TOP_ARTICLE_LIMIT_CRON')) || undefined;

  const base = Deno.env.get('VERCEL_API_BASE');
  if (!base) {
    return jsonResponse({ ok: false, error: 'Missing VERCEL_API_BASE env' }, 500);
  }

  try {
    const body = {
      from,
      to,
      limit: topLimit,
      candidateLimit
    };
    const cronSecret = Deno.env.get('CRON_SECRET');
    const resp = await fetch(`${base}/api/articles/manual-scrape`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cronSecret ? { 'x-cron-secret': cronSecret } : {})
      },
      body: JSON.stringify(body)
    });
    const text = await resp.text();
    const durationMs = Date.now() - start;
    return jsonResponse({ ok: true, upstreamStatus: resp.status, upstreamBody: text, from, to, durationMs });
  } catch (e) {
    return jsonResponse({ ok: false, error: String(e) }, 500);
  }
});
