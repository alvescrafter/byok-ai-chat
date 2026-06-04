/**
 * BYOK AI Chat - Web Search API Module
 * Handles web search via DuckDuckGo HTML scraping.
 * No API key needed. Designed to run in the service worker context.
 */

const WebSearchAPI = {
    // --- Search ---
    // Searches DuckDuckGo and returns formatted results.
    async search(query) {
        if (!query) {
            throw new Error('Query is required');
        }

        // Try DuckDuckGo HTML endpoints
        const urls = [
            `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
            `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`,
        ];

        for (const url of urls) {
            try {
                const response = await fetch(url, {
                    signal: AbortSignal.timeout(12000),
                    headers: {
                        'Accept': 'text/html,application/xhtml+xml',
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
                    },
                });

                if (!response.ok) {
                    console.log(`[WebSearch] DDG ${url} returned HTTP ${response.status}`);
                    continue;
                }

                const html = await response.text();

                // Skip if it's a challenge/captcha page
                if (html.includes('challenge-form') || html.includes('anomaly-modal')) {
                    console.log(`[WebSearch] DDG ${url} returned challenge page, skipping`);
                    continue;
                }

                const result = this._parseDuckDuckGoHtml(html, query);
                if (result.results.length > 0) {
                    result.provider = 'duckduckgo';
                    return result;
                }
            } catch (err) {
                console.log(`[WebSearch] DDG ${url} failed: ${err.message}`);
            }
        }

        // Try via CORS proxy as last resort
        try {
            const proxyUrl = 'https://corsproxy.io/?' + encodeURIComponent(urls[0]);
            const proxyResponse = await fetch(proxyUrl, {
                signal: AbortSignal.timeout(12000),
                headers: { 'Accept': 'text/html' },
            });

            if (!proxyResponse.ok) {
                throw new Error(`DuckDuckGo proxy HTTP ${proxyResponse.status}`);
            }

            const html = await proxyResponse.text();
            if (!html.includes('challenge-form') && !html.includes('anomaly-modal')) {
                const result = this._parseDuckDuckGoHtml(html, query);
                if (result.results.length > 0) {
                    result.provider = 'duckduckgo';
                    return result;
                }
            }
        } catch (proxyErr) {
            console.log(`[WebSearch] DDG CORS proxy failed: ${proxyErr.message}`);
        }

        // Everything failed
        return { results: [], query, provider: 'none' };
    },

    // --- Parse DuckDuckGo HTML Results ---
    // Handles both html.duckduckgo.com (result__a, result__snippet, result__url__domain)
    // and lite.duckduckgo.com (result-link, result-snippet) formats.
    _parseDuckDuckGoHtml(html, query) {
        const results = [];

        // Try html.duckduckgo.com format first (class="result__a")
        if (html.includes('result__a')) {
            const resultRegex = /class="result__body"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/gi;
            let match;

            while ((match = resultRegex.exec(html)) !== null && results.length < 8) {
                const block = match[1];

                const titleMatch = block.match(/class="result__a"[^>]*>([\s\S]*?)<\/a>/i);
                const title = titleMatch ? this._decodeHtml(titleMatch[1].trim()) : '';

                const urlMatch = block.match(/class="result__a"[^>]*href="([^"]+)"/i);
                let url = urlMatch ? urlMatch[1] : '';

                if (url.includes('uddg=')) {
                    try { const uddg = url.match(/uddg=([^&]+)/); if (uddg) url = decodeURIComponent(uddg[1]); } catch {}
                } else if (url.startsWith('//')) {
                    url = 'https:' + url;
                } else if (url.startsWith('/')) {
                    continue;
                }

                const snippetMatch = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i);
                const snippet = snippetMatch ? this._decodeHtml(snippetMatch[1].trim()) : '';

                const sourceMatch = block.match(/class="result__url__domain"[^>]*>([\s\S]*?)<\/(?:a|span)>/i);
                let source = 'Unknown';
                if (sourceMatch) { source = this._decodeHtml(sourceMatch[1].trim()); }
                else { try { source = new URL(url).hostname.replace(/^www\./, ''); } catch {} }

                if (title && url && !url.startsWith('/')) {
                    results.push({ title, url, snippet, source, engine: 'duckduckgo' });
                }
            }

            // Simpler fallback regex for html version
            if (results.length === 0) {
                const simpleRegex = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
                let simpleMatch;
                while ((simpleMatch = simpleRegex.exec(html)) !== null && results.length < 8) {
                    let url = simpleMatch[1];
                    const title = this._decodeHtml(simpleMatch[2].trim());
                    if (url.includes('uddg=')) {
                        try { const uddg = url.match(/uddg=([^&]+)/); if (uddg) url = decodeURIComponent(uddg[1]); } catch {}
                    }
                    if (url.startsWith('/')) continue;
                    let source = 'Unknown';
                    try { source = new URL(url).hostname.replace(/^www\./, ''); } catch {}
                    if (title && url) { results.push({ title, url, snippet: '', source, engine: 'duckduckgo' }); }
                }
            }
        }

        // Try lite.duckduckgo.com format (class='result-link', class='result-snippet')
        if (results.length === 0 && html.includes('result-link')) {
            const linkRegex = /class='result-link'[^>]*href='([^']+)'[^>]*>([\s\S]*?)<\/a>/gi;
            let linkMatch;

            while ((linkMatch = linkRegex.exec(html)) !== null && results.length < 8) {
                let url = linkMatch[1];
                const title = this._decodeHtml(linkMatch[2].trim());

                if (url.includes('uddg=')) {
                    try { const uddg = url.match(/uddg=([^&]+)/); if (uddg) url = decodeURIComponent(uddg[1]); } catch {}
                } else if (url.startsWith('//')) {
                    url = 'https:' + url;
                } else if (url.startsWith('/')) {
                    continue;
                }

                let source = 'Unknown';
                try { source = new URL(url).hostname.replace(/^www\./, ''); } catch {}

                const snippetBaseIdx = linkMatch.index;
                const afterSnippet = html.substring(snippetBaseIdx, snippetBaseIdx + 2000);
                const snippetMatch = afterSnippet.match(/class='result-snippet'[^>]*>([\s\S]*?)<\/a>/i);
                const snippet = snippetMatch ? this._decodeHtml(snippetMatch[1].trim()) : '';

                if (title && url) {
                    results.push({ title, url, snippet, source, engine: 'duckduckgo' });
                }
            }
        }

        return { results, query };
    },

    // --- Decode HTML entities ---
    _decodeHtml(text) {
        return text
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/&#x27;/g, "'")
            .replace(/<[^>]+>/g, '')
            .trim();
    },

    // --- Test Connection ---
    // Tests if DuckDuckGo search is reachable.
    async testConnection() {
        try {
            const url = 'https://html.duckduckgo.com/html/?q=test';
            const response = await fetch(url, {
                signal: AbortSignal.timeout(10000),
                headers: {
                    'Accept': 'text/html',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
                },
            });

            if (response.ok) {
                const html = await response.text();
                if (!html.includes('challenge-form') && !html.includes('anomaly-modal')) {
                    return { ok: true };
                }
                return { ok: false, error: 'DuckDuckGo returned a challenge page' };
            }

            return { ok: false, error: `HTTP ${response.status}` };
        } catch (err) {
            return { ok: false, error: err.message };
        }
    },

    // --- Build search context for LLM ---
    // Formats search results into a text block that can be injected into the LLM prompt.
    buildSearchContext(searchData) {
        if (!searchData || !searchData.results || searchData.results.length === 0) {
            return 'No web search results were found for this query.';
        }

        const lines = searchData.results.map((r, i) => {
            const title = r.title || 'Untitled';
            const snippet = r.snippet || '';
            const source = r.source || 'Unknown';
            return `[${i + 1}] **${title}** (${source})\n${snippet}`;
        });

        return lines.join('\n\n');
    },
};