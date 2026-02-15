/**
 * Memory / Knowledge Hub Stats Routes
 *
 * Exposes aggregated knowledge statistics: topic clusters, skills, concepts,
 * and related posts. Used by the frontend to visualize what the user is
 * learning and to surface related content by semantic similarity.
 */

const express = require('express');
const router = express.Router();
const redis = require('../redis');
const { embedQuery } = require('../openai');

/**
 * GET /api/memory/topics - Get topic clusters with counts
 * Returns the topics you're building knowledge in
 */
router.get('/topics', async (req, res) => {
  try {
    const clusters = await redis.getTopicClusters();

    // Also get skills
    const posts = await redis.getAllPosts({ limit: 500 });

    const skillMap = {};
    const conceptMap = {};

    for (const post of posts) {
      const skills = Array.isArray(post.skills) ? post.skills : [];
      for (const s of skills) {
        const skill = s.trim().toLowerCase();
        if (skill) skillMap[skill] = (skillMap[skill] || 0) + 1;
      }
      const concepts = Array.isArray(post.concepts) ? post.concepts : [];
      for (const c of concepts) {
        const concept = c.trim().toLowerCase();
        if (concept) conceptMap[concept] = (conceptMap[concept] || 0) + 1;
      }
    }

    const topSkills = Object.entries(skillMap)
      .map(([skill, count]) => ({ skill, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 20);

    const topConcepts = Object.entries(conceptMap)
      .map(([concept, count]) => ({ concept, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 20);

    res.json({
      topics: clusters,
      skills: topSkills,
      concepts: topConcepts,
    });
  } catch (err) {
    console.error('GET /api/memory/topics error:', err);
    res.status(500).json({ error: 'Failed to get topics' });
  }
});

/**
 * GET /api/memory/stats - Knowledge hub statistics
 */
router.get('/stats', async (req, res) => {
  try {
    const stats = await redis.getStats();
    res.json(stats);
  } catch (err) {
    console.error('GET /api/memory/stats error:', err);
    res.status(500).json({ error: 'Failed to get stats' });
  }
});

/**
 * POST /api/memory/related - Get posts related to a topic
 * Body: { topic: "machine learning", limit?: 10 }
 */
router.post('/related', async (req, res) => {
  try {
    const { topic, limit = 10 } = req.body;

    if (!topic || topic.trim().length === 0) {
      return res.status(400).json({ error: 'topic is required' });
    }

    // Use semantic search to find posts related to the topic
    const embedding = await embedQuery(topic.trim());
    const results = await redis.vectorSearch(embedding, { k: parseInt(limit) });

    res.json({
      topic: topic.trim(),
      total: results.length,
      posts: results,
    });
  } catch (err) {
    console.error('POST /api/memory/related error:', err);
    res.status(500).json({ error: 'Failed to get related posts' });
  }
});

module.exports = router;
