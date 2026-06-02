/**
 * BYOK AI Chat - Markdown Module
 * Wraps marked.js and highlight.js for rendering markdown in chat messages.
 * Libraries are loaded from bundled local files (lib/).
 * Compatible with marked v15+ (new renderer API).
 */

const Markdown = (() => {
    let configured = false;

    function configure() {
        if (configured) return;
        if (typeof marked === 'undefined') {
            console.warn('Markdown: marked.js not loaded');
            return;
        }

        // Custom renderer for code blocks with copy button
        const renderer = {
            code({ text, lang }) {
                const codeText = text || '';
                const language = lang || '';
                const langLabel = language || 'code';
                const highlighted = (typeof hljs !== 'undefined' && language && hljs.getLanguage(language))
                    ? hljs.highlight(codeText, { language }).value
                    : (typeof hljs !== 'undefined' ? hljs.highlightAuto(codeText).value : escapeHtml(codeText));

                return `<div class="code-block">
                    <div class="code-header">
                        <span class="code-lang">${langLabel}</span>
                        <button class="code-copy-btn" title="Copy code">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                        </button>
                    </div>
                    <pre><code class="hljs ${language ? `language-${language}` : ''}">${highlighted}</code></pre>
                </div>`;
            },
            link({ href, title, text }) {
                const linkHref = href || '';
                const linkTitle = title || '';
                const linkText = text || '';
                return `<a href="${linkHref}" target="_blank" rel="noopener noreferrer" ${linkTitle ? `title="${linkTitle}"` : ''}>${linkText}</a>`;
            },
        };

        // Configure marked v15+
        marked.use({
            breaks: true,
            gfm: true,
            renderer,
        });

        configured = true;
    }

    function render(text) {
        configure();
        if (typeof marked === 'undefined') {
            return escapeHtml(text).replace(/\n/g, '<br>');
        }
        try {
            return marked.parse(text);
        } catch (e) {
            return escapeHtml(text).replace(/\n/g, '<br>');
        }
    }

    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    // Attach copy handlers via event delegation
    function initCopyHandlers(container) {
        container.addEventListener('click', (e) => {
            const btn = e.target.closest('.code-copy-btn');
            if (!btn) return;

            const codeBlock = btn.closest('.code-block');
            const code = codeBlock?.querySelector('code');
            if (!code) return;

            navigator.clipboard.writeText(code.textContent).then(() => {
                btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>`;
                btn.classList.add('copied');
                setTimeout(() => {
                    btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
                    btn.classList.remove('copied');
                }, 2000);
            });
        });
    }

    return {
        render,
        configure,
        initCopyHandlers,
        escapeHtml,
    };
})();