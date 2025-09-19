// Server / API bootstrap
// ENV documentation (core + deployment):
//   PORT
//   NEWS_API_KEY, NEWS_API_URL
//   SUPABASE_URL, SUPABASE_ANON_KEY (or service role if strictly server-side)
//   GEMINI_API_KEY
//   TOP_ARTICLE_LIMIT_MANUAL, TOP_ARTICLE_LIMIT_CRON
//   CRON_SUMMARY_CONCURRENCY
//   GEMINI_MAX_REQUESTS_PER_MIN, GEMINI_ADAPTIVE_LIMIT
//   SUPABASE_EDGE_SCRAPE_URL, SUPABASE_EDGE_FUNCTION_KEY (for offloading cron)
//   CRON_SECRET (optional header x-cron-secret)
const express = require("express");
const app = express();
const articleRoutes = require("./routes/articles");
const offloadRoutes = require("./routes/offload");
require("dotenv").config();
const PORT = process.env.PORT || 4000;

app.use(express.json());
app.use("/api/articles", articleRoutes);
app.use('/api/offload', offloadRoutes); // proxy that hides Supabase project ref

// Only start listening when executed directly (local dev).
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
  });
}

module.exports = app;
