/**
 * Posts API Routes
 *
 * Implements the 3-step enrichment pipeline for saving LinkedIn posts:
 * 1. TinyFish fetches full content from the post URL (full text, first comment, links)
 * 2. OpenAI extracts entities (topics, skills, concepts) and generates embeddings
 * 3. Redis stores the enriched, analyzed post with JSON + vector index
 *
 * Also provides CRUD: list, get, update, delete posts.
 */

const express = require('express');
const router = express.Router();
const redis = require('../redis');
const { analyzePost } = require('../openai');
const { enrichPost } = require('../tinyfish');

/**
 * POST /api/posts - Save and analyze new posts (batch)
 * 
 * Pipeline per post:
 *   1. TinyFish fetches full content from the post URL (stealth browser)
 *   2. OpenAI extracts entities + generates embedding from the enriched content
 *   3. Enriched + analyzed post is stored in Redis (JSON + vector index)
 * 
 * Body: { posts: [{ id, title, description, url, author, ... }] }
 */
router.post('/', async (req, res) => {
  try {
    const { posts } = req.body;

    if (!Array.isArray(posts) || posts.length === 0) {
      return res.status(400).json({ error: 'posts array is required' });
    }

    const results = [];
    const errors = [];

    for (const post of posts) {
      try {
        // Skip if already exists
        const exists = await redis.postExists(post.id);
        if (exists) {
          const existing = await redis.getPost(post.id);
          results.push({ ...existing, alreadyExists: true });
          continue;
        }

        // Step 1: Enrich with TinyFish (fetch full content from URL)
        // This gets the complete post text, engagement data, etc.
        // Gracefully skips if TINYFISH_API_KEY is not configured.
        let enriched;
        try {
          enriched = await enrichPost(post);
        } catch (fetchErr) {
          console.warn(`TinyFish enrichment skipped for ${post.id}:`, fetchErr.message);
          enriched = post;
        }

        // Step 2: Analyze with OpenAI (entities + embedding)
        // Uses the enriched content for better extraction quality.
        const analyzed = await analyzePost({
          ...enriched,
          content: enriched.description || enriched.content || '',
          savedAt: Date.now(),
          source: enriched.source || 'linkedin',
        });

        // Step 3: Save to Redis
        await redis.savePost(analyzed);

        // Return without the embedding (too large for HTTP response)
        const { embedding, ...safe } = analyzed;
        results.push(safe);
      } catch (err) {
        console.error(`Failed to process post ${post.id}:`, err.message);
        errors.push({ id: post.id, error: err.message });

        // Save without analysis as fallback (no embedding so it won't pollute vector search)
        try {
          const fallback = {
            ...post,
            content: post.description || '',
            topics: [],
            skills: [],
            concepts: [],
            relevance: '',
            summary: post.description ? post.description.substring(0, 150) : '',
            savedAt: Date.now(),
            source: post.source || 'linkedin',
            // No embedding field - avoids polluting vector search with zero vectors
          };
          await redis.savePost(fallback);
          results.push({ ...fallback, analysisError: true });
        } catch (e) {
          console.error(`Failed to save fallback for ${post.id}:`, e.message);
        }
      }
    }

    res.json({
      saved: results.length,
      errors: errors.length,
      posts: results,
      ...(errors.length > 0 && { errorDetails: errors }),
    });
  } catch (err) {
    console.error('POST /api/posts error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/posts - List all posts (with optional filters)
 * Query: ?category=ai&source=linkedin&limit=50&offset=0
 */
router.get('/', async (req, res) => {
  try {
    const { category, source, limit = 100, offset = 0 } = req.query;

    const posts = await redis.getAllPosts({
      category,
      source,
      limit: parseInt(limit),
      offset: parseInt(offset),
    });

    res.json({ total: posts.length, posts });
  } catch (err) {
    console.error('GET /api/posts error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/posts/:id - Get a single post by ID
 */
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const post = await redis.getPost(id);
    if (!post) {
      return res.status(404).json({ error: 'Post not found' });
    }
    res.json(post);
  } catch (err) {
    console.error('GET /api/posts/:id error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * PATCH /api/posts/:id - Update post fields
 * Body: { status: 'read', category: 'ai', ... }
 */
router.patch('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    // Don't allow updating id or embedding directly
    delete updates.id;
    delete updates.embedding;

    const updated = await redis.updatePost(id, updates);
    if (!updated) {
      return res.status(404).json({ error: 'Post not found' });
    }

    res.json(updated);
  } catch (err) {
    console.error('PATCH /api/posts error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * DELETE /api/posts/:id - Delete a post
 */
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await redis.deletePost(id);
    res.json({ deleted: true, id });
  } catch (err) {
    console.error('DELETE /api/posts error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
