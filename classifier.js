/**
 * Classification Engine - Local AI classification with keyword fallback.
 *
 * Uses Chrome's built-in LanguageModel API for on-device classification when available. Falls back to
 * keyword matching when AI is unavailable. Provides category/status options, task prompts, and batch
 * classification. Central to the Knowledge Hub's content organization.
 */

const Classifier = {
    // --- Category & Status Definitions ---
    categories: {
        jobs: { name: 'jobs', icon: '💼', color: '#0077b5' },
        ai: { name: 'ai', icon: '🤖', color: '#8b5cf6' },
        learning: { name: 'learning', icon: '📚', color: '#008a05' },
        articles: { name: 'articles', icon: '📰', color: '#5f4bb6' },
        networking: { name: 'networking', icon: '🤝', color: '#915907' },
        other: { name: 'other', icon: '📌', color: '#717171' }
    },

    statusOptions: {
        jobs: [
            { value: 'not-actioned', label: 'pending' },
            { value: 'reached-out', label: 'applied' },
            { value: 'waiting-response', label: 'waiting' },
            { value: 'responded', label: 'response' },
            { value: 'rejected', label: 'closed' }
        ],
        default: [
            { value: 'unread', label: 'unread' },
            { value: 'read', label: 'read' },
            { value: 'understood', label: 'done' },
            { value: 'favorite', label: 'saved' }
        ]
    },

    getStatusOptions(category) {
        return category === 'jobs' ? this.statusOptions.jobs : this.statusOptions.default;
    },

    getDefaultStatus(category) {
        return category === 'jobs' ? 'not-actioned' : 'unread';
    },

    getAllCategories() {
        return this.categories;
    },

    classifierSession: null,
    assistantSession: null,
    aiAvailable: null,

    // --- AI Session Management ---
    async checkAvailability() {
        if (this.aiAvailable !== null) return this.aiAvailable;

        try {
            if (typeof LanguageModel === 'undefined') {
                this.aiAvailable = false;
                return false;
            }
            const availability = await LanguageModel.availability();
            this.aiAvailable = (availability === 'available' || availability === 'downloadable');
            return this.aiAvailable;
        } catch (error) {
            this.aiAvailable = false;
            return false;
        }
    },

    async initClassifierSession() {
        if (this.classifierSession) return this.classifierSession;
        const available = await this.checkAvailability();
        if (!available) throw new Error('AI not available');

        this.classifierSession = await LanguageModel.create({
            expectedInputLanguages: ['en'],
            outputLanguage: 'en'
        });
        return this.classifierSession;
    },

    async initAssistantSession() {
        if (this.assistantSession) return this.assistantSession;
        const available = await this.checkAvailability();
        if (!available) throw new Error('AI not available');

        this.assistantSession = await LanguageModel.create({
            expectedInputLanguages: ['en'],
            outputLanguage: 'en',
            systemPrompt: `You help users manage their saved LinkedIn items. Be concise and direct. 
No greetings like "Hey there". Just describe what the item is about and ask a simple question.
Keep responses under 30 words. Be professional.`
        });
        return this.assistantSession;
    },

    // --- Task Prompts (AI-generated or static fallback) ---
    async getTaskPrompt(item) {
        // Return cached prompt if exists
        if (item.taskPrompt) {
            return item.taskPrompt;
        }

        const available = await this.checkAvailability();
        
        if (!available) {
            return this.getStaticTaskPrompt(item);
        }

        try {
            const session = await this.initAssistantSession();
            
            let prompt;
            if (item.category === 'jobs') {
                prompt = `This is a job opportunity: "${item.title}". ${item.description ? item.description.substring(0, 150) : ''}

Generate a short message (under 25 words) that:
1. Briefly describes what kind of job/role this is
2. Asks if they've applied or taken action

Do NOT start with greetings. Be direct.`;
            } else {
                prompt = `This is saved content: "${item.title}". ${item.description ? item.description.substring(0, 150) : ''}

Generate a short message (under 25 words) that:
1. Briefly describes what this content is about
2. Asks if they've read or understood it

Do NOT start with greetings. Be direct.`;
            }

            const response = await session.prompt(prompt);
            const taskPrompt = response.trim();
            
            // Save the prompt to the item for next time
            await this.saveTaskPrompt(item.id, taskPrompt);
            
            return taskPrompt;
        } catch (error) {
            console.error('AI prompt failed:', error);
            return this.getStaticTaskPrompt(item);
        }
    },

    async saveTaskPrompt(itemId, taskPrompt) {
        try {
            const items = await StorageService.getItems();
            const index = items.findIndex(i => i.id === itemId);
            if (index >= 0) {
                items[index].taskPrompt = taskPrompt;
                await chrome.storage.local.set({ savedItems: items });
            }
        } catch (e) {
            console.error('Failed to save task prompt:', e);
        }
    },

    getStaticTaskPrompt(item) {
        if (item.category === 'jobs') {
            const title = item.title || 'this position';
            return `This looks like a job opportunity for ${title.substring(0, 50)}. Have you applied or reached out?`;
        } else {
            const topic = item.category === 'ai' ? 'AI/ML content' : 
                          item.category === 'learning' ? 'learning resource' : 
                          item.category === 'articles' ? 'article' : 'content';
            return `This is ${topic} about ${(item.title || 'the topic').substring(0, 40)}. Have you read it?`;
        }
    },

    // --- Classification (AI primary, keywords fallback) ---
    async classifyWithAI(item) {
        const session = await this.initClassifierSession();
        const text = [item.title, item.description, item.author].filter(Boolean).join('\n');
        if (!text.trim()) return 'other';

        const schema = {
            type: 'object',
            properties: {
                category: {
                    type: 'string',
                    enum: ['jobs', 'ai', 'learning', 'articles', 'networking', 'other']
                }
            },
            required: ['category']
        };

        const prompt = `Classify this LinkedIn post:
- jobs: Job postings, hiring, career opportunities
- ai: AI, ML, LLMs, GPT, machine learning topics
- learning: Tutorials, courses, tips (non-AI)
- articles: Blog posts, insights, opinions
- networking: Events, meetups, connections
- other: Everything else

If about AI/ML, classify as "ai".

Content: "${text.substring(0, 400)}"`;

        try {
            const result = await session.prompt(prompt, { responseConstraint: schema });
            return JSON.parse(result).category || 'other';
        } catch (error) {
            return this.classifyByKeywords(text);
        }
    },

    // Keyword fallback when LanguageModel API is unavailable
    classifyByKeywords(text) {
        const lower = text.toLowerCase();
        
        if (/\b(ai|artificial intelligence|machine learning|llm|gpt|chatgpt|claude|openai|neural|deep learning)\b/i.test(lower)) {
            return 'ai';
        }
        if (/\b(hiring|job|position|role|opportunity|career|recruit|apply|resume)\b/i.test(lower)) {
            return 'jobs';
        }
        if (/\b(learn|tutorial|course|guide|how to|tips|education)\b/i.test(lower)) {
            return 'learning';
        }
        if (/\b(article|blog|wrote|insight|opinion)\b/i.test(lower)) {
            return 'articles';
        }
        if (/\b(event|meetup|conference|connect|network)\b/i.test(lower)) {
            return 'networking';
        }
        
        return 'other';
    },

    createSummary(item) {
        const text = item.description || '';
        if (!text || text.length < 30) return '';
        
        const sentences = text.replace(/\n+/g, ' ').split(/(?<=[.!?])\s+/).filter(s => s.length > 10);
        if (sentences.length === 0) return text.length > 120 ? text.substring(0, 117) + '...' : text;
        
        let summary = sentences[0];
        return summary.length > 120 ? summary.substring(0, 117) + '...' : summary;
    },

    // Batch classify items; reports progress for UI
    async classifyAll(items, onProgress = null) {
        const results = [];
        const aiAvailable = await this.checkAvailability();

        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            if (onProgress) onProgress(i + 1, items.length);

            let category = 'other';
            if (aiAvailable) {
                try {
                    category = await this.classifyWithAI(item);
                } catch (e) {
                    category = this.classifyByKeywords(item.description || item.title || '');
                }
            } else {
                category = this.classifyByKeywords(item.description || item.title || '');
            }

            const categoryData = this.categories[category] || this.categories.other;
            const status = item.status || this.getDefaultStatus(category);

            results.push({
                ...item,
                category,
                categoryName: categoryData.name,
                categoryIcon: categoryData.icon,
                categoryColor: categoryData.color,
                summary: this.createSummary(item),
                status,
                classifiedWithAI: aiAvailable
            });
        }

        return results;
    },

    destroySession() {
        if (this.classifierSession) {
            try { this.classifierSession.destroy(); } catch (e) { }
            this.classifierSession = null;
        }
        if (this.assistantSession) {
            try { this.assistantSession.destroy(); } catch (e) { }
            this.assistantSession = null;
        }
    }
};

if (typeof module !== 'undefined') {
    module.exports = Classifier;
}
