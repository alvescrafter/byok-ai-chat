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

        case 'GET_YOUTUBE_TRANSCRIPT':
            handleGetYoutubeTranscript(sendResponse);
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

// --- Handler: Get YouTube Transcript ---
async function handleGetYoutubeTranscript(sendResponse) {
    try {
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (!tab) {
            sendResponse({ success: false, error: 'No active tab found' });
            return;
        }

        const videoId = extractVideoId(tab.url);
        if (!videoId) {
            sendResponse({ success: false, error: 'Not a YouTube video page' });
            return;
        }

        // Fetch the YouTube watch page HTML
        const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
        const response = await fetch(watchUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept-Language': 'en-US,en;q=0.9',
            },
        });

        if (!response.ok) {
            sendResponse({ success: false, error: `Failed to fetch YouTube page (${response.status})` });
            return;
        }

        const html = await response.text();

        // Extract ytInitialPlayerResponse from the page HTML
        const playerResponse = extractPlayerResponse(html);
        if (!playerResponse) {
            sendResponse({ success: false, error: 'Could not parse YouTube page data' });
            return;
        }

        // Get caption tracks
        const captionTracks = extractCaptionTracks(playerResponse);
        if (!captionTracks || captionTracks.length === 0) {
            sendResponse({ success: false, error: 'No captions available for this video' });
            return;
        }

        // Prefer English captions, fall back to first available
        let track = captionTracks.find(t => t.languageCode?.startsWith('en')) || captionTracks[0];

        // Fetch the caption XML
        const captionUrl = track.baseUrl + '&fmt=srv3';
        const captionResponse = await fetch(captionUrl);
        if (!captionResponse.ok) {
            sendResponse({ success: false, error: 'Failed to fetch captions' });
            return;
        }

        const captionXml = await captionResponse.text();
        const transcript = parseCaptionXml(captionXml);

        if (!transcript || transcript.trim().length === 0) {
            sendResponse({ success: false, error: 'Transcript is empty' });
            return;
        }

        // Truncate if too long (same limit as page context)
        const maxLen = 8000;
        const finalTranscript = transcript.length > maxLen
            ? transcript.substring(0, maxLen) + '... [truncated]'
            : transcript;

        // Extract video title from the page
        const titleMatch = html.match(/<title>(.*?)<\/title>/);
        const videoTitle = titleMatch ? titleMatch[1].replace(' - YouTube', '') : `YouTube Video ${videoId}`;

        sendResponse({
            success: true,
            transcript: finalTranscript,
            title: videoTitle,
            videoId,
            url: watchUrl,
            language: track.languageCode || track.name?.simpleText || 'unknown',
        });
    } catch (error) {
        sendResponse({ success: false, error: error.message });
    }
}

// --- YouTube Helper: Extract Video ID ---
function extractVideoId(url) {
    if (!url) return null;
    // Match standard watch URLs, shorts, embeds, and various YouTube domains
    const patterns = [
        /(?:youtube\.com\/watch\?.*v=|youtu\.be\/|youtube\.com\/shorts\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
        /youtube\.com\/watch\?.*v=([a-zA-Z0-9_-]{11})/,
    ];
    for (const pattern of patterns) {
        const match = url.match(pattern);
        if (match) return match[1];
    }
    return null;
}

// --- YouTube Helper: Extract Player Response from HTML ---
function extractPlayerResponse(html) {
    // Try to find ytInitialPlayerResponse in the page scripts
    const patterns = [
        /var\s+ytInitialPlayerResponse\s*=\s*(\{.+?\});/s,
        /ytInitialPlayerResponse\s*=\s*(\{.+?\});/s,
        /"playerCaptionsTracklistRenderer"/,
    ];

    for (let i = 0; i < patterns.length - 1; i++) {
        const match = html.match(patterns[i]);
        if (match) {
            try {
                return JSON.parse(match[1]);
            } catch (e) {
                // JSON parse failed, try next pattern
                continue;
            }
        }
    }

    // Fallback: try to find captions data in ytInitialData
    const dataMatch = html.match(/var\s+ytInitialData\s*=\s*(\{.+?\});/s);
    if (dataMatch) {
        try {
            const data = JSON.parse(dataMatch[1]);
            // Navigate through ytInitialData to find player response
            const contents = data?.contents?.twoColumnWatchNextResults;
            if (contents) {
                // This path may vary; try to extract what we can
            }
        } catch (e) { /* ignore */ }
    }

    return null;
}

// --- YouTube Helper: Extract Caption Tracks from Player Response ---
function extractCaptionTracks(playerResponse) {
    try {
        const captionTracks =
            playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks ||
            playerResponse?.playerCaptionsTracklistRenderer?.captionTracks ||
            [];

        return captionTracks.map(track => ({
            baseUrl: track.baseUrl,
            languageCode: track.languageCode || '',
            name: track.name,
            kind: track.kind || '', // 'asr' = auto-generated
        }));
    } catch (e) {
        return [];
    }
}

// --- YouTube Helper: Parse Caption XML ---
function parseCaptionXml(xml) {
    try {
        // YouTube caption XML uses <text start="..." dur="...">content</text>
        const textRegex = /<text[^>]*>([\s\S]*?)<\/text>/g;
        const segments = [];
        let match;

        while ((match = textRegex.exec(xml)) !== null) {
            let text = match[1];
            // Decode HTML entities
            text = text
                .replace(/&amp;/g, '&')
                .replace(/&lt;/g, '<')
                .replace(/&gt;/g, '>')
                .replace(/&quot;/g, '"')
                .replace(/&#39;/g, "'")
                .replace(/&apos;/g, "'")
                .replace(/&nbsp;/g, ' ')
                // Remove nested HTML tags (e.g. <font> styling)
                .replace(/<[^>]+>/g, '');
            // Collapse whitespace
            text = text.replace(/\s+/g, ' ').trim();
            if (text) {
                segments.push(text);
            }
        }

        return segments.join(' ');
    } catch (e) {
        return '';
    }
}