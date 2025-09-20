const { supabase } = require('../models/supabaseClient');
const express = require('express');
const { fetchAndStoreNews } = require('../services/news-scrape');
// Upstash QStash client for scheduling per-day jobs
const { Client: QStashClient } = require('@upstash/qstash');
const qstash = process.env.QSTASH_TOKEN ? new QStashClient({ token: process.env.QSTASH_TOKEN }) : null;
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
            //default sort by relevance
            const sortParam = (req.query.sort || 'desc').toString().toLowerCase();
            if (data && Array.isArray(data)) {
                data.sort((a, b) => {
                    const aRel = a && a.relevance ? a.relevance : -Infinity;
                    const bRel = b && b.relevance ? b.relevance : -Infinity;
                    return sortParam === 'asc' ? aRel - bRel : bRel - aRel;
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

const { verifyQStash } = require('../services/qstashReceiver');
// POST /api/articles/manual-scrape
// Body: { from: 'YYYY-MM-DD', to: 'YYYY-MM-DD', limit?: number, candidateLimit?: number, split?: boolean }
// If the range spans multiple days OR split flag present, enqueue one job per day via QStash.
// Otherwise execute synchronously (single-day) to return results immediately.
const manualScrape = async (req, res) => {
    const { from, to, limit, candidateLimit, split } = req.body || {};
    if (!from || !to) {
        return res.status(400).json({ error: 'Both "from" and "to" dates are required' });
    }
    const start = Date.now();
    const limitNum = typeof limit === 'number' ? limit : parseInt(limit, 10);
    const validLimit = Number.isFinite(limitNum) && limitNum > 0 && limitNum <= 500 ? limitNum : undefined;
    const candNum = typeof candidateLimit === 'number' ? candidateLimit : parseInt(candidateLimit, 10);
    const validCandidateLimit = Number.isFinite(candNum) && candNum > 0 ? candNum : undefined;
    const needsSplit = split === true || split === 1 || from !== to;

    if (needsSplit) {
        if (!qstash) {
            return res.status(500).json({ error: 'QStash not configured (missing QSTASH_TOKEN)' });
        }
        try {
            const days = [];
            const startDate = new Date(from);
            const endDate = new Date(to);
            if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
                return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD' });
            }
            for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
                days.push(d.toISOString().slice(0,10));
            }
            const base = process.env.VERCEL_URL || process.env.VERCEL_API_BASE;
            if (!base) {
                return res.status(500).json({ error: 'Missing VERCEL_URL (or VERCEL_API_BASE) env for callback URL' });
            }
            const url = `${base}/api/articles/manual-scrape`;
            for (const day of days) {
                // eslint-disable-next-line no-await-in-loop
                await qstash.publishJSON({
                    url,
                        body: { from: day, to: day, limit: validLimit, candidateLimit: validCandidateLimit },
                    retries: 3
                });
            }
            const dur = Date.now() - start;
            return res.status(202).json({
                message: 'Scheduled per-day scrape jobs',
                days: days.length,
                range: { from, to },
                limit: validLimit || null,
                candidateLimit: validCandidateLimit || null,
                duration_ms: dur
            });
        } catch (e) {
            const dur = Date.now() - start;
            console.error('[manualScrape][queue] error', e);
            return res.status(500).json({ error: e.message || 'queue_failed', duration_ms: dur });
        }
    }

    // Single day synchronous execution (may be invoked by QStash queued job)
    const sigHeader = req.headers['upstash-signature'];
    if (sigHeader) {
        // Validate signature if signing keys configured
        const verification = await verifyQStash(req.rawBody || JSON.stringify(req.body || {}), String(sigHeader));
        if (!verification.valid) {
            return res.status(401).json({ error: 'invalid_qstash_signature', detail: verification.error });
        }
    }
    // Execute local scrape
    try {
        const stats = await fetchAndStoreNews(from, to, { mode: 'manual', manualLimit: validLimit, candidateLimit: validCandidateLimit });
        const dur = Date.now() - start;
        return res.status(200).json({ message: 'scrape_complete', from, to, stats, duration_ms: dur });
    } catch (err) {
        const dur = Date.now() - start;
        console.error('[manualScrape] error', err);
        return res.status(500).json({ error: err?.message || 'scrape_failed', duration_ms: dur });
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