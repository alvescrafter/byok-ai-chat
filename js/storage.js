/**
 * BYOK AI Chat - Storage Module
 * Handles chrome.storage.local persistence for conversations, settings, and presets.
 * All functions are async (chrome.storage API is callback-based but we wrap in Promises).
 */

const Storage = (() => {
    const KEYS = {
        CONVERSATIONS: 'aichat_conversations',
        ACTIVE_CONVERSATION: 'aichat_active_conversation',
        SETTINGS: 'aichat_settings',
        PRESETS: 'aichat_presets',
        THEME: 'aichat_theme',
    };

    // --- Helpers ---
    function _get(key) {
        return new Promise((resolve) => {
            chrome.storage.local.get(key, (result) => {
                if (chrome.runtime.lastError) {
                    console.error(`Storage: Error reading ${key}`, chrome.runtime.lastError);
                    resolve(null);
                    return;
                }
                resolve(result[key] ?? null);
            });
        });
    }

    function _set(key, value) {
        return new Promise((resolve) => {
            chrome.storage.local.set({ [key]: value }, () => {
                if (chrome.runtime.lastError) {
                    console.error(`Storage: Error writing ${key}`, chrome.runtime.lastError);
                    resolve(false);
                    return;
                }
                resolve(true);
            });
        });
    }

    function _remove(key) {
        return new Promise((resolve) => {
            chrome.storage.local.remove(key, () => {
                if (chrome.runtime.lastError) {
                    console.error(`Storage: Error removing ${key}`, chrome.runtime.lastError);
                    resolve(false);
                    return;
                }
                resolve(true);
            });
        });
    }

    function generateId() {
        return Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
    }

    // --- Conversations ---
    async function getConversations() {
        return (await _get(KEYS.CONVERSATIONS)) || [];
    }

    async function saveConversations(conversations) {
        return _set(KEYS.CONVERSATIONS, conversations);
    }

    async function getConversation(id) {
        const convos = await getConversations();
        return convos.find(c => c.id === id) || null;
    }

    async function createConversation(title = 'New Chat') {
        const conversation = {
            id: generateId(),
            title,
            provider: '',
            model: '',
            systemPrompt: '',
            messages: [],
            branches: {},
            activeBranch: {},
            createdAt: Date.now(),
            updatedAt: Date.now(),
        };
        const convos = await getConversations();
        convos.unshift(conversation);
        await saveConversations(convos);
        return conversation;
    }

    async function updateConversation(id, updates) {
        const convos = await getConversations();
        const idx = convos.findIndex(c => c.id === id);
        if (idx === -1) return null;
        convos[idx] = { ...convos[idx], ...updates, updatedAt: Date.now() };
        await saveConversations(convos);
        return convos[idx];
    }

    async function deleteConversation(id) {
        let convos = await getConversations();
        convos = convos.filter(c => c.id !== id);
        await saveConversations(convos);
        if ((await getActiveConversationId()) === id) {
            await setActiveConversationId(convos.length > 0 ? convos[0].id : null);
        }
    }

    async function addMessage(conversationId, message) {
        const msg = {
            id: generateId(),
            role: message.role,
            content: message.content || '',
            timestamp: Date.now(),
            files: message.files || [],
            ...message,
        };
        delete msg.id; // keep our generated id
        const convos = await getConversations();
        const idx = convos.findIndex(c => c.id === conversationId);
        if (idx === -1) return null;
        const msgWithId = { id: generateId(), role: message.role, content: message.content || '', timestamp: Date.now(), files: message.files || [] };
        convos[idx].messages.push(msgWithId);
        convos[idx].updatedAt = Date.now();
        await saveConversations(convos);
        return msgWithId;
    }

    async function updateMessage(conversationId, messageId, updates) {
        const convos = await getConversations();
        const idx = convos.findIndex(c => c.id === conversationId);
        if (idx === -1) return null;
        const msgIdx = convos[idx].messages.findIndex(m => m.id === messageId);
        if (msgIdx === -1) return null;
        convos[idx].messages[msgIdx] = { ...convos[idx].messages[msgIdx], ...updates };
        convos[idx].updatedAt = Date.now();
        await saveConversations(convos);
        return convos[idx].messages[msgIdx];
    }

    async function deleteMessage(conversationId, messageId) {
        const convos = await getConversations();
        const idx = convos.findIndex(c => c.id === conversationId);
        if (idx === -1) return;
        convos[idx].messages = convos[idx].messages.filter(m => m.id !== messageId);
        convos[idx].updatedAt = Date.now();
        await saveConversations(convos);
    }

    // --- Branching ---
    async function createBranch(conversationId, fromMessageId) {
        const convos = await getConversations();
        const idx = convos.findIndex(c => c.id === conversationId);
        if (idx === -1) return null;

        if (!convos[idx].branches) convos[idx].branches = {};
        if (!convos[idx].branches[fromMessageId]) convos[idx].branches[fromMessageId] = [];

        const msgIdx = convos[idx].messages.findIndex(m => m.id === fromMessageId);
        if (msgIdx === -1) return null;

        const currentBranch = convos[idx].messages.slice(msgIdx + 1);
        convos[idx].branches[fromMessageId].push(currentBranch);

        if (!convos[idx].activeBranch) convos[idx].activeBranch = {};
        convos[idx].activeBranch[fromMessageId] = convos[idx].branches[fromMessageId].length - 1;

        convos[idx].messages = convos[idx].messages.slice(0, msgIdx + 1);
        convos[idx].updatedAt = Date.now();
        await saveConversations(convos);
        return convos[idx];
    }

    async function switchBranch(conversationId, fromMessageId, branchIndex) {
        const convos = await getConversations();
        const idx = convos.findIndex(c => c.id === conversationId);
        if (idx === -1) return null;

        const branches = convos[idx].branches?.[fromMessageId];
        if (!branches || branchIndex >= branches.length) return null;

        const msgIdx = convos[idx].messages.findIndex(m => m.id === fromMessageId);
        if (msgIdx === -1) return null;

        const currentBranchIdx = convos[idx].activeBranch?.[fromMessageId] ?? 0;
        if (branches[currentBranchIdx] !== undefined) {
            branches[currentBranchIdx] = convos[idx].messages.slice(msgIdx + 1);
        }

        convos[idx].messages = [
            ...convos[idx].messages.slice(0, msgIdx + 1),
            ...branches[branchIndex],
        ];

        if (!convos[idx].activeBranch) convos[idx].activeBranch = {};
        convos[idx].activeBranch[fromMessageId] = branchIndex;
        convos[idx].updatedAt = Date.now();
        await saveConversations(convos);
        return convos[idx];
    }

    // --- Active Conversation ---
    async function getActiveConversationId() {
        return (await _get(KEYS.ACTIVE_CONVERSATION)) || null;
    }

    async function setActiveConversationId(id) {
        if (id) {
            return _set(KEYS.ACTIVE_CONVERSATION, id);
        } else {
            return _remove(KEYS.ACTIVE_CONVERSATION);
        }
    }

    // --- Settings ---
    async function getSettings() {
        return (await _get(KEYS.SETTINGS)) || {
            providers: {
                openai: { apiKey: '', baseUrl: 'https://api.openai.com/v1' },
                anthropic: { apiKey: '', baseUrl: 'https://api.anthropic.com' },
                google: { apiKey: '', baseUrl: '' },
                ollama: { apiKey: '', baseUrl: 'http://localhost:11434' },
                lmstudio: { apiKey: '', baseUrl: 'http://localhost:1234/v1' },
                custom: { apiKey: '', baseUrl: '', model: '' },
            },
            defaultProvider: 'openai',
            defaultModel: 'gpt-4o',
            defaultSystemPrompt: 'You are a helpful assistant.',
            defaultTemperature: 0.7,
            defaultTopP: 1,
            contextMode: 'truncate',
            maxContextMessages: 50,
            enableVoiceInput: false,
            enableTTS: false,
            webSearchEnabled: false,
            maxSearchRounds: 5,
        };
    }

    async function saveSettings(settings) {
        return _set(KEYS.SETTINGS, settings);
    }

    async function updateSettings(updates) {
        const settings = await getSettings();
        const merged = { ...settings, ...updates };
        if (updates.providers) {
            merged.providers = { ...settings.providers, ...updates.providers };
            for (const key of Object.keys(updates.providers)) {
                merged.providers[key] = { ...(settings.providers[key] || {}), ...updates.providers[key] };
            }
        }
        await saveSettings(merged);
        return merged;
    }

    // --- Presets ---
    async function getPresets() {
        return (await _get(KEYS.PRESETS)) || [
            { id: 'default', name: 'Default', prompt: 'You are a helpful assistant.' },
            { id: 'coder', name: 'Coder', prompt: 'You are an expert programmer. Write clean, efficient, well-documented code. Always explain your approach.' },
            { id: 'creative', name: 'Creative Writer', prompt: 'You are a creative writer with a vivid imagination. Write engaging, descriptive, and original content.' },
            { id: 'analyst', name: 'Data Analyst', prompt: 'You are a data analyst expert. Analyze data carefully, provide insights, and present findings clearly.' },
            { id: 'tutor', name: 'Tutor', prompt: 'You are a patient and encouraging tutor. Explain concepts step by step, use analogies, and check for understanding.' },
        ];
    }

    async function savePresets(presets) {
        return _set(KEYS.PRESETS, presets);
    }

    async function addPreset(name, prompt) {
        const presets = await getPresets();
        const preset = { id: generateId(), name, prompt };
        presets.push(preset);
        await savePresets(presets);
        return preset;
    }

    async function deletePreset(id) {
        let presets = await getPresets();
        presets = presets.filter(p => p.id !== id);
        await savePresets(presets);
    }

    // --- Theme ---
    async function getTheme() {
        return (await _get(KEYS.THEME)) || 'dark';
    }

    async function setTheme(theme) {
        return _set(KEYS.THEME, theme);
    }

    // --- Export / Import ---
    async function exportAll() {
        return {
            version: 1,
            conversations: await getConversations(),
            settings: await getSettings(),
            presets: await getPresets(),
            exportedAt: new Date().toISOString(),
        };
    }

    async function importData(data) {
        if (data.version !== 1) {
            throw new Error('Unsupported data version');
        }
        if (data.conversations) await saveConversations(data.conversations);
        if (data.settings) await saveSettings(data.settings);
        if (data.presets) await savePresets(data.presets);
    }

    // --- Storage usage ---
    async function getUsage() {
        return new Promise((resolve) => {
            chrome.storage.local.getBytesInUse(null, (bytes) => {
                resolve(bytes);
            });
        });
    }

    return {
        getConversations,
        saveConversations,
        getConversation,
        createConversation,
        updateConversation,
        deleteConversation,
        addMessage,
        updateMessage,
        deleteMessage,
        createBranch,
        switchBranch,
        getActiveConversationId,
        setActiveConversationId,
        getSettings,
        saveSettings,
        updateSettings,
        getPresets,
        savePresets,
        addPreset,
        deletePreset,
        getTheme,
        setTheme,
        exportAll,
        importData,
        getUsage,
        generateId,
    };
})();