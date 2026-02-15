# Knowledge Hub

**Turn LinkedIn into your personal learning engine.**

Knowledge Hub is a Chrome extension + backend that captures your saved LinkedIn posts, analyzes them with AI, and stores them in a searchable, categorized knowledge graph. Every post you save becomes part of your personal memory — searchable by meaning, not just keywords.

## How It Works

```
LinkedIn Saved Posts
        │
        ▼
┌─────────────────────┐
│  Chrome Extension    │  ← Scrapes posts, classifies locally
│  (Manifest V3)      │     with Chrome's built-in AI
└────────┬────────────┘
         │
         ▼
┌─────────────────────┐
│  Background Worker   │  ← Syncs to backend even after
│  (Service Worker)    │     popup is closed
└────────┬────────────┘
         │
         ▼
┌─────────────────────┐
│  Node.js Backend     │
│                      │
│  1. TinyFish Agent   │  ← AI web agent fetches full post
│     ↓                │     text, first comment, linked URLs
│  2. OpenAI           │  ← Extracts topics, skills, concepts
│     ↓                │     + generates vector embedding
│  3. Redis Stack      │  ← Stores JSON + full-text index
│                      │     + vector similarity index
└─────────────────────┘
```

## Features

- **Auto-classify** — Scans LinkedIn saved posts and categorizes them (Jobs, AI, Learning, Articles, Networking) using Chrome's local LanguageModel API
- **Semantic search** — Search by meaning, not keywords. "startup funding" finds the "$2M seed round" post even though those words don't appear in the query
- **Background sync** — Close the popup, browse around. Sync keeps running in the background service worker
- **Knowledge memory** — See your topics, skills, and concepts growing over time
- **Content enrichment** — TinyFish AI agent reads full post text, first comments, and follows linked URLs for richer analysis
- **Offline fallback** — Works with local storage when the backend is offline

## Quick Start

### 1. Load the Extension

1. Open `chrome://extensions/`
2. Enable **Developer mode**
3. Click **Load unpacked** → select this project folder
4. Pin the Knowledge Hub extension

### 2. Start the Backend

```bash
cd backend
cp .env.example .env
# Edit .env with your API keys (see below)
npm install
npm start
```

### 3. Configure API Keys

Edit `backend/.env`:

| Key | Required | Get it from |
|-----|----------|-------------|
| `REDIS_URL` | Yes | [Redis Cloud](https://cloud.redis.io) (free tier works) |
| `OPENAI_API_KEY` | Yes | [OpenAI Platform](https://platform.openai.com/api-keys) |
| `TINYFISH_API_KEY` | Optional | [TinyFish](https://agent.tinyfish.ai/dashboard) |

### 4. Use It

1. Go to [LinkedIn Saved Posts](https://www.linkedin.com/my-items/saved-posts/)
2. Click the Knowledge Hub extension icon
3. Hit the **scan** button
4. Posts are classified locally, then enriched + analyzed in the background

## Tech Stack

| Layer | Technology | Purpose |
|-------|-----------|---------|
| Extension | Chrome Manifest V3 | Popup UI, content script, background worker |
| Local AI | Chrome LanguageModel API | Fast on-device classification |
| Backend | Node.js + Express | API server, orchestration |
| Database | Redis Stack (JSON + Search) | Structured storage + full-text + vector search |
| Embeddings | OpenAI text-embedding-3-small | 1536-dim vectors for semantic search |
| Extraction | OpenAI gpt-4o-mini | Topics, skills, concepts, relevance |
| Scraping | TinyFish Web Agent | Full post content, comments, linked URLs |

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/health` | Backend status (Redis, OpenAI, TinyFish) |
| `POST` | `/api/posts` | Save & analyze posts (TinyFish → OpenAI → Redis) |
| `GET` | `/api/posts` | List posts with optional category filter |
| `GET` | `/api/posts/:id` | Get a single post by ID |
| `PATCH` | `/api/posts/:id` | Update post fields (status, category) |
| `DELETE` | `/api/posts/:id` | Delete a post |
| `POST` | `/api/search` | Hybrid semantic + full-text search |
| `GET` | `/api/search/similar/:id` | Find posts similar to a given post |
| `GET` | `/api/memory/topics` | Topic clusters, skills, concepts |
| `GET` | `/api/memory/stats` | Knowledge hub statistics |

## Project Structure

```
knowledge-hub/
├── manifest.json          # Chrome extension manifest (V3)
├── popup.html             # Extension popup UI
├── popup.css              # Styles
├── popup.js               # Main popup controller
├── api.js                 # Backend API client
├── storage.js             # Chrome local storage wrapper
├── classifier.js          # Local AI classification engine
├── content.js             # LinkedIn page scraper (content script)
├── background.js          # Background sync service worker
├── icons/                 # Extension icons
└── backend/
    ├── server.js          # Express API server
    ├── redis.js           # Redis data layer (JSON + Search + Vector)
    ├── openai.js          # OpenAI embeddings + entity extraction
    ├── tinyfish.js        # TinyFish web agent client
    ├── routes/
    │   ├── posts.js       # Post CRUD + enrichment pipeline
    │   ├── search.js      # Hybrid search endpoint
    │   └── memory.js      # Knowledge stats endpoints
    ├── .env.example       # Environment config template
    └── package.json       # Backend dependencies
```

## Cost Estimate

Per post saved (with all services enabled):

| Service | Cost |
|---------|------|
| OpenAI embedding | ~$0.00002 |
| OpenAI entity extraction | ~$0.001 |
| TinyFish (1-4 page fetches) | ~$0.01-0.04 |
| Redis Cloud | Free tier (30MB) |
| **Total per post** | **~$0.01-0.04** |

## License

MIT
