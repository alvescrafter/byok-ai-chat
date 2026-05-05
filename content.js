/**
 * BYOK AI Chat - Content Script
 * Extracts page context (title, URL, selected text, page text) for the AI chat.
 * Runs on all pages. Communicates with side panel via chrome.runtime messaging.
 */

(function() {
    'use strict';

    // Listen for messages from the side panel or service worker
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.type === 'GET_PAGE_CONTEXT') {
            const context = extractPageContext(message.options || {});
            sendResponse(context);
            return true; // Keep channel open for async
        }

        if (message.type === 'GET_SELECTED_TEXT') {
            sendResponse({ selectedText: getSelectedText() });
            return true;
        }
    });

    function extractPageContext(options = {}) {
        const maxTextLength = options.maxTextLength || 4000;

        return {
            title: document.title || '',
            url: window.location.href || '',
            selectedText: getSelectedText(),
            pageText: getPageText(maxTextLength),
            metaDescription: getMetaDescription(),
            language: document.documentElement.lang || '',
        };
    }

    function getSelectedText() {
        const selection = window.getSelection();
        return selection ? selection.toString().trim() : '';
    }

    function getPageText(maxLength) {
        // Try to get clean text from the main content area first
        const article = document.querySelector('article') || document.querySelector('main') || document.querySelector('[role="main"]');
        let text = '';

        if (article) {
            text = article.innerText || article.textContent || '';
        }

        // Fallback to body if article text is too short
        if (text.length < 200) {
            text = document.body?.innerText || document.body?.textContent || '';
        }

        // Clean up whitespace
        text = text.replace(/\s+/g, ' ').trim();

        // Truncate if needed
        if (text.length > maxLength) {
            text = text.substring(0, maxLength) + '... [truncated]';
        }

        return text;
    }

    function getMetaDescription() {
        const meta = document.querySelector('meta[name="description"]');
        return meta?.content || '';
    }
})();