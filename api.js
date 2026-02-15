/**
 * API Client - Communication bridge between the Chrome extension and the Node.js backend.
 *
 * In the Knowledge Hub architecture, this module is the sole HTTP layer for all extension-to-backend
 * communication: posts CRUD, search, memory/topics, and health checks. Used by popup.js and background.js.
 */

const KnowledgeAPI = {
  BASE_URL: 'http://localhost:3456/api',

  // --- Core HTTP ---

  async request(path, options = {}) {
    const url = `${this.BASE_URL}${path}`;
    const config = {
      headers: { 'Content-Type': 'application/json' },
      ...options,
    };

    if (config.body && typeof config.body === 'object') {
      config.body = JSON.stringify(config.body);
    }

    try {
      const response = await fetch(url, config);
      if (!response.ok) {
        const err = await response.json().catch(() => ({ error: response.statusText }));
        throw new Error(err.error || `HTTP ${response.status}`);
      }
      return response.json();
    } catch (err) {
      if (err.message.includes('Failed to fetch') || err.message.includes('NetworkError')) {
        throw new Error('Backend offline. Start the server with: cd backend && npm start');
      }
      throw err;
    }
  },

  // --- Health ---

  async checkHealth() {
    try {
      const data = await this.request('/health');
      return data.status === 'ok';
    } catch (e) {
      console.log('Health check failed:', e.message);
      return false;
    }
  },

  // --- Posts ---

  async savePosts(posts) {
    return this.request('/posts', {
      method: 'POST',
      body: { posts },
    });
  },

  async getPost(id) {
    return this.request(`/posts/${encodeURIComponent(id)}`);
  },

  async getPosts(options = {}) {
    const params = new URLSearchParams();
    if (options.category) params.set('category', options.category);
    if (options.source) params.set('source', options.source);
    if (options.limit) params.set('limit', options.limit);
    if (options.offset) params.set('offset', options.offset);

    const qs = params.toString();
    return this.request(`/posts${qs ? '?' + qs : ''}`);
  },

  async updatePost(id, updates) {
    return this.request(`/posts/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: updates,
    });
  },

  async deletePost(id) {
    return this.request(`/posts/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  },

  // --- Search ---

  async search(query, options = {}) {
    return this.request('/search', {
      method: 'POST',
      body: {
        query,
        category: options.category,
        limit: options.limit || 10,
      },
    });
  },

  async findSimilar(postId, limit = 5) {
    return this.request(`/search/similar/${encodeURIComponent(postId)}?limit=${limit}`);
  },

  // --- Memory ---

  async getTopics() {
    return this.request('/memory/topics');
  },

  async getStats() {
    return this.request('/memory/stats');
  },

  async getRelatedPosts(topic, limit = 10) {
    return this.request('/memory/related', {
      method: 'POST',
      body: { topic, limit },
    });
  },
};
