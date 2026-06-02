/**
 * BYOK AI Chat - Background Service Worker
 * Handles API calls (avoids CORS), screenshots, page context extraction,
 * context menu, and message routing between side panel and content scripts.
 */

// Import API module via importScripts (service worker context)
importScripts('js/api.js');

// --- Side Panel Setup ---
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);

// --- Context Menu ---
chrome.runtime.onInstalled.addListener(() => {
    chrome.contextMenus.create({
        id: 'send-to-ai-chat',
        title: 'Send to BYOK AI Chat',
        contexts: ['selection'],
    });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === 'send-to-ai-chat' && info.selectionText) {
        // Open side panel and send selected text
        chrome.sidePanel.open({ windowId: tab.windowId }).then(() => {
            // Small delay to let panel load
            setTimeout(() => {
                chrome.runtime.sendMessage({
                    type: 'CONTEXT_MENU_TEXT',
                    text: info.selectionText,
                    sourceUrl: tab.url,
                    sourceTitle: tab.title,
                }).catch(() => { /* panel may not be ready */ });
            }, 500);
        });
    }
});

// --- Message Handler ---
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message.type) {
        case 'CAPTURE_SCREENSHOT':
            handleCaptureScreenshot(sender, sendResponse);
            return true; // async

        case 'GET_PAGE_CONTENT':
            handleGetPageContent(message, sender, sendResponse);
            return true; // async

        case 'LIST_MODELS':
            handleListModels(message, sendResponse);
            return true; // async

        case 'GENERATE_TITLE':
            handleGenerateTitle(message, sendResponse);
            return true; // async

        case 'TEST_CONNECTION':
            handleTestConnection(message, sendResponse);
            return true; // async

        case 'GET_SETTINGS':
            handleGetSettings(sendResponse);
            return true; // async

        case 'SAVE_SETTINGS':
            handleSaveSettings(message, sendResponse);
            return true; // async

        default:
            return false;
    }
});

// --- Port-based Streaming Handler ---
// The side panel opens a port via chrome.runtime.connect() for streaming.
// This is the ONLY reliable way to stream from service worker → side panel.
chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== 'ai-stream') return;

    port.onMessage.addListener(async (message) => {
        if (message.type !== 'SEND_MESSAGE') return;

        const { messages, options, settings } = message;

        try {
            const stream = API.sendMessage(messages, options, settings);
            let fullContent = '';

            for await (const chunk of stream) {
                fullContent += chunk;
                // Send streaming chunks back through the port
                try {
                    port.postMessage({
                        type: 'STREAM_CHUNK',
                        content: chunk,
                        fullContent,
                        provider: options.provider,
                        model: options.model,
                    });
                } catch (e) {
                    // Port disconnected — panel was closed
                    break;
                }
            }

            // Send completion signal
            try {
                port.postMessage({
                    type: 'STREAM_DONE',
                    content: fullContent,
                    provider: options.provider,
                    model: options.model,
                });
            } catch (e) { /* port closed */ }
        } catch (error) {
            try {
                port.postMessage({
                    type: 'STREAM_ERROR',
                    error: error.message,
                    provider: options.provider,
                    model: options.model,
                });
            } catch (e) { /* port closed */ }
        }
    });

    // Clean up when port disconnects
    port.onDisconnect.addListener(() => {
        // Could abort any in-flight request here if needed
    });
});

// --- Handler: Capture Screenshot ---
async function handleCaptureScreenshot(sender, sendResponse) {
    try {
        // Get the active tab in the current window
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (!tab) {
            sendResponse({ success: false, error: 'No active tab found' });
            return;
        }

        const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
            format: 'png',
            quality: 90,
        });

        sendResponse({ success: true, dataUrl, tabTitle: tab.title, tabUrl: tab.url });
    } catch (error) {
        sendResponse({ success: false, error: error.message });
    }
}

// --- Handler: Get Page Content ---
async function handleGetPageContent(message, sender, sendResponse) {
    try {
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (!tab) {
            sendResponse({ success: false, error: 'No active tab found' });
            return;
        }

        const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: extractPageContent,
            args: [message.maxTextLength || 4000],
        });

        const pageContext = results?.[0]?.result || null;
        sendResponse({ success: true, context: pageContext, tabTitle: tab.title, tabUrl: tab.url });
    } catch (error) {
        sendResponse({ success: false, error: error.message });
    }
}

// Function that runs in the page context
function extractPageContent(maxTextLength) {
    const article = document.querySelector('article') || document.querySelector('main') || document.querySelector('[role="main"]');
    let text = '';

    if (article) {
        text = article.innerText || article.textContent || '';
    }
    if (text.length < 200) {
        text = document.body?.innerText || document.body?.textContent || '';
    }

    text = text.replace(/\s+/g, ' ').trim();
    if (text.length > maxTextLength) {
        text = text.substring(0, maxTextLength) + '... [truncated]';
    }

    const selection = window.getSelection();
    const selectedText = selection ? selection.toString().trim() : '';

    const meta = document.querySelector('meta[name="description"]');

    return {
        title: document.title || '',
        url: window.location.href || '',
        selectedText,
        pageText: text,
        metaDescription: meta?.content || '',
        language: document.documentElement.lang || '',
    };
}

// --- Handler: List Models ---
async function handleListModels(message, sendResponse) {
    try {
        const { provider, settings } = message;
        const adapter = API.getProvider(provider);

        if (adapter?.listModels) {
            const models = await adapter.listModels(settings);
            sendResponse({ success: true, models });
        } else {
            const models = API.getModelsForProvider(provider);
            sendResponse({ success: true, models });
        }
    } catch (error) {
        sendResponse({ success: false, error: error.message, models: API.getModelsForProvider(message.provider) });
    }
}

// --- Handler: Generate Title ---
async function handleGenerateTitle(message, sendResponse) {
    try {
        const { messages, provider, model, settings } = message;
        const title = await API.generateTitle(messages, provider, model, settings);
        sendResponse({ success: true, title });
    } catch (error) {
        sendResponse({ success: false, title: 'New Chat' });
    }
}

// --- Handler: Test Connection ---
async function handleTestConnection(message, sendResponse) {
    try {
        const { provider, settings } = message;
        const result = await API.testConnection(provider, settings);
        sendResponse(result);
    } catch (error) {
        sendResponse({ success: false, error: error.message });
    }
}

// --- Handler: Get Settings ---
async function handleGetSettings(sendResponse) {
    try {
        const result = await chrome.storage.local.get('aichat_settings');
        const settings = result.aichat_settings || getDefaultSettings();
        sendResponse({ success: true, settings });
    } catch (error) {
        sendResponse({ success: false, error: error.message, settings: getDefaultSettings() });
    }
}

// --- Handler: Save Settings ---
async function handleSaveSettings(message, sendResponse) {
    try {
        await chrome.storage.local.set({ aichat_settings: message.settings });
        sendResponse({ success: true });
    } catch (error) {
        sendResponse({ success: false, error: error.message });
    }
}

// --- Default Settings ---
function getDefaultSettings() {
    return {
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
    };
}


