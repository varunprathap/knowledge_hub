/**
 * Knowledge Hub API Server
 *
 * Main Express entry point for the Knowledge Hub backend. Bootstraps the API
 * and wires together Redis (data storage + search), OpenAI (embeddings + entity
 * extraction), and TinyFish (web agent for content enrichment). Exposes REST
 * endpoints for posts, search, and memory stats.
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { connectRedis, ensureIndex } = require('./redis');
const postsRouter = require('./routes/posts');
const searchRouter = require('./routes/search');
const memoryRouter = require('./routes/memory');

const app = express();
const PORT = process.env.PORT || 3456;

// Middleware
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '2mb' }));

// Routes
app.use('/api/posts', postsRouter);
app.use('/api/search', searchRouter);
app.use('/api/memory', memoryRouter);

// Health check
app.get('/api/health', async (req, res) => {
  try {
    const { getClient } = require('./redis');
    const client = getClient();
    await client.ping();

    const tinyfishKey = process.env.TINYFISH_API_KEY;
    const openaiKey = process.env.OPENAI_API_KEY;

    res.json({
      status: 'ok',
      redis: 'connected',
      openai: openaiKey && openaiKey !== 'sk-your-key-here' ? 'configured' : 'MISSING (required)',
      tinyfish: tinyfishKey && tinyfishKey !== 'your-tinyfish-api-key' ? 'configured' : 'MISSING (required)',
    });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// Start: connect Redis, ensure RediSearch index, then bind HTTP server
async function start() {
  try {
    await connectRedis();
    await ensureIndex();
    app.listen(PORT, () => {
      console.log(`Knowledge Hub API running on http://localhost:${PORT}`);
      console.log(`Health check: http://localhost:${PORT}/api/health`);
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

start();
