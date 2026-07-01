/**
 * BYOK AI Chat - Web Search API Module
 * Handles web search via SearXNG public instances and readable page visits.
 * Designed to run in the background service worker.
 */

const WebSearchAPI = {
    // Public SearXNG instances are volatile. Prefer live discovery from
    // searx.space, then fall back to a curated list if discovery fails.
    _instances: [
        'https://searxng.cups.moe',
        'https://searxng.canine.tools',
        'https://searxng.gr',
        'https://searx.perennialte.ch',
        'https://search.inetol.net',
        'https://searx.tiekoetter.com',
        'https://searx.be',
        'https://northboot.xyz',
        'https://searx.oloke.xyz',
        'https://search.seddens.net',
        'https://etsi.me',
        'https://searx.tuxcloud.net',
        'https://searx.party',
        'https://searx.sev.monster',
    ],
    _discoveredInstances: null,
    _discoveryExpiresAt: 0,
    _lastWorkingInstance: '',
    _discoveryInFlight: null,

    async search(query) {
        if (!query) {
            throw new Error('Query is required');
        }

        const candidates = this._getCandidateInstances();

        // Fast tier: try the first few SearXNG instances + DuckDuckGo + Wikipedia
        // in parallel. This ensures fallback providers are reached quickly even
        // when all SearXNG instances are rate-limited or down (the common case).
        const fastBatch = candidates.slice(0, 4);
        const fastPromises = [
            ...fastBatch.map(baseUrl => this._searchInstance(baseUrl, query)),
            this._searchDuckDuckGo(query),
            this._searchWikipedia(query),
        ];
        const fastResults = await Promise.all(fastPromises);
        for (const result of fastResults) {
            if (result && result.results.length > 0) return result;
        }

        console.log('[WebSearch] Fast tier exhausted; trying remaining SearXNG instances');

        // Slow tier: remaining curated SearXNG instances, sequentially
        const remaining = candidates.slice(4);
        for (const baseUrl of remaining) {
            const result = await this._searchInstance(baseUrl, query);
            if (result) return result;
        }

        // Last resort: refresh discovered instances and try new ones
        const discovered = await this._refreshDiscoveredInstances();
        const known = new Set(candidates);
        const newCandidates = this._dedupeInstances(discovered || []).filter(url => !known.has(url));
        for (const baseUrl of newCandidates) {
            const result = await this._searchInstance(baseUrl, query);
            if (result) return result;
        }

        console.log('[WebSearch] All search providers failed');
        return { results: [], query, provider: 'none' };
    },

    async _searchDuckDuckGo(query) {
        try {
            const params = new URLSearchParams({
                q: query,
            });
            const url = `https://html.duckduckgo.com/html/?${params.toString()}`;
            const response = await fetch(url, {
                headers: {
                    'Accept': 'text/html,application/xhtml+xml,text/plain;q=0.8,*/*;q=0.5',
                    'Accept-Language': 'en-US,en;q=0.9',
                },
                signal: AbortSignal.timeout(10000),
            });

            if (!response.ok) {
                console.log(`[WebSearch] DuckDuckGo returned HTTP ${response.status}`);
                return null;
            }

            const text = await response.text();
            const results = this._parseDuckDuckGoHtmlResults(text);

            if (results.length === 0) {
                console.log('[WebSearch] DuckDuckGo returned 0 parseable results');
                return null;
            }

            console.log(`[WebSearch] DuckDuckGo returned ${results.length} results`);
            return { results, query, provider: 'duckduckgo', instance: 'html.duckduckgo.com' };
        } catch (err) {
            const errType = err.name || 'Error';
            console.log(`[WebSearch] DuckDuckGo failed: [${errType}] ${err.message}`);
            return null;
        }
    },

    _parseDuckDuckGoHtmlResults(html) {
        const results = [];
        const seenUrls = new Set();
        const blocks = String(html).split(/<div class="result results_links/i).slice(1);

        for (const block of blocks) {
            if (results.length >= 10) break;

            const linkMatch = block.match(/<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
            if (!linkMatch) continue;

            const url = this._decodeDuckDuckGoResultUrl(linkMatch[1]);
            const normalizedUrl = this._normalizeVisitUrl(url);
            if (!normalizedUrl || seenUrls.has(normalizedUrl)) continue;

            const snippetMatch = block.match(/<(?:a|div)[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div)>/i);
            seenUrls.add(normalizedUrl);
            results.push({
                title: this._cleanText(linkMatch[2]),
                url: normalizedUrl,
                snippet: snippetMatch ? this._cleanText(snippetMatch[1]) : '',
                source: this._sourceFromUrl(normalizedUrl),
                engine: 'duckduckgo',
            });
        }

        return results;
    },

    _decodeDuckDuckGoResultUrl(href) {
        if (!href) return '';

        try {
            const absolute = href.startsWith('//') ? `https:${href}` : href;
            const parsed = new URL(absolute, 'https://duckduckgo.com');
            const uddg = parsed.searchParams.get('uddg');
            return uddg ? decodeURIComponent(uddg) : parsed.href;
        } catch {
            return '';
        }
    },

    async _searchWikipedia(query) {
        try {
            const params = new URLSearchParams({
                action: 'query',
                list: 'search',
                srsearch: query,
                srlimit: '10',
                format: 'json',
                origin: '*',
            });
            const url = `https://en.wikipedia.org/w/api.php?${params.toString()}`;
            const response = await fetch(url, {
                signal: AbortSignal.timeout(10000),
            });

            if (!response.ok) {
                console.log(`[WebSearch] Wikipedia returned HTTP ${response.status}`);
                return null;
            }

            const text = await response.text();
            let data;
            try {
                data = JSON.parse(text);
            } catch {
                console.log('[WebSearch] Wikipedia returned non-JSON response');
                return null;
            }

            const searchItems = data?.query?.search;
            if (!Array.isArray(searchItems) || searchItems.length === 0) {
                console.log('[WebSearch] Wikipedia returned 0 parseable results');
                return null;
            }

            const results = [];
            const seenUrls = new Set();
            for (const item of searchItems) {
                if (results.length >= 10) break;
                if (!item.title) continue;
                const title = this._cleanText(item.title);
                const pageUrl = `https://en.wikipedia.org/wiki/${encodeURIComponent(item.title.replace(/ /g, '_'))}`;
                const normalized = this._normalizeVisitUrl(pageUrl);
                if (!normalized || seenUrls.has(normalized)) continue;
                seenUrls.add(normalized);
                results.push({
                    title,
                    url: normalized,
                    snippet: this._cleanText(item.snippet || ''),
                    source: 'en.wikipedia.org',
                    engine: 'wikipedia',
                });
            }

            if (results.length === 0) {
                console.log('[WebSearch] Wikipedia returned 0 parseable results');
                return null;
            }

            console.log(`[WebSearch] Wikipedia returned ${results.length} results`);
            return { results, query, provider: 'wikipedia', instance: 'en.wikipedia.org' };
        } catch (err) {
            const errType = err.name || 'Error';
            console.log(`[WebSearch] Wikipedia failed: [${errType}] ${err.message}`);
            return null;
        }
    },

    async _searchInstance(baseUrl, query) {
        try {
            const params = new URLSearchParams({
                q: query,
                format: 'json',
                categories: 'general',
                language: 'auto',
                safesearch: '0',
            });
            const url = `${baseUrl}/search?${params.toString()}`;
            const response = await fetch(url, {
                signal: AbortSignal.timeout(8000),
            });

            if (!response.ok) {
                console.log(`[WebSearch] ${baseUrl} returned HTTP ${response.status}`);
                return null;
            }

            const text = await response.text();
            let data;
            try {
                data = JSON.parse(text);
            } catch {
                console.log(`[WebSearch] ${baseUrl} returned non-JSON response (len=${text.length})`);
                return null;
            }

            if (data && Array.isArray(data.results) && data.results.length > 0) {
                const results = this._parseSearXngResults(data.results);
                if (results.length > 0) {
                    console.log(`[WebSearch] ${baseUrl} returned ${results.length} results`);
                    this._lastWorkingInstance = baseUrl;
                    return { results, query, provider: 'searxng', instance: baseUrl };
                }
            }

            console.log(`[WebSearch] ${baseUrl} returned 0 parseable results`);
        } catch (err) {
            const errType = err.name || 'Error';
            console.log(`[WebSearch] ${baseUrl} failed: [${errType}] ${err.message}`);
        }

        return null;
    },

    async visit(url, options = {}) {
        const maxTextLength = options.maxTextLength || 6000;
        const normalizedUrl = this._normalizeVisitUrl(url);
        if (!normalizedUrl) {
            throw new Error('Only http and https URLs can be visited');
        }

        const response = await fetch(normalizedUrl, {
            redirect: 'follow',
            headers: {
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5',
                'Accept-Language': 'en-US,en;q=0.9',
            },
            signal: AbortSignal.timeout(options.timeout || 15000),
        });

        if (!response.ok) {
            throw new Error(`Website returned HTTP ${response.status}`);
        }

        const contentType = response.headers.get('content-type') || '';
        const lowerContentType = contentType.toLowerCase();
        const isReadable =
            lowerContentType.includes('text/') ||
            lowerContentType.includes('html') ||
            lowerContentType.includes('json') ||
            lowerContentType.includes('xml');

        if (!isReadable) {
            throw new Error(`Unsupported content type: ${contentType || 'unknown'}`);
        }

        const raw = await response.text();
        const isHtml = lowerContentType.includes('html') || /<html[\s>]/i.test(raw);
        const title = isHtml ? this._extractTitle(raw) : '';
        const metaDescription = isHtml ? this._extractMetaDescription(raw) : '';
        const text = isHtml ? this._extractReadableText(raw) : this._cleanPlainText(raw);
        const truncatedText = text.length > maxTextLength
            ? text.slice(0, maxTextLength).trim() + '... [truncated]'
            : text;

        return {
            url: response.url || normalizedUrl,
            requestedUrl: normalizedUrl,
            title: title || this._titleFromUrl(response.url || normalizedUrl),
            source: this._sourceFromUrl(response.url || normalizedUrl),
            contentType,
            metaDescription,
            text: truncatedText,
            textLength: text.length,
        };
    },

    async testConnection() {
        const candidates = this._getCandidateInstances();

        for (const baseUrl of candidates) {
            try {
                const params = new URLSearchParams({
                    q: 'test',
                    format: 'json',
                    categories: 'general',
                    safesearch: '0',
                });
                const response = await fetch(`${baseUrl}/search?${params.toString()}`, {
                    signal: AbortSignal.timeout(10000),
                });

                if (!response.ok) {
                    console.log(`[WebSearch] Test: ${baseUrl} HTTP ${response.status}`);
                    continue;
                }

                const text = await response.text();
                let data;
                try {
                    data = JSON.parse(text);
                } catch {
                    console.log(`[WebSearch] Test: ${baseUrl} returned non-JSON response`);
                    continue;
                }

                if (data && Array.isArray(data.results)) {
                    this._lastWorkingInstance = baseUrl;
                    return { ok: true, provider: 'searxng', instance: baseUrl, results: data.results.length };
                }
            } catch (err) {
                const errType = err.name || 'Error';
                console.log(`[WebSearch] Test: ${baseUrl} failed: [${errType}] ${err.message}`);
            }
        }

        console.log('[WebSearch] Test: SearXNG exhausted; trying fallback providers');

        const ddgResult = await this._searchDuckDuckGo('test');
        if (ddgResult && ddgResult.results.length > 0) {
            return { ok: true, provider: 'duckduckgo', instance: 'html.duckduckgo.com', results: ddgResult.results.length };
        }

        const wikiResult = await this._searchWikipedia('test');
        if (wikiResult && wikiResult.results.length > 0) {
            return { ok: true, provider: 'wikipedia', instance: 'en.wikipedia.org', results: wikiResult.results.length };
        }

        return { ok: false, error: 'All search providers unreachable' };
    },

    buildSearchContext(searchData) {
        if (!searchData || !searchData.results || searchData.results.length === 0) {
            return 'No web search results were found for this query.';
        }

        return searchData.results.map((r, i) => {
            const title = r.title || 'Untitled';
            const snippet = r.snippet || '';
            const source = r.source || 'Unknown';
            return `[${i + 1}] **${title}** (${source})\n${snippet}`;
        }).join('\n\n');
    },

    _getCandidateInstances() {
        if (!this._discoveredInstances || Date.now() >= this._discoveryExpiresAt) {
            this._refreshDiscoveredInstances();
        }

        const combined = [this._lastWorkingInstance, ...this._instances, ...(this._discoveredInstances || [])];
        return this._dedupeInstances(combined);
    },

    _dedupeInstances(instances) {
        const seen = new Set();

        return (instances || [])
            .map(url => this._normalizeBaseUrl(url))
            .filter(Boolean)
            .filter(url => {
                if (seen.has(url)) return false;
                seen.add(url);
                return true;
            });
    },

    _refreshDiscoveredInstances() {
        if (this._discoveryInFlight) return this._discoveryInFlight;

        this._discoveryInFlight = this._fetchDiscoveredInstances()
            .finally(() => {
                this._discoveryInFlight = null;
            });

        return this._discoveryInFlight;
    },

    async _fetchDiscoveredInstances() {
        const now = Date.now();
        if (this._discoveredInstances && now < this._discoveryExpiresAt) {
            return this._discoveredInstances;
        }

        try {
            const response = await fetch('https://searx.space/data/instances.json', {
                signal: AbortSignal.timeout(6000),
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);

            const data = await response.json();
            const instances = data?.instances || data;
            const urls = [];

            if (instances && typeof instances === 'object') {
                for (const [url, info] of Object.entries(instances)) {
                    const normalized = this._normalizeBaseUrl(url);
                    if (!normalized || !normalized.startsWith('https://')) continue;
                    if (info?.network_type && info.network_type !== 'normal') continue;
                    if (info?.http?.grade && ['F', 'E'].includes(String(info.http.grade).toUpperCase())) continue;
                    const searchTiming = info?.timing?.search;
                    const successRate = Number(searchTiming?.success_percentage);
                    const medianTime = Number(searchTiming?.all?.median ?? searchTiming?.server?.median);
                    if (Number.isFinite(successRate) && successRate < 50) continue;
                    if (Number.isFinite(medianTime) && medianTime > 8) continue;
                    urls.push(normalized);
                }
            }

            this._discoveredInstances = urls.slice(0, 25);
            this._discoveryExpiresAt = now + (60 * 60 * 1000);
            console.log(`[WebSearch] Discovered ${this._discoveredInstances.length} SearXNG instances`);
            return this._discoveredInstances;
        } catch (err) {
            console.log(`[WebSearch] Instance discovery failed: ${err.message}`);
            this._discoveredInstances = [];
            this._discoveryExpiresAt = now + (10 * 60 * 1000);
            return [];
        }
    },

    _parseSearXngResults(rawResults) {
        const results = [];
        const seenUrls = new Set();

        for (const r of rawResults) {
            if (!r.url || !r.title) continue;

            const normalizedUrl = this._normalizeVisitUrl(r.url);
            if (!normalizedUrl || seenUrls.has(normalizedUrl)) continue;
            seenUrls.add(normalizedUrl);

            const source = this._sourceFromUrl(normalizedUrl);
            const engine = r.engine || (Array.isArray(r.engines) && r.engines[0]) || source;

            results.push({
                title: this._cleanText(r.title),
                url: normalizedUrl,
                snippet: this._cleanText(r.content || ''),
                source,
                engine,
            });

            if (results.length >= 10) break;
        }

        return results;
    },

    _cleanText(text) {
        if (!text) return '';
        return this._decodeHtmlEntities(String(text).replace(/<[^>]+>/g, ' '))
            .replace(/\s+/g, ' ')
            .trim();
    },

    _normalizeBaseUrl(url) {
        if (!url || typeof url !== 'string') return '';
        try {
            const parsed = new URL(url);
            if (!/^https?:$/.test(parsed.protocol)) return '';
            parsed.hash = '';
            parsed.search = '';
            return parsed.toString().replace(/\/+$/, '');
        } catch {
            return '';
        }
    },

    _normalizeVisitUrl(url) {
        if (!url || typeof url !== 'string') return '';
        try {
            const parsed = new URL(url.trim());
            if (!['http:', 'https:'].includes(parsed.protocol)) return '';
            parsed.hash = '';
            return parsed.toString();
        } catch {
            return '';
        }
    },

    _extractTitle(html) {
        const match = String(html).match(/<title[^>]*>([\s\S]*?)<\/title>/i);
        return match ? this._decodeHtmlEntities(match[1]).replace(/\s+/g, ' ').trim() : '';
    },

    _extractMetaDescription(html) {
        const htmlText = String(html);
        const match = htmlText.match(/<meta[^>]+(?:name|property)=["'](?:description|og:description)["'][^>]*content=["']([^"']*)["'][^>]*>/i)
            || htmlText.match(/<meta[^>]+content=["']([^"']*)["'][^>]*(?:name|property)=["'](?:description|og:description)["'][^>]*>/i);
        return match ? this._decodeHtmlEntities(match[1]).replace(/\s+/g, ' ').trim() : '';
    },

    _extractReadableText(html) {
        return this._decodeHtmlEntities(String(html)
            .replace(/<script[\s\S]*?<\/script>/gi, ' ')
            .replace(/<style[\s\S]*?<\/style>/gi, ' ')
            .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
            .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
            .replace(/<!--[\s\S]*?-->/g, ' ')
            .replace(/<\/(p|div|section|article|header|footer|main|li|tr|h[1-6]|blockquote)>/gi, '\n')
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/<[^>]+>/g, ' '))
            .split('\n')
            .map(line => line.replace(/\s+/g, ' ').trim())
            .filter(Boolean)
            .join('\n')
            .trim();
    },

    _cleanPlainText(text) {
        return this._decodeHtmlEntities(String(text))
            .replace(/\r/g, '')
            .replace(/[ \t]+/g, ' ')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
    },

    _decodeHtmlEntities(text) {
        if (!text) return '';
        return String(text)
            .replace(/&nbsp;/g, ' ')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/&#x27;/g, "'")
            .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
            .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)));
    },

    _sourceFromUrl(url) {
        try {
            return new URL(url).hostname.replace(/^www\./, '');
        } catch {
            return 'Unknown';
        }
    },

    _titleFromUrl(url) {
        try {
            const parsed = new URL(url);
            return `${parsed.hostname.replace(/^www\./, '')}${parsed.pathname.replace(/\/$/, '')}`;
        } catch {
            return 'Untitled page';
        }
    },
};
