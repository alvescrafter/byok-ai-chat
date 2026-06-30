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
    let webSearchMode = 'off'; // web search mode: 'off' or 'on'

    // --- DOM References ---
    const $ = (id) => document.getElementById(id);

    // --- Web Search Helpers ---
    function getMaxSearches(mode) {
        return mode === 'off' ? 0 : 1;
    }

    function normalizeWebSearchMode(mode, enabledFallback = false) {
        return mode && mode !== 'off' ? 'on' : (enabledFallback ? 'on' : 'off');
    }

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

        // Apply web search mode from settings (backward compat: old named modes -> 'on')
        webSearchMode = normalizeWebSearchMode(settings.webSearchMode, settings.webSearchEnabled);
        updateWebSearchButton();
        updateWebSearchMenuActive();

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

        // Web search dropdown
        $('web-search-btn').addEventListener('click', handleWebSearchButtonClick);
        if ($('web-search-menu')) $('web-search-menu').addEventListener('click', handleWebSearchMenuClick);
        document.addEventListener('click', handleWebSearchOutsideClick);

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
        if (webSearchMode !== 'off') {
            await handleSendWithResearch(conversation, messages);
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

    // --- Handle Send with Web Research (Search + Visit Loop) ---
    async function handleSendWithResearch(conversation, messages) {
        const userContent = messages[messages.length - 1]?.content || '';
        const maxSearches = getMaxSearches(webSearchMode);
        const maxVisits = Math.max(2, Math.min(12, maxSearches * 2));
        const now = new Date().toLocaleString();
        const statusContainer = showSearchStatusContainer();

        try {
            const planningEl = showPlanningStatus(statusContainer);
            const planningMessages = [
                {
                    role: 'system',
                    content: `You are a research assistant. Given a user's question, generate one focused web search query.

Current date and time: ${now}

Use current dates in the query when recency matters. Return ONLY the search query. No numbering, markdown, explanation, or quotes.`
                },
                { role: 'user', content: userContent },
            ];

            const planResponse = await callLLM(planningMessages, { temperature: 0.3, maxTokens: 150, timeout: 20000 });
            removeSearchStatus(planningEl);

            let queries = parsePlannedQueries(planResponse);
            if (queries.length === 0) {
                console.log('[WebSearch] No queries parsed from LLM response, using user question as fallback');
                queries = [userContent.slice(0, 200)];
            }

            const allResults = [];
            const visitedPages = [];
            const seenUrls = new Set();
            const visitedUrls = new Set();
            const usedQueries = new Set();
            const searchedQueries = [];
            let searchCount = 0;
            let visitCount = 0;
            let satisfied = false;
            let actions = queries.slice(0, maxSearches).map(query => ({ type: 'search', value: query }));

            while (!satisfied && (searchCount < maxSearches || visitCount < maxVisits)) {
                while (actions.length > 0 && (searchCount < maxSearches || visitCount < maxVisits)) {
                    const action = actions.shift();

                    if (action.type === 'search') {
                        const query = action.value.trim();
                        if (!query || usedQueries.has(query.toLowerCase()) || searchCount >= maxSearches) continue;
                        usedQueries.add(query.toLowerCase());
                        searchedQueries.push(query);
                        searchCount++;

                        const searchEl = showSearchRoundStatus(statusContainer, query, searchCount, maxSearches);
                        const searchResults = await performWebSearch(query);

                        if (searchResults && searchResults.results && searchResults.results.length > 0) {
                            for (const result of searchResults.results) {
                                if (result.url && !seenUrls.has(result.url)) {
                                    seenUrls.add(result.url);
                                    allResults.push({ ...result, query });
                                }
                            }
                            finalizeSearchRoundStatus(searchEl, query, searchResults.results.length);
                        } else {
                            failSearchRoundStatus(searchEl, query);
                        }
                    }

                    if (action.type === 'visit') {
                        const url = resolveVisitTarget(action.value, allResults);
                        if (!url || visitedUrls.has(url) || visitCount >= maxVisits) continue;
                        visitedUrls.add(url);
                        visitCount++;

                        const visitEl = showVisitStatus(statusContainer, url, visitCount, maxVisits);
                        const page = await performVisitWebsite(url);

                        if (page && page.text) {
                            visitedPages.push(page);
                            finalizeVisitStatus(visitEl, page);
                        } else {
                            failVisitStatus(visitEl, url);
                        }
                    }
                }

                const canSearchMore = searchCount < maxSearches;
                const canVisitMore = visitCount < maxVisits && allResults.some(r => r.url && !visitedUrls.has(r.url));
                if (!canSearchMore && !canVisitMore) break;

                const reviewEl = showReviewStatus(statusContainer);
                const reviewMessages = buildResearchReviewMessages({
                    userContent,
                    allResults,
                    visitedPages,
                    visitedUrls,
                    searchCount,
                    maxSearches,
                    visitCount,
                    maxVisits,
                    now,
                });

                const reviewResponse = await callLLM(reviewMessages, { temperature: 0.2, maxTokens: 260, timeout: 25000 });
                removeSearchStatus(reviewEl);

                const nextActions = parseResearchActions(reviewResponse, allResults)
                    .filter(action => {
                        if (action.type === 'search') {
                            return canSearchMore && action.value && !usedQueries.has(action.value.toLowerCase());
                        }
                        if (action.type === 'visit') {
                            const url = resolveVisitTarget(action.value, allResults);
                            return canVisitMore && url && !visitedUrls.has(url);
                        }
                        return false;
                    })
                    .slice(0, 2);

                if (nextActions.length === 0) {
                    satisfied = true;
                } else {
                    actions.push(...nextActions);
                }
            }

            removeSearchStatusContainer(statusContainer);

            if (allResults.length === 0 && visitedPages.length === 0) {
                UI.toast('No search results found, answering without web context', 'info');
                startStreaming(messages);
                return;
            }

            if (!satisfied && searchCount >= maxSearches) {
                UI.toast(`Max searches (${maxSearches}) reached, answering with available info`, 'info');
            }

            const contextBlock = buildFinalResearchContext({
                allResults,
                visitedPages,
                queriesUsed: searchedQueries,
                now,
            });

            const finalMessages = messages.map(m => ({ ...m }));
            const systemIdx = finalMessages.findIndex(m => m.role === 'system');
            if (systemIdx >= 0) {
                finalMessages[systemIdx] = {
                    ...finalMessages[systemIdx],
                    content: finalMessages[systemIdx].content + '\n\n' + contextBlock,
                };
            } else {
                finalMessages.unshift({ role: 'system', content: contextBlock });
            }

            startStreaming(finalMessages);
        } catch (err) {
            console.error('[WebSearch] Error:', err);
            removeSearchStatusContainer(statusContainer);
            UI.toast('Web search failed, answering without search', 'error');
            startStreaming(messages);
        }
    }

    function parsePlannedQueries(response) {
        return (response || '')
            .split('\n')
            .map(q => q.replace(/^\d+[\.\)]\s*/, '').trim())
            .map(q => q.replace(/^[`*#>]+\s*/, '').trim())
            .filter(q => q.length > 0)
            .filter(q => !q.startsWith('```'))
            .filter(q => {
                const lower = q.toLowerCase();
                return !lower.startsWith('here are') &&
                       !lower.startsWith('search queries') &&
                       !lower.startsWith("i'll ") &&
                       !lower.startsWith('i will ') &&
                       !lower.startsWith('let me ') &&
                       !lower.startsWith('sure') &&
                       !lower.startsWith('okay') &&
                       !lower.startsWith('of course') &&
                       !lower.startsWith('certainly') &&
                       !lower.startsWith('to answer') &&
                       !lower.startsWith('based on') &&
                       !lower.startsWith('these are') &&
                       !lower.startsWith('the following') &&
                       !lower.startsWith('i need') &&
                       !lower.startsWith('i should');
            });
    }

    function buildResearchReviewMessages(context) {
        const {
            userContent,
            allResults,
            visitedPages,
            visitedUrls,
            searchCount,
            maxSearches,
            visitCount,
            maxVisits,
            now,
        } = context;

        const searchContext = allResults.length > 0
            ? allResults.map((r, i) => {
                const wasRead = visitedPages.some(p => p.url === r.url || p.requestedUrl === r.url);
                const visitState = wasRead ? 'read' : (visitedUrls.has(r.url) ? 'visit failed' : 'not visited');
                return `[${i + 1}] ${r.title} (${r.source}) [${visitState}] [query: "${r.query}"]\nURL: ${r.url}\n${r.snippet || ''}`;
            }).join('\n\n')
            : 'No search results collected yet.';

        const pageContext = visitedPages.length > 0
            ? visitedPages.map((p, i) => {
                const excerpt = (p.text || '').slice(0, 1600);
                return `[P${i + 1}] ${p.title} (${p.source})\nURL: ${p.url}\n${p.metaDescription || ''}\n${excerpt}`;
            }).join('\n\n')
            : 'No pages visited yet.';

        return [
            {
                role: 'system',
                content: `You are controlling web research tools for an AI chat answer.

Current date and time: ${now}
User question: ${userContent}

Search budget used: ${searchCount}/${maxSearches}
Visit budget used: ${visitCount}/${maxVisits}

Search results:
${searchContext}

Visited pages:
${pageContext}

Decide the next step.

Reply with exactly one of these formats:
ANSWER
SEARCH: <new focused search query>
VISIT: <result number or URL>

Use VISIT when a search result looks relevant but snippets are not enough. Use SEARCH when the available results are missing key facts or need corroboration. Ask for at most 2 actions, one per line.`
            },
            { role: 'user', content: 'Choose the next research action, or ANSWER if the gathered context is sufficient.' },
        ];
    }

    function parseResearchActions(response, allResults) {
        const lines = (response || '').split('\n').map(line => line.trim()).filter(Boolean);
        const actions = [];

        for (const line of lines) {
            const searchMatch = line.match(/^SEARCH:\s*(.+)$/i);
            if (searchMatch) {
                actions.push({ type: 'search', value: searchMatch[1].trim() });
                continue;
            }

            const visitMatch = line.match(/^VISIT:\s*(.+)$/i);
            if (visitMatch) {
                actions.push({ type: 'visit', value: visitMatch[1].trim() });
                continue;
            }

            const upper = line.toUpperCase();
            if (upper === 'ANSWER' || upper.startsWith('ANSWER ')) {
                break;
            }
        }

        return actions.filter(action => {
            if (action.type === 'search') return action.value.length > 0;
            if (action.type === 'visit') return Boolean(resolveVisitTarget(action.value, allResults));
            return false;
        });
    }

    function resolveVisitTarget(value, allResults) {
        const target = (value || '').trim();
        if (!target) return '';

        const urlMatch = target.match(/https?:\/\/[^\s>)\]]+/i);
        if (urlMatch) return urlMatch[0];

        const numberMatch = target.match(/\d+/);
        if (numberMatch) {
            const index = parseInt(numberMatch[0], 10) - 1;
            return allResults[index]?.url || '';
        }

        return '';
    }

    function buildFinalResearchContext({ allResults, visitedPages, queriesUsed, now }) {
        const sources = [];

        for (const page of visitedPages) {
            sources.push({
                title: page.title,
                source: page.source,
                url: page.url,
                text: `${page.metaDescription ? page.metaDescription + '\n' : ''}${page.text || ''}`.trim(),
            });
        }

        for (const result of allResults) {
            if (sources.some(source => source.url === result.url)) continue;
            sources.push({
                title: result.title,
                source: result.source,
                url: result.url,
                text: result.snippet || '',
            });
        }

        let body = '';
        let includedCount = 0;
        for (let i = 0; i < sources.length; i++) {
            const source = sources[i];
            const next = `[${i + 1}] ${source.title || 'Untitled'} (${source.source || 'Unknown'})\nURL: ${source.url}\n${source.text || ''}\n\n`;
            if ((body + next).length > 28000) break;
            body += next;
            includedCount++;
        }

        return `[Web Research Context - ${includedCount} sources]
Searches performed: ${queriesUsed.length > 0 ? queriesUsed.join(' | ') : 'none'}
Current date: ${now}

${body.trim()}
[/Web Research Context]

Use the web research context to answer the user's question. Cite sources with [number] references. Prioritize visited page text over snippets, and say when the gathered sources do not cover part of the question.`;
    }

    // --- Handle Send with Web Search (Iterative Multi-Query Protocol) ---
    // LLM plans search queries → searches one-by-one → LLM reviews results →
    // decides to search more or answer. Injects current date/time for recency.
    async function handleSendWithSearch(conversation, messages) {
        const userContent = messages[messages.length - 1]?.content || '';
        const maxSearches = getMaxSearches(webSearchMode);
        const now = new Date().toLocaleString();

        // Container for all stacked search status indicators
        const statusContainer = showSearchStatusContainer();

        try {
            // === PLANNING STEP ===
            const planningEl = showPlanningStatus(statusContainer);

            const planningMessages = [
                {
                    role: 'system',
                    content: `You are a research assistant. Given a user's question, generate web search queries to find relevant, current information.

Current date and time: ${now}

Break the question into 1-3 focused search queries if the question is complex or multi-faceted. For simple questions, generate a single query. Use the current date above to make queries time-relevant when appropriate (e.g., add the current year or month for news, recent events, or evolving topics).

Return ONLY the search queries, one per line. No numbering, no explanation, no quotes, no prefixes. Just the search terms.`
                },
                { role: 'user', content: userContent },
            ];

            const planResponse = await callLLM(planningMessages, { temperature: 0.3, maxTokens: 150, timeout: 15000 });
            removeSearchStatus(planningEl);

            // Parse queries (one per line, strip numbering, preamble, markdown)
            let queries = planResponse
                .split('\n')
                .map(q => q.replace(/^\d+[\.\)]\s*/, '').trim())  // strip "1. " prefixes
                .map(q => q.replace(/^[`*#>]+\s*/, '').trim())       // strip markdown prefixes
                .filter(q => q.length > 0)
                .filter(q => !q.startsWith('```'))                     // strip code fence lines
                .filter(q => {
                    const lower = q.toLowerCase();
                    // Strip common LLM preamble lines
                    return !lower.startsWith('here are') &&
                           !lower.startsWith('search queries') &&
                           !lower.startsWith("i'll ") &&
                           !lower.startsWith('i will ') &&
                           !lower.startsWith('let me ') &&
                           !lower.startsWith('sure') &&
                           !lower.startsWith('okay') &&
                           !lower.startsWith('of course') &&
                           !lower.startsWith('certainly') &&
                           !lower.startsWith('to answer') &&
                           !lower.startsWith('based on') &&
                           !lower.startsWith('these are') &&
                           !lower.startsWith('the following') &&
                           !lower.startsWith('i need') &&
                           !lower.startsWith('i should');
                });

            if (queries.length === 0) {
                // Fallback: use the raw user question as a single search query
                console.log('[WebSearch] No queries parsed from LLM response, using user question as fallback');
                queries = [userContent.slice(0, 200)];
            }

            // Limit initial queries to maxSearches
            queries = queries.slice(0, maxSearches);

            // === ITERATIVE SEARCH LOOP ===
            const allResults = [];      // accumulated results from all searches
            const seenUrls = new Set(); // dedup by URL
            let searchCount = 0;

            while (queries.length > 0 && searchCount < maxSearches) {
                const query = queries.shift();
                searchCount++;

                // Show search status for this query
                const searchEl = showSearchRoundStatus(statusContainer, query, searchCount, maxSearches);

                // Perform the search
                const searchResults = await performWebSearch(query);

                if (searchResults && searchResults.results && searchResults.results.length > 0) {
                    // Deduplicate by URL and accumulate
                    for (const result of searchResults.results) {
                        if (result.url && !seenUrls.has(result.url)) {
                            seenUrls.add(result.url);
                            allResults.push({ ...result, query });
                        }
                    }
                    finalizeSearchRoundStatus(searchEl, query, searchResults.results.length);
                } else {
                    // No results for this query
                    failSearchRoundStatus(searchEl, query);
                }

                // === REVIEW STEP (only if we have more searches budget and more queries pending) ===
                if (searchCount < maxSearches && queries.length === 0 && allResults.length > 0) {
                    const reviewEl = showReviewStatus(statusContainer);

                    const reviewContext = allResults.map((r, i) => {
                        return `[${i + 1}] **${r.title}** (${r.source}) [query: "${r.query}"]\n${r.snippet}`;
                    }).join('\n\n');

                    const reviewMessages = [
                        {
                            role: 'system',
                            content: `You are a research assistant reviewing web search results to answer a user's question.

User's question: ${userContent}

Search results collected so far:
${reviewContext}

Do you have enough information to answer the question comprehensively and accurately?

- If YES, respond with exactly: ANSWER
- If NO, respond with one or more lines in the format: SEARCH: <new search query>

Only request more searches if the current results are clearly insufficient. Be efficient — do not search for information you already have. Do not request more than 2 additional searches.`
                        },
                        { role: 'user', content: 'Review the results and decide: ANSWER or SEARCH: <query>' },
                    ];

                    const reviewResponse = await callLLM(reviewMessages, { temperature: 0.2, maxTokens: 200, timeout: 15000 });
                    removeSearchStatus(reviewEl);

                    // Parse review response
                    const trimmed = reviewResponse.trim();
                    if (trimmed.toUpperCase().startsWith('ANSWER')) {
                        // LLM is satisfied — proceed to final answer
                        break;
                    }

                    // Extract SEARCH: queries
                    const newQueries = trimmed
                        .split('\n')
                        .filter(line => line.match(/^SEARCH:\s*/i))
                        .map(line => line.replace(/^SEARCH:\s*/i, '').trim())
                        .filter(q => q.length > 0)
                        .slice(0, 2); // max 2 follow-up queries per review

                    if (newQueries.length === 0) {
                        // Malformed response — treat as ANSWER
                        break;
                    }

                    // Add new queries to the queue (respecting maxSearches)
                    const remainingBudget = maxSearches - searchCount;
                    queries.push(...newQueries.slice(0, remainingBudget));
                }
            }

            // === FINALIZE ===
            removeSearchStatusContainer(statusContainer);

            if (allResults.length === 0) {
                UI.toast('No search results found, answering without web context', 'info');
                startStreaming(messages);
                return;
            }

            if (searchCount >= maxSearches && queries.length > 0) {
                UI.toast(`Max searches (${maxSearches}) reached, answering with available info`, 'info');
            }

            // Build context block from ALL collected results
            const searchContext = allResults.map((r, i) => {
                return `[${i + 1}] **${r.title}** (${r.source})\n${r.snippet}`;
            }).join('\n\n');

            const queriesUsed = [...new Set(allResults.map(r => r.query))];
            const contextBlock = `[Web Search Results — ${allResults.length} results from ${queriesUsed.length} search${queriesUsed.length > 1 ? 'es' : ''}]
Searches performed: ${queriesUsed.join(' | ')}

${searchContext}
[/Web Search Results]

Current date: ${now}

Use the above search results to inform your answer. Cite sources using [number] references where applicable. If the search results are not relevant to a part of the question, answer that part based on your own knowledge. Prioritize the most recent information when relevant.`;

            // Inject search context into the system prompt or as a system message
            const finalMessages = messages.map(m => ({ ...m }));
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
            console.error('[WebSearch] Error:', err);
            removeSearchStatusContainer(statusContainer);
            UI.toast('Web search failed, answering without search', 'error');
            startStreaming(messages);
        }
    }

    // --- Generic Non-Streaming LLM Call ---
    // Reusable helper: sends messages to the LLM via a temporary port, collects
    // the full response, and resolves. Used for planning, review, and follow-up
    // query generation in the iterative search protocol.
    async function callLLM(messages, opts = {}) {
        const temperature = opts.temperature ?? 0.3;
        const maxTokens = opts.maxTokens ?? 100;
        const timeout = opts.timeout ?? 15000;

        return new Promise((resolve) => {
            const port = chrome.runtime.connect({ name: 'ai-stream' });
            let fullContent = '';
            let settled = false;

            const finish = (value) => {
                if (settled) return;
                settled = true;
                try { port.disconnect(); } catch {}
                resolve(value);
            };

            port.onMessage.addListener((msg) => {
                switch (msg.type) {
                    case 'STREAM_CHUNK':
                        fullContent = msg.fullContent;
                        break;
                    case 'STREAM_DONE':
                        finish(fullContent.trim());
                        break;
                    case 'STREAM_ERROR':
                        finish('');
                        break;
                }
            });

            port.onDisconnect.addListener(() => {
                finish(fullContent.trim() || '');
            });

            port.postMessage({
                type: 'SEND_MESSAGE',
                messages,
                options: {
                    provider: $('provider-select').value,
                    model: $('model-select').value,
                    temperature,
                    topP: 1,
                    maxTokens,
                    abortSignal: null,
                },
                settings,
            });

            setTimeout(() => finish(fullContent.trim() || ''), timeout);
        });
    }

    // --- Perform Web Search ---
    // Sends search request to the service worker with a 25s timeout.
    // Resolves with { results, query, provider } on success, or null on failure.
    // Errors are logged and surfaced to the caller (not silently swallowed).
    // 25s allows the fast tier (SearXNG + DDG + Wikipedia in parallel, ~10s)
    // plus a few slow-tier SearXNG attempts before giving up.
    async function performWebSearch(query) {
        return new Promise((resolve) => {
            let settled = false;
            const timeoutId = setTimeout(() => {
                if (!settled) {
                    settled = true;
                    console.error('[WebSearch] Timeout for query:', query);
                    resolve(null);
                }
            }, 25000);

            chrome.runtime.sendMessage({
                type: 'WEB_SEARCH',
                query,
            }, (response) => {
                if (settled) return;
                settled = true;
                clearTimeout(timeoutId);

                if (chrome.runtime.lastError) {
                    console.error('[WebSearch] Runtime error:', chrome.runtime.lastError.message);
                    resolve(null);
                    return;
                }

                if (response?.success) {
                    resolve(response.data);
                } else {
                    console.error('[WebSearch] Error:', response?.error || 'Unknown error');
                    resolve(null);
                }
            });
        });
    }

    // --- Visit Website ---
    // Sends a page visit request to the service worker and resolves with
    // extracted readable text on success, or null on failure.
    async function performVisitWebsite(url) {
        return new Promise((resolve) => {
            let settled = false;
            const timeoutId = setTimeout(() => {
                if (!settled) {
                    settled = true;
                    console.error('[WebSearch] Visit timeout for URL:', url);
                    resolve(null);
                }
            }, 20000);

            chrome.runtime.sendMessage({
                type: 'VISIT_WEBSITE',
                url,
                maxTextLength: 6000,
            }, (response) => {
                if (settled) return;
                settled = true;
                clearTimeout(timeoutId);

                if (chrome.runtime.lastError) {
                    console.error('[WebSearch] Visit runtime error:', chrome.runtime.lastError.message);
                    resolve(null);
                    return;
                }

                if (response?.success) {
                    resolve(response.data);
                } else {
                    console.error('[WebSearch] Visit error:', response?.error || 'Unknown error');
                    resolve(null);
                }
            });
        });
    }

    // --- Search Status UI (Stacked Indicators) ---
    function showSearchStatusContainer() {
        const messagesEl = $('messages');
        const container = document.createElement('div');
        container.className = 'search-status-container';
        messagesEl.appendChild(container);
        UI.scrollToBottom($('chat-container'));
        return container;
    }

    function showPlanningStatus(container) {
        const div = document.createElement('div');
        div.className = 'search-status planning';
        div.innerHTML = `<span class="search-icon">🧠</span> <span>Planning search queries...</span>`;
        container.appendChild(div);
        UI.scrollToBottom($('chat-container'));
        return div;
    }

    function showSearchRoundStatus(container, query, roundNum, maxRounds) {
        const div = document.createElement('div');
        div.className = 'search-status';
        div.innerHTML = `<span class="search-round-badge">${roundNum}/${maxRounds}</span> <span class="search-icon">🔍</span> <span>Searching: <span class="search-query">${UI.escapeHtml(query)}</span></span>`;
        container.appendChild(div);
        UI.scrollToBottom($('chat-container'));
        return div;
    }

    function finalizeSearchRoundStatus(el, query, resultCount) {
        if (el) {
            el.className = 'search-status done';
            el.innerHTML = `<span class="search-round-badge done">✓</span> <span class="search-icon">🌐</span> <span>Found ${resultCount} result${resultCount !== 1 ? 's' : ''}: <span class="search-query">${UI.escapeHtml(query)}</span></span>`;
            UI.scrollToBottom($('chat-container'));
        }
    }

    function failSearchRoundStatus(el, query) {
        if (el) {
            el.className = 'search-status done';
            el.innerHTML = `<span class="search-round-badge failed">✗</span> <span class="search-icon">🔍</span> <span>No results: <span class="search-query">${UI.escapeHtml(query)}</span></span>`;
            UI.scrollToBottom($('chat-container'));
        }
    }

    function showReviewStatus(container) {
        const div = document.createElement('div');
        div.className = 'search-status reviewing';
        div.innerHTML = `<span class="search-icon">📋</span> <span>Reviewing results...</span>`;
        container.appendChild(div);
        UI.scrollToBottom($('chat-container'));
        return div;
    }

    function showVisitStatus(container, url, visitNum, maxVisits) {
        const div = document.createElement('div');
        div.className = 'search-status visiting';
        div.innerHTML = `<span class="search-round-badge">${visitNum}/${maxVisits}</span> <span class="search-icon">-&gt;</span> <span>Visiting: <span class="search-query">${UI.escapeHtml(url)}</span></span>`;
        container.appendChild(div);
        UI.scrollToBottom($('chat-container'));
        return div;
    }

    function finalizeVisitStatus(el, page) {
        if (el) {
            el.className = 'search-status done';
            const title = page?.title || page?.source || 'page';
            el.innerHTML = `<span class="search-round-badge done">OK</span> <span class="search-icon">-&gt;</span> <span>Read: <span class="search-query">${UI.escapeHtml(title)}</span></span>`;
            UI.scrollToBottom($('chat-container'));
        }
    }

    function failVisitStatus(el, url) {
        if (el) {
            el.className = 'search-status done';
            el.innerHTML = `<span class="search-round-badge failed">X</span> <span class="search-icon">-&gt;</span> <span>Could not read: <span class="search-query">${UI.escapeHtml(url)}</span></span>`;
            UI.scrollToBottom($('chat-container'));
        }
    }

    function removeSearchStatus(el) {
        if (el) el.remove();
    }

    function removeSearchStatusContainer(container) {
        if (container) container.remove();
    }

    // --- Web Search Dropdown ---
    function handleWebSearchButtonClick(e) {
        e.stopPropagation();
        if (webSearchMode !== 'off') {
            // Search is active — clicking the button turns it off directly
            setWebSearchMode('off');
        } else {
            // Search is off — open the dropdown menu
            setWebSearchMode('on');
        }
    }

    function handleWebSearchMenuClick(e) {
        const item = e.target.closest('.web-search-dropdown-item');
        if (!item) return;
        e.stopPropagation();
        const { mode } = item.dataset;
        setWebSearchMode(mode);
        hideWebSearchMenu();
    }

    function handleWebSearchOutsideClick(e) {
        const wrapper = document.querySelector('.web-search-wrapper');
        const menu = $('web-search-menu');
        if (menu && menu.style.display !== 'none' && wrapper && !wrapper.contains(e.target)) {
            hideWebSearchMenu();
        }
    }

    function setWebSearchMode(mode) {
        webSearchMode = normalizeWebSearchMode(mode);
        updateWebSearchButton();
        updateWebSearchMenuActive();

        // Persist to settings
        settings.webSearchMode = webSearchMode;
        settings.webSearchEnabled = (webSearchMode !== 'off'); // backward compat
        Storage.saveSettings(settings);
        chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings });

        // Persist to conversation
        if (currentConversationId) {
            Storage.updateConversation(currentConversationId, {
                webSearchMode,
                webSearchEnabled: webSearchMode !== 'off',
            });
        }

        if (webSearchMode === 'off') {
            UI.toast('Web search off', 'info');
        } else {
            UI.toast('Web search on', 'success');
        }
    }

    function toggleWebSearchMenu() {
        const menu = $('web-search-menu');
        if (!menu) return;
        if (menu.style.display === 'none') {
            updateWebSearchMenuActive();
            menu.style.display = 'flex';
        } else {
            menu.style.display = 'none';
        }
    }

    function hideWebSearchMenu() {
        const menu = $('web-search-menu');
        if (menu) menu.style.display = 'none';
    }

    function updateWebSearchButton() {
        const btn = $('web-search-btn');
        if (!btn) return;
        if (webSearchMode !== 'off') {
            btn.classList.add('web-search-active');
            btn.title = 'Web search on - click to turn off';
        } else {
            btn.classList.remove('web-search-active');
            btn.title = 'Toggle web search';
        }
    }

    function updateWebSearchMenuActive() {
        const menu = $('web-search-menu');
        if (!menu) return;
        menu.querySelectorAll('.web-search-dropdown-item').forEach(item => {
            if (item.dataset.mode === webSearchMode) {
                item.classList.add('active');
            } else {
                item.classList.remove('active');
            }
        });
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

        // Restore web search mode from conversation (backward compat: old named modes -> 'on')
        webSearchMode = normalizeWebSearchMode(convo.webSearchMode ?? settings.webSearchMode, convo.webSearchEnabled ?? settings.webSearchEnabled);
        updateWebSearchButton();
        updateWebSearchMenuActive();
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
                const providerLabels = {
                    searxng: 'SearXNG',
                    duckduckgo: 'DuckDuckGo',
                    wikipedia: 'Wikipedia',
                };
                const providerLabel = providerLabels[response.provider] || response.provider || 'search';
                const instance = response.instance ? ` (${response.instance})` : '';
                UI.toast(`Web search connected via ${providerLabel}${instance} — ${response.results} results`, 'success');
            } else {
                btn.textContent = '✗ Failed';
                btn.classList.add('error');
                UI.toast(response?.error || 'Web search connection failed', 'error');
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
