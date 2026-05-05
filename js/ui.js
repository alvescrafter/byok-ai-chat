/**
 * BYOK AI Chat - UI Module
 * DOM helpers, toast notifications, modal management, message rendering.
 */

const UI = (() => {
    // --- Toast Notifications ---
    function toast(message, type = 'info', duration = 3000) {
        const container = document.getElementById('toast-container') || createToastContainer();
        const el = document.createElement('div');
        el.className = `toast toast-${type}`;
        el.textContent = message;
        container.appendChild(el);

        requestAnimationFrame(() => el.classList.add('show'));

        setTimeout(() => {
            el.classList.remove('show');
            setTimeout(() => el.remove(), 300);
        }, duration);
    }

    function createToastContainer() {
        const container = document.createElement('div');
        container.id = 'toast-container';
        document.body.appendChild(container);
        return container;
    }

    // --- Modal Management ---
    function openModal(id) {
        const modal = document.getElementById(id);
        if (modal) {
            modal.classList.add('active');
            modal.setAttribute('aria-hidden', 'false');
        }
    }

    function closeModal(id) {
        const modal = document.getElementById(id);
        if (modal) {
            modal.classList.remove('active');
            modal.setAttribute('aria-hidden', 'true');
        }
    }

    function closeAllModals() {
        document.querySelectorAll('.modal.active').forEach(m => {
            m.classList.remove('active');
            m.setAttribute('aria-hidden', 'true');
        });
    }

    // --- Message Rendering ---
    function renderMessage(msg, isStreaming = false) {
        const div = document.createElement('div');
        div.className = `message message-${msg.role}`;
        div.dataset.messageId = msg.id;

        const avatar = document.createElement('div');
        avatar.className = 'message-avatar';
        avatar.textContent = msg.role === 'user' ? '👤' : msg.role === 'assistant' ? '🤖' : '⚙️';

        const content = document.createElement('div');
        content.className = 'message-content';

        if (msg.role === 'error') {
            content.classList.add('message-error');
            content.textContent = msg.content;
        } else if (msg.role === 'user') {
            // User messages: render as plain text with line breaks
            content.innerHTML = escapeHtml(msg.content).replace(/\n/g, '<br>');
            // Render file attachments
            if (msg.files?.length) {
                const filesDiv = document.createElement('div');
                filesDiv.className = 'message-files';
                for (const file of msg.files) {
                    if (file.type?.startsWith('image/')) {
                        const img = document.createElement('img');
                        img.src = file.data;
                        img.className = 'message-image';
                        img.alt = file.name;
                        filesDiv.appendChild(img);
                    } else {
                        const chip = document.createElement('span');
                        chip.className = 'file-chip';
                        chip.textContent = `📎 ${file.name}`;
                        filesDiv.appendChild(chip);
                    }
                }
                content.appendChild(filesDiv);
            }
        } else {
            // Assistant messages: render markdown
            content.innerHTML = Markdown.render(msg.content || '');
        }

        const actions = document.createElement('div');
        actions.className = 'message-actions';

        if (msg.role === 'assistant' && !isStreaming) {
            actions.innerHTML = `
                <button class="btn btn-ghost btn-sm copy-btn" title="Copy response">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                </button>
                <button class="btn btn-ghost btn-sm regen-btn" title="Regenerate">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
                </button>
            `;
        } else if (msg.role === 'user' && !isStreaming) {
            actions.innerHTML = `
                <button class="btn btn-ghost btn-sm edit-btn" title="Edit message">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
                </button>
                <button class="btn btn-ghost btn-sm copy-btn" title="Copy message">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                </button>
            `;
        }

        div.appendChild(avatar);
        div.appendChild(content);
        div.appendChild(actions);

        return div;
    }

    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    // --- Scroll Management ---
    function scrollToBottom(container) {
        if (!container) return;
        container.scrollTop = container.scrollHeight;
    }

    function isScrolledToBottom(container, threshold = 100) {
        if (!container) return true;
        return container.scrollHeight - container.scrollTop - container.clientHeight < threshold;
    }

    // --- Conversation List Rendering ---
    function renderConversationList(conversations, activeId, container) {
        if (!container) return;
        container.innerHTML = '';

        if (conversations.length === 0) {
            container.innerHTML = '<div class="empty-list">No conversations yet</div>';
            return;
        }

        for (const convo of conversations) {
            const item = document.createElement('div');
            item.className = `conversation-item ${convo.id === activeId ? 'active' : ''}`;
            item.dataset.conversationId = convo.id;

            const title = document.createElement('span');
            title.className = 'conversation-title';
            title.textContent = convo.title || 'New Chat';

            const delBtn = document.createElement('button');
            delBtn.className = 'btn btn-ghost btn-sm conversation-delete';
            delBtn.title = 'Delete conversation';
            delBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`;

            item.appendChild(title);
            item.appendChild(delBtn);
            container.appendChild(item);
        }
    }

    // --- Provider/Model Dropdowns ---
    function populateProviderSelect(select, settings) {
        if (!select) return;
        const providers = [
            { id: 'openai', name: 'OpenAI' },
            { id: 'anthropic', name: 'Anthropic' },
            { id: 'google', name: 'Google Gemini' },
            { id: 'ollama', name: 'Ollama (Local)' },
            { id: 'lmstudio', name: 'LM Studio (Local)' },
            { id: 'custom', name: 'Custom API' },
        ];

        select.innerHTML = '';
        for (const p of providers) {
            const opt = document.createElement('option');
            opt.value = p.id;
            opt.textContent = p.name;
            select.appendChild(opt);
        }

        if (settings.defaultProvider) {
            select.value = settings.defaultProvider;
        }
    }

    function populateModelSelect(select, providerName, models) {
        if (!select) return;
        select.innerHTML = '';

        if (models.length === 0) {
            const opt = document.createElement('option');
            opt.value = '';
            opt.textContent = 'No models available';
            select.appendChild(opt);
            return;
        }

        for (const m of models) {
            const opt = document.createElement('option');
            opt.value = m.id;
            opt.textContent = m.name;
            select.appendChild(opt);
        }
    }

    // --- Loading Indicator ---
    function showLoading(container) {
        const loader = document.createElement('div');
        loader.className = 'loading-indicator';
        loader.id = 'loading-indicator';
        loader.innerHTML = '<div class="loading-dots"><span></span><span></span><span></span></div>';
        container?.appendChild(loader);
    }

    function hideLoading() {
        document.getElementById('loading-indicator')?.remove();
    }

    // --- Streaming text indicator ---
    function showStreamingCursor(element) {
        const cursor = document.createElement('span');
        cursor.className = 'streaming-cursor';
        cursor.id = 'streaming-cursor';
        cursor.textContent = '▊';
        element?.appendChild(cursor);
    }

    function hideStreamingCursor() {
        document.getElementById('streaming-cursor')?.remove();
    }

    return {
        toast,
        openModal,
        closeModal,
        closeAllModals,
        renderMessage,
        scrollToBottom,
        isScrolledToBottom,
        renderConversationList,
        populateProviderSelect,
        populateModelSelect,
        showLoading,
        hideLoading,
        showStreamingCursor,
        hideStreamingCursor,
        escapeHtml,
    };
})();