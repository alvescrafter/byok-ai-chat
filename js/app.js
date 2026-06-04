/**
 * BYOK AI Chat - Main App Module
 * Orchestrates the side panel UI, handles events, manages conversations,
 * communicates with the service worker for API calls, screenshots, and page context.
 */

const App = (() => {
    // --- State ---
    let currentConversationId = null;
    let isStreaming = false;
    let abortController = null;
    let settings = {};
    let presets = [];
    let pageContext = null;   // attached page context
    let screenshotData = null; // attached screenshot data URL
    let attachedFiles = [];     // attached files (images + text)
    let streamPort = null;     // port for streaming communication with service worker
    let webSearchEnabled = false; // web search toggle state

    // --- DOM References ---
    const $ = (id) => document.getElementById(id);

    // --- Initialization ---
    async function init() {
        // Load settings
        settings = await Storage.getSettings();
        presets = await Storage.getPresets();

        // Apply theme
        const theme = await Storage.getTheme();
        document.documentElement.dataset.theme = theme;
        $('theme-select').value = theme;
        updateHljsTheme(theme);

        // Apply web search toggle from settings
        webSearchEnabled = settings.webSearchEnabled || false;
        updateWebSearchButton();

        // Populate provider/model dropdowns
        UI.populateProviderSelect($('provider-select'), settings);
        await updateModelSelect();

        // Set default provider/model
        if (settings.defaultProvider) $('provider-select').value = settings.defaultProvider;
        if (settings.defaultModel) $('model-select').value = settings.defaultModel;

        // Load conversations
        await loadConversationList();
        const activeId = await Storage.getActiveConversationId();
        if (activeId) {
            await switchConversation(activeId);
        }

        // Populate settings form
        populateSettingsForm();

        // Init markdown copy handlers
        Markdown.initCopyHandlers($('chat-container'));

        // Bind events
        bindEvents();

        // Listen for messages from service worker (context menu text, etc.)
        chrome.runtime.onMessage.addListener(handleBackgroundMessage);
    }

    // --- Event Binding ---
    function bindEvents() {
        // Send message
        $('send-btn').addEventListener('click', handleSend);
        $('message-input').addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSend();
            }
        });
        $('message-input').addEventListener('input', () => {
            autoResizeTextarea();
        });

        // Provider/model changes
        $('provider-select').addEventListener('change', async () => {
            await updateModelSelect();
            saveCurrentProviderModel();
        });
        $('model-select').addEventListener('change', saveCurrentProviderModel);

        // Sidebar toggle
        $('sidebar-toggle-btn').addEventListener('click', toggleSidebar);
        $('sidebar-overlay').addEventListener('click', closeSidebar);

        // New chat
        $('new-chat-btn').addEventListener('click', handleNewChat);

        // Search
        $('search-input').addEventListener('input', handleSearch);

        // Theme dropdown
        $('theme-select').addEventListener('change', (e) => handleThemeChange(e.target.value));

        // Settings
        $('settings-btn').addEventListener('click', () => UI.openModal('settings-modal'));
        $('save-settings-btn').addEventListener('click', handleSaveSettings);

        // Modal close buttons
        document.querySelectorAll('.modal-close').forEach(btn => {
            btn.addEventListener('click', () => {
                const modalId = btn.dataset.close;
                if (modalId) UI.closeModal(modalId);
            });
        });

        // Close modals on backdrop click
        document.querySelectorAll('.modal').forEach(modal => {
            modal.addEventListener('click', (e) => {
                if (e.target === modal) UI.closeModal(modal.id);
            });
        });

        // Screenshot
        $('screenshot-btn').addEventListener('click', handleScreenshot);

        // Page context
        $('page-context-btn').addEventListener('click', handlePageContext);

        // File attachment
        $('attach-file-btn').addEventListener('click', () => $('file-input').click());
        $('file-input').addEventListener('change', handleFileAttach);

        // Web search toggle
        $('web-search-btn').addEventListener('click', handleWebSearchToggle);

        // Conversation rename event
        document.addEventListener('conversation-renamed', (e) => {
            const { id, title } = e.detail;
            Storage.updateConversation(id, { title });
            loadConversationList();
        });

        // Export
        $('export-btn').addEventListener('click', () => UI.openModal('export-modal'));
        $('do-export-btn').addEventListener('click', handleExport);

        // Conversation list clicks (delegated)
        $('conversation-list').addEventListener('click', handleConversationListClick);

        // Message actions (delegated)
        $('chat-container').addEventListener('click', handleMessageActions);

        // Shortcut cards
        $('welcome-screen')?.addEventListener('click', (e) => {
            const card = e.target.closest('.shortcut-card');
            if (card) {
                $('message-input').value = card.dataset.prompt;
                handleSend();
            }
        });

        // Test connection buttons
        document.querySelectorAll('.test-connection-btn').forEach(btn => {
            btn.addEventListener('click', () => handleTestConnection(btn.dataset.provider, btn));
        });

        // Web search test connection
        $('websearch-test-btn').addEventListener('click', handleWebSearchTest);
    }

    // --- Handle Background Messages (from service worker) ---
    function handleBackgroundMessage(message) {
        // Only handle non-streaming messages here.
        // Stream events (STREAM_CHUNK, STREAM_DONE, STREAM_ERROR) now arrive
        // through the port opened by chrome.runtime.connect().
        switch (message.type) {
            case 'CONTEXT_MENU_TEXT':
                handleContextMenuText(message);
                break;
        }
    }

    // --- Send Message ---
    async function handleSend() {
        const input = $('message-input');
        const text = input.value.trim();
        if (!text && !screenshotData && !pageContext && attachedFiles.length === 0) return;
        if (isStreaming) return;

        // Ensure we have a conversation
        if (!currentConversationId) {
            const convo = await Storage.createConversation();
            currentConversationId = convo.id;
            await Storage.setActiveConversationId(convo.id);
            await loadConversationList();
            showChatArea();
        }

        // Build user message
        const userMessage = {
            role: 'user',
            content: text,
            files: [],
        };

        // Add screenshot as file attachment
        if (screenshotData) {
            userMessage.files.push({
                name: 'screenshot.png',
                type: 'image/png',
                data: screenshotData,
                size: 0,
            });
        }

        // Add attached files
        for (const file of attachedFiles) {
            if (file.type?.startsWith('image/')) {
                userMessage.files.push({
                    name: file.name,
                    type: file.type,
                    data: file.data,
                    size: file.size,
                });
            } else {
                // Text file: add content as file entry
                userMessage.files.push({
                    name: file.name,
                    type: file.type,
                    content: file.content,
                    size: file.size,
                });
            }
        }

        // Add page context as text content prefix
        if (pageContext) {
            let contextText = `[Page Context]\nTitle: ${pageContext.title}\nURL: ${pageContext.url}`;
            if (pageContext.selectedText) {
                contextText += `\nSelected Text: ${pageContext.selectedText}`;
            }
            if (pageContext.pageText) {
                contextText += `\nPage Content: ${pageContext.pageText}`;
            }
            contextText += '\n[/Page Context]\n\n';
            userMessage.content = contextText + userMessage.content;
        }

        // Save user message
        const savedMsg = await Storage.addMessage(currentConversationId, userMessage);
        renderUserMessage(savedMsg);

        // Clear input and attachments
        input.value = '';
        autoResizeTextarea();
        clearAttachments();

        // Hide welcome screen
        hideWelcomeScreen();

        // Build messages array for API
        const conversation = await Storage.getConversation(currentConversationId);
        const messages = buildApiMessages(conversation);

        // Start streaming (with or without web search)
        if (webSearchEnabled) {
            await handleSendWithSearch(conversation, messages);
        } else {
            startStreaming(messages);
        }

        // Generate title if first message
        if (conversation.messages.length <= 1) {
            generateTitle(messages);
        }
    }

    // --- Start Streaming (normal, no search) ---
    function startStreaming(messages) {
        isStreaming = true;
        abortController = new AbortController();
        updateSendButton();

        // Add assistant message placeholder
        const assistantMsg = { id: Storage.generateId(), role: 'assistant', content: '', timestamp: Date.now(), files: [] };
        renderAssistantMessage(assistantMsg, true);

        // Send to service worker via port-based streaming
        streamPort = chrome.runtime.connect({ name: 'ai-stream' });

        streamPort.onMessage.addListener((msg) => {
            switch (msg.type) {
                case 'STREAM_CHUNK':
                    handleStreamChunk(msg);
                    break;
                case 'STREAM_DONE':
                    handleStreamDone(msg);
                    break;
                case 'STREAM_ERROR':
                    handleStreamError(msg);
                    break;
            }
        });

        streamPort.onDisconnect.addListener(() => {
            if (isStreaming) {
                handleStreamError({ error: 'Connection to service worker lost.' });
            }
            streamPort = null;
        });

        streamPort.postMessage({
            type: 'SEND_MESSAGE',
            messages,
            options: {
                provider: $('provider-select').value,
                model: $('model-select').value,
                temperature: settings.defaultTemperature ?? 0.7,
                topP: settings.defaultTopP ?? 1,
                abortSignal: null,
            },
            settings,
        });
    }

    // --- Handle Send with Web Search ---
    // 3-step pipeline: LLM generates search query → DuckDuckGo search → LLM answers with context
    async function handleSendWithSearch(conversation, messages) {
        const userContent = messages[messages.length - 1]?.content || '';

        // Show search status indicator
        const searchStatusEl = showSearchStatus('Generating search query...');

        try {
            // Step 1: Ask LLM to generate a search query
            const queryMessages = [
                { role: 'system', content: 'You are a search query generator. Given a user message, generate a concise web search query that would find relevant information to answer it. Return ONLY the search query, nothing else. No explanation, no quotes, no prefixes. Just the search terms.' },
                { role: 'user', content: userContent },
            ];

            const searchQuery = await generateSearchQuery(queryMessages);

            if (!searchQuery || searchQuery.trim().length === 0) {
                // Query generation failed — fall back to normal send
                removeSearchStatus(searchStatusEl);
                startStreaming(messages);
                return;
            }

            // Update status
            updateSearchStatus(searchStatusEl, `Searching web for: ${searchQuery}`);

            // Step 2: Search DuckDuckGo
            const searchResults = await performWebSearch(searchQuery);

            if (!searchResults || !searchResults.results || searchResults.results.length === 0) {
                // No results — fall back to normal send with a note
                removeSearchStatus(searchStatusEl);
                UI.toast('No search results found, answering without web context', 'info');
                startStreaming(messages);
                return;
            }

            // Update status to done
            finalizeSearchStatus(searchStatusEl, searchQuery);

            // Step 3: Build final messages with search context injected
            const searchContext = WebSearchAPI.buildSearchContext(searchResults);
            const contextBlock = `[Web Search Results for: "${searchQuery}"]
${searchContext}
[/Web Search Results]

Use the above search results to inform your answer. Cite sources using [number] references where applicable. If the search results are not relevant, answer based on your own knowledge.`;

            // Inject search context into the system prompt or as a system message
            const finalMessages = messages.map(m => ({ ...m }));

            // Find system message and append context, or add a new system message
            const systemIdx = finalMessages.findIndex(m => m.role === 'system');
            if (systemIdx >= 0) {
                finalMessages[systemIdx] = {
                    ...finalMessages[systemIdx],
                    content: finalMessages[systemIdx].content + '\n\n' + contextBlock,
                };
            } else {
                finalMessages.unshift({ role: 'system', content: contextBlock });
            }

            // Start streaming with enriched context
            startStreaming(finalMessages);

        } catch (err) {
            // Any error in the search pipeline — fall back to normal send
            console.error('[WebSearch] Error:', err);
            removeSearchStatus(searchStatusEl);
            UI.toast('Web search failed, answering without search', 'error');
            startStreaming(messages);
        }
    }

    // --- Generate Search Query via LLM ---
    // Sends a short non-streaming request to the LLM to generate a search query.
    async function generateSearchQuery(messages) {
        return new Promise((resolve) => {
            // Use a temporary port for the query generation (non-streaming)
            const queryPort = chrome.runtime.connect({ name: 'ai-stream' });
            let fullContent = '';

            queryPort.onMessage.addListener((msg) => {
                switch (msg.type) {
                    case 'STREAM_CHUNK':
                        fullContent = msg.fullContent;
                        break;
                    case 'STREAM_DONE':
                        queryPort.disconnect();
                        resolve(fullContent.trim());
                        break;
                    case 'STREAM_ERROR':
                        queryPort.disconnect();
                        resolve('');
                        break;
                }
            });

            queryPort.onDisconnect.addListener(() => {
                resolve(fullContent.trim() || '');
            });

            queryPort.postMessage({
                type: 'SEND_MESSAGE',
                messages,
                options: {
                    provider: $('provider-select').value,
                    model: $('model-select').value,
                    temperature: 0.3, // Low temperature for focused query
                    topP: 1,
                    maxTokens: 50, // Short response
                    abortSignal: null,
                },
                settings,
            });

            // Timeout after 10 seconds
            setTimeout(() => {
                try { queryPort.disconnect(); } catch {}
                resolve(fullContent.trim() || '');
            }, 10000);
        });
    }

    // --- Perform Web Search ---
    async function performWebSearch(query) {
        return new Promise((resolve) => {
            chrome.runtime.sendMessage({
                type: 'WEB_SEARCH',
                query,
            }, (response) => {
                if (response?.success) {
                    resolve(response.data);
                } else {
                    console.error('[WebSearch] Error:', response?.error);
                    resolve(null);
                }
            });
        });
    }

    // --- Search Status UI ---
    function showSearchStatus(text) {
        const messagesEl = $('messages');
        const div = document.createElement('div');
        div.className = 'search-status';
        div.innerHTML = `<span class="search-icon">🔍</span> <span>${UI.escapeHtml(text)}</span>`;
        messagesEl.appendChild(div);
        UI.scrollToBottom($('chat-container'));
        return div;
    }

    function updateSearchStatus(el, text) {
        if (el) {
            el.innerHTML = `<span class="search-icon">🔍</span> <span>${UI.escapeHtml(text)}</span>`;
            UI.scrollToBottom($('chat-container'));
        }
    }

    function finalizeSearchStatus(el, query) {
        if (el) {
            el.className = 'search-status done';
            el.innerHTML = `<span class="search-icon">🌐</span> Searched DuckDuckGo: <span class="search-query">${UI.escapeHtml(query)}</span>`;
            UI.scrollToBottom($('chat-container'));
        }
    }

    function removeSearchStatus(el) {
        if (el) el.remove();
    }

    // --- Web Search Toggle ---
    function handleWebSearchToggle() {
        webSearchEnabled = !webSearchEnabled;
        updateWebSearchButton();

        // Persist to settings
        settings.webSearchEnabled = webSearchEnabled;
        Storage.saveSettings(settings);
        chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings });

        // Persist to conversation
        if (currentConversationId) {
            Storage.updateConversation(currentConversationId, { webSearchEnabled });
        }

        UI.toast(webSearchEnabled ? '🌐 Web search on' : 'Web search off', webSearchEnabled ? 'success' : 'info');
    }

    function updateWebSearchButton() {
        const btn = $('web-search-btn');
        if (!btn) return;
        if (webSearchEnabled) {
            btn.classList.add('web-search-active');
            btn.title = 'Web search is on (click to turn off)';
        } else {
            btn.classList.remove('web-search-active');
            btn.title = 'Toggle web search';
        }
    }

    // --- Stream Handling ---
    let streamingMessageId = null;
    let streamingContent = '';

    function renderAssistantMessage(msg, streaming) {
        const messagesEl = $('messages');
        const div = UI.renderMessage(msg, streaming);
        messagesEl.appendChild(div);
        UI.scrollToBottom($('chat-container'));
        streamingMessageId = msg.id;
        streamingContent = '';
    }

    function handleStreamChunk(message) {
        streamingContent = message.fullContent;
        const messagesEl = $('messages');
        const msgDiv = messagesEl.querySelector(`[data-message-id="${streamingMessageId}"] .message-content`);
        if (msgDiv) {
            msgDiv.innerHTML = Markdown.render(streamingContent);
            UI.scrollToBottom($('chat-container'));
        }
    }

    async function handleStreamDone(message) {
        isStreaming = false;
        abortController = null;
        updateSendButton();

        // Close the streaming port
        if (streamPort) {
            streamPort.disconnect();
            streamPort = null;
        }

        // Save assistant message
        if (currentConversationId && streamingContent) {
            await Storage.addMessage(currentConversationId, {
                role: 'assistant',
                content: streamingContent,
            });
        }

        streamingMessageId = null;
        streamingContent = '';
    }

    function handleStreamError(message) {
        isStreaming = false;
        abortController = null;
        updateSendButton();

        // Close the streaming port
        if (streamPort) {
            streamPort.disconnect();
            streamPort = null;
        }

        // Show error message
        if (currentConversationId) {
            Storage.addMessage(currentConversationId, {
                role: 'error',
                content: message.error || 'An error occurred',
            });
        }

        const messagesEl = $('messages');
        const errorDiv = document.createElement('div');
        errorDiv.className = 'message message-error';
        errorDiv.innerHTML = `<div class="message-avatar">⚠️</div><div class="message-content message-error">${UI.escapeHtml(message.error || 'An error occurred')}</div>`;
        messagesEl.appendChild(errorDiv);

        UI.toast(message.error || 'API Error', 'error');
        streamingMessageId = null;
        streamingContent = '';
    }

    // --- Build API Messages ---
    function buildApiMessages(conversation) {
        const messages = [];

        // System prompt
        const systemPrompt = conversation.systemPrompt || settings.defaultSystemPrompt || 'You are a helpful assistant.';
        if (systemPrompt) {
            messages.push({ role: 'system', content: systemPrompt });
        }

        // Conversation messages
        const maxMessages = settings.maxContextMessages || 50;
        const allMessages = conversation.messages || [];
        const trimmed = allMessages.slice(-maxMessages);

        for (const msg of trimmed) {
            messages.push({
                role: msg.role,
                content: msg.content,
                files: msg.files || [],
            });
        }

        return messages;
    }

    // --- Generate Title ---
    async function generateTitle(messages) {
        try {
            chrome.runtime.sendMessage({
                type: 'GENERATE_TITLE',
                messages: messages.slice(0, 2),
                provider: $('provider-select').value,
                model: $('model-select').value,
                settings,
            }, (response) => {
                if (response?.success && response.title && currentConversationId) {
                    Storage.updateConversation(currentConversationId, { title: response.title });
                    loadConversationList();
                }
            });
        } catch (e) { /* ignore */ }
    }

    // --- Render Messages ---
    function renderUserMessage(msg) {
        const messagesEl = $('messages');
        const div = UI.renderMessage(msg);
        messagesEl.appendChild(div);
        UI.scrollToBottom($('chat-container'));
    }

    function renderConversationMessages(conversation) {
        const messagesEl = $('messages');
        messagesEl.innerHTML = '';

        if (!conversation?.messages?.length) return;

        for (const msg of conversation.messages) {
            const div = UI.renderMessage(msg);
            messagesEl.appendChild(div);
        }

        UI.scrollToBottom($('chat-container'));
    }

    // --- Conversation Management ---
    async function handleNewChat() {
        const convo = await Storage.createConversation();
        currentConversationId = convo.id;
        await Storage.setActiveConversationId(convo.id);
        await loadConversationList();
        showChatArea();
        renderConversationMessages(convo);
        $('message-input').focus();
        closeSidebar();
    }

    async function switchConversation(id) {
        const convo = await Storage.getConversation(id);
        if (!convo) return;

        currentConversationId = id;
        await Storage.setActiveConversationId(id);
        showChatArea();
        renderConversationMessages(convo);
        await loadConversationList();

        // Set provider/model from conversation
        if (convo.provider) $('provider-select').value = convo.provider;
        if (convo.model) $('model-select').value = convo.model;

        // Restore web search toggle from conversation
        webSearchEnabled = convo.webSearchEnabled ?? settings.webSearchEnabled ?? false;
        updateWebSearchButton();
    }

    async function loadConversationList() {
        const convos = await Storage.getConversations();
        UI.renderConversationList(convos, currentConversationId, $('conversation-list'));
    }

    function handleConversationListClick(e) {
        const item = e.target.closest('.conversation-item');
        const delBtn = e.target.closest('.conversation-delete');

        if (delBtn) {
            e.stopPropagation();
            const id = item?.dataset.conversationId;
            if (id && confirm('Delete this conversation?')) {
                Storage.deleteConversation(id).then(() => {
                    if (currentConversationId === id) {
                        currentConversationId = null;
                        showWelcomeScreen();
                    }
                    loadConversationList();
                });
            }
            return;
        }

        if (item) {
            switchConversation(item.dataset.conversationId);
            closeSidebar();
        }
    }

    // --- Search ---
    async function handleSearch() {
        const query = $('search-input').value.toLowerCase().trim();
        const convos = await Storage.getConversations();
        const filtered = query
            ? convos.filter(c => c.title?.toLowerCase().includes(query) || c.messages?.some(m => m.content?.toLowerCase().includes(query)))
            : convos;
        UI.renderConversationList(filtered, currentConversationId, $('conversation-list'));
    }

    // --- Message Actions ---
    async function handleMessageActions(e) {
        const copyBtn = e.target.closest('.copy-btn');
        const regenBtn = e.target.closest('.regen-btn');
        const editBtn = e.target.closest('.edit-btn');

        if (copyBtn) {
            const msgEl = copyBtn.closest('.message');
            const content = msgEl?.querySelector('.message-content')?.textContent;
            if (content) {
                navigator.clipboard.writeText(content).then(() => UI.toast('Copied!', 'success'));
            }
        }

        if (regenBtn && !isStreaming) {
            const msgEl = regenBtn.closest('.message');
            const msgId = msgEl?.dataset.messageId;
            if (msgId && currentConversationId) {
                // Remove last assistant message and regenerate
                await Storage.deleteMessage(currentConversationId, msgId);
                msgEl?.remove();

                // Re-send the conversation
                const conversation = await Storage.getConversation(currentConversationId);
                const messages = buildApiMessages(conversation);

                startStreaming(messages);
            }
        }

        if (editBtn) {
            const msgEl = editBtn.closest('.message');
            const msgId = msgEl?.dataset.messageId;
            const contentEl = msgEl?.querySelector('.message-content');
            if (msgId && contentEl && currentConversationId) {
                const originalText = contentEl.textContent;
                contentEl.contentEditable = true;
                contentEl.focus();
                contentEl.classList.add('editing');

                const finish = async () => {
                    contentEl.contentEditable = false;
                    contentEl.classList.remove('editing');
                    const newText = contentEl.textContent?.trim();
                    if (newText && newText !== originalText) {
                        await Storage.updateMessage(currentConversationId, msgId, { content: newText });
                        contentEl.innerHTML = UI.escapeHtml(newText).replace(/\n/g, '<br>');
                    } else {
                        contentEl.innerHTML = UI.escapeHtml(originalText).replace(/\n/g, '<br>');
                    }
                };

                contentEl.addEventListener('blur', finish, { once: true });
                contentEl.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        finish();
                    }
                    if (e.key === 'Escape') {
                        contentEl.textContent = originalText;
                        finish();
                    }
                });
            }
        }
    }

    // --- Screenshot ---
    async function handleScreenshot() {
        try {
            chrome.runtime.sendMessage({ type: 'CAPTURE_SCREENSHOT' }, (response) => {
                if (response?.success) {
                    screenshotData = response.dataUrl;
                    renderAttachmentPreviews();
                    UI.toast('Screenshot captured!', 'success');
                } else {
                    UI.toast(response?.error || 'Failed to capture screenshot', 'error');
                }
            });
        } catch (e) {
            UI.toast('Failed to capture screenshot', 'error');
        }
    }

    // --- Page Context ---
    async function handlePageContext() {
        try {
            chrome.runtime.sendMessage({ type: 'GET_PAGE_CONTENT', maxTextLength: 4000 }, (response) => {
                if (response?.success) {
                    pageContext = response.context;
                    renderAttachmentPreviews();
                    UI.toast('Page context attached!', 'success');
                } else {
                    UI.toast(response?.error || 'Failed to get page context', 'error');
                }
            });
        } catch (e) {
            UI.toast('Failed to get page context', 'error');
        }
    }

    // --- File Attachment ---
    function handleFileAttach(e) {
        const files = Array.from(e.target.files || []);
        if (!files.length) return;

        for (const file of files) {
            if (file.size > 10 * 1024 * 1024) {
                UI.toast(`${file.name} is too large (max 10MB)`, 'error');
                continue;
            }

            if (file.type?.startsWith('image/')) {
                // Read image as data URL
                const reader = new FileReader();
                reader.onload = () => {
                    attachedFiles.push({
                        name: file.name,
                        type: file.type,
                        data: reader.result,
                        size: file.size,
                    });
                    renderAttachmentPreviews();
                };
                reader.readAsDataURL(file);
            } else {
                // Read text-based file as text
                const reader = new FileReader();
                reader.onload = () => {
                    attachedFiles.push({
                        name: file.name,
                        type: file.type || 'text/plain',
                        content: reader.result,
                        size: file.size,
                    });
                    renderAttachmentPreviews();
                };
                reader.readAsText(file);
            }
        }

        UI.toast(`${files.length} file${files.length > 1 ? 's' : ''} attached`, 'success');

        // Reset file input so the same file can be re-attached
        e.target.value = '';
    }

    // --- Attachment Previews ---
    function renderAttachmentPreviews() {
        const container = $('attachment-previews');
        container.innerHTML = '';
        container.style.display = 'none';

        if (screenshotData) {
            container.style.display = 'block';
            const div = document.createElement('div');
            div.className = 'screenshot-preview';
            div.innerHTML = `
                <img src="${screenshotData}" alt="Screenshot">
                <button class="remove-screenshot" title="Remove screenshot">×</button>
            `;
            div.querySelector('.remove-screenshot').addEventListener('click', () => {
                screenshotData = null;
                renderAttachmentPreviews();
            });
            container.appendChild(div);
        }

        if (pageContext) {
            container.style.display = 'block';
            const badge = document.createElement('div');
            badge.className = 'context-badge';
            badge.innerHTML = `📄 ${pageContext.title || 'Page context'} <span class="remove-context">×</span>`;
            badge.querySelector('.remove-context').addEventListener('click', () => {
                pageContext = null;
                renderAttachmentPreviews();
            });
            container.appendChild(badge);
        }

        // Render attached file previews
        for (let i = 0; i < attachedFiles.length; i++) {
            const file = attachedFiles[i];
            container.style.display = 'block';
            const badge = document.createElement('div');
            badge.className = 'context-badge';
            if (file.type?.startsWith('image/')) {
                badge.innerHTML = `🖼️ ${file.name} <span class="remove-attachment" data-index="${i}">×</span>`;
            } else {
                badge.innerHTML = `📎 ${file.name} <span class="remove-attachment" data-index="${i}">×</span>`;
            }
            badge.querySelector('.remove-attachment').addEventListener('click', () => {
                attachedFiles.splice(i, 1);
                renderAttachmentPreviews();
            });
            container.appendChild(badge);
        }
    }

    function clearAttachments() {
        screenshotData = null;
        pageContext = null;
        attachedFiles = [];
        const container = $('attachment-previews');
        container.innerHTML = '';
        container.style.display = 'none';
    }

    // --- Context Menu Text ---
    function handleContextMenuText(message) {
        if (message.text) {
            $('message-input').value = message.text;
            $('message-input').focus();
            autoResizeTextarea();
        }
    }

    // --- Provider/Model ---
    async function updateModelSelect() {
        const provider = $('provider-select').value;
        const modelSelect = $('model-select');

        // Try to fetch live models from service worker
        chrome.runtime.sendMessage({ type: 'LIST_MODELS', provider, settings }, (response) => {
            const models = response?.success ? response.models : [];
            UI.populateModelSelect(modelSelect, provider, models.length > 0 ? models : getDefaultModels(provider));
        });
    }

    function getDefaultModels(provider) {
        const defaults = {
            openai: [
                { id: 'gpt-4o', name: 'GPT-4o' },
                { id: 'gpt-4o-mini', name: 'GPT-4o Mini' },
                { id: 'gpt-3.5-turbo', name: 'GPT-3.5 Turbo' },
            ],
            anthropic: [
                { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4' },
                { id: 'claude-3-5-sonnet-20241022', name: 'Claude 3.5 Sonnet' },
            ],
            google: [
                { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash' },
                { id: 'gemini-1.5-pro', name: 'Gemini 1.5 Pro' },
            ],
            ollama: [
                { id: 'llama3.1', name: 'Llama 3.1' },
                { id: 'mistral', name: 'Mistral' },
            ],
            lmstudio: [
                { id: 'local-model', name: 'Local Model' },
            ],
            custom: [],
        };
        return defaults[provider] || [];
    }

    function saveCurrentProviderModel() {
        const provider = $('provider-select').value;
        const model = $('model-select').value;
        if (currentConversationId) {
            Storage.updateConversation(currentConversationId, { provider, model });
        }
        $('model-info').textContent = `${provider}/${model}`;

        // Persist LLM choice across sessions
        settings.defaultProvider = provider;
        settings.defaultModel = model;
        Storage.saveSettings(settings);
        chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings });
    }

    // --- Settings ---
    function populateSettingsForm() {
        const p = settings.providers || {};
        $('openai-apikey').value = p.openai?.apiKey || '';
        $('openai-baseurl').value = p.openai?.baseUrl || 'https://api.openai.com/v1';
        $('anthropic-apikey').value = p.anthropic?.apiKey || '';
        $('anthropic-baseurl').value = p.anthropic?.baseUrl || 'https://api.anthropic.com';
        $('google-apikey').value = p.google?.apiKey || '';
        $('ollama-baseurl').value = p.ollama?.baseUrl || 'http://localhost:11434';
        $('lmstudio-baseurl').value = p.lmstudio?.baseUrl || 'http://localhost:1234/v1';
        $('custom-baseurl').value = p.custom?.baseUrl || '';
        $('custom-apikey').value = p.custom?.apiKey || '';
        $('custom-model').value = p.custom?.model || '';

        // Web search settings — no configuration needed (DuckDuckGo works out of the box)
    }

    async function handleSaveSettings() {
        settings.providers = {
            openai: { apiKey: $('openai-apikey').value, baseUrl: $('openai-baseurl').value || 'https://api.openai.com/v1' },
            anthropic: { apiKey: $('anthropic-apikey').value, baseUrl: $('anthropic-baseurl').value || 'https://api.anthropic.com' },
            google: { apiKey: $('google-apikey').value, baseUrl: '' },
            ollama: { apiKey: '', baseUrl: $('ollama-baseurl').value || 'http://localhost:11434' },
            lmstudio: { apiKey: '', baseUrl: $('lmstudio-baseurl').value || 'http://localhost:1234/v1' },
            custom: { apiKey: $('custom-apikey').value, baseUrl: $('custom-baseurl').value, model: $('custom-model').value },
        };

        await Storage.saveSettings(settings);

        // Also save to service worker
        chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings });

        UI.closeModal('settings-modal');
        UI.toast('Settings saved!', 'success');

        // Refresh model list
        await updateModelSelect();
    }

    async function handleTestConnection(provider, btn) {
        btn.textContent = 'Testing...';
        btn.className = 'test-connection-btn';

        // Gather current form values for this provider
        const currentSettings = { ...settings };
        currentSettings.providers = { ...settings.providers };

        if (provider === 'openai') {
            currentSettings.providers.openai = { apiKey: $('openai-apikey').value, baseUrl: $('openai-baseurl').value };
        } else if (provider === 'anthropic') {
            currentSettings.providers.anthropic = { apiKey: $('anthropic-apikey').value, baseUrl: $('anthropic-baseurl').value };
        } else if (provider === 'google') {
            currentSettings.providers.google = { apiKey: $('google-apikey').value, baseUrl: '' };
        } else if (provider === 'ollama') {
            currentSettings.providers.ollama = { apiKey: '', baseUrl: $('ollama-baseurl').value };
        } else if (provider === 'lmstudio') {
            currentSettings.providers.lmstudio = { apiKey: '', baseUrl: $('lmstudio-baseurl').value };
        } else if (provider === 'custom') {
            currentSettings.providers.custom = { apiKey: $('custom-apikey').value, baseUrl: $('custom-baseurl').value, model: $('custom-model').value };
        }

        chrome.runtime.sendMessage({ type: 'TEST_CONNECTION', provider, settings: currentSettings }, (response) => {
            if (response?.success) {
                btn.textContent = '✓ Connected';
                btn.classList.add('success');
                UI.toast(`${provider} connected!`, 'success');
            } else {
                btn.textContent = '✗ Failed';
                btn.classList.add('error');
                UI.toast(response?.error || 'Connection failed', 'error');
            }

            setTimeout(() => {
                btn.textContent = 'Test';
                btn.className = 'test-connection-btn';
            }, 3000);
        });
    }

    // --- Theme ---
    async function handleThemeChange(theme) {
        document.documentElement.dataset.theme = theme;
        await Storage.setTheme(theme);
        updateHljsTheme(theme);
    }

    function updateHljsTheme(theme) {
        const darkSheet = document.getElementById('hljs-dark-theme');
        const lightSheet = document.getElementById('hljs-light-theme');
        if (darkSheet && lightSheet) {
            const isLight = theme === 'light';
            darkSheet.disabled = isLight;
            lightSheet.disabled = !isLight;
        }
    }

    // --- Sidebar ---
    function toggleSidebar() {
        const sidebar = $('sidebar');
        const overlay = $('sidebar-overlay');
        sidebar.classList.toggle('open');
        overlay.classList.toggle('active');
    }

    function closeSidebar() {
        $('sidebar').classList.remove('open');
        $('sidebar-overlay').classList.remove('active');
    }

    // --- UI Helpers ---
    function showWelcomeScreen() {
        $('welcome-screen').style.display = '';
        $('messages').style.display = 'none';
    }

    function hideWelcomeScreen() {
        $('welcome-screen').style.display = 'none';
        $('messages').style.display = '';
    }

    function showChatArea() {
        hideWelcomeScreen();
    }

    function autoResizeTextarea() {
        const textarea = $('message-input');
        textarea.style.height = 'auto';
        textarea.style.height = Math.min(textarea.scrollHeight, 120) + 'px';
    }

    function updateSendButton() {
        const btn = $('send-btn');
        if (isStreaming) {
            btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>`;
            btn.className = 'btn btn-stop';
            btn.title = 'Stop generating';
            btn.onclick = () => {
                // Note: can't abort service worker fetch from side panel directly
                // The stream will end on its own or we'd need a more complex abort mechanism
                isStreaming = false;
                updateSendButton();
            };
        } else {
            btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>`;
            btn.className = 'btn btn-send';
            btn.title = 'Send message';
            btn.onclick = handleSend;
        }
    }

    // --- Export ---
    async function handleExport() {
        const format = $('export-format').value;
        const data = await Storage.exportAll();

        let content, filename, mimeType;

        if (format === 'json') {
            content = JSON.stringify(data, null, 2);
            filename = `aichat-export-${new Date().toISOString().slice(0, 10)}.json`;
            mimeType = 'application/json';
        } else if (format === 'markdown') {
            content = data.conversations.map(c => {
                let md = `# ${c.title}\n\n`;
                for (const msg of c.messages) {
                    md += `**${msg.role}**: ${msg.content}\n\n`;
                }
                return md;
            }).join('---\n\n');
            filename = `aichat-export-${new Date().toISOString().slice(0, 10)}.md`;
            mimeType = 'text/markdown';
        } else {
            content = data.conversations.map(c => {
                let txt = `${c.title}\n${'='.repeat(c.title.length)}\n\n`;
                for (const msg of c.messages) {
                    txt += `[${msg.role}]: ${msg.content}\n\n`;
                }
                return txt;
            }).join('\n---\n\n');
            filename = `aichat-export-${new Date().toISOString().slice(0, 10)}.txt`;
            mimeType = 'text/plain';
        }

        const blob = new Blob([content], { type: mimeType });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);

        UI.closeModal('export-modal');
        UI.toast('Exported!', 'success');
    }

    // --- Start ---
    document.addEventListener('DOMContentLoaded', init);

    // --- Web Search Test Connection ---
    async function handleWebSearchTest() {
        const btn = $('websearch-test-btn');

        btn.textContent = 'Testing...';
        btn.className = 'test-connection-btn';

        chrome.runtime.sendMessage({
            type: 'WEB_SEARCH_TEST',
        }, (response) => {
            if (response?.ok) {
                btn.textContent = '✓ Connected';
                btn.classList.add('success');
                UI.toast('DuckDuckGo search connected!', 'success');
            } else {
                btn.textContent = '✗ Failed';
                btn.classList.add('error');
                UI.toast(response?.error || 'DuckDuckGo connection failed', 'error');
            }

            setTimeout(() => {
                btn.textContent = 'Test';
                btn.className = 'test-connection-btn';
            }, 3000);
        });
    }

    return {
        init,
        handleSend,
        handleNewChat,
        switchConversation,
    };
})();