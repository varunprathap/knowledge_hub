/**
 * Search API Routes
 *
 * Hybrid search: combines vector similarity (semantic) with RediSearch full-text,
 * then falls back to in-memory filtering if Redis/OpenAI are unavailable. POST
 * /api/search runs hybrid search; GET /api/search/similar/:id finds posts similar
 * to a given post by vector distance.
 */

const express = require('express');
const router = express.Router();
const redis = require('../redis');

let embedQuery;
try {
  embedQuery = require('../openai').embedQuery;
} catch (e) {
  embedQuery = null;
}

/**
 * POST /api/search - Hybrid text + semantic search
 * Body: { query: "machine learning RAG", category?: "ai", limit?: 10 }
 * 
 * Falls back to text-only search if OpenAI embedding fails.
 */
router.post('/', async (req, res) => {
  try {
    const { query, category, limit = 10 } = req.body;

    if (!query || query.trim().length === 0) {
      return res.status(400).json({ error: 'query is required' });
    }

    const q = query.trim();
    const k = parseInt(limit);
    let results = [];

    // Try hybrid search (text + vector) first
    try {
      if (embedQuery) {
        const embedding = await embedQuery(q);
        results = await redis.hybridSearch(q, embedding, { k, category });
      }
    } catch (embErr) {
      console.warn('Embedding/hybrid search failed, falling back to text:', embErr.message);
    }

    // Fall back to text-only search if hybrid returned nothing or failed
    if (results.length === 0) {
      try {
        results = await redis.textSearch(q, { category, limit: k });
      } catch (textErr) {
        console.warn('Text search also failed:', textErr.message);
      }
    }

    // Final fallback: get all posts and filter in memory
    if (results.length === 0) {
      try {
        const allPosts = await redis.getAllPosts({ category, limit: 500 });
        const words = q.toLowerCase().split(/\s+/).filter(w => w.length > 0);

        results = allPosts.filter(p => {
          // Build searchable blob from all fields including tags
          const blob = [
            p.title, p.content, p.summary, p.author, p.relevance,
            ...(Array.isArray(p.topics) ? p.topics : []),
            ...(Array.isArray(p.skills) ? p.skills : []),
            ...(Array.isArray(p.concepts) ? p.concepts : []),
          ].filter(Boolean).join(' ').toLowerCase();

          // ALL words must appear in the post (AND logic)
          return words.every(word => blob.includes(word));
        }).slice(0, k);
      } catch (fallbackErr) {
        console.warn('Fallback search failed:', fallbackErr.message);
      }
    }

    res.json({
      query: q,
      total: results.length,
      results,
    });
  } catch (err) {
    console.error('POST /api/search error:', err);
    res.status(500).json({ error: 'Search failed' });
  }
});

/**
 * GET /api/search/similar/:id - Find posts similar to a given post
 * Query: ?limit=5
 */
router.get('/similar/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { limit = 5 } = req.query;

    const post = await redis.getPost(id);
    if (!post) {
      return res.status(404).json({ error: 'Post not found' });
    }

    let filtered = [];

    // Try vector similarity if embedding works
    try {
      if (embedQuery) {
        const text = [post.title, post.content || post.summary, post.author]
          .filter(Boolean).join(' ');
        const embedding = await embedQuery(text);

        const results = await redis.vectorSearch(embedding, {
          k: parseInt(limit) + 1,
        });

        // Filter out the source post and irrelevant results (score > 0.70)
        filtered = results
          .filter(r => r.id !== id)
          .filter(r => {
            const score = parseFloat(r.score);
            return isNaN(score) || score <= 0.70;
          })
          .slice(0, parseInt(limit));
      }
    } catch (e) {
      console.warn('Vector similar search failed:', e.message);
    }

    res.json({
      sourcePost: { id: post.id, title: post.title },
      total: filtered.length,
      similar: filtered,
    });
  } catch (err) {
    console.error('GET /api/search/similar error:', err);
    res.status(500).json({ error: 'Similar search failed' });
  }
});

module.exports = router;
