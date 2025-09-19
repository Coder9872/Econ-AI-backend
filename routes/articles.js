const express = require('express');
const router = express.Router(); 
const { supabase } = require('../models/supabaseClient');
const { getAllArticles,
    createArticle,
    getArticleById,
    updateArticleById,
    deleteArticleById,
    manualScrape
} = require('../controllers/articleController');

// GET /articles - Retrieve a list of articles
router.get('/', getAllArticles);

// POST /articles - Create a new article
router.post('/', createArticle);

// GET /articles/:id - Retrieve a specific article by ID
router.get('/:id', getArticleById);

// PATCH /articles/:id - Update an existing article by ID
router.patch('/:id', updateArticleById);

// Optional: support PUT as an alias for update
router.put('/:id', updateArticleById);

// DELETE /articles/:id - Delete an article by ID
router.delete('/:id', deleteArticleById);

// POST /articles/manual-scrape
router.post('/manual-scrape', manualScrape);

module.exports = router;