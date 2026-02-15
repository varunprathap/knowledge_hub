/**
 * OpenAI Integration
 *
 * Generates embeddings for posts and search queries (text-embedding-3-small,
 * 1536 dimensions) and extracts structured metadata from posts (gpt-4o-mini).
 * Entity extraction produces topics, skills, concepts, relevance, and summary
 * used for indexing and search in Redis.
 */

const OpenAI = require('openai');

let _openai = null;

function getOpenAI() {
  if (!_openai) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey || apiKey === 'sk-your-key-here') {
      throw new Error('OPENAI_API_KEY not configured. Add it to backend/.env');
    }
    _openai = new OpenAI({ apiKey });
  }
  return _openai;
}

const EMBEDDING_MODEL = 'text-embedding-3-small';
const EXTRACTION_MODEL = 'gpt-4o-mini';
const EMBEDDING_DIM = 1536;

/**
 * Generate a vector embedding for the given text.
 * Uses text-embedding-3-small (1536 dimensions, ~$0.00002 per 1K tokens).
 */
async function generateEmbedding(text) {
  if (!text || text.trim().length === 0) {
    return new Array(EMBEDDING_DIM).fill(0);
  }

  // Truncate to ~8000 tokens (~32000 chars) to stay within limits
  const truncated = text.substring(0, 32000);

  const response = await getOpenAI().embeddings.create({
    model: EMBEDDING_MODEL,
    input: truncated,
  });

  return response.data[0].embedding;
}

/**
 * Extract structured metadata from a post using GPT-4o-mini.
 * Returns: { topics, skills, concepts, relevance, summary }
 */
async function extractEntities(post) {
  // Use enriched content (from TinyFish) if available, fallback to description
  const mainContent = post.content || post.description || '';
  const content = [
    post.title && `Title: ${post.title}`,
    post.author && `Author: ${post.author}`,
    post.authorHeadline && `Author headline: ${post.authorHeadline}`,
    mainContent && `Content: ${mainContent}`,
    post.postType && `Type: ${post.postType}`,
  ].filter(Boolean).join('\n');

  if (!content.trim()) {
    return getDefaultEntities();
  }

  try {
    // Entity extraction prompt: instructs GPT to parse post content and output
    // structured JSON (topics, skills, concepts, relevance, summary) for indexing
    const response = await getOpenAI().chat.completions.create({
      model: EXTRACTION_MODEL,
      messages: [
        {
          role: 'system',
          content: `You are a knowledge extraction engine for a personal learning system. 
Analyze content from LinkedIn posts and extract structured metadata.
Be specific and precise. Topics and concepts should be meaningful and searchable.
Always return valid JSON.`,
        },
        {
          role: 'user',
          content: `Analyze this LinkedIn post and extract metadata:

${content}

Return a JSON object with these fields:
{
  "topics": ["2-5 main topics, e.g. 'machine learning', 'startup fundraising'"],
  "skills": ["0-3 technical skills mentioned or needed, e.g. 'Python', 'React'"],
  "concepts": ["1-3 key concepts or frameworks, e.g. 'retrieval augmented generation', 'product-market fit'"],
  "relevance": "1-2 sentence note on why this post is valuable for professional learning",
  "summary": "2-3 sentence summary of the post content"
}`,
        },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.3,
      max_tokens: 500,
    });

    const parsed = JSON.parse(response.choices[0].message.content);

    return {
      topics: ensureArray(parsed.topics).slice(0, 5),
      skills: ensureArray(parsed.skills).slice(0, 3),
      concepts: ensureArray(parsed.concepts).slice(0, 3),
      relevance: typeof parsed.relevance === 'string' ? parsed.relevance : '',
      summary: typeof parsed.summary === 'string' ? parsed.summary : '',
    };
  } catch (err) {
    console.error('Entity extraction failed:', err.message);
    return getDefaultEntities();
  }
}

/**
 * Analyze a post completely: extract entities + generate embedding.
 * This is the main function called when saving a new post.
 */
async function analyzePost(post) {
  // Use enriched content (from TinyFish) for better embedding quality
  const textForEmbedding = [post.title, post.content || post.description, post.author]
    .filter(Boolean).join(' ');

  const [entities, embedding] = await Promise.all([
    extractEntities(post),
    generateEmbedding(textForEmbedding),
  ]);

  return {
    ...post,
    ...entities,
    embedding,
    analyzedAt: Date.now(),
  };
}

/**
 * Generate embedding for a search query.
 */
async function embedQuery(query) {
  return generateEmbedding(query);
}

// --- Helpers ---

function ensureArray(val) {
  if (Array.isArray(val)) return val.map(v => String(v).trim()).filter(Boolean);
  return [];
}

function getDefaultEntities() {
  return {
    topics: [],
    skills: [],
    concepts: [],
    relevance: '',
    summary: '',
  };
}

module.exports = {
  generateEmbedding,
  extractEntities,
  analyzePost,
  embedQuery,
  EMBEDDING_DIM,
};
