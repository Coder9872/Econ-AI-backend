const axios = require("axios");
const { GoogleGenAI } = require("@google/genai");
const { supabase } = require("../models/supabaseClient");
const { format } = require("date-fns");
const { performance } = require('node:perf_hooks');

const NEWS_API_KEY = process.env.NEWS_API_KEY;
const NEWS_API_URL = process.env.NEWS_API_URL;
const NEWS_API_PAGE_PARAM = process.env.NEWS_API_PAGE_PARAM || 'page';
const NEWS_API_LIMIT_PARAM = process.env.NEWS_API_LIMIT_PARAM || 'limit';
const NEWS_API_PAGE_SIZE = Math.max(1, parseInt(process.env.NEWS_API_PAGE_SIZE || '200', 10));

const genAI = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
});
// Allow model override via env GEMINI_MODEL, default to gemini-2.5-pro for grouped analysis
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-pro';
// Separate model for title-only ranking (defaults to full analysis model)
const GEMINI_TITLE_MODEL = process.env.GEMINI_TITLE_MODEL || 'gemini-2.5-pro';
// Title ranking batch size and keep ratio (fraction of each batch to keep)
const TITLE_RANK_BATCH_SIZE = Math.max(1, parseInt(process.env.TITLE_RANK_BATCH_SIZE || '300', 10));
const TITLE_RANK_KEEP_RATIO = Math.max(0.01, Math.min(1, parseFloat(process.env.TITLE_RANK_KEEP_RATIO || '0.04')));

// ---------------- Gemini API Rate Limiting & Retry Helpers ----------------
// Separate token buckets per model (title=2.5-pro, summary=2.5-flash-lite)
// Strategy:
// 1) Independent RPM caps to respect per-model quotas
// 2) 429-aware adaptive lowering with quiet-period restoration
// 3) Exponential backoff + jitter; honor RetryInfo when provided
const ADAPTIVE_ENABLED = process.env.GEMINI_ADAPTIVE_LIMIT !== '0';
const MAX_RETRIES_429 = 4; // max retries on 429 before giving up

class RateLimiter {
  constructor(baseRpm, label) {
    this.base = Math.max(1, parseInt(baseRpm || '1', 10));
    this.dynamic = this.base;
    this.label = label || 'generic';
    this.timestamps = [];
    this.last429At = 0;
    // Periodic restore after 5 minutes without 429s
    setInterval(() => {
      if (ADAPTIVE_ENABLED && this.dynamic < this.base && Date.now() - this.last429At > 5 * 60_000) {
        this.dynamic = this.base;
        console.log(`[GeminiLimiter][${this.label}] Restored dynamicMaxRpm to base ${this.base}`);
      }
    }, 60_000).unref?.();
  }
  async acquire() {
    while (true) {
      const now = Date.now();
      // Drop timestamps older than 60 seconds
      while (this.timestamps.length && now - this.timestamps[0] > 60_000) {
        this.timestamps.shift();
      }
      if (this.timestamps.length < this.dynamic) {
        this.timestamps.push(now);
        return;
      }
      const waitMs = 60_000 - (now - this.timestamps[0]) + 25;
      await new Promise(r => setTimeout(r, waitMs));
    }
  }
  on429() {
    this.last429At = Date.now();
    if (ADAPTIVE_ENABLED) {
      const lowered = Math.max(1, Math.floor(this.dynamic * 0.8));
      if (lowered < this.dynamic) {
        this.dynamic = lowered;
        console.warn(`[GeminiLimiter][${this.label}] 429 received. Lowering dynamicMaxRpm -> ${this.dynamic}`);
      }
    }
  }
  getDyn() { return this.dynamic; }
  getBase() { return this.base; }
}

// Defaults: title (Flash) = 14 RPM; summary (Flash Lite) = 14 RPM
// Override via env if your quota differs.
const SUMMARY_MAX_RPM = parseInt(process.env.GEMINI_SUMMARY_MAX_RPM || '14', 10);
const TITLE_MAX_RPM   = parseInt(process.env.GEMINI_TITLE_MAX_RPM   || '14', 10);
const limiterSummary = new RateLimiter(SUMMARY_MAX_RPM, 'summary');
const limiterTitle   = new RateLimiter(TITLE_MAX_RPM, 'title');

function parseRetryDelaySeconds(err) {
  try {
    const obj = err && err.error;
    if (!obj || !Array.isArray(obj.details)) return null;
    const retryInfo = obj.details.find(d => d['@type'] && d['@type'].includes('RetryInfo'));
    if (retryInfo && retryInfo.retryDelay) {
      const match = retryInfo.retryDelay.match(/(\d+)s/);
      if (match) return parseInt(match[1], 10);
    }
  } catch (_) { /* ignore parse errors */ }
  return null;
}

function buildNewsApiUrl(extraParams = {}) {
  if (!NEWS_API_URL) return '';
  const entries = Object.entries(extraParams).filter(([, value]) => value !== undefined && value !== null);
  try {
    const url = new URL(NEWS_API_URL);
    for (const [key, value] of entries) {
      url.searchParams.set(key, String(value));
    }
    return url.toString();
  } catch (_) {
    const query = entries.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`).join('&');
    const joiner = NEWS_API_URL.includes('?') ? '&' : '?';
    return `${NEWS_API_URL}${joiner}${query}`;
  }
}

// Prompt builder for relevance/category/summary scoring
const genRelPrompt = (title = "", content = "") => {
  const clippedContent = String(content).slice(0, 1500); // configurable prompt size
  return `You are an expert financial analyst and AI editor for a platform called "econ AI". Your audience consists of investors who need fast, accurate, and actionable information.

Your task is to analyze the provided news article and return a single, valid JSON object containing three keys: "relevance_score", "categories", and "summary_points".

### 1. Relevance Score (1-100)
Assign a relevance_score from 1 to 100 based on the article's importance and market-moving potential for a general stock market investor.

90-100 (Must Read): Direct, high-impact news. (e.g., Fed rate decisions, major inflation reports, mega-cap earnings, significant M&A).
70-89 (Highly Relevant): Significant sector/company impact (approvals, warnings, major launches, guidance changes).
40-69 (Relevant Context): Useful context; not immediate catalysts (ratings, macro analysis).
10-39 (General Interest): Loosely related to business.
1-9 (Irrelevant): Not financial news.

### 2. Categories
Assign one or more categories from the predefined list below. The output must be a JSON array of strings.
- Macroeconomics & Policy
- Market Analysis & Sentiment
- Geopolitics & Regulation
- Corporate Earnings & Guidance
- Mergers & Acquisitions (M&A)
- Technology Sector
- Energy & Commodities
- Healthcare & Pharma
- Consumer & Retail
- Digital Assets & Crypto

### 3. Summary Points (markdown-ready)
Return an array of 5-10 concise bullet items. EACH item must start with a bolded label and a colon using markdown, for example:
**What happened:** ...; **Key numbers:** ...; **Why it matters:** ...; **Context:** ...
Do NOT wrap in markdown code fences. The array items are plain strings containing markdown emphasis.

### Required Output Format
MUST be a single valid JSON object, no markdown fences, no extra text:
{
  "relevance_score": <integer 1-100>,
  "categories": [<string>, ...],
  "summary_points": [<string>, ...]  // 3-5 items, each begins with a bolded label (e.g., **What happened:** ...)
}
  Responses should be aorund 150-300 words long

Article to Analyze:
Title:
${String(title)}

Content:
${clippedContent}
`;
};

//just string input

//bunch of fixes needed here
async function summarizeWithGemini(title, content) {
  if (!title || !content) return "";
  let lastErr;
  try {
    await limiterSummary.acquire();
    for (let attempt = 0; attempt <= MAX_RETRIES_429; attempt++) {
      try {
        const response = await genAI.models.generateContent({
          model: GEMINI_MODEL,
          contents: genRelPrompt(title, content),
        });
        const rawText = response?.text ?? "";
        let parsed = null;
        const jsonMatch = rawText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          try { parsed = JSON.parse(jsonMatch[0]); } catch (_) { parsed = null; }
        }
        if (parsed && typeof parsed === "object") {
          parsed.relevance_score = typeof parsed.relevance_score === "number" ? parsed.relevance_score : parseInt(parsed.relevance_score) || 0;
          parsed.categories = Array.isArray(parsed.categories) ? parsed.categories : [];
          parsed.summary_points = Array.isArray(parsed.summary_points) ? parsed.summary_points : [];
          return parsed;
        }
        return { raw: rawText };
      } catch (err) {
        // Handle 429 with exponential backoff + jitter, honoring server-provided retry if available
        if (err?.status === 429 && attempt < MAX_RETRIES_429) {
          limiterSummary.on429();
          const serverDelay = parseRetryDelaySeconds(err); // seconds
            const backoff = serverDelay != null ? serverDelay : (2 ** attempt);
          const jitterMs = Math.floor(Math.random() * 300);
          const waitMs = backoff * 1000 + jitterMs;
          console.warn(`[summarizeWithGemini] 429 retry attempt=${attempt + 1} wait_ms=${waitMs} dynMax=${limiterSummary.getDyn()}`);
          await new Promise(r => setTimeout(r, waitMs));
          await limiterSummary.acquire(); // re-check bucket after waiting
          continue;
        }
        lastErr = err;
        break;
      }
    }
  } catch (outer) {
    lastErr = outer;
  }
  if (lastErr) {
    console.error("Error summarizing text (final):", lastErr);
  }
  return "";
}

// Grouped analysis: send ~20 articles per request to Gemini 2.5 Pro, parse per-article JSON, and optionally a group-level combined summary.
const GROUP_SIZE = 20;

function buildGroupedAnalysisPrompt(group) {
  // Each group item: { idx: number, title: string, content: string }
  const items = group.map((g, i) => ({
    idx: g.idx,
    title: String(g.title || '').slice(0, 260),
    content: String(g.content || '').replace(/\s+/g, ' ').slice(0, 1800)
  }));
  const itemsJson = JSON.stringify(items);
  return `You are an expert financial analyst. Analyze the following news items and return JSON ONLY.

For EACH item, output an object with keys:
- idx: number (echo from input)
- relevance_score: integer 0-100
- categories: array of strings (from this list only: "Macroeconomics & Policy", "Market Analysis & Sentiment", "Geopolitics & Regulation", "Corporate Earnings & Guidance", "Mergers & Acquisitions (M&A)", "Technology Sector", "Energy & Commodities", "Healthcare & Pharma", "Consumer & Retail", "Digital Assets & Crypto")
- summary_points: array of 3-5 markdown-ready strings, each beginning with a bolded label, e.g., "**What happened:** ..."

Also provide a short combined summary for the whole group.

STRICT OUTPUT FORMAT (no commentary, no markdown fences):
{
  "articles": [
    { "idx": number, "relevance_score": number, "categories": [string,...], "summary_points": [string,...] },
    ... one per input item in the SAME ORDER ...
  ],
  "combined": { "summary_points": [string,...] }
}

INPUT_ITEMS = ${itemsJson}
Return ONLY the JSON object.`;
}

function parseGroupedAnalysis(rawText, expectedCount) {
  if (!rawText) return { perItem: [], combined: null };
  const stripped = rawText.replace(/^```(json)?/i, '').replace(/```\s*$/,'').trim();
  const first = stripped.indexOf('{');
  const last = stripped.lastIndexOf('}');
  if (first === -1 || last === -1 || last <= first) return { perItem: [], combined: null };
  let obj;
  try { obj = JSON.parse(stripped.slice(first, last + 1)); } catch { return { perItem: [], combined: null }; }
  const per = Array.isArray(obj?.articles) ? obj.articles : [];
  const trimmed = per.slice(0, expectedCount).map(x => ({
    idx: Number.isInteger(x?.idx) ? x.idx : null,
    relevance_score: Number.isFinite(Number(x?.relevance_score)) ? parseInt(x.relevance_score, 10) : 0,
    categories: Array.isArray(x?.categories) ? x.categories : [],
    summary_points: Array.isArray(x?.summary_points) ? x.summary_points : []
  }));
  return { perItem: trimmed, combined: obj?.combined || null };
}

// Non-batch flow: per-group single request with limited concurrency
const ANALYSIS_BATCH_SIZE = 100; // number of original articles per window; inside each window, we create groups of 20
async function analyzeArticlesInBatches(articles, phase) {
  const results = [];
  const windows = chunkArray(articles, ANALYSIS_BATCH_SIZE);
  for (let w = 0; w < windows.length; w++) {
    const windowArts = windows[w];
    const groups = chunkArray(windowArts.map((art, i) => ({
      art,
      idx: i,
      title: art.title ?? art.headline ?? '',
      content: art.content ?? art.summary ?? ''
    })), GROUP_SIZE);
    phase?.(`ANALYSIS window ${w + 1}/${windows.length} groups=${groups.length} method=single`);
    const concurrency = Math.min(5, groups.length);
    let gIndex = 0;
    const out = [];
    await Promise.all(Array.from({ length: concurrency }, () => (async function worker() {
      while (gIndex < groups.length) {
        const curr = gIndex++;
        const group = groups[curr];
        try {
          await limiterSummary.acquire();
          const resp = await genAI.models.generateContent({ model: GEMINI_MODEL, contents: buildGroupedAnalysisPrompt(group) });
          const rawText = resp?.text ?? '';
          const parsed = parseGroupedAnalysis(rawText, group.length);
          for (let m = 0; m < group.length; m++) {
            const per = parsed.perItem[m] || {};
            const gItem = group[m];
            out.push({ art: gItem.art, analysis: {
              relevance_score: per.relevance_score ?? 0,
              categories: per.categories || [],
              summary_points: per.summary_points || []
            }});
          }
        } catch (err) {
          console.error('[groupedAnalyze] error:', err?.message || err);
          for (const gItem of group) out.push({ art: gItem.art, analysis: { relevance_score: 0, categories: [], summary_points: [] } });
        }
      }
    })()));
    results.push(...out);
  }
  return results;
}

// ---------------- Title-only pre-ranking to reduce detailed requests ----------------
/**
 * Build a compact prompt asking the model to score each title for market relevance.
 * Returns scores 0..100 for each input id without extra commentary.
 * @param {{id:number,title:string}[]} items
 */
function buildTitleRankPrompt(items) {
  const lines = items.map(it => `{"id": ${it.id}, "title": ${JSON.stringify(String(it.title).slice(0, 250))}}`).join("\n");
  return `You are an expert markets editor. Score each news title for market-moving relevance for public equity investors.

Instructions:
- For EVERY input item, return an array of JSON objects with fields {"id": number, "score": integer 0-100}.
- 90-100: Must-read, direct high impact (Fed decisions, CPI/PPI, mega-cap earnings, major M&A, critical guidance).
- 70-89: Highly relevant sector/company news (approvals, warnings, significant launches, guidance changes).
- 40-69: Useful context but not immediate catalyst.
- 10-39: General business interest.
- 0-9: Not financial news.
- Output ONLY the JSON array. No explanations, no markdown.

Input titles (JSON per line):
${lines}
`;
}

/**
 * Call Gemini to score titles for one batch. Reuses rate limiting and 429 retry logic.
 * @param {{id:number,title:string}[]} items
 * @returns {Promise<Array<{id:number, score:number}>>}
 */
async function scoreTitleBatch(items) {
  let lastErr;
  try {
    await limiterTitle.acquire();
    for (let attempt = 0; attempt <= MAX_RETRIES_429; attempt++) {
      try {
        const resp = await genAI.models.generateContent({
          model: GEMINI_TITLE_MODEL,
          contents: buildTitleRankPrompt(items),
        });
        const rawText = resp?.text ?? "";
        const jsonMatch = rawText.match(/\[[\s\S]*\]/);
        if (!jsonMatch) return [];
        let arr;
        try { arr = JSON.parse(jsonMatch[0]); } catch (_) { return []; }
        if (!Array.isArray(arr)) return [];
        return arr
          .map(x => ({ id: Number(x.id), score: Math.max(0, Math.min(100, parseInt(x.score, 10) || 0)) }))
          .filter(x => Number.isInteger(x.id));
      } catch (err) {
        if (err?.status === 429 && attempt < MAX_RETRIES_429) {
          limiterTitle.on429();
          const serverDelay = parseRetryDelaySeconds(err);
          const backoff = serverDelay != null ? serverDelay : (2 ** attempt);
          const jitterMs = Math.floor(Math.random() * 300);
          const waitMs = backoff * 1000 + jitterMs;
          console.warn(`[titleRank] 429 retry attempt=${attempt + 1} wait_ms=${waitMs} dynMax=${limiterTitle.getDyn()}`);
          await new Promise(r => setTimeout(r, waitMs));
          await limiterTitle.acquire();
          continue;
        }
        lastErr = err;
        break;
      }
    }
  } catch (outer) {
    lastErr = outer;
  }
  if (lastErr) console.error('[titleRank] Error (final):', lastErr?.message || lastErr);
  return [];
}

async function fetchArticlesPaginated(from, to, totalLimit, phase) {
  const collected = [];
  let page = 1;
  let batches = 0;
  while (collected.length < totalLimit) {
    const remaining = totalLimit - collected.length;
    const requestSize = Math.min(NEWS_API_PAGE_SIZE, remaining);
    const params = {
      api_token: NEWS_API_KEY,
      from,
      to,
      [NEWS_API_LIMIT_PARAM]: String(requestSize),
    };
    if (NEWS_API_PAGE_PARAM) {
      params[NEWS_API_PAGE_PARAM] = String(page);
    }
    const url = buildNewsApiUrl(params);
    phase?.(`FETCH page=${page} size=${requestSize} collected=${collected.length}/${totalLimit}`);
    const response = await axios.get(url, { timeout: 30_000 });
    const raw = response.data;
    const batch = Array.isArray(raw) ? raw : raw?.data ? raw.data : [];
    batches++;
    if (!Array.isArray(batch) || !batch.length) {
      phase?.(`FETCH page=${page} returned 0 results; stopping pagination`);
      break;
    }
    collected.push(...batch);
    if (batch.length < requestSize) {
      phase?.(`FETCH page=${page} returned ${batch.length} < ${requestSize}; reached end of feed`);
      break;
    }
    page += 1;
  }
  return { articles: collected.slice(0, totalLimit), batches };
}

function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Score all titles in batches and return the selected article indexes to keep.
 * @param {Array<any>} articles
 * @param {(msg:string)=>void} phase
 * @returns {Promise<number[]>} indexes of selected articles by original order
 */
async function preselectByTitle(articles, phase, { global = false } = {}) {
  const items = articles.map((a, i) => ({ id: i, title: a.title ?? a.headline ?? '' }));
  const validItems = items.filter(it => it.title && typeof it.title === 'string');
  if (!validItems.length) return [];
  phase(`TITLE-RANK start total=${validItems.length} batch=${TITLE_RANK_BATCH_SIZE} keep_ratio=${TITLE_RANK_KEEP_RATIO} model=${GEMINI_TITLE_MODEL} global=${global}`);
  if (global || validItems.length <= TITLE_RANK_BATCH_SIZE) {
    // Single global batch (e.g., cron): keep top 25% of entire set
    const res = await scoreTitleBatch(validItems);
    res.sort((a, b) => b.score - a.score);
    const keepCount = Math.max(1, Math.ceil(TITLE_RANK_KEEP_RATIO * validItems.length));
    const chosen = res.slice(0, Math.min(keepCount, res.length));
    const selected = chosen.filter(r => Number.isInteger(r.id)).map(r => r.id);
    phase(`TITLE-RANK complete(global) selected_total=${selected.length} of ${validItems.length}`);
    return selected;
  } else {
    // Per-batch selection (manual): keep 25% from each batch
    const batches = chunkArray(validItems, TITLE_RANK_BATCH_SIZE);
    const selectedSet = new Set();
    for (let b = 0; b < batches.length; b++) {
      const batch = batches[b];
      const res = await scoreTitleBatch(batch);
      res.sort((a, b) => b.score - a.score);
      const keepCount = Math.max(1, Math.ceil(TITLE_RANK_KEEP_RATIO * batch.length));
      const chosen = res.slice(0, Math.min(keepCount, res.length));
      for (const r of chosen) if (Number.isInteger(r.id)) selectedSet.add(r.id);
      phase(`TITLE-RANK batch ${b+1}/${batches.length} scored=${res.length} keep=${chosen.length}/${batch.length}`);
    }
    const selected = Array.from(selectedSet.values());
    phase(`TITLE-RANK complete(selected per-batch) total=${selected.length} of ${validItems.length}`);
    return selected;
  }
}

// --- Title similarity utilities (bag-of-words cosine) ---
function tokenizeTitle(s) {
  if (!s || typeof s !== "string") return [];
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function vectorize(tokens) {
  const map = Object.create(null);
  for (const t of tokens) map[t] = (map[t] || 0) + 1;
  return map;
}

function dot(a, b) {
  let sum = 0;
  const keys = Object.keys(a);
  for (const k of keys) if (b[k]) sum += a[k] * b[k];
  return sum;
}

function cosineSim(vecA, vecB) {
  const magA =
    Math.sqrt(Object.values(vecA).reduce((s, v) => s + v * v, 0)) || 0;
  const magB =
    Math.sqrt(Object.values(vecB).reduce((s, v) => s + v * v, 0)) || 0;
  const denom = magA * magB;
  if (!denom) return 0;
  return dot(vecA, vecB) / denom;
}

// Jaccard similarity for token sets
function jaccardSimilarity(setA, setB) {
  if (!setA || !setB || setA.size === 0 || setB.size === 0) return 0;
  let inter = 0;
  for (const t of setA) if (setB.has(t)) inter++;
  const union = setA.size + setB.size - inter;
  return union ? inter / union : 0;
}

function tokensToSet(tokens) {
  return new Set(tokens);
}

// Unified relevance + categorization + summarization workflow
/**
 * Fetch, analyze, rank, dedupe and store news articles.
 * @param {string} from - inclusive date (YYYY-MM-DD)
 * @param {string} to   - inclusive date (YYYY-MM-DD)
 * @param {Object} opts
 * @param {'manual'|'cron'} [opts.mode] - invocation mode influences concurrency + ranking slice selection.
 * @param {number} [opts.manualLimit] - optional override for max ranked articles to keep in manual mode (1..500).
 * @param {number} [opts.candidateLimit] - optional override for how many raw articles to fetch/analyze before ranking.
 */
async function fetchAndStoreNews(from, to, opts = {}) {
  const t0 = performance.now();
  const phase = (msg) => console.log(`[news-scrape][${(performance.now()-t0).toFixed(0)}ms] ${msg}`);
  const mode = opts.mode === 'cron' ? 'cron' : 'manual';
  // Allow caller (manual invocation) to override limit via opts.manualLimit.
  // Fallback to env TOP_ARTICLE_LIMIT_MANUAL when not provided or invalid.
  const manualLimitEnv = parseInt(process.env.TOP_ARTICLE_LIMIT_MANUAL || '75', 10);
  const manualLimitOverride = typeof opts.manualLimit === 'number' && opts.manualLimit > 0 && opts.manualLimit <= 500 ? opts.manualLimit : null;
  const manualLimit = manualLimitOverride || manualLimitEnv;
  const cronLimit = parseInt(process.env.TOP_ARTICLE_LIMIT_CRON || '75', 10);
  // Candidate fetch limits (raw articles scanned before ranking). Higher = more coverage, more cost/time.
  const defaultCandidateCron = parseInt(process.env.CANDIDATE_FETCH_LIMIT_CRON || '3000', 10); // target scanning 3000
  const defaultCandidateManual = parseInt(process.env.CANDIDATE_FETCH_LIMIT_MANUAL || '50', 10);
  const candidateLimitOverride = typeof opts.candidateLimit === 'number' && opts.candidateLimit > 0 ? opts.candidateLimit : null;
  const candidateLimit = candidateLimitOverride || (mode === 'cron' ? defaultCandidateCron : defaultCandidateManual);
  // Concurrency lowered to 3 by default to reduce risk of bursting through Gemini free tier (15 RPM)
  // Override via env CRON_SUMMARY_CONCURRENCY if you have higher quota.
  const concurrency = parseInt(process.env.CRON_SUMMARY_CONCURRENCY || '3', 10);
  phase(`INIT mode=${mode} range=${from}->${to} limits(manual=${manualLimit},cron=${cronLimit}) candidateLimit=${candidateLimit} concurrency=${concurrency} models(summary=${GEMINI_MODEL}, title=${GEMINI_TITLE_MODEL}) rpms(summary=${limiterSummary.getBase()}, title=${limiterTitle.getBase()})`);
  phase('FETCH start');
  const stats = { mode, from, to, candidateLimit, manualLimit, cronLimit, started_at: new Date().toISOString(), fetched_total: 0, fetch_batches: 0, analyzed: 0, kept_ranked: 0, final_after_dedupe: 0, inserted: 0, conflicts: 0, insert_errors: 0, errors: [], zero_reason: null, duration_ms: 0 };
  if (!NEWS_API_URL || !NEWS_API_KEY) {
    stats.zero_reason = 'missing_env';
    stats.errors.push({ type: 'config', message: 'Missing NEWS_API_URL or NEWS_API_KEY env var' });
    phase('CONFIG missing required env vars');
    stats.duration_ms = Math.round(performance.now() - t0);
    return stats;
  }
  try {
    const { articles: fetchedArticles, batches } = await fetchArticlesPaginated(from, to, candidateLimit, phase);
    phase(`FETCH done batches=${batches}`);
    let articles = Array.isArray(fetchedArticles) ? fetchedArticles : [];
    if (!articles.length) {
      phase("NO ARTICLES - EXIT");
      stats.zero_reason = 'no_articles_returned';
      stats.duration_ms = Math.round(performance.now() - t0);
      return stats;
    }
    if (articles.length > 1) {
      shuffleInPlace(articles);
      phase(`ARTICLES fetched_total=${articles.length} shuffled_to_reduce_bias`);
    } else {
      phase(`ARTICLES fetched_total=${articles.length}`);
    }
    stats.fetched_total = articles.length;
    stats.fetch_batches = batches;

    // Stage 1: Title-only preselection to reduce detailed model calls
    try {
      const selectedIdx = await preselectByTitle(articles, phase, { global: mode === 'cron' });
      if (selectedIdx && selectedIdx.length) {
        const idxSet = new Set(selectedIdx);
        const before = articles.length;
        articles = articles.filter((_, i) => idxSet.has(i));
        phase(`ARTICLES preselected_by_title before=${before} after=${articles.length}`);
      } else {
        phase('TITLE-RANK produced no selection; proceeding with all articles');
      }
    } catch (e) {
      console.warn('Title preselection failed, proceeding without:', e?.message || e);
    }

    // First pass: run unified Gemini prompt for each article (title+content) to get relevance, categories, summary points
  const enriched = [];
    let analyzedCount = 0;
    let skippedNoTitle = 0;
    async function processOne(art){
      const title = art.title ?? art.headline ?? '';
      const content = art.content ?? art.summary ?? '';
      if (!title) {
        skippedNoTitle++;
        enriched.push({ ...art, _error: 'missing_title' });
        return;
      }
      try {
        const analysis = await summarizeWithGemini(title, content);
        if (!analysis || typeof analysis !== 'object') {
          enriched.push({ ...art, _error: 'analysis_failed' });
        } else {
          analyzedCount++;
          if (analyzedCount % 10 === 0) {
            phase(`ANALYSIS progress analyzed=${analyzedCount} skipped_no_title=${skippedNoTitle}`);
          }
          enriched.push({ ...art, _analysis: analysis });
        }
      } catch (e) {
        console.error('Unified analysis error:', e?.message || e);
        enriched.push({ ...art, _error: 'exception' });
      }
    }
    {
  // Grouped single requests (no batch API), windows of ~100, groups of 20
  phase(`ANALYSIS start (grouped single requests, mode=${mode})`);
      const batched = await analyzeArticlesInBatches(articles, phase);
      for (const item of batched) {
        const art = item.art;
        const analysis = item.analysis;
        if (!analysis || typeof analysis !== 'object') {
          enriched.push({ ...art, _error: 'analysis_failed' });
        } else {
          analyzedCount++;
          enriched.push({ ...art, _analysis: analysis });
        }
      }
    }
  phase(`ANALYSIS complete analyzed=${analyzedCount} enriched_total=${enriched.length}`);
  stats.analyzed = analyzedCount;

    // Filter those with valid analysis and numeric relevance_score
    const analyzed = enriched.filter(a => a._analysis && typeof a._analysis.relevance_score === 'number');
    if (!analyzed.length) {
      console.warn('No successfully analyzed articles. Aborting.');
      stats.zero_reason = 'analysis_failed_all';
      stats.duration_ms = Math.round(performance.now() - t0);
      return stats;
    }

    // Rank by relevance_score descending, keep top 75
    const ranked = [...analyzed].sort((a,b) => b._analysis.relevance_score - a._analysis.relevance_score);
    const topRanked = ranked;
  phase(`RANK complete kept=${topRanked.length} limit=all dyn(summary=${limiterSummary.getDyn()}, title=${limiterTitle.getDyn()})`);
    stats.kept_ranked = topRanked.length;

    // Dedupe by Jaccard title similarity AFTER ranking
    const acceptedTitleSets = [];
    const finalList = [];
    for (const art of topRanked) {
      const title = art.title ?? art.headline ?? '';
      const candSet = tokensToSet(tokenizeTitle(title));
      let duplicate = false;
      for (const prev of acceptedTitleSets) {
        const sim = jaccardSimilarity(candSet, prev);
        if (sim >= 0.7) {
          duplicate = true;
          console.log(`Skipping near-duplicate (jaccard=${sim.toFixed(3)}): ${title}`);
          break;
        }
      }
      if (!duplicate) {
        acceptedTitleSets.push(candSet);
        finalList.push(art);
      }
    }
  phase(`DEDUPE complete final=${finalList.length} removed=${topRanked.length - finalList.length}`);
    stats.final_after_dedupe = finalList.length;

    // Insert each retained article
  let inserted = 0;
  let conflicts = 0;
    phase('UPSERT start');
  for (const art of finalList) {
      const title = art.title ?? art.headline ?? null;
      if (!title) continue; // safety
      const link = art.link ?? art.url ?? null;
      const dateStr = art.date ?? art.published_at ?? art.time ?? null;
    const tickers = Array.isArray(art.symbols)
      ? art.symbols
      : Array.isArray(art.tickers)
      ? art.tickers
      : art.symbols
      ? [art.symbols]
      : [];

    const analysis = art._analysis || {};
    const relevance = Number.isFinite(Number(analysis.relevance_score))
      ? parseInt(analysis.relevance_score, 10)
      : 0;
    const categories = Array.isArray(analysis.categories)
      ? analysis.categories
      : [];
    const summaryPoints = Array.isArray(analysis.summary_points)
      ? analysis.summary_points
      : [];

  // Build the 'summary' text: bullet points only (markdown-ready, '- ')
  const bulletLines = summaryPoints.length ? summaryPoints.map(p => `- ${p}`) : [];
  const summaryText = bulletLines.length ? bulletLines.join('\n') : null;

    // Build the JSON payload for the `symbols` json/jsonb column (only tickers here)
    // Categories, relevance, and summary points are intentionally kept OUT of `symbols`
    // to keep ticker symbols separate from analysis metadata.
    let symbolsPayload = tickers.length ? { tickers } : null;

    // Ensure article_date and summarized_at are ISO timestamps (Postgres timestamp acceptable)
    const articleDateIso = dateStr ? new Date(dateStr).toISOString() : null;
    const summarizedAtIso = new Date().toISOString();

    let error;
    if (link) {
      // Manual duplicate check (no unique constraint present on link yet)
      const existing = await supabase.from("Articles").select('id').eq('link', link).limit(1);
      if (existing.error) {
        error = existing.error;
      } else if (existing.data && existing.data.length) {
        conflicts++;
        phase(`UPSERT skip duplicate link=${link}`);
      } else {
        const insertPayload = {
          title: title || null,
          summary: summaryText,
          link: link || null,
          article_date: articleDateIso,
          symbols: symbolsPayload,
          summarized_at: summarizedAtIso,
        };
  // Persist to dedicated columns when present
  //make sure to understand relveance is a score, it is not relevance_score
  insertPayload.relevance = Number.isFinite(relevance) ? relevance : null;
  insertPayload.categories = categories.length ? categories : null;

        const insertRes = await supabase.from("Articles").insert([insertPayload]);
        error = insertRes.error;
      }
    } else {
      // Insert without link (cannot dedupe)
      const insertPayload = {
        title: title || null,
        summary: summaryText,
        link: null,
        article_date: articleDateIso,
        symbols: symbolsPayload,
        summarized_at: summarizedAtIso,
      };
  insertPayload.relevance = Number.isFinite(relevance) ? relevance : null;
  insertPayload.categories = categories.length ? categories : null;

      const insertRes = await supabase.from("Articles").insert([insertPayload]);
      error = insertRes.error;
    }
      if (error) {
        console.error('Insert error:', error);
        stats.insert_errors++;
        stats.errors.push({ type: 'insert', message: error.message || String(error), link });
      } else {
        inserted++;
        if (inserted % 10 === 0) phase(`UPSERT progress inserted=${inserted} conflicts=${conflicts}`);
      }
    }
    phase(`UPSERT complete inserted=${inserted} conflicts=${conflicts}`);
    if (!inserted && !stats.zero_reason) {
      stats.zero_reason = stats.insert_errors ? 'all_inserts_failed' : (conflicts ? 'all_duplicates' : 'unknown');
    }
    phase('DONE');
    stats.inserted = inserted;
    stats.conflicts = conflicts;
    stats.duration_ms = Math.round(performance.now() - t0);
    return stats;
  } catch (error) {
    console.error('Error fetching news:', error);
    phase('ABORT due to error');
    stats.error = error?.message || String(error);
    stats.duration_ms = Math.round(performance.now() - t0);
    throw Object.assign(new Error(stats.error), { stats });
  }
}

module.exports = { fetchAndStoreNews };
