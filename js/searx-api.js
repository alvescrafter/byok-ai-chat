/**
 * BYOK AI Chat - Web Search API Module
 * Handles web search via SearXNG public instances (JSON API).
 * No API key needed. Designed to run in the service worker context.
 *
 * SearXNG is a privacy-focused meta-search engine that aggregates results
 * from Google, Bing, DuckDuckGo, Wikipedia, and more. Public instances
 * handle bot-detection server-side, so we get clean JSON results without
 * CAPTCHAs. The file is named searx-api.js because it was always intended
 * to use SearXNG — the previous DuckDuckGo HTML scraping approach broke
 * when DDG started serving CAPTCHA challenge pages to all automated requests.
 */

const WebSearchAPI = {
    // SearXNG public instances that support JSON output (format=json).
    // These are tried in order — if one fails, the next is attempted.
    // Verified working as of 2026-06-28. Public instances can go offline
    // or start rate-limiting (HTTP 429), so we maintain multiple for redundancy.
    //
    // Primary instances return full search results from active engines (bing,
    // duckduckgo, brave, wikipedia). Fallback instances return valid JSON but
    // may have fewer active engines — they're kept as last-resort failover.
    _instances: [
        // Primary — full results from multiple search engines
        'https://searx.oloke.xyz',
        'https://search.seddens.net',
        'https://etsi.me',
        // Fallback — valid JSON, sparse results (some engines suspended)
        'https://searx.tuxcloud.net',
        'https://searx.party',
        'https://searx.sev.monster',
    ],

    // --- Search ---
    // Queries SearXNG instances and returns formatted results.
    async search(query) {
        if (!query) {
            throw new Error('Query is required');
        }

        const encodedQuery = encodeURIComponent(query);

        for (const baseUrl of this._instances) {
            try {
                const url = `${baseUrl}/search?q=${encodedQuery}&format=json`;

                const response = await fetch(url, {
                    signal: AbortSignal.timeout(12000),
                    // No custom headers — adding Accept: application/json triggers a CORS
                    // preflight (OPTIONS) request, which many SearXNG instances don't
                    // handle properly. The format=json URL parameter already tells
                    // SearXNG to return JSON.
                });

                if (!response.ok) {
                    console.log(`[WebSearch] ${baseUrl} returned HTTP ${response.status}`);
                    continue;
                }

                // Read as text first, then parse as JSON. We can't rely on the
                // content-type header — many SearXNG instances return "text/html"
                // even when serving valid JSON with format=json.
                const text = await response.text();
                let data;
                try {
                    data = JSON.parse(text);
                } catch (parseErr) {
                    console.log(`[WebSearch] ${baseUrl} returned non-JSON response (len=${text.length})`);
                    continue;
                }

                // SearXNG JSON format: { query, results: [...], answers: [...], ... }
                if (data && Array.isArray(data.results) && data.results.length > 0) {
                    const results = this._parseSearXngResults(data.results);
                    if (results.length > 0) {
                        console.log(`[WebSearch] ${baseUrl} returned ${results.length} results`);
                        return { results, query, provider: 'searxng', instance: baseUrl };
                    }
                }

                console.log(`[WebSearch] ${baseUrl} returned 0 parseable results`);
            } catch (err) {
                // Log the full error type and message for diagnostics
                const errType = err.name || 'Error';
                console.log(`[WebSearch] ${baseUrl} failed: [${errType}] ${err.message}`);
            }
        }

        // All instances failed
        console.log('[WebSearch] All SearXNG instances failed');
        return { results: [], query, provider: 'none' };
    },

    // --- Parse SearXNG JSON Results ---
    // Converts SearXNG result objects to our internal format.
    // SearXNG fields: url, title, content (snippet), engine, engines (array)
    _parseSearXngResults(rawResults) {
        const results = [];
        const seenUrls = new Set();

        for (const r of rawResults) {
            if (!r.url || !r.title) continue;
            if (seenUrls.has(r.url)) continue;
            seenUrls.add(r.url);

            // Extract source hostname from URL
            let source = 'Unknown';
            try {
                source = new URL(r.url).hostname.replace(/^www\./, '');
            } catch {}

            // Use the engine field if available, otherwise use source
            const engine = r.engine || (r.engines && r.engines[0]) || source;

            results.push({
                title: this._cleanText(r.title),
                url: r.url,
                snippet: this._cleanText(r.content || ''),
                source,
                engine,
            });

            if (results.length >= 10) break;
        }

        return results;
    },

    // --- Clean text (strip HTML tags, decode entities) ---
    _cleanText(text) {
        if (!text) return '';
        return String(text)
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
    // Tests if any SearXNG instance is reachable and returns parseable JSON results.
    async testConnection() {
        for (const baseUrl of this._instances) {
            try {
                const url = `${baseUrl}/search?q=test&format=json`;
                const response = await fetch(url, {
                    signal: AbortSignal.timeout(10000),
                    // No custom headers — avoid CORS preflight failures.
                    // format=json URL parameter already requests JSON output.
                });

                if (!response.ok) {
                    console.log(`[WebSearch] Test: ${baseUrl} HTTP ${response.status}`);
                    continue;
                }

                // Read as text first, then parse as JSON. Content-type header
                // is unreliable — many SearXNG instances return text/html for JSON.
                const text = await response.text();
                let data;
                try {
                    data = JSON.parse(text);
                } catch (parseErr) {
                    console.log(`[WebSearch] Test: ${baseUrl} returned non-JSON response`);
                    continue;
                }
                if (data && Array.isArray(data.results)) {
                    return { ok: true, instance: baseUrl, results: data.results.length };
                }
            } catch (err) {
                const errType = err.name || 'Error';
                console.log(`[WebSearch] Test: ${baseUrl} failed: [${errType}] ${err.message}`);
            }
        }

        return { ok: false, error: 'All SearXNG instances unreachable' };
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