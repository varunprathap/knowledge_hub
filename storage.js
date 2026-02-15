/**
 * Storage Service - Chrome storage wrapper for local persistence.
 *
 * Handles all local data via chrome.storage.local. In the Knowledge Hub architecture, this provides
 * offline-first storage for saved items, settings, and task prompts. Used by popup, background, and classifier.
 */

const StorageService = {
    // --- Keys ---
    KEYS: {
        SAVED_ITEMS: 'savedItems',
        SETTINGS: 'settings'
    },

    // --- CRUD ---
    async getItems() {
        const result = await chrome.storage.local.get(this.KEYS.SAVED_ITEMS);
        return result[this.KEYS.SAVED_ITEMS] || [];
    },

    async saveItems(items) {
        const existing = await this.getItems();
        // Merge by url/id to avoid duplicates and preserve existing status
        const merged = [...existing];
        for (const item of items) {
            const existingIndex = merged.findIndex(e => 
                (item.url && e.url === item.url) || e.id === item.id
            );
            if (existingIndex >= 0) {
                const existingStatus = merged[existingIndex].status;
                merged[existingIndex] = { 
                    ...merged[existingIndex], 
                    ...item, 
                    id: merged[existingIndex].id,
                    status: existingStatus || item.status
                };
            } else {
                merged.push(item);
            }
        }
        
        await chrome.storage.local.set({ [this.KEYS.SAVED_ITEMS]: merged });
        return merged;
    },

    async updateItem(id, updates) {
        const items = await this.getItems();
        const index = items.findIndex(item => item.id === id);
        
        if (index >= 0) {
            items[index] = { ...items[index], ...updates };
            await chrome.storage.local.set({ [this.KEYS.SAVED_ITEMS]: items });
        }
        
        return items;
    },

    async deleteItem(id) {
        const items = await this.getItems();
        const filtered = items.filter(item => item.id !== id);
        await chrome.storage.local.set({ [this.KEYS.SAVED_ITEMS]: filtered });
        return filtered;
    },

    // --- Queries ---
    async getItemsByCategory(category) {
        const items = await this.getItems();
        return items.filter(item => item.category === category);
    },

    async getTaskItems() {
        const items = await this.getItems();
        return items.filter(item => {
            if (item.category === 'jobs') {
                return item.status === 'not-actioned' || item.status === 'waiting-response' || !item.status;
            }
            return item.status === 'unread' || !item.status;
        });
    },

    async getItemById(id) {
        const items = await this.getItems();
        return items.find(item => item.id === id);
    },

    // --- Bulk / Export ---
    async clearAll() {
        await chrome.storage.local.remove(this.KEYS.SAVED_ITEMS);
    },

    async exportItems() {
        const items = await this.getItems();
        return JSON.stringify(items, null, 2);
    },

    async getCategoryCounts() {
        const items = await this.getItems();
        const counts = {
            tasks: 0,
            jobs: 0,
            ai: 0,
            learning: 0,
            articles: 0,
            networking: 0,
            other: 0
        };
        
        for (const item of items) {
            if (counts[item.category] !== undefined) {
                counts[item.category]++;
            }
            
            // Count tasks
            if (item.category === 'jobs') {
                if (item.status === 'not-actioned' || item.status === 'waiting-response' || !item.status) {
                    counts.tasks++;
                }
            } else {
                if (item.status === 'unread' || !item.status) {
                    counts.tasks++;
                }
            }
        }
        
        return counts;
    }
};

if (typeof module !== 'undefined') {
    module.exports = StorageService;
}
