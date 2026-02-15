/**
 * TinyFish Web Agent Client
 *
 * AI-powered web automation agent that fetches full LinkedIn post content,
 * follows embedded URLs to extract linked articles/docs, and reads the first
 * comment for additional context. Enriches posts before OpenAI analysis so
 * embeddings and entity extraction use complete content. Part of the Knowledge
 * Hub enrichment pipeline.
 *
 * API: https://agent.tinyfish.ai/v1/automation/run-sse
 * Docs: https://docs.mino.ai/
 */

const TINYFISH_API_URL = 'https://agent.tinyfish.ai/v1/automation/run-sse';

function getApiKey() {
  const key = process.env.TINYFISH_API_KEY;
  if (!key || key === 'your-tinyfish-api-key') return null;
  return key;
}

// ─── Core: call TinyFish with a URL + goal ───

async function callTinyFish(url, goal, profile = 'stealth') {
  const apiKey = getApiKey();
  if (!apiKey) return null;

  try {
    console.log(`TinyFish: ${url.substring(0, 80)}...`);

    const response = await fetch(TINYFISH_API_URL, {
      method: 'POST',
      headers: {
        'X-API-Key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ url, goal, browser_profile: profile }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error(`TinyFish HTTP ${response.status}:`, errText);
      return null;
    }

    return await parseSSEStream(response);
  } catch (err) {
    console.error('TinyFish error:', err.message);
    return null;
  }
}

// ─── 1. Fetch LinkedIn Post (full content + first comment + links) ───

async function fetchPostContent(url) {
  const goal = `Extract the complete content from this LinkedIn post page.

IMPORTANT STEPS:
1. If there is a "see more" or "...more" button on the post text, click it to reveal the full text.
2. Look at the COMMENTS section. Extract the FIRST comment (top comment).
3. Look for any URLs or links inside the post text AND inside the first comment.

Return as JSON:
{
  "full_text": "The complete post text content with all paragraphs",
  "author_name": "Name of the post author",
  "author_headline": "Author's job title or headline",
  "author_profile_url": "URL to the author's LinkedIn profile",
  "post_type": "post, article, job, or other",
  "hashtags": ["list", "of", "hashtags"],
  "urls_in_post": ["https://example.com", "any URLs found inside the post text"],
  "first_comment": {
    "author": "Name of the first commenter",
    "text": "Full text of the first/top comment",
    "urls": ["any URLs found in the first comment"]
  },
  "mentioned_links": [{"url": "https://...", "text": "link text"}],
  "engagement": {
    "likes": number or null,
    "comments": number or null,
    "reposts": number or null
  },
  "posted_date": "When the post was published, if visible",
  "media_type": "text, image, video, document, carousel, poll, or none"
}

RULES:
- If any field is not found, set it to null.
- For urls_in_post: look for any clickable links, shortened URLs (bit.ly, t.co, lnkd.in, etc.), or plain text URLs in the post body.
- For first_comment: if no comments exist or comments are not visible, set to null.
- If a login wall or CAPTCHA appears, return whatever partial results you have.
- Extract as much text content as possible.`;

  return callTinyFish(url, goal, 'stealth');
}

// ─── 2. Fetch content from an external URL (article, blog, etc.) ───

async function fetchExternalUrl(url) {
  // Skip LinkedIn internal URLs (profiles, feeds, etc.)
  if (url.includes('linkedin.com/in/') ||
      url.includes('linkedin.com/feed/') ||
      url.includes('linkedin.com/notifications') ||
      url.includes('linkedin.com/search')) {
    return null;
  }

  const goal = `Extract the main content from this page. Return as JSON:
{
  "title": "Page title or article headline",
  "content": "The main text content of the page (article body, blog post, etc.). Extract the full text.",
  "summary": "A 2-3 sentence summary of what this page is about",
  "site_name": "Name of the website",
  "content_type": "article, blog, documentation, tool, video, product, or other"
}

RULES:
- Focus on the MAIN content, skip navigation, ads, sidebars, footers.
- If it's a YouTube video, extract the title and description.
- If it's a GitHub repo, extract the README content.
- If the page requires login or is blocked, return null fields.
- Keep the content under 2000 characters.`;

  return callTinyFish(url, goal, 'lite'); // External sites usually don't need stealth
}

// ─── 3. Enrich a post with full content + linked URL details ───

async function enrichPost(post) {
  if (!post.url) return post;
  if (!getApiKey()) return post;

  try {
    const enriched = { ...post };

    // Step 1: Fetch the full LinkedIn post content + first comment
    const postContent = await fetchPostContent(post.url);

    if (postContent) {
      // Merge full text
      if (postContent.full_text && postContent.full_text.length > (post.description || '').length) {
        enriched.description = postContent.full_text;
        enriched.content = postContent.full_text;
        enriched.fetchedFullContent = true;
      }

      // Author info
      if (postContent.author_name && postContent.author_name.length > (post.author || '').length) {
        enriched.author = postContent.author_name;
      }
      if (postContent.author_headline) enriched.authorHeadline = postContent.author_headline;
      if (postContent.author_profile_url) enriched.authorUrl = postContent.author_profile_url;

      // Engagement
      if (postContent.engagement) enriched.engagement = postContent.engagement;

      // Hashtags (merge)
      if (Array.isArray(postContent.hashtags)) {
        const existing = Array.isArray(post.hashtags) ? post.hashtags : [];
        enriched.hashtags = [...new Set([...existing, ...postContent.hashtags.map(h => h.toLowerCase().replace('#', ''))])];
      }

      // Media type
      if (postContent.media_type) enriched.mediaType = postContent.media_type;
      if (postContent.posted_date) enriched.postedDate = postContent.posted_date;

      // First comment - valuable context
      if (postContent.first_comment && postContent.first_comment.text) {
        enriched.firstComment = {
          author: postContent.first_comment.author || '',
          text: postContent.first_comment.text,
        };
        // Append first comment to content for better embeddings
        enriched.content = (enriched.content || enriched.description || '') +
          '\n\n[First Comment by ' + (postContent.first_comment.author || 'unknown') + ']: ' +
          postContent.first_comment.text;
      }

      // Collect all URLs found (from post text + first comment + mentioned links)
      const allFoundUrls = new Set();

      if (Array.isArray(postContent.urls_in_post)) {
        postContent.urls_in_post.forEach(u => allFoundUrls.add(u));
      }
      if (postContent.first_comment && Array.isArray(postContent.first_comment.urls)) {
        postContent.first_comment.urls.forEach(u => allFoundUrls.add(u));
      }
      if (Array.isArray(postContent.mentioned_links)) {
        postContent.mentioned_links.forEach(l => {
          if (l.url) allFoundUrls.add(l.url);
        });
        enriched.contentLinks = postContent.mentioned_links.slice(0, 10);
      }

      // Step 2: Follow the discovered URLs and fetch their content
      const urlsToFetch = [...allFoundUrls]
        .filter(u => u && u.startsWith('http') && !u.includes('linkedin.com/feed/'))
        .slice(0, 3); // Limit to 3 external URLs to avoid rate limits

      if (urlsToFetch.length > 0) {
        console.log(`TinyFish: Following ${urlsToFetch.length} URLs from post ${post.id}`);
        const linkedContents = await fetchMultipleUrls(urlsToFetch);

        if (linkedContents.length > 0) {
          enriched.linkedContent = linkedContents;

          // Append linked content summaries to the main content for richer embeddings
          const linkedText = linkedContents
            .filter(lc => lc.summary || lc.content)
            .map(lc => `[Linked: ${lc.title || lc.url}] ${lc.summary || lc.content?.substring(0, 300)}`)
            .join('\n\n');

          if (linkedText) {
            enriched.content = (enriched.content || '') + '\n\n' + linkedText;
          }
        }
      }
    }

    console.log(`TinyFish: Enriched post ${post.id} (${(enriched.content || '').length} chars)`);
    return enriched;
  } catch (err) {
    console.error(`TinyFish enrichment failed for ${post.id}:`, err.message);
    return post;
  }
}

// ─── Fetch multiple external URLs in parallel ───

async function fetchMultipleUrls(urls) {
  const results = [];

  // Process 2 at a time to respect rate limits
  for (let i = 0; i < urls.length; i += 2) {
    const batch = urls.slice(i, i + 2);
    const fetched = await Promise.all(
      batch.map(async (url) => {
        try {
          const content = await fetchExternalUrl(url);
          if (content) {
            return { url, ...content };
          }
          return null;
        } catch (e) {
          console.warn(`TinyFish: Failed to fetch ${url}:`, e.message);
          return null;
        }
      })
    );
    results.push(...fetched.filter(Boolean));
  }

  return results;
}

// ─── Batch enrich multiple posts ───

async function enrichPosts(posts, { concurrency = 1 } = {}) {
  if (!getApiKey()) return posts;

  const results = [];
  // Process one at a time - each post may trigger multiple TinyFish calls
  for (const post of posts) {
    const enriched = await enrichPost(post);
    results.push(enriched);
  }
  return results;
}

// ─── SSE Stream Parsing ───

async function parseSSEStream(response) {
  // Node 18+ fetch returns a ReadableStream body
  const text = await response.text();
  return parseSSEText(text);
}

function parseSSEText(text) {
  const lines = text.split('\n');
  let result = null;

  for (const line of lines) {
    if (line.startsWith('data: ')) {
      try {
        const event = JSON.parse(line.substring(6));

        if (event.type === 'PROGRESS') {
          console.log(`  TinyFish: ${event.purpose}`);
        }

        if (event.type === 'COMPLETE') {
          if (event.status === 'COMPLETED' && event.resultJson) {
            result = event.resultJson;
          } else if (event.status === 'FAILED') {
            console.error('TinyFish automation failed:', event.error);
          }
        }
      } catch (e) {
        // Skip malformed JSON lines
      }
    }
  }

  return result;
}

module.exports = {
  fetchPostContent,
  fetchExternalUrl,
  enrichPost,
  enrichPosts,
};
