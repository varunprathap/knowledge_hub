/**
 * Redis Data Layer
 *
 * Handles RedisJSON document storage and RediSearch indexing for the Knowledge
 * Hub. Provides full-text search (TEXT + TAG fields), vector similarity search
 * (HNSW), and hybrid search (text + vector) over saved posts. All post data
 * is stored as JSON under the post: prefix.
 */

const { createClient, SchemaFieldTypes, VectorAlgorithms } = require('redis');

const INDEX_NAME = 'idx:posts';
const PREFIX = 'post:';

let client = null;

function getClient() {
  if (!client) throw new Error('Redis not connected. Call connectRedis() first.');
  return client;
}

// --- Connection ---

async function connectRedis() {
  const url = process.env.REDIS_URL || 'redis://localhost:6379';

  // Redis Cloud uses rediss:// (TLS). Detect and configure accordingly.
  const isTLS = url.startsWith('rediss://');

  const options = {
    url,
    ...(isTLS && {
      socket: {
        tls: true,
        rejectUnauthorized: false, // Redis Cloud uses self-signed certs
      },
    }),
  };

  // Redis Cloud may provide username:password in the URL.
  // If REDIS_PASSWORD is set separately, use it.
  if (process.env.REDIS_PASSWORD) {
    options.password = process.env.REDIS_PASSWORD;
  }
  if (process.env.REDIS_USERNAME) {
    options.username = process.env.REDIS_USERNAME;
  }

  client = createClient(options);

  client.on('error', (err) => console.error('Redis error:', err));
  client.on('connect', () => console.log(`Redis connected (${isTLS ? 'TLS' : 'plain'})`));

  await client.connect();
  return client;
}

// --- Index Creation ---

async function ensureIndex() {
  try {
    // Check if index exists
    await client.ft.info(INDEX_NAME);
    console.log(`Index "${INDEX_NAME}" already exists`);
  } catch (err) {
    // Index doesn't exist, create it
    console.log(`Creating index "${INDEX_NAME}"...`);

    await client.ft.create(INDEX_NAME, {
      // Text search fields (full-text indexed, title weighted higher for relevance)
      '$.title': {
        type: SchemaFieldTypes.TEXT,
        AS: 'title',
        WEIGHT: 2.0,
      },
      '$.content': {
        type: SchemaFieldTypes.TEXT,
        AS: 'content',
      },
      '$.summary': {
        type: SchemaFieldTypes.TEXT,
        AS: 'summary',
      },
      '$.relevance': {
        type: SchemaFieldTypes.TEXT,
        AS: 'relevance',
      },
      // Tag fields for exact-match filtering (author, category, source, status)
      '$.author': {
        type: SchemaFieldTypes.TAG,
        AS: 'author',
      },
      '$.category': {
        type: SchemaFieldTypes.TAG,
        AS: 'category',
      },
      '$.source': {
        type: SchemaFieldTypes.TAG,
        AS: 'source',
      },
      '$.topics[*]': {
        type: SchemaFieldTypes.TAG,
        AS: 'topics',
      },
      '$.skills[*]': {
        type: SchemaFieldTypes.TAG,
        AS: 'skills',
      },
      '$.concepts[*]': {
        type: SchemaFieldTypes.TAG,
        AS: 'concepts',
      },
      '$.status': {
        type: SchemaFieldTypes.TAG,
        AS: 'status',
      },
      // Numeric field for sorting by save date
      '$.savedAt': {
        type: SchemaFieldTypes.NUMERIC,
        AS: 'savedAt',
      },
      // Vector field for semantic search (HNSW, 1536 dims, cosine distance)
      '$.embedding': {
        type: SchemaFieldTypes.VECTOR,
        AS: 'embedding',
        ALGORITHM: VectorAlgorithms.HNSW,
        TYPE: 'FLOAT32',
        DIM: 1536,
        DISTANCE_METRIC: 'COSINE',
      },
    }, {
      ON: 'JSON',
      PREFIX: PREFIX,
    });

    console.log(`Index "${INDEX_NAME}" created successfully`);
  }
}

// --- CRUD ---

// Save a post as a JSON document
async function savePost(post) {
  const key = `${PREFIX}${post.id}`;

  // For RedisJSON, embeddings must be stored as plain number arrays (NOT Buffers).
  // Buffers are only used in HASH storage and search query PARAMS.
  const doc = { ...post };
  if (doc.embedding && Buffer.isBuffer(doc.embedding)) {
    // Convert Buffer back to array if accidentally passed as Buffer
    doc.embedding = Array.from(new Float32Array(doc.embedding.buffer, doc.embedding.byteOffset, doc.embedding.byteLength / 4));
  }

  await client.json.set(key, '$', doc);
  return post;
}

// Get a single post by ID
async function getPost(id) {
  const key = `${PREFIX}${id}`;
  const doc = await client.json.get(key);
  if (!doc) return null;
  // Remove embedding buffer from response
  if (doc.embedding) delete doc.embedding;
  return doc;
}

// Get all posts (with optional category filter)
async function getAllPosts(options = {}) {
  const { category, source, limit = 100, offset = 0 } = options;

  let query = '*';
  const filters = [];

  if (category) filters.push(`@category:{${escapeTag(category)}}`);
  if (source) filters.push(`@source:{${escapeTag(source)}}`);

  if (filters.length > 0) {
    query = filters.join(' ');
  }

  try {
    const results = await client.ft.search(INDEX_NAME, query, {
      LIMIT: { from: offset, size: limit },
      SORTBY: { BY: 'savedAt', DIRECTION: 'DESC' },
      RETURN: ['$.id', '$.title', '$.url', '$.author', '$.category',
        '$.topics', '$.skills', '$.concepts', '$.relevance',
        '$.summary', '$.source', '$.savedAt', '$.status',
        '$.authorUrl', '$.postType', '$.content'],
    });
    return parseSearchResults(results);
  } catch (err) {
    console.error('getAllPosts error:', err);
    return [];
  }
}

// Update a post field
async function updatePost(id, updates) {
  const key = `${PREFIX}${id}`;
  for (const [field, value] of Object.entries(updates)) {
    await client.json.set(key, `$.${field}`, value);
  }
  return getPost(id);
}

// Delete a post
async function deletePost(id) {
  const key = `${PREFIX}${id}`;
  return client.json.del(key);
}

// --- Search ---

// Full-text search (searches text fields + tag fields)
async function textSearch(queryText, options = {}) {
  const { category, limit = 20 } = options;

  // Search across text fields (title, content, summary, relevance)
  const escapedText = escapeQuery(queryText);
  const textQuery = `(${escapedText})`;

  // Also search tag fields (topics, skills, concepts) for each word
  const words = queryText.trim().split(/\s+/).filter(w => w.length > 1);
  const tagQueries = words.map(w => {
    const t = escapeTag(w.toLowerCase());
    return `(@topics:{${t}} | @skills:{${t}} | @concepts:{${t}})`;
  });

  // Combine: match text OR any tag
  let query = textQuery;
  if (tagQueries.length > 0) {
    query = `(${textQuery} | ${tagQueries.join(' | ')})`;
  }

  if (category) {
    query += ` @category:{${escapeTag(category)}}`;
  }

  try {
    const results = await client.ft.search(INDEX_NAME, query, {
      LIMIT: { from: 0, size: limit },
      RETURN: ['$.id', '$.title', '$.url', '$.author', '$.category',
        '$.topics', '$.skills', '$.summary', '$.relevance',
        '$.source', '$.savedAt', '$.status'],
    });
    return parseSearchResults(results);
  } catch (err) {
    console.error('textSearch error:', err);
    // If the combined query fails, try simpler text-only query
    try {
      const simpleQuery = category
        ? `${textQuery} @category:{${escapeTag(category)}}`
        : textQuery;
      const results = await client.ft.search(INDEX_NAME, simpleQuery, {
        LIMIT: { from: 0, size: limit },
        RETURN: ['$.id', '$.title', '$.url', '$.author', '$.category',
          '$.topics', '$.skills', '$.summary', '$.relevance',
          '$.source', '$.savedAt', '$.status'],
      });
      return parseSearchResults(results);
    } catch (simpleErr) {
      console.error('textSearch simple fallback also failed:', simpleErr);
      return [];
    }
  }
}

// Vector similarity search (KNN)
async function vectorSearch(embedding, options = {}) {
  const { k = 10, category } = options;

  let preFilter = '*';
  if (category) {
    preFilter = `@category:{${escapeTag(category)}}`;
  }

  const query = `(${preFilter})=>[KNN ${k} @embedding $BLOB AS score]`;

  try {
    const results = await client.ft.search(INDEX_NAME, query, {
      PARAMS: { BLOB: float32ArrayToBuffer(embedding) },
      SORTBY: { BY: 'score', DIRECTION: 'ASC' },
      LIMIT: { from: 0, size: k },
      RETURN: ['$.id', '$.title', '$.url', '$.author', '$.category',
        '$.topics', '$.skills', '$.summary', '$.relevance',
        '$.source', '$.savedAt', '$.status', 'score'],
      DIALECT: 2,
    });
    return parseSearchResults(results);
  } catch (err) {
    console.error('vectorSearch error:', err);
    return [];
  }
}

// Hybrid search: combine text + vector, with strict relevance filtering
async function hybridSearch(queryText, embedding, options = {}) {
  const { k = 10, category } = options;

  // Cosine distance: 0 = identical, 2 = opposite
  const SCORE_HARD_CUTOFF = 0.70; // Never show results worse than this
  const SCORE_GAP_THRESHOLD = 0.08; // Drop results after a big relevance gap

  // Run both in parallel
  const [textResults, vectorResults] = await Promise.all([
    textSearch(queryText, { category, limit: k }),
    vectorSearch(embedding, { k, category }),
  ]);

  // Filter vector results: hard cutoff + gap detection
  const sorted = vectorResults
    .filter(item => {
      const score = parseFloat(item.score);
      return !isNaN(score) && score <= SCORE_HARD_CUTOFF;
    })
    .sort((a, b) => parseFloat(a.score) - parseFloat(b.score));

  // Gap detection: if there's a big jump between consecutive scores, cut there
  let relevantVectorResults = sorted;
  if (sorted.length > 1) {
    let cutIndex = sorted.length;
    for (let i = 1; i < sorted.length; i++) {
      const gap = parseFloat(sorted[i].score) - parseFloat(sorted[i - 1].score);
      if (gap >= SCORE_GAP_THRESHOLD) {
        cutIndex = i;
        break;
      }
    }
    relevantVectorResults = sorted.slice(0, cutIndex);
  }

  console.log(`[hybridSearch] text: ${textResults.length}, vector: ${vectorResults.length} -> ${relevantVectorResults.length} after filtering`);

  // Merge and deduplicate, prioritizing vector results for ranking
  const seen = new Set();
  const merged = [];

  for (const item of relevantVectorResults) {
    if (!seen.has(item.id)) {
      seen.add(item.id);
      merged.push({ ...item, matchType: 'semantic' });
    }
  }
  for (const item of textResults) {
    if (!seen.has(item.id)) {
      seen.add(item.id);
      merged.push({ ...item, matchType: 'text' });
    }
  }

  return merged.slice(0, k);
}

// --- Aggregations & Stats ---

// Get all unique topics with counts
async function getTopicClusters() {
  try {
    const results = await client.ft.aggregate(INDEX_NAME, '*', {
      STEPS: [
        { type: 'APPLY', expression: 'split(@topics, ",")', AS: 'topic' },
        { type: 'GROUPBY', properties: ['@topic'], REDUCE: [{ type: 'COUNT', AS: 'count' }] },
        { type: 'SORTBY', BY: { BY: '@count', DIRECTION: 'DESC' } },
        { type: 'LIMIT', from: 0, size: 50 },
      ],
    });
    return results.results || [];
  } catch (err) {
    // Fallback: scan all posts and aggregate manually
    return getTopicClustersFallback();
  }
}

async function getTopicClustersFallback() {
  const posts = await getAllPosts({ limit: 500 });
  const topicMap = {};
  for (const post of posts) {
    const topics = Array.isArray(post.topics) ? post.topics : [];
    for (const t of topics) {
      const topic = t.trim().toLowerCase();
      if (topic) {
        topicMap[topic] = (topicMap[topic] || 0) + 1;
      }
    }
  }
  return Object.entries(topicMap)
    .map(([topic, count]) => ({ topic, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 50);
}

// Get stats
async function getStats() {
  try {
    const info = await client.ft.info(INDEX_NAME);
    const posts = await getAllPosts({ limit: 1000 });

    const categories = {};
    const sources = {};
    const allTopics = new Set();
    const allSkills = new Set();

    for (const post of posts) {
      categories[post.category] = (categories[post.category] || 0) + 1;
      sources[post.source || 'unknown'] = (sources[post.source || 'unknown'] || 0) + 1;

      const topics = Array.isArray(post.topics) ? post.topics : [];
      topics.forEach(t => { if (t.trim()) allTopics.add(t.trim().toLowerCase()); });

      const skills = Array.isArray(post.skills) ? post.skills : [];
      skills.forEach(s => { if (s.trim()) allSkills.add(s.trim().toLowerCase()); });
    }

    return {
      totalPosts: posts.length,
      totalTopics: allTopics.size,
      totalSkills: allSkills.size,
      categories,
      sources,
      indexInfo: {
        numDocs: info.numDocs,
        indexSize: info.invertedSzMb,
      },
    };
  } catch (err) {
    console.error('getStats error:', err);
    return { totalPosts: 0, totalTopics: 0, totalSkills: 0, categories: {}, sources: {} };
  }
}

// Check if post exists
async function postExists(id) {
  const key = `${PREFIX}${id}`;
  return (await client.exists(key)) === 1;
}

// --- Helpers ---

function float32ArrayToBuffer(arr) {
  return Buffer.from(new Float32Array(arr).buffer);
}

function escapeTag(tag) {
  return tag.replace(/[^a-zA-Z0-9_-]/g, '\\$&');
}

function escapeQuery(text) {
  // Escape special RediSearch characters
  return text.replace(/[\\@!{}()|[\]"~*^$:]/g, '\\$&');
}

function parseSearchResults(results) {
  if (!results || !results.documents) return [];

  // Fields that should be arrays (RedisJSON sometimes returns them as JSON strings)
  const ARRAY_FIELDS = new Set(['topics', 'skills', 'concepts', 'hashtags', 'contentLinks', 'linkedContent']);

  return results.documents.map(doc => {
    const data = {};
    // RedisJSON returns nested fields like $.title
    for (const [key, value] of Object.entries(doc.value)) {
      const cleanKey = key.replace(/^\$\./, '');

      // Parse stringified JSON arrays back into real arrays
      if (ARRAY_FIELDS.has(cleanKey) && typeof value === 'string') {
        try {
          const parsed = JSON.parse(value);
          data[cleanKey] = Array.isArray(parsed) ? parsed : value;
        } catch (e) {
          data[cleanKey] = value;
        }
      } else {
        data[cleanKey] = value;
      }
    }
    // Include score if present
    if (doc.value && doc.value.score !== undefined) {
      data.score = parseFloat(doc.value.score);
    }
    return data;
  });
}

module.exports = {
  connectRedis,
  ensureIndex,
  getClient,
  savePost,
  getPost,
  getAllPosts,
  updatePost,
  deletePost,
  textSearch,
  vectorSearch,
  hybridSearch,
  getTopicClusters,
  getStats,
  postExists,
  PREFIX,
  INDEX_NAME,
};
