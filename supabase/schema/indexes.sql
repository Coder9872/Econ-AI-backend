-- Operational indexes for EconAI Supabase project
-- Run once (or include in migrations) to keep primary workloads fast.

-- DailySummaries optimizations -------------------------------------------------
-- Ensure summary_date lookup stays O(log n) and supports latest-first ordering.
create unique index if not exists daily_summaries_summary_date_key
  on public."DailySummaries" (summary_date);

create index if not exists daily_summaries_summary_date_generated_at_desc
  on public."DailySummaries" (summary_date desc, generated_at desc);

-- Articles optimizations -------------------------------------------------------
-- Support relevance-first pagination with deterministic ties via id.
create index if not exists articles_relevance_id_desc
  on public."Articles" (relevance desc, id desc);

-- Speed up daily scrape windows filtered by UTC day.
create index if not exists articles_article_date_idx
  on public."Articles" (article_date);

-- Optional: if categories JSONB filtering becomes common, add a GIN index.
-- create index if not exists articles_categories_gin on public."Articles" using gin (categories jsonb_path_ops);

-- Users & personalization tables -------------------------------------------
create unique index if not exists users_email_unique_lower
  on public."Users" (lower(email));

create unique index if not exists users_favorite_articles_user_article_idx
  on public."UsersFavoriteArticles" (user_id, article_id);

create unique index if not exists users_read_articles_user_article_idx
  on public."UsersReadArticles" (user_id, article_id);
