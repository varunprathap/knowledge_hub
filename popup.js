/**
 * Main Popup Controller - Orchestrates the extension UI.
 *
 * Handles tabs (tasks, categories, memory), search (backend + local fallback), item list rendering,
 * modals (task action, reclassify), scan flow, and sync progress from the background worker. Entry
 * point for user interaction in the Knowledge Hub extension.
 */

document.addEventListener('DOMContentLoaded', () => {
    init().catch(err => console.error('Init error:', err));
});

// Catch any unhandled promise rejections
window.addEventListener('unhandledrejection', (e) => {
    console.warn('Unhandled rejection:', e.reason);
    e.preventDefault();
});

let currentCategory = 'tasks';
let currentItems = [];
let selectedItemForReclassify = null;
let selectedItemForTask = null;
let backendOnline = false;
let searchTimeout = null;
let searchRequestId = 0; // Tracks active search to cancel stale results

async function init() {
    try {
        setupEventListeners();
        await checkBackend();
        await loadItems();
        await updateCounts();
        // Check if there's an ongoing background sync (from before popup was closed)
        checkOngoingSync();
    } catch (err) {
        console.error('Init failed:', err);
    }
}

// Restore sync progress UI if user reopened popup during background sync
function checkOngoingSync() {
    try {
        chrome.runtime.sendMessage({ type: 'getSyncState' }, (state) => {
            if (chrome.runtime.lastError) return;
            if (state && (state.status === 'syncing' || state.status === 'done')) {
                showSyncProgress(state);
                if (state.status === 'syncing') {
                    startProgressPolling();
                }
            }
        });
    } catch (e) {
        console.log('No ongoing sync');
    }
}

// --- Backend Health ---

async function checkBackend() {
    const banner = document.getElementById('backendBanner');
    const status = document.getElementById('backendStatus');

    try {
        backendOnline = await KnowledgeAPI.checkHealth();
        console.log('[Backend] health check result:', backendOnline);
        if (backendOnline) {
            banner.classList.add('connected');
            status.textContent = 'connected to knowledge hub';
            setTimeout(() => banner.classList.add('hidden'), 2000);
        } else {
            throw new Error('offline');
        }
    } catch (e) {
        console.log('[Backend] check failed:', e);
        backendOnline = false;
        banner.classList.remove('hidden', 'connected');
        status.textContent = 'backend offline - using local storage';
    }
}

// --- Event Listeners ---

function setupEventListeners() {
    document.getElementById('scanBtn').addEventListener('click', handleScan);
    document.getElementById('exportBtn').addEventListener('click', handleExport);
    document.getElementById('clearBtn').addEventListener('click', handleClear);

    // Tabs
    document.querySelectorAll('.tab').forEach(tab => {
        tab.addEventListener('click', () => switchCategory(tab.dataset.category));
    });

    // Search
    const searchInput = document.getElementById('searchInput');
    searchInput.addEventListener('input', handleSearchInput);
    searchInput.addEventListener('keydown', e => {
        if (e.key === 'Escape') clearSearch();
    });
    document.getElementById('searchClear').addEventListener('click', clearSearch);
    document.getElementById('searchBack').addEventListener('click', clearSearch);

    // Modals
    document.getElementById('closeTaskModal').addEventListener('click', closeTaskModal);
    document.getElementById('cancelReclassify').addEventListener('click', closeReclassifyModal);

    document.querySelectorAll('.modal-backdrop').forEach(backdrop => {
        backdrop.addEventListener('click', () => {
            closeTaskModal();
            closeReclassifyModal();
        });
    });
}

// --- Category / View Switching ---

function switchCategory(category) {
    currentCategory = category;
    document.querySelectorAll('.tab').forEach(tab => {
        tab.classList.toggle('active', tab.dataset.category === category);
    });

    // Show/hide views
    const itemsView = document.getElementById('itemsView');
    const memoryView = document.getElementById('memoryView');
    const searchResults = document.getElementById('searchResults');

    searchResults.classList.add('hidden');

    if (category === 'memory') {
        itemsView.classList.add('hidden');
        memoryView.classList.remove('hidden');
        loadMemoryView();
    } else {
        itemsView.classList.remove('hidden');
        memoryView.classList.add('hidden');
        loadItems();
    }
}

// --- Load Items ---

async function loadItems() {
    let items;

    if (backendOnline && currentCategory !== 'tasks') {
        try {
            const data = await KnowledgeAPI.getPosts({ category: currentCategory });
            items = data.posts || [];
        } catch (e) {
            console.warn('Backend fetch failed, using local:', e);
            items = await loadItemsLocal();
        }
    } else {
        items = await loadItemsLocal();
    }

    currentItems = items;
    renderItems(items);
}

async function loadItemsLocal() {
    let items;
    if (currentCategory === 'tasks') {
        items = await StorageService.getTaskItems();
    } else {
        items = await StorageService.getItems();
        items = items.filter(item => item.category === currentCategory);
    }
    return items;
}

async function updateCounts() {
    const items = await StorageService.getItems();
    const counts = { tasks: 0, jobs: 0, ai: 0, learning: 0, articles: 0, networking: 0, other: 0 };

    items.forEach(item => {
        if (counts.hasOwnProperty(item.category)) {
            counts[item.category]++;
        }
        if ((item.category === 'jobs' && (!item.status || item.status === 'not-actioned')) ||
            (item.category !== 'jobs' && (!item.status || item.status === 'unread'))) {
            counts.tasks++;
        }
    });

    Object.entries(counts).forEach(([cat, count]) => {
        const el = document.getElementById(`count-${cat}`);
        if (el) {
            el.textContent = count;
            if (count > 0) {
                el.classList.remove('hidden');
            } else {
                el.classList.add('hidden');
            }
        }
    });
}

// --- Render Items ---

function renderItems(items) {
    const list = document.getElementById('itemsList');
    const empty = document.getElementById('emptyState');

    list.innerHTML = '';

    if (items.length === 0) {
        list.classList.add('hidden');
        empty.classList.remove('hidden');
        return;
    }

    list.classList.remove('hidden');
    empty.classList.add('hidden');

    items.forEach(item => {
        const li = document.createElement('li');
        li.innerHTML = createItemCard(item);
        list.appendChild(li);
    });

    attachItemListeners();
}

function createItemCard(item) {
    if (!item || !item.id) return '<article class="item-card">invalid item</article>';

    const icon = item.categoryIcon || getCategoryIcon(item.category || 'other');
    const statusLabel = getStatusLabel(item);
    const isTask = currentCategory === 'tasks';

    // Build topics HTML
    let topicsHtml = '';
    const topics = Array.isArray(item.topics) ? item.topics.slice(0, 3) : [];
    if (topics.length > 0) {
        topicsHtml = `<div class="item-topics">${topics.map(t =>
            `<span class="item-topic-tag">${escapeHtml(t)}</span>`
        ).join('')}</div>`;
    }

    // Build match badge
    let matchBadge = '';
    if (item.matchType) {
        matchBadge = `<span class="match-badge ${item.matchType}">${item.matchType}</span>`;
    }

    return `
        <article class="item-card ${isTask ? 'task-item' : ''}" data-id="${item.id}">
            <div class="item-header">
                <div class="item-category-badge">${icon}</div>
                <div class="item-content">
                    <h3 class="item-title">${escapeHtml(item.title || 'untitled')}</h3>
                    <div class="item-meta">
                        ${item.author ? `<span>${escapeHtml(item.author)}</span>` : ''}
                        ${matchBadge}
                    </div>
                </div>
            </div>
            ${item.description || item.summary ? `<p class="item-description">${escapeHtml(item.summary || item.description)}</p>` : ''}
            ${topicsHtml}
            <div class="item-footer">
                <span class="status-tag ${item.status || 'unread'}">${statusLabel}</span>
                <div class="item-actions">
                    <button class="item-action-btn reclassify-btn" data-id="${item.id}" title="change category">◫</button>
                    <button class="item-action-btn delete-btn" data-id="${item.id}" title="delete">×</button>
                </div>
            </div>
        </article>
    `;
}

function getCategoryIcon(category) {
    const icons = { jobs: '💼', ai: '🤖', learning: '📚', articles: '📰', networking: '🤝', other: '📌' };
    return icons[category] || '📌';
}

function getStatusLabel(item) {
    try {
        const cat = item.category || 'other';
        const options = Classifier.getStatusOptions(cat);
        const status = item.status || (cat === 'jobs' ? 'not-actioned' : 'unread');
        const found = options.find(opt => opt.value === status);
        return found ? found.label.toLowerCase() : 'pending';
    } catch (e) {
        return item.status || 'pending';
    }
}

function attachItemListeners() {
    document.querySelectorAll('.item-card').forEach(card => {
        card.addEventListener('click', e => {
            if (e.target.closest('.item-action-btn')) return;
            openTaskModal(card.dataset.id);
        });
    });

    document.querySelectorAll('.reclassify-btn').forEach(btn => {
        btn.addEventListener('click', e => {
            e.stopPropagation();
            openReclassifyModal(btn.dataset.id);
        });
    });

    document.querySelectorAll('.delete-btn').forEach(btn => {
        btn.addEventListener('click', e => {
            e.stopPropagation();
            handleDelete(btn.dataset.id);
        });
    });
}

// --- Search ---

function handleSearchInput(e) {
    const query = e.target.value.trim();
    const clearBtn = document.getElementById('searchClear');

    if (query.length > 0) {
        clearBtn.classList.remove('hidden');
    } else {
        clearBtn.classList.add('hidden');
        clearSearch();
        return;
    }

    // Debounce search
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
        if (query.length >= 2) {
            performSearch(query);
        }
    }, 300);
}

async function performSearch(query) {
    // Increment request ID -- any older in-flight search becomes stale
    const thisRequestId = ++searchRequestId;

    const searchResults = document.getElementById('searchResults');
    const searchList = document.getElementById('searchResultsList');
    const searchCount = document.getElementById('searchResultsCount');
    const itemsView = document.getElementById('itemsView');
    const memoryView = document.getElementById('memoryView');

    console.log(`[Search] query="${query}" backendOnline=${backendOnline} requestId=${thisRequestId}`);

    // Show search view and clear old results immediately
    searchResults.classList.remove('hidden');
    itemsView.classList.add('hidden');
    memoryView.classList.add('hidden');
    searchList.innerHTML = '<li class="loading-placeholder">searching your knowledge...</li>';
    searchCount.textContent = `searching for "${query}"...`;

    try {
        let results = [];
        let searchSource = 'none';

        // === Strategy 1: Always try backend search (hybrid text + semantic) ===
        // Try backend regardless of health check -- it may have come online after init
        try {
            console.log('[Search] calling backend API...');
            const data = await KnowledgeAPI.search(query);
            if (thisRequestId !== searchRequestId) return;
            results = data.results || [];
            searchSource = 'backend';
            // Backend is working, update the flag
            if (!backendOnline) {
                backendOnline = true;
                console.log('[Search] backend is now online');
            }
            console.log(`[Search] backend returned ${results.length} results`);
        } catch (backendErr) {
            console.warn('[Search] backend failed:', backendErr.message);
            if (thisRequestId !== searchRequestId) return;
        }

        // === Strategy 2: Local storage search (fallback if backend failed or returned 0) ===
        if (searchSource === 'none' || results.length === 0) {
            console.log('[Search] using local storage search...');
            const allItems = await StorageService.getItems();
            if (thisRequestId !== searchRequestId) return;

            const lower = query.toLowerCase();
            const words = lower.split(/\s+/).filter(w => w.length > 0);

            const localResults = allItems.filter(item => {
                const blob = [
                    item.title, item.description, item.author, item.summary,
                    ...(Array.isArray(item.topics) ? item.topics : []),
                    ...(Array.isArray(item.skills) ? item.skills : []),
                    ...(Array.isArray(item.concepts) ? item.concepts : []),
                    item.relevance,
                ].filter(Boolean).join(' ').toLowerCase();

                return words.every(word => blob.includes(word));
            }).map(item => ({ ...item, matchType: 'text' }));

            console.log(`[Search] local returned ${localResults.length} results from ${allItems.length} items`);

            // Only use local results if they found something or backend found nothing
            if (localResults.length > 0 || results.length === 0) {
                results = localResults;
                searchSource = searchSource === 'none' ? 'local' : searchSource + '+local';
            }
        }

        // Final stale check before rendering
        if (thisRequestId !== searchRequestId) return;

        const sourceLabel = searchSource === 'backend' ? 'AI search' : 'local search';
        searchCount.textContent = `${results.length} result${results.length !== 1 ? 's' : ''} for "${query}" (${sourceLabel})`;
        searchList.innerHTML = '';

        if (results.length === 0) {
            searchList.innerHTML = `<li class="loading-placeholder">no matches found for "${escapeHtml(query)}"</li>`;
            return;
        }

        results.forEach(item => {
            const li = document.createElement('li');
            li.innerHTML = createItemCard(item);
            searchList.appendChild(li);
        });

        // Attach listeners to search result cards
        searchList.querySelectorAll('.item-card').forEach(card => {
            card.addEventListener('click', e => {
                if (e.target.closest('.item-action-btn')) return;
                openTaskModal(card.dataset.id);
            });
        });
    } catch (err) {
        if (thisRequestId !== searchRequestId) return;
        console.error('[Search] error:', err);
        searchList.innerHTML = `<li class="loading-placeholder">search failed: ${escapeHtml(err.message)}</li>`;
        searchCount.textContent = 'search error';
    }
}

function clearSearch() {
    const searchInput = document.getElementById('searchInput');
    const searchResults = document.getElementById('searchResults');
    const searchList = document.getElementById('searchResultsList');
    const searchCount = document.getElementById('searchResultsCount');
    const itemsView = document.getElementById('itemsView');
    const memoryView = document.getElementById('memoryView');

    // Cancel any pending/in-flight searches
    searchRequestId++;
    clearTimeout(searchTimeout);

    searchInput.value = '';
    document.getElementById('searchClear').classList.add('hidden');
    searchResults.classList.add('hidden');

    // Clear old results from DOM so they don't flash on next search
    searchList.innerHTML = '';
    searchCount.textContent = '';

    if (currentCategory === 'memory') {
        memoryView.classList.remove('hidden');
    } else {
        itemsView.classList.remove('hidden');
    }
}

// --- Memory View ---

async function loadMemoryView() {
    if (!backendOnline) {
        showMemoryOffline();
        return;
    }

    try {
        // Load stats and topics in parallel
        const [statsData, topicsData] = await Promise.all([
            KnowledgeAPI.getStats(),
            KnowledgeAPI.getTopics(),
        ]);

        renderMemoryStats(statsData);
        renderTopicCloud(topicsData.topics || []);
        renderSkills(topicsData.skills || []);
        renderConcepts(topicsData.concepts || []);
    } catch (err) {
        console.error('Memory load error:', err);
        showMemoryOffline();
    }
}

function showMemoryOffline() {
    document.getElementById('statPosts').textContent = '—';
    document.getElementById('statTopics').textContent = '—';
    document.getElementById('statSkills').textContent = '—';
    document.getElementById('topicCloud').innerHTML =
        '<div class="loading-placeholder">connect backend to see your knowledge graph</div>';
    document.getElementById('skillsList').innerHTML = '';
    document.getElementById('conceptsList').innerHTML = '';
}

function renderMemoryStats(stats) {
    document.getElementById('statPosts').textContent = stats.totalPosts || 0;
    document.getElementById('statTopics').textContent = stats.totalTopics || 0;
    document.getElementById('statSkills').textContent = stats.totalSkills || 0;
}

function renderTopicCloud(topics) {
    const container = document.getElementById('topicCloud');

    if (!topics || topics.length === 0) {
        container.innerHTML = '<div class="loading-placeholder">no topics yet - scan some posts!</div>';
        return;
    }

    const maxCount = Math.max(...topics.map(t => t.count || 1));

    container.innerHTML = topics.map(t => {
        const isLarge = (t.count || 1) >= maxCount * 0.5;
        return `<button class="topic-tag ${isLarge ? 'large' : ''}" data-topic="${escapeHtml(t.topic)}">
            ${escapeHtml(t.topic)}
            <span class="topic-count">${t.count}</span>
        </button>`;
    }).join('');

    // Click topic to search for related posts
    container.querySelectorAll('.topic-tag').forEach(tag => {
        tag.addEventListener('click', () => {
            const topic = tag.dataset.topic;
            document.getElementById('searchInput').value = topic;
            performSearch(topic);
        });
    });
}

function renderSkills(skills) {
    const container = document.getElementById('skillsList');
    if (!skills || skills.length === 0) {
        container.innerHTML = '<div class="loading-placeholder">no skills detected yet</div>';
        return;
    }
    container.innerHTML = skills.map(s =>
        `<span class="skill-tag">${escapeHtml(s.skill)} (${s.count})</span>`
    ).join('');
}

function renderConcepts(concepts) {
    const container = document.getElementById('conceptsList');
    if (!concepts || concepts.length === 0) {
        container.innerHTML = '<div class="loading-placeholder">no concepts extracted yet</div>';
        return;
    }
    container.innerHTML = concepts.map(c =>
        `<span class="concept-tag">${escapeHtml(c.concept)} (${c.count})</span>`
    ).join('');
}

// --- Task Modal ---

async function openTaskModal(itemId) {
    // Try backend first, then local
    let item = null;

    if (backendOnline) {
        try {
            item = await KnowledgeAPI.getPost(itemId);
        } catch (e) { console.log('Backend post fetch fallback:', e); }
    }

    if (!item) {
        const items = await StorageService.getItems();
        item = items.find(i => i.id === itemId);
    }

    if (!item) return;

    selectedItemForTask = item;

    document.getElementById('taskModalTitle').textContent = item.category === 'jobs' ? 'job action' : 'item action';
    document.getElementById('taskItemPreview').innerHTML = `
        <h4>${escapeHtml(item.title || 'untitled')}</h4>
        <p>${escapeHtml(item.summary || item.description || '')}</p>
        <a href="${item.url}" target="_blank">open on linkedin &#8594;</a>
    `;

    // Show relevance note if available
    const relevanceEl = document.getElementById('taskRelevance');
    const relevanceText = document.getElementById('taskRelevanceText');
    if (item.relevance) {
        relevanceText.textContent = item.relevance;
        relevanceEl.classList.remove('hidden');
    } else {
        relevanceEl.classList.add('hidden');
    }

    // Show topic/skill tags
    const tagsEl = document.getElementById('taskTags');
    const tags = [
        ...(Array.isArray(item.topics) ? item.topics : []).map(t => `<span class="item-topic-tag">${escapeHtml(t)}</span>`),
        ...(Array.isArray(item.skills) ? item.skills : []).map(s => `<span class="skill-tag">${escapeHtml(s)}</span>`),
    ];
    if (tags.length > 0) {
        tagsEl.innerHTML = tags.join('');
        tagsEl.classList.remove('hidden');
    } else {
        tagsEl.classList.add('hidden');
    }

    // Show loading state for AI prompt
    const aiMessage = document.getElementById('aiMessage');
    aiMessage.textContent = 'thinking...';
    aiMessage.classList.add('loading');

    renderTaskActions(item);
    document.getElementById('taskModal').classList.remove('hidden');

    // Get AI prompt
    try {
        const prompt = await Classifier.getTaskPrompt(item);
        aiMessage.textContent = prompt;
        aiMessage.classList.remove('loading');
    } catch (e) {
        console.log('AI prompt fallback:', e);
        aiMessage.textContent = Classifier.getStaticTaskPrompt(item);
        aiMessage.classList.remove('loading');
    }

    // Load similar posts from backend
    loadSimilarPosts(itemId);
}

async function loadSimilarPosts(itemId) {
    const container = document.getElementById('similarPosts');
    const list = document.getElementById('similarList');

    if (!backendOnline) {
        container.classList.add('hidden');
        return;
    }

    try {
        const data = await KnowledgeAPI.findSimilar(itemId, 3);
        const similar = data.similar || [];

        if (similar.length === 0) {
            container.classList.add('hidden');
            return;
        }

        list.innerHTML = similar.map(s => `
            <li class="similar-item" data-url="${s.url || '#'}">
                <span class="similar-item-title">${escapeHtml(s.title || 'untitled')}</span>
                ${s.score !== undefined ? `<span class="similar-item-score">${Math.round((1 - s.score) * 100)}%</span>` : ''}
            </li>
        `).join('');

        container.classList.remove('hidden');

        // Open similar post in new tab on click
        list.querySelectorAll('.similar-item').forEach(item => {
            item.addEventListener('click', () => {
                const url = item.dataset.url;
                if (url && url !== '#') {
                    window.open(url, '_blank');
                }
            });
        });
    } catch (e) {
        console.log('Similar posts error:', e);
        container.classList.add('hidden');
    }
}

function renderTaskActions(item) {
    const actionsContainer = document.getElementById('taskActions');

    if (item.category === 'jobs') {
        actionsContainer.innerHTML = `
            <button class="task-action-btn primary" data-status="reached-out">
                <span class="label">applied / reached out</span>
            </button>
            <button class="task-action-btn secondary" data-status="waiting-response">
                <span class="label">waiting for response</span>
            </button>
            <button class="task-action-btn muted" data-status="rejected">
                <span class="label">not interested</span>
            </button>
        `;
    } else {
        actionsContainer.innerHTML = `
            <button class="task-action-btn primary" data-status="read">
                <span class="label">marked as read</span>
            </button>
            <button class="task-action-btn secondary" data-status="favorite">
                <span class="label">save as favorite</span>
            </button>
            <button class="task-action-btn muted" data-status="understood">
                <span class="label">done with this</span>
            </button>
        `;
    }

    actionsContainer.querySelectorAll('button').forEach(btn => {
        btn.addEventListener('click', () => handleTaskAction(btn.dataset.status));
    });
}

async function handleTaskAction(status) {
    if (!selectedItemForTask) return;

    // Update locally
    await StorageService.updateItem(selectedItemForTask.id, { status });

    // Also update in backend
    if (backendOnline) {
        try {
            await KnowledgeAPI.updatePost(selectedItemForTask.id, { status });
        } catch (e) { console.log('Backend status update:', e); }
    }

    closeTaskModal();
    await loadItems();
    await updateCounts();
}

function closeTaskModal() {
    document.getElementById('taskModal').classList.add('hidden');
    document.getElementById('similarPosts').classList.add('hidden');
    selectedItemForTask = null;
}

// --- Reclassify Modal ---

async function openReclassifyModal(itemId) {
    const items = await StorageService.getItems();
    const item = items.find(i => i.id === itemId);
    if (!item) return;

    selectedItemForReclassify = item;
    document.getElementById('reclassifyItemTitle').textContent = item.title || 'untitled';
    renderCategoryOptions(item.category);
    document.getElementById('reclassifyModal').classList.remove('hidden');
}

function renderCategoryOptions(currentCat) {
    const container = document.getElementById('categoryOptions');
    const categories = Classifier.getAllCategories();

    container.innerHTML = Object.entries(categories)
        .map(([key, data]) => `
            <button class="category-option ${key === currentCat ? 'active' : ''}" data-category="${key}">
                <span class="category-option-icon">${data.icon}</span>
                <span class="category-option-label">${data.name.toLowerCase()}</span>
            </button>
        `).join('');

    container.querySelectorAll('.category-option').forEach(btn => {
        btn.addEventListener('click', () => handleReclassify(btn.dataset.category));
    });
}

async function handleReclassify(newCategory) {
    if (!selectedItemForReclassify) return;

    const categoryData = Classifier.categories[newCategory];
    const updates = {
        category: newCategory,
        categoryName: categoryData.name,
        categoryIcon: categoryData.icon,
        categoryColor: categoryData.color,
        status: Classifier.getDefaultStatus(newCategory),
    };

    await StorageService.updateItem(selectedItemForReclassify.id, updates);

    if (backendOnline) {
        try {
            await KnowledgeAPI.updatePost(selectedItemForReclassify.id, updates);
        } catch (e) { console.log('Backend reclassify update:', e); }
    }

    closeReclassifyModal();
    await loadItems();
    await updateCounts();
}

function closeReclassifyModal() {
    document.getElementById('reclassifyModal').classList.add('hidden');
    selectedItemForReclassify = null;
}

// --- Scan ---

async function handleScan() {
    const btn = document.getElementById('scanBtn');
    btn.disabled = true;
    showStatus('scanning linkedin...', 'info');

    try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

        if (!tab?.url?.includes('linkedin.com')) {
            showStatus('please open linkedin saved posts', 'error');
            btn.disabled = false;
            return;
        }

        const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ['content.js']
        });

        const items = results[0]?.result || [];

        if (items.length === 0) {
            showStatus('no items found', 'error');
            btn.disabled = false;
            return;
        }

        showStatus(`classifying ${items.length} items...`, 'info');

        // Classify locally first (fast)
        const classified = await Classifier.classifyAll(items, (done, total) => {
            showStatus(`classifying ${done}/${total}...`, 'info');
        });

        // Save to local storage immediately
        await StorageService.saveItems(classified);
        await loadItems();
        await updateCounts();

        // Offload backend sync to background service worker
        // This survives popup close!
        if (backendOnline) {
            showSyncProgress({ status: 'syncing', total: classified.length, processed: 0, message: 'starting AI analysis...' });
            chrome.runtime.sendMessage(
                { type: 'startSync', posts: classified },
                (response) => {
                    if (response?.started) {
                        console.log('Background sync started for', classified.length, 'posts');
                        startProgressPolling();
                    }
                }
            );
        } else {
            showStatus(`done! ${classified.length} items saved locally`, 'success');
        }
    } catch (error) {
        console.error('Scan error:', error);
        showStatus('scan failed', 'error');
    } finally {
        btn.disabled = false;
    }
}

// --- Sync Progress (from background worker) ---

let progressPollInterval = null;

function startProgressPolling() {
    // Poll every 2 seconds for sync state from background worker
    stopProgressPolling();
    progressPollInterval = setInterval(async () => {
        try {
            chrome.runtime.sendMessage({ type: 'getSyncState' }, (state) => {
                if (chrome.runtime.lastError) {
                    stopProgressPolling();
                    return;
                }
                if (state) {
                    showSyncProgress(state);
                    if (state.status === 'done' || state.status === 'error') {
                        stopProgressPolling();
                        // Refresh items list when done
                        if (state.status === 'done') {
                            loadItems();
                            updateCounts();
                        }
                    }
                }
            });
        } catch (e) {
            stopProgressPolling();
        }
    }, 2000);
}

function stopProgressPolling() {
    if (progressPollInterval) {
        clearInterval(progressPollInterval);
        progressPollInterval = null;
    }
}

function showSyncProgress(state) {
    const progressBar = document.getElementById('syncProgressBar');
    const progressFill = document.getElementById('syncProgressFill');
    const progressText = document.getElementById('syncProgressText');
    const progressCount = document.getElementById('syncProgressCount');

    if (!progressBar) return;

    if (state.status === 'idle') {
        progressBar.classList.add('hidden');
        return;
    }

    progressBar.classList.remove('hidden');

    if (state.status === 'syncing') {
        const pct = state.total > 0 ? Math.round((state.processed / state.total) * 100) : 0;
        progressFill.style.width = `${pct}%`;
        progressText.textContent = state.message || 'analyzing...';
        progressCount.textContent = `${state.processed}/${state.total}`;
        progressBar.classList.remove('done', 'error');
        progressBar.classList.add('syncing');
    } else if (state.status === 'done') {
        progressFill.style.width = '100%';
        progressText.textContent = state.message || 'done!';
        progressCount.textContent = `${state.saved} saved`;
        progressBar.classList.remove('syncing', 'error');
        progressBar.classList.add('done');
        // Auto-hide after 5s
        setTimeout(() => {
            progressBar.classList.add('hidden');
            chrome.runtime.sendMessage({ type: 'clearSyncState' });
        }, 5000);
    } else if (state.status === 'error') {
        progressText.textContent = state.message || 'sync failed';
        progressCount.textContent = '';
        progressBar.classList.remove('syncing', 'done');
        progressBar.classList.add('error');
        setTimeout(() => progressBar.classList.add('hidden'), 5000);
    }
}

// Listen for real-time progress from background worker
chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'syncProgress') {
        showSyncProgress(message.state);
        if (message.state.status === 'done') {
            loadItems();
            updateCounts();
        }
    }
});

// --- Delete / Export / Clear ---

async function handleDelete(itemId) {
    await StorageService.deleteItem(itemId);

    if (backendOnline) {
        try { await KnowledgeAPI.deletePost(itemId); } catch (e) { console.log('Backend delete:', e); }
    }

    await loadItems();
    await updateCounts();
}

async function handleExport() {
    const items = await StorageService.getItems();
    if (items.length === 0) return;

    const blob = new Blob([JSON.stringify(items, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const date = new Date().toISOString().split('T')[0];

    chrome.downloads.download({
        url: url,
        filename: `knowledge-hub-${date}.json`,
        saveAs: true
    });
}

async function handleClear() {
    if (!confirm('delete all saved items?')) return;
    await StorageService.clearAll();
    await loadItems();
    await updateCounts();
    showStatus('all items cleared', 'info');
}

// --- Utilities ---

function showStatus(message, type = 'info') {
    const banner = document.getElementById('statusBanner');
    const text = document.getElementById('statusText');
    const icon = document.getElementById('statusIcon');

    banner.classList.remove('hidden', 'success', 'error');
    if (type !== 'info') banner.classList.add(type);

    text.textContent = message;
    icon.textContent = type === 'success' ? '✓' : type === 'error' ? '!' : '↻';

    if (type === 'success') {
        setTimeout(() => banner.classList.add('hidden'), 3000);
    }
}

function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}
