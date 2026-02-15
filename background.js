/**
 * Background Service Worker - Backend sync that survives popup close.
 *
 * Runs independently of the popup. Handles long-running sync of posts to the backend (TinyFish + OpenAI
 * analysis), persists progress to chrome.storage.local, and notifies the popup when open. Also handles
 * health checks requested by the popup.
 */

const API_BASE = 'http://localhost:3456/api';

// --- Sync State (persisted in chrome.storage.local) ---

async function getSyncState() {
  const result = await chrome.storage.local.get('syncState');
  return result.syncState || {
    status: 'idle',      // idle | syncing | done | error
    total: 0,
    processed: 0,
    saved: 0,
    errors: 0,
    message: '',
    startedAt: null,
  };
}

async function setSyncState(updates) {
  const current = await getSyncState();
  const newState = { ...current, ...updates };
  await chrome.storage.local.set({ syncState: newState });

  // Notify popup if it's open
  try {
    chrome.runtime.sendMessage({ type: 'syncProgress', state: newState });
  } catch (e) {
    // Popup not open, that's fine
  }
}

// --- Message Handler ---

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'startSync') {
    // Start background sync - don't await, just kick it off
    handleBackgroundSync(message.posts).catch(err => {
      console.error('Background sync error:', err);
      setSyncState({ status: 'error', message: err.message });
    });
    sendResponse({ started: true });
    return true; // Keep message channel open
  }

  if (message.type === 'getSyncState') {
    getSyncState().then(state => sendResponse(state));
    return true; // Async response
  }

  if (message.type === 'clearSyncState') {
    setSyncState({ status: 'idle', total: 0, processed: 0, saved: 0, errors: 0, message: '' });
    sendResponse({ cleared: true });
    return true;
  }
});

// --- Background Sync: Send posts to backend one by one ---

async function handleBackgroundSync(posts) {
  if (!posts || posts.length === 0) return;

  await setSyncState({
    status: 'syncing',
    total: posts.length,
    processed: 0,
    saved: 0,
    errors: 0,
    message: `analyzing 0/${posts.length} posts...`,
    startedAt: Date.now(),
  });

  let saved = 0;
  let errors = 0;

  // Process posts one at a time so each gets full TinyFish + OpenAI treatment
  // and we can report progress per post
  for (let i = 0; i < posts.length; i++) {
    const post = posts[i];

    await setSyncState({
      processed: i,
      message: `analyzing ${i + 1}/${posts.length}: ${(post.title || '').substring(0, 40)}...`,
    });

    try {
      const response = await fetch(`${API_BASE}/posts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ posts: [post] }),
      });

      if (response.ok) {
        const data = await response.json();
        saved += data.saved || 0;
        errors += data.errors || 0;
      } else {
        errors++;
        console.error(`Sync failed for post ${post.id}: HTTP ${response.status}`);
      }
    } catch (err) {
      errors++;
      console.error(`Sync error for post ${post.id}:`, err.message);
    }
  }

  await setSyncState({
    status: 'done',
    processed: posts.length,
    saved,
    errors,
    message: `done! ${saved} posts analyzed & saved to memory` +
      (errors > 0 ? ` (${errors} errors)` : ''),
  });
}

// --- Health Check (used by popup on startup) ---

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'checkBackend') {
    fetch(`${API_BASE}/health`)
      .then(res => res.json())
      .then(data => sendResponse({ online: data.status === 'ok', data }))
      .catch(() => sendResponse({ online: false }));
    return true;
  }
});
