const { supabase } = require('../models/supabaseClient');

const EPSILON = 1e-5;

async function fetchArticlesByIds(ids) {
  if (!ids || !ids.length) return [];
  const { data, error } = await supabase
    .from('Articles')
    .select('*')
    .in('id', ids);
  if (error) throw error;
  const lookup = new Map();
  (data || []).forEach(article => {
    lookup.set(article.id, article);
  });
  return ids.map(id => lookup.get(id)).filter(Boolean);
}

async function updateFavoriteBreakdown(userId) {
  const { data: favRows, error: favError } = await supabase
    .from('UsersFavoriteArticles')
    .select('article_id')
    .eq('user_id', userId);
  if (favError) throw favError;
  const articleIds = (favRows || []).map(r => r.article_id);
  if (!articleIds.length) {
    await supabase
      .from('Users')
      .update({ favorite_categories_breakdown: {} })
      .eq('id', userId);
    return;
  }
  const articles = await fetchArticlesByIds(articleIds);
  const counts = {};
  articles.forEach(article => {
    const cats = Array.isArray(article?.categories) ? article.categories : [];
    cats.forEach(cat => {
      if (!cat) return;
      counts[cat] = (counts[cat] || 0) + 1;
    });
  });
  const total = Object.values(counts).reduce((acc, v) => acc + v, 0) || 0;
  const breakdown = Object.entries(counts).reduce((acc, [cat, count]) => {
    acc[cat] = {
      count,
      ratio: total ? count / total : 0,
    };
    return acc;
  }, {});
  await supabase
    .from('Users')
    .update({ favorite_categories_breakdown: breakdown })
    .eq('id', userId);
}

async function getFavorites(req, res) {
  try {
    const userId = req.user.id;
    const { data: favRows, error } = await supabase
      .from('UsersFavoriteArticles')
      .select('article_id')
      .eq('user_id', userId);
    if (error) throw error;
    const ids = (favRows || []).map(r => r.article_id);
    const articles = await fetchArticlesByIds(ids);
    const withMeta = articles.map(article => ({
      ...article,
      is_favorite: true,
    }));
    return res.json({ data: withMeta });
  } catch (err) {
    console.error('[userContent.getFavorites] error', err);
    return res.status(500).json({ error: 'favorites_fetch_failed', detail: err?.message });
  }
}

async function addFavorite(req, res) {
  try {
    const userId = req.user.id;
    const { article_id } = req.body || {};
    const articleId = Number(article_id);
    if (!Number.isFinite(articleId)) {
      return res.status(400).json({ error: 'invalid_article_id' });
    }
    const { error } = await supabase
      .from('UsersFavoriteArticles')
      .upsert([{ user_id: userId, article_id: articleId }], { onConflict: 'user_id,article_id', ignoreDuplicates: false });
    if (error && error.code !== '23505') throw error;
    await updateFavoriteBreakdown(userId);
    return res.status(201).json({ ok: true });
  } catch (err) {
    console.error('[userContent.addFavorite] error', err);
    return res.status(500).json({ error: 'favorite_failed', detail: err?.message });
  }
}

async function removeFavorite(req, res) {
  try {
    const userId = req.user.id;
    const articleId = Number(req.params.articleId);
    if (!Number.isFinite(articleId)) {
      return res.status(400).json({ error: 'invalid_article_id' });
    }
    const { error } = await supabase
      .from('UsersFavoriteArticles')
      .delete()
      .eq('user_id', userId)
      .eq('article_id', articleId);
    if (error) throw error;
    await updateFavoriteBreakdown(userId);
    return res.json({ ok: true });
  } catch (err) {
    console.error('[userContent.removeFavorite] error', err);
    return res.status(500).json({ error: 'favorite_remove_failed', detail: err?.message });
  }
}

async function markArticleRead(req, res) {
  try {
    const userId = req.user.id;
    const { article_id } = req.body || {};
    const articleId = Number(article_id);
    if (!Number.isFinite(articleId)) {
      return res.status(400).json({ error: 'invalid_article_id' });
    }
    const { error } = await supabase
      .from('UsersReadArticles')
      .upsert([{ user_id: userId, article_id: articleId }], { onConflict: 'user_id,article_id', ignoreDuplicates: false });
    if (error && error.code !== '23505') throw error;
    return res.status(201).json({ ok: true });
  } catch (err) {
    console.error('[userContent.markArticleRead] error', err);
    return res.status(500).json({ error: 'read_mark_failed', detail: err?.message });
  }
}

async function getReadArticles(req, res) {
  try {
    const userId = req.user.id;
    const { data, error } = await supabase
      .from('UsersReadArticles')
      .select('article_id')
      .eq('user_id', userId);
    if (error) throw error;
    return res.json({ data: data || [] });
  } catch (err) {
    console.error('[userContent.getReadArticles] error', err);
    return res.status(500).json({ error: 'read_fetch_failed', detail: err?.message });
  }
}

async function getPersonalizedFeed(req, res) {
  try {
    const userId = req.user.id;

    const [favoritesRes, readRes, dailyRes] = await Promise.all([
      supabase.from('UsersFavoriteArticles').select('article_id').eq('user_id', userId),
      supabase.from('UsersReadArticles').select('article_id').eq('user_id', userId),
      supabase
        .from('DailySummaries')
        .select('*')
        .order('summary_date', { ascending: false })
        .order('generated_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);

    if (favoritesRes.error) throw favoritesRes.error;
    if (readRes.error) throw readRes.error;
    if (dailyRes.error && (!dailyRes.error.code || dailyRes.error.code !== 'PGRST116')) {
      throw dailyRes.error;
    }
    const dailySummary = dailyRes.data ?? null;

    const favoriteIds = (favoritesRes.data || []).map(r => r.article_id);
    const readIds = new Set((readRes.data || []).map(r => r.article_id));

    const favoriteArticles = await fetchArticlesByIds(favoriteIds);
    const favoriteIdSet = new Set(favoriteArticles.map(a => a.id));
    const totalFavorites = favoriteArticles.length;

    const categoryCounts = new Map();
    favoriteArticles.forEach(article => {
      const cats = Array.isArray(article?.categories) ? article.categories : [];
      cats.forEach(cat => {
        if (!cat) return;
        categoryCounts.set(cat, (categoryCounts.get(cat) || 0) + 1);
      });
    });

    const { data: candidateArticles, error: candidateError } = await supabase
      .from('Articles')
      .select('*')
      .order('relevance', { ascending: false })
      .limit(120);
    if (candidateError) throw candidateError;

    const personalized = (candidateArticles || [])
      .filter(article => !favoriteIdSet.has(article.id))
      .map(article => {
        const categories = Array.isArray(article?.categories) ? article.categories : [];
        let matchingCount = 0;
        categories.forEach(cat => {
          matchingCount += categoryCounts.get(cat) || 0;
        });
        const ratio = (matchingCount + EPSILON) / ((totalFavorites || 0) + EPSILON);
        const personalizedScore = (article?.relevance || 0) * ratio;
        return {
          ...article,
          personalized_score: personalizedScore,
          is_read: readIds.has(article.id),
        };
      })
      .filter(article => Number.isFinite(article.personalized_score))
      .sort((a, b) => b.personalized_score - a.personalized_score)
      .slice(0, 40);

    const favoritesWithMeta = favoriteArticles.map(article => ({
      ...article,
      is_favorite: true,
      is_read: readIds.has(article.id),
    }));

    return res.json({
      dailySummary,
      favorites: favoritesWithMeta,
      personalized,
    });
  } catch (err) {
    console.error('[userContent.getPersonalizedFeed] error', err);
    return res.status(500).json({ error: 'feed_failed', detail: err?.message });
  }
}

module.exports = {
  getFavorites,
  addFavorite,
  removeFavorite,
  markArticleRead,
  getReadArticles,
  getPersonalizedFeed,
};
