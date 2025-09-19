'use strict';

/**
 * @typedef {Object} Article
 * @property {number} id
 * @property {string} summarized_at - ISO timestamp with timezone
 * @property {string|null} [article_date] - ISO timestamp without timezone
 * @property {string|null} [summary]
 * @property {string|null} [title]
 * @property {string|null} [link]
 * @property {Object|null} [symbols]
 * @property {Object|null} [categories] - ISO timestamp without timezone
 */

/**
 * @typedef {Object} ArticleInsert
 * @property {string|null} [title]
 * @property {string|null} [summary]
 * @property {string|null} [article_date]
 * @property {Object|null} [symbols]
 * @property {string|null} [link]
 * @property {Object|null} [categories]
 */

/**
 * @typedef {Partial<ArticleInsert>} ArticleUpdate
 */

module.exports = {};
