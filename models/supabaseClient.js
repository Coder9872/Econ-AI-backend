const {createClient} = require("@supabase/supabase-js");
require("dotenv").config();
/** @typedef {import('./types').Article} Article */
/** @typedef {import('./types').ArticleInsert} ArticleInsert */
/** @typedef {import('./types').ArticleUpdate} ArticleUpdate */

const PORT = process.env.PORT;
const SUPABASE_URL = process.env.SUPABASE_URL;
// Prefer service role key on the server to bypass RLS when needed
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL || (!SUPABASE_ANON_KEY && !SUPABASE_SERVICE_ROLE_KEY)) {
  throw new Error("Missing SUPABASE_URL and either SUPABASE_ANON_KEY or SUPABASE_SERVICE_ROLE_KEY in environment");
}
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY || SUPABASE_ANON_KEY);
module.exports = { supabase };
