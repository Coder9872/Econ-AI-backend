const express = require('express');
const router = express.Router();
const {
  getFavorites,
  addFavorite,
  removeFavorite,
  markArticleRead,
  getReadArticles,
  getPersonalizedFeed,
} = require('../controllers/userContentController');
const { requireAuth } = require('../middleware/auth');

router.use(requireAuth);

router.get('/favorites', getFavorites);
router.post('/favorites', addFavorite);
router.delete('/favorites/:articleId', removeFavorite);

router.get('/read', getReadArticles);
router.post('/read', markArticleRead);

router.get('/feed', getPersonalizedFeed);

module.exports = router;
