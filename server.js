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
require("dotenv").config();
const PORT = process.env.PORT || 4000;

// Capture raw body for QStash signature verification while still parsing JSON
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf.toString(); } }));
app.use("/api/articles", articleRoutes);
app.use('/api', healthRoutes); // /api/offload/health presence check (renamed semantics now includes QStash)

// Only start listening when executed directly (local dev).
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
  });
}

module.exports = app;
