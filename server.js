// Server / API bootstrap
// ENV documentation (core + deployment):
//   PORT
//   NEWS_API_KEY, NEWS_API_URL
//   SUPABASE_URL, SUPABASE_ANON_KEY (or service role if strictly server-side)
//   GEMINI_API_KEY
//   TOP_ARTICLE_LIMIT_MANUAL, TOP_ARTICLE_LIMIT_CRON
//   CRON_SUMMARY_CONCURRENCY
//   GEMINI_MAX_REQUESTS_PER_MIN, GEMINI_ADAPTIVE_LIMIT
//   QSTASH_TOKEN (for Upstash QStash scheduling)
//   VERCEL_URL (auto in prod) or VERCEL_API_BASE (fallback for local callback construction)
//   CRON_SECRET (optional header x-cron-secret)
const express = require("express");
const app = express();
const articleRoutes = require("./routes/articles");
const healthRoutes = require("./routes/health");
const dailySummaryRoutes = require('./routes/dailySummary');
require("dotenv").config();
const PORT = process.env.PORT || 4000;

// Capture raw body for QStash signature verification while still parsing JSON
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf.toString(); } }));

// Basic Content Security Policy middleware (adds permissive connect-src so browser devtools & fetches work)
app.use((req, res, next) => {
  // Force-set CSP (overwrites any prior) with explicit default-src (not 'none').
  const policy = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "connect-src 'self' https: wss: http://localhost:* http://127.0.0.1:*",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'self'"
  ].join('; ');
  res.setHeader('Content-Security-Policy', policy);
  next();
});
app.use("/api/articles", articleRoutes);
app.use('/api', healthRoutes); // /api/offload/health presence check (renamed semantics now includes QStash)
app.use('/api/daily-summary', dailySummaryRoutes);

// Only start listening when executed directly (local dev).
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
    try {
      const list = [];
      app._router.stack.forEach(mw => {
        if (mw.route && mw.route.path) {
          const methods = Object.keys(mw.route.methods).join(',');
          list.push(`${methods.toUpperCase()} ${mw.route.path}`);
        } else if (mw.name === 'router' && mw.handle.stack) {
          mw.handle.stack.forEach(r => {
            if (r.route) {
              const methods = Object.keys(r.route.methods).join(',');
              list.push(`${methods.toUpperCase()} ${r.route.path}`);
            }
          });
        }
      });
      console.log('[RouteDiagnostics] Registered paths (relative to mount points):');
      list.forEach(p => console.log('  ', p));
    } catch (e) {
      console.warn('Route diagnostics failed:', e.message);
    }
  });
}

module.exports = app;
