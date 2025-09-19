const { supabase } = require('../models/supabaseClient');
const express = require('express');
const { fetchAndStoreNews } = require('../services/news-scrape');
const { triggerEdgeNewsScrape } = require('../services/edgeOffloader');
/** @typedef {import('../models/types').Article} Article */
/** @typedef {import('../models/types').ArticleInsert} ArticleInsert */
/** @typedef {import('../models/types').ArticleUpdate} ArticleUpdate */

// Types are centralized in models/types.js
/* schema id: bigint, primary key, auto-incremented
summarized_at: timestamp with time zone, not null, defaults to current time
summary: text, nullable, defaults to 'NULL'
article_date: timestamp without time zone, nullable
title: text, nullable
link: text, nullable
symbols: json, nullable
tags
sentiment json
//need to add category column will figure it out
*/

// GET /articles - Retrieve a list of articles
/**
 * Get a list of articles
 * @param {express.Request} req
 * @param {express.Response<Article[]>} res
 */
const getAllArticles = async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('Articles')
            .select('*');
            // Support sorting by article_date via query param ?sort=asc or ?sort=desc (default: desc)
            const sortParam = (req.query.sort || 'desc').toString().toLowerCase();
            if (data && Array.isArray(data)) {
                data.sort((a, b) => {
                    const aTime = a && a.article_date ? new Date(a.article_date).getTime() : -Infinity;
                    const bTime = b && b.article_date ? new Date(b.article_date).getTime() : -Infinity;
                    return sortParam === 'asc' ? aTime - bTime : bTime - aTime;
                });
            }
        if (error) throw error;

        res.status(200).json(data);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
};

// POST /articles - Create a new article
// need to implement category searching + summarizations
/**
 * Create a new article
 * @param {express.Request<{}, {}, ArticleInsert>} req
 * @param {express.Response<{ mssg: string, article?: Article }>} res
 */
const createArticle = async (req, res) => {
    try {
        const { title, content, article_date, symbols, link } = req.body;
        // Normalize article_date to ISO (timestamp without timezone in DB accepts ISO string)
        const articleDateISO = article_date ? new Date(article_date).toISOString() : null;

        // Map incoming `content` -> DB `summary`
        /** @type {ArticleInsert} */
        const insertObj = {
            title: title ?? null,
            summary: (content ?? req.body.summary) ?? null,
            article_date: articleDateISO,
            symbols: symbols ?? null,
            link: link ?? null,
        };

        const { data, error } = await supabase
            .from('Articles')
            .insert([insertObj])
            .select()
            .single();

        if (error) throw error;

        res.status(201).json({ mssg: 'Article created', article: data });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
};

// GET /articles/:id - Retrieve a specific article by ID
const getArticleById = async (req, res) => {
    try {
        const { id } = req.params;
        const { data, error } = await supabase
            .from('Articles')
            .select('*')
            .eq('id', id)
            .single();
            
        if (error) throw error;
        if (!data) return res.status(404).json({ error: 'Article not found' });

        res.status(200).json(data);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
};

// PATCH /articles/:id - Update an existing article by ID
/**
 * Update an article by ID
 * @param {express.Request<{id: string}, {}, ArticleUpdate>} req
 * @param {express.Response<Article>} res
 */
const updateArticleById = async (req, res) => {
    try {
        const { id } = req.params;
        // Whitelist updatable fields to avoid schema errors
        const allowedUpdateFields = ['title', 'summary', 'article_date', 'symbols', 'link'];
        /** @type {ArticleUpdate & { summarized_at?: string }} */
        const updatesRaw = req.body || {};
        /** @type {Record<string, any>} */
        const updates = {};
        for (const key of allowedUpdateFields) {
            if (Object.prototype.hasOwnProperty.call(updatesRaw, key)) {
                updates[key] = updatesRaw[key];
            }
        }
        // If article_date is being updated, convert to ISO string
        if (updates.article_date) {
            updates.article_date = new Date(updates.article_date).toISOString();
        }
        // Update summarized_at to current time if summary is updated
        if (typeof updates.summary === 'string') {
            updates.summarized_at = new Date().toISOString();
        }

        const { data, error } = await supabase
            .from('Articles')
            .update(updates)
            .eq('id', id)
            .select()
            .single();

        if (error) throw error;
        if (!data) return res.status(404).json({ error: 'Article not found' });

        res.status(200).json(data);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
}

// DELETE /articles/:id - Delete an article by ID
const deleteArticleById = async (req, res) => {
    try {
        const { id } = req.params;
        const { data, error } = await supabase
            .from('Articles')
            .delete()
            .eq('id', id)
            .select()
            .single();

        if (error) throw error;
        if (!data) return res.status(404).json({ error: 'Article not found' });

        res.status(200).json({ message: 'Article deleted successfully', data });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
}

// POST /api/articles/manual-scrape
// Body: { from: 'YYYY-MM-DD', to: 'YYYY-MM-DD', limit?: number }
// Query: ?async=1 to run old fire-and-forget behavior (not reliable on serverless)
// Default now waits for completion so inserts succeed before response ends.
const manualScrape = async (req, res) => {
    const { from, to, limit, candidateLimit, offload } = req.body || {};
    if (!from || !to) {
        return res.status(400).json({ error: 'Both "from" and "to" dates are required' });
    }

    // Modes:
    //   sync  (default) : wait for completion & return stats (best for small ranges)
    //   async (?async=1) : fire & forget (NOT reliable on serverless – discouraged)
    //   offload (?offload=1 or body.offload=1) : trigger Supabase Edge Function to do the heavy work
    const asyncMode = req.query.async === '1' || req.query.async === 'true';
    const offloadMode = offload === 1 || offload === true || req.query.offload === '1' || req.query.offload === 'true';

    const start = Date.now();
    const limitNum = typeof limit === 'number' ? limit : parseInt(limit, 10);
    const validLimit = Number.isFinite(limitNum) && limitNum > 0 && limitNum <= 500 ? limitNum : undefined;
    const candNum = typeof candidateLimit === 'number' ? candidateLimit : parseInt(candidateLimit, 10);
    const validCandidateLimit = Number.isFinite(candNum) && candNum > 0 ? candNum : undefined;
    console.log(`[manualScrape] START range=${from}->${to} limit=${validLimit || 'default'} candidateLimit=${validCandidateLimit || 'default'} async=${asyncMode} offload=${offloadMode} at=${new Date(start).toISOString()}`);

    // Offload path (recommended for long / large ranges)
    if (offloadMode) {
        try {
            const trigger = await triggerEdgeNewsScrape({ from, to, limit: validLimit, candidateLimit: validCandidateLimit });
            const dur = Date.now() - start;
            return res.status(trigger.ok ? 202 : (trigger.status || 500)).json({
                message: trigger.ok ? 'Offloaded scrape to edge function' : 'Edge offload failed',
                mode: 'offload',
                from,
                to,
                limit: validLimit || null,
                candidateLimit: validCandidateLimit || null,
                duration_ms: dur,
                edge: trigger
            });
        } catch (e) {
            const dur = Date.now() - start;
            console.error('[manualScrape] offload error', e);
            return res.status(500).json({ error: e.message || 'offload_failed', duration_ms: dur });
        }
    }

    if (asyncMode) {
        res.status(202).json({ message: `Scrape (async) started for ${from} -> ${to}`, from, to, limit: validLimit || null, candidateLimit: validCandidateLimit || null });
        fetchAndStoreNews(from, to, { mode: 'manual', manualLimit: validLimit, candidateLimit: validCandidateLimit })
            .then(stats => {
                const dur = Date.now() - start;
                console.log(`[manualScrape] COMPLETE async range=${from}->${to} limit=${validLimit || 'default'} candidateLimit=${validCandidateLimit || 'default'} duration_ms=${dur} inserted=${stats?.inserted ?? 'n/a'}`);
            })
            .catch(err => {
                const dur = Date.now() - start;
                console.error(`[manualScrape] ERROR async range=${from}->${to} limit=${validLimit || 'default'} candidateLimit=${validCandidateLimit || 'default'} duration_ms=${dur} msg=${err?.message || err}`);
            });
        return;
    }

    // Sync (wait) path
    try {
        const stats = await fetchAndStoreNews(from, to, { mode: 'manual', manualLimit: validLimit, candidateLimit: validCandidateLimit });
        const dur = Date.now() - start;
        console.log(`[manualScrape] COMPLETE sync range=${from}->${to} limit=${validLimit || 'default'} candidateLimit=${validCandidateLimit || 'default'} duration_ms=${dur}`);
        return res.status(200).json({
            message: 'Scrape completed',
            from,
            to,
            limit: validLimit || null,
            candidateLimit: validCandidateLimit || null,
            duration_ms: dur,
            stats: stats || null
        });
    } catch (err) {
        const dur = Date.now() - start;
        console.error(`[manualScrape] ERROR sync range=${from}->${to} limit=${validLimit || 'default'} candidateLimit=${validCandidateLimit || 'default'} duration_ms=${dur} msg=${err?.message || err}`);
        return res.status(500).json({ error: err?.message || 'scrape_failed' });
    }
};

module.exports = {
    getAllArticles,
    createArticle,
    getArticleById,
    updateArticleById,
    deleteArticleById,
    manualScrape
};