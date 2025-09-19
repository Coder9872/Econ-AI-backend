const express = require('express');
const router = express.Router();

// GET /api/offload/health
// Returns presence (not values) of critical env vars for diagnostics.
router.get('/offload/health', (req, res) => {
  const required = [
    'SUPABASE_EDGE_SCRAPE_URL',
    'SUPABASE_EDGE_FUNCTION_KEY',
    'EDGE_TRIGGER_TOKEN',
    'NEWS_API_URL',
    'NEWS_API_KEY',
    'SUPABASE_SERVICE_ROLE_KEY'
  ];
  const presence = {};
  for (const key of required) {
    presence[key] = !!process.env[key];
  }
  return res.status(200).json({ ok: true, presence, timestamp: new Date().toISOString() });
});

module.exports = router;
