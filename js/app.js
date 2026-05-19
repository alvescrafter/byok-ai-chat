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
    let youtubeTranscript = null; // attached YouTube transcript
    let streamPort = null;     // port for streaming communication with service worker

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
        updateThemeIcon(theme);

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

        // Update YouTube button state when active tab changes
        if (chrome.tabs?.onActivated) {
            chrome.tabs.onActivated.addListener(() => updateYoutubeButtonState());
        }
        if (chrome.tabs?.onUpdated) {
            chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
                if (changeInfo.url) updateYoutubeButtonState();
            });
        }

        // Update token counter on input
        updateTokenCounter();
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
            updateTokenCounter();
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

        // Theme toggle
        $('theme-toggle-btn').addEventListener('click', handleThemeToggle);

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

        // YouTube transcript
        $('youtube-transcript-btn').addEventListener('click', handleYoutubeTranscript);
        updateYoutubeButtonState();

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
        if (!text && !screenshotData && !pageContext && !youtubeTranscript && attachedFiles.length === 0) return;
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

        // Add YouTube transcript as text content prefix
        if (youtubeTranscript) {
            let ytText = `[YouTube Transcript]\nTitle: ${youtubeTranscript.title}\nURL: ${youtubeTranscript.url}\nLanguage: ${youtubeTranscript.language}\n\n${youtubeTranscript.transcript}\n[/YouTube Transcript]\n\n`;
            userMessage.content = ytText + userMessage.content;
        }

        // Save user message
        const savedMsg = await Storage.addMessage(currentConversationId, userMessage);
        renderUserMessage(savedMsg);

        // Clear input and attachments
        input.value = '';
        autoResizeTextarea();
        clearAttachments();
        updateTokenCounter();

        // Hide welcome screen
        hideWelcomeScreen();

        // Build messages array for API
        const conversation = await Storage.getConversation(currentConversationId);
        const messages = buildApiMessages(conversation);

        // Start streaming
        isStreaming = true;
        abortController = new AbortController();
        updateSendButton();

        // Add assistant message placeholder
        const assistantMsg = { id: Storage.generateId(), role: 'assistant', content: '', timestamp: Date.now(), files: [] };
        renderAssistantMessage(assistantMsg, true);

        // Send to service worker via port-based streaming
        // chrome.runtime.sendMessage is unreliable for service worker → side panel.
        // Instead, open a port and send/receive through it.
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
            // Port closed (service worker restarted or panel closed)
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
                abortSignal: null, // can't pass AbortSignal across message boundary
            },
            settings,
        });

        // Generate title if first message
        if (conversation.messages.length <= 1) {
            generateTitle(messages);
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

                isStreaming = true;
                abortController = new AbortController();
                updateSendButton();

                const assistantMsg = { id: Storage.generateId(), role: 'assistant', content: '', timestamp: Date.now(), files: [] };
                renderAssistantMessage(assistantMsg, true);

                // Use port-based streaming for regeneration too
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
                    },
                    settings,
                });
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

    // --- YouTube Transcript ---
    async function handleYoutubeTranscript() {
        try {
            UI.toast('Extracting transcript...', 'info', 5000);
            chrome.runtime.sendMessage({ type: 'GET_YOUTUBE_TRANSCRIPT' }, (response) => {
                if (response?.success) {
                    youtubeTranscript = {
                        transcript: response.transcript,
                        title: response.title,
                        url: response.url,
                        videoId: response.videoId,
                        language: response.language,
                    };
                    renderAttachmentPreviews();
                    UI.toast('YouTube transcript attached!', 'success');
                } else {
                    UI.toast(response?.error || 'Failed to get YouTube transcript', 'error');
                }
            });
        } catch (e) {
            UI.toast('Failed to get YouTube transcript', 'error');
        }
    }

    // --- YouTube Button State ---
    async function updateYoutubeButtonState() {
        try {
            const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
            const btn = $('youtube-transcript-btn');
            if (!btn) return;

            const isYoutube = tab?.url && /^https?:\/\/(www\.)?youtube\.com\/watch/.test(tab.url);
            if (isYoutube) {
                btn.classList.remove('btn-youtube-disabled');
                btn.title = 'Extract YouTube transcript';
            } else {
                btn.classList.add('btn-youtube-disabled');
                btn.title = 'Not a YouTube video page';
            }
        } catch (e) {
            // Ignore errors (e.g. during startup)
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

        if (youtubeTranscript) {
            container.style.display = 'block';
            const badge = document.createElement('div');
            badge.className = 'youtube-badge';
            badge.innerHTML = `▶️ ${youtubeTranscript.title || 'YouTube Transcript'} <span class="remove-youtube">×</span>`;
            badge.querySelector('.remove-youtube').addEventListener('click', () => {
                youtubeTranscript = null;
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
        youtubeTranscript = null;
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
            updateTokenCounter();
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
    async function handleThemeToggle() {
        const current = document.documentElement.dataset.theme;
        const next = current === 'dark' ? 'light' : 'dark';
        document.documentElement.dataset.theme = next;
        await Storage.setTheme(next);
        updateThemeIcon(next);
    }

    function updateThemeIcon(theme) {
        const darkIcon = $('theme-icon-dark');
        const lightIcon = $('theme-icon-light');
        if (theme === 'dark') {
            darkIcon.style.display = '';
            lightIcon.style.display = 'none';
        } else {
            darkIcon.style.display = 'none';
            lightIcon.style.display = '';
        }
        // Switch highlight.js theme
        const darkSheet = document.getElementById('hljs-dark-theme');
        const lightSheet = document.getElementById('hljs-light-theme');
        if (darkSheet && lightSheet) {
            darkSheet.disabled = theme !== 'dark';
            lightSheet.disabled = theme !== 'light';
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

    function updateTokenCounter() {
        const text = $('message-input').value;
        const tokens = Math.ceil(text.length / 3.5);
        $('token-counter').textContent = `~${tokens} tokens`;
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

    return {
        init,
        handleSend,
        handleNewChat,
        switchConversation,
    };
})();