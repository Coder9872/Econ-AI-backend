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
const cors = require('cors');
const helmet = require('helmet');
const app = express();
const articleRoutes = require("./routes/articles");
const healthRoutes = require("./routes/health");
const dailySummaryRoutes = require('./routes/dailySummary');
const authRoutes = require('./routes/auth');
const meRoutes = require('./routes/me');
require("dotenv").config();
const PORT = process.env.PORT || 4000;

// Capture raw body for QStash signature verification while still parsing JSON
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf.toString(); } }));

// Helmet security headers (production ready defaults)
app.use(helmet({
  // Keep frameguard, hsts, etc. Defaults are fine; CSP added separately below
}));
app.use(helmet.contentSecurityPolicy({
  useDefaults: false,
  directives: {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'"],
    styleSrc: ["'self'", "'unsafe-inline'"],
    imgSrc: ["'self'", 'data:'],
    fontSrc: ["'self'", 'data:'],
    connectSrc: ["'self'", 'https:', 'wss:', 'http://localhost:*', 'http://127.0.0.1:*'],
    objectSrc: ["'none'"],
    baseUri: ["'self'"],
    frameAncestors: ["'self'"],
  },
}));

// CORS allowlist (env CORS_ALLOW_ORIGINS comma-separated)
const ALLOWED_ORIGINS = (process.env.CORS_ALLOW_ORIGINS || 'http://localhost:3000,https://econ-ai.vercel.app').split(',').map(o => o.trim());
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // Non-browser or same-origin
    if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    return cb(new Error(`CORS not allowed for origin: ${origin}`));
  },
  credentials: true,
  methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization','X-Requested-With']
}));
// Preflight handling is covered by the global CORS middleware above.
app.use("/api/articles", articleRoutes);
app.use('/api', healthRoutes); // /api/offload/health presence check (renamed semantics now includes QStash)
app.use('/api/daily-summary', dailySummaryRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/me', meRoutes);

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
