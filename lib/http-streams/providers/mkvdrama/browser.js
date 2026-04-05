/**
 * MKVDrama browser + catalog module.
 *
 * Catalog: fetched via direct HTTP (SOCKS5 proxy), cached in SQLite for 24h.
 * On startup, loads from SQLite instantly, refreshes in background if stale.
 *
 * Content pages: loaded via Puppeteer (needs CF bypass + JS rendering).
 * Browser launched on-demand, auto-closed after 5 min idle.
 * CF cookies cached 10 min, content pages cached 10 min in-memory.
 */

import puppeteerExtra from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { SocksProxyAgent } from 'socks-proxy-agent';
import https from 'https';
import os from 'os';
import cluster from 'cluster';
import * as SqliteCache from '../../../util/cache-store.js';

puppeteerExtra.use(StealthPlugin());

const PROXY_URL = process.env.MKVDRAMA_BROWSER_PROXY_URL
    || process.env.MKVDRAMA_DIRECT_PROXY_URL
    || 'socks5://100.109.163.45:1080';
// FlareSolverr runs in its own container and may need a different proxy
const FLARESOLVERR_PROXY_URL = process.env.FLARESOLVERR_PROXY_URL
    || process.env.MKVDRAMA_CF_HARVEST_PROXY
    || PROXY_URL;
const BROWSER_TIMEOUT_MS = parseInt(process.env.MKVDRAMA_BROWSER_TIMEOUT_MS || '60000', 10);
const PAGE_WAIT_MS = parseInt(process.env.MKVDRAMA_PAGE_WAIT_MS || '15000', 10);
const C_LINK_CONCURRENCY = Math.max(1, parseInt(process.env.MKVDRAMA_C_LINK_CONCURRENCY || '5', 10));
const API_URL = (process.env.MKVDRAMA_API_URL || 'https://mkvdrama.net').replace(/\/+$/, '');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';

const CATALOG_REFRESH_MS = 24 * 60 * 60 * 1000; // 24 hours
const CATALOG_SQLITE_KEY = 'mkvdrama-full-catalog';
const CATALOG_SQLITE_SERVICE = 'mkvdrama';

let _browser = null;
let _browserLaunchPromise = null;
let _cfCookies = null;
let _cfCookiesTs = 0;
const CF_COOKIE_TTL_MS = 10 * 60 * 1000;
let _lastUsed = 0;
const BROWSER_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

// Full catalog in memory
let _fullCatalog = [];
let _catalogFetchTs = 0;
let _catalogFetchPromise = null;

// Content cache: slug -> { result, ts }
const _contentCache = new Map();
const CONTENT_CACHE_TTL_MS = 10 * 60 * 1000;
const CONTENT_CACHE_MAX = 100;

function normalizeProxy(url) {
    if (!url) return null;
    return url.replace('socks5h://', 'socks5://');
}

// ─── Direct HTTP catalog fetch (no Puppeteer) ───

function createProxyAgent() {
    if (!PROXY_URL) return undefined;
    // Use socks5h:// for remote DNS resolution (avoids IPv4/IPv6 issues)
    const proxyUrl = PROXY_URL.replace(/^socks5:\/\//, 'socks5h://');
    return new SocksProxyAgent(proxyUrl);
}

// ─── FlareSolverr CF bypass for catalog API ───
const FLARESOLVERR_URL = process.env.FLARESOLVERR_URL || '';
const CATALOG_CF_COOKIE_TTL_MS = 30 * 60 * 1000; // 30 min
let _catalogCfCookies = null; // { cookie: 'cf_clearance=...', ua: '...', ts: 0 }
let _cfCookiePromise = null; // dedup concurrent FlareSolverr calls

async function getCatalogCfCookies() {
    if (_catalogCfCookies && Date.now() - _catalogCfCookies.ts < CATALOG_CF_COOKIE_TTL_MS) {
        return _catalogCfCookies;
    }
    if (!FLARESOLVERR_URL) return null;

    // Dedup: if another call is already fetching, wait for it
    if (_cfCookiePromise) return _cfCookiePromise;

    _cfCookiePromise = (async () => {
        try {
            const { default: axios } = await import('axios');
            const proxyNorm = normalizeProxy(FLARESOLVERR_PROXY_URL);
            const payload = {
                cmd: 'request.get',
                url: `${API_URL}/titles/?page=1&per_page=200`,
                maxTimeout: 30000,
                ...(proxyNorm ? { proxy: { url: proxyNorm } } : {})
            };
            const resp = await axios.post(`${FLARESOLVERR_URL}/v1`, payload, { timeout: 35000 });
            const sol = resp.data?.solution;
            if (!sol?.cookies?.length) return null;

            const cookie = sol.cookies.map(c => `${c.name}=${c.value}`).join('; ');
            const ua = sol.userAgent || UA;
            _catalogCfCookies = { cookie, ua, ts: Date.now() };
            console.log('[MKVDrama/Catalog] Got CF cookies via FlareSolverr');
            return _catalogCfCookies;
        } catch (err) {
            console.error(`[MKVDrama/Catalog] FlareSolverr CF bypass failed: ${err.message}`);
            return null;
        } finally {
            _cfCookiePromise = null;
        }
    })();

    return _cfCookiePromise;
}

function extractEntries(results) {
    const entries = [];
    for (const e of results) {
        entries.push({
            title: e.title || '',
            alternative_title: e.alternative_title || '',
            slug: e.slug || '',
            release_date: e.release_date || '',
        });
    }
    return entries;
}

function _httpGetJson(url, headers = {}) {
    return new Promise((resolve, reject) => {
        const agent = createProxyAgent();
        const timer = setTimeout(() => { req.destroy(); reject(new Error('Timeout')); }, 20000);
        const req = https.get(url, { agent, headers: { 'User-Agent': UA, 'Accept': 'application/json', ...headers } }, (res) => {
            if (res.statusCode >= 301 && res.statusCode <= 308 && res.headers.location) {
                clearTimeout(timer);
                res.resume();
                const loc = res.headers.location;
                _httpGetJson(loc.startsWith('http') ? loc : new URL(loc, url).toString(), headers).then(resolve, reject);
                return;
            }
            if (res.statusCode !== 200) {
                clearTimeout(timer);
                res.resume();
                reject(new Error(`HTTP ${res.statusCode}`));
                return;
            }
            let body = '';
            res.on('data', chunk => { body += chunk; });
            res.on('end', () => { clearTimeout(timer); resolve(body); });
        });
        req.on('error', err => { clearTimeout(timer); reject(err); });
    });
}

/**
 * Parse catalog entries from HTML returned by FlareSolverr.
 * Extracts slug and title from itemprop="url" anchor tags.
 */
function extractEntriesFromHtml(html) {
    const entries = [];
    const seen = new Set();
    // Pattern: <a href="/SLUG" itemprop="url" title="TITLE" ...>
    const regex = /<a[^>]*href="\/([^"]+)"[^>]*itemprop="url"[^>]*title="([^"]+)"/g;
    let match;
    while ((match = regex.exec(html)) !== null) {
        const slug = match[1];
        const title = match[2];
        if (slug && !seen.has(slug)) {
            seen.add(slug);
            entries.push({ title, alternative_title: '', slug, release_date: '' });
        }
    }
    // Also try reverse attribute order: itemprop before href
    const regex2 = /<a[^>]*itemprop="url"[^>]*href="\/([^"]+)"[^>]*title="([^"]+)"/g;
    while ((match = regex2.exec(html)) !== null) {
        const slug = match[1];
        const title = match[2];
        if (slug && !seen.has(slug)) {
            seen.add(slug);
            entries.push({ title, alternative_title: '', slug, release_date: '' });
        }
    }
    return entries;
}

/**
 * Extract max page number from pagination links in HTML.
 */
function extractMaxPageFromHtml(html) {
    const pages = [];
    const regex = /[?&]page=(\d+)/g;
    let match;
    while ((match = regex.exec(html)) !== null) {
        pages.push(parseInt(match[1], 10));
    }
    return pages.length > 0 ? Math.max(...pages) : 1;
}

async function fetchOnePage(pageNum, perPage) {
    const url = `${API_URL}/titles/?page=${pageNum}&per_page=${perPage}`;

    // Try direct JSON API first
    try {
        const body = await _httpGetJson(url);
        return JSON.parse(body);
    } catch (directErr) {
        // Only try CF bypass on 403
        if (!directErr.message.includes('403')) {
            throw new Error(`${directErr.message} on page ${pageNum}`);
        }
    }

    // Get CF cookies and retry direct
    const cf = await getCatalogCfCookies();
    if (cf) {
        try {
            const body = await _httpGetJson(url, { 'Cookie': cf.cookie, 'User-Agent': cf.ua });
            return JSON.parse(body);
        } catch {
            // CF cookies didn't help (TLS fingerprint blocked), fall through to FlareSolverr
        }
    }

    // Fallback: use FlareSolverr to fetch the page and parse HTML
    if (!FLARESOLVERR_URL) throw new Error(`HTTP 403 on page ${pageNum} (no FlareSolverr)`);

    try {
        const { default: axios } = await import('axios');
        const proxyNorm = normalizeProxy(FLARESOLVERR_PROXY_URL);
        const payload = {
            cmd: 'request.get',
            url,
            maxTimeout: 45000,
            ...(proxyNorm ? { proxy: { url: proxyNorm } } : {})
        };
        const resp = await axios.post(`${FLARESOLVERR_URL}/v1`, payload, { timeout: 50000 });
        const sol = resp.data?.solution;
        if (!sol?.response || sol.status !== 200) {
            throw new Error(`FlareSolverr status ${sol?.status || 'unknown'} on page ${pageNum}`);
        }

        // Update CF cookies from successful solve
        if (sol.cookies?.length) {
            const cookie = sol.cookies.map(c => `${c.name}=${c.value}`).join('; ');
            const ua = sol.userAgent || UA;
            _catalogCfCookies = { cookie, ua, ts: Date.now() };
        }

        const html = sol.response;
        const entries = extractEntriesFromHtml(html);
        const maxPage = extractMaxPageFromHtml(html);
        const total = maxPage * perPage; // Estimate total from pagination

        console.log(`[MKVDrama/Catalog] FlareSolverr page ${pageNum}: ${entries.length} entries (maxPage=${maxPage})`);
        return { results: entries, total, _fromHtml: true };
    } catch (err) {
        throw new Error(`FlareSolverr failed on page ${pageNum}: ${err.message}`);
    }
}

async function fetchCatalogViaHttp() {
    const perPage = 200; // Max accepted by the API
    const concurrency = 5;
    const t0 = Date.now();

    // Fetch page 1 to get total count
    let firstData;
    try {
        firstData = await fetchOnePage(1, perPage);
    } catch (err) {
        console.error(`[MKVDrama/Catalog] Failed to fetch page 1: ${err.message}`);
        return [];
    }

    const total = firstData.total || 0;
    const totalPages = Math.ceil(total / perPage);
    // HTML-parsed entries are already in the right format; JSON API entries need extractEntries()
    const entries = firstData._fromHtml
        ? (firstData.results || [])
        : extractEntries(firstData.results || []);

    if (totalPages <= 1) {
        console.log(`[MKVDrama/Catalog] Fetched ${entries.length} entries in 1 page (${Date.now() - t0}ms)`);
        return entries;
    }

    console.log(`[MKVDrama/Catalog] Total: ${total} entries across ${totalPages} pages, fetching sequentially...`);

    // Fetch remaining pages sequentially (SOCKS proxy hangs with concurrent connections)
    for (let p = 2; p <= totalPages; p++) {
        try {
            const data = await fetchOnePage(p, perPage);
            const pageEntries = data._fromHtml
                ? (data.results || [])
                : extractEntries(data.results || []);
            entries.push(...pageEntries);
            if (p % 5 === 0 || p === totalPages) {
                console.log(`[MKVDrama/Catalog] Progress: page ${p}/${totalPages} (${entries.length} entries, ${Date.now() - t0}ms)`);
            }
        } catch (err) {
            console.error(`[MKVDrama/Catalog] Page ${p} failed: ${err.message}`);
        }
    }

    console.log(`[MKVDrama/Catalog] Fetched ${entries.length} entries in ${totalPages} pages (${Date.now() - t0}ms)`);
    return entries;
}

async function loadCatalogFromSqlite() {
    if (!SqliteCache.isEnabled()) return null;
    try {
        const cached = await SqliteCache.getCachedRecord(CATALOG_SQLITE_SERVICE, CATALOG_SQLITE_KEY);
        if (!cached?.data) return null;
        const updatedAt = cached.updatedAt || cached.createdAt;
        if (updatedAt) {
            const age = Date.now() - new Date(updatedAt).getTime();
            if (age <= CATALOG_REFRESH_MS) {
                console.log(`[MKVDrama/Catalog] Loaded ${cached.data.length} entries from SQLite (age: ${Math.round(age / 60000)}min)`);
                return cached.data;
            }
            console.log(`[MKVDrama/Catalog] SQLite catalog stale (age: ${Math.round(age / 60000)}min), will refresh`);
            // Still return stale data to use while refreshing
            return { stale: true, entries: cached.data };
        }
    } catch (err) {
        console.error(`[MKVDrama/Catalog] SQLite read failed: ${err.message}`);
    }
    return null;
}

async function saveCatalogToSqlite(entries) {
    if (!SqliteCache.isEnabled()) return;
    try {
        await SqliteCache.upsertCachedMagnet({
            service: CATALOG_SQLITE_SERVICE,
            hash: CATALOG_SQLITE_KEY,
            data: entries,
            releaseKey: 'mkvdrama-catalog'
        }, { ttlMs: CATALOG_REFRESH_MS * 2 }); // Keep in DB for 48h, refresh after 24h
        console.log(`[MKVDrama/Catalog] Saved ${entries.length} entries to SQLite`);
    } catch (err) {
        console.error(`[MKVDrama/Catalog] SQLite write failed: ${err.message}`);
    }
}

async function fetchFullCatalog() {
    if (_catalogFetchPromise) return _catalogFetchPromise;

    _catalogFetchPromise = (async () => {
        try {
            const entries = await fetchCatalogViaHttp();
            if (entries.length > 0) {
                _fullCatalog = entries;
                _catalogFetchTs = Date.now();
                saveCatalogToSqlite(entries).catch(() => {});
            } else {
                console.error('[MKVDrama/Catalog] HTTP fetch returned 0 entries, keeping existing catalog');
            }
        } catch (err) {
            console.error(`[MKVDrama/Catalog] Fetch failed: ${err.message}`);
        } finally {
            _catalogFetchPromise = null;
        }
    })();

    return _catalogFetchPromise;
}

// ─── Startup: load from SQLite first, refresh in background if stale ───

setTimeout(async () => {
    console.log('[MKVDrama/Catalog] Loading catalog...');
    const sqliteResult = await loadCatalogFromSqlite();

    if (sqliteResult) {
        // Got data from SQLite (fresh or stale)
        const entries = Array.isArray(sqliteResult) ? sqliteResult : sqliteResult.entries;
        if (entries && entries.length > 0) {
            _fullCatalog = entries;
            _catalogFetchTs = Date.now();
            console.log(`[MKVDrama/Catalog] Using ${entries.length} entries from SQLite`);

            // If stale, refresh in background
            if (sqliteResult.stale) {
                console.log('[MKVDrama/Catalog] Refreshing stale catalog in background...');
                fetchFullCatalog().catch(() => {});
            }
            return;
        }
    }

    // No SQLite data — fetch from API
    console.log('[MKVDrama/Catalog] No cached catalog, fetching from API...');
    fetchFullCatalog().catch(() => {});
}, 2000);

// Refresh catalog daily
setInterval(() => {
    if (Date.now() - _catalogFetchTs > CATALOG_REFRESH_MS && !_catalogFetchPromise) {
        console.log('[MKVDrama/Catalog] Daily refresh...');
        fetchFullCatalog().catch(() => {});
    }
}, 60 * 60 * 1000).unref(); // Check every hour

// ─── Background content pre-fetcher ───

const PREFETCH_ENABLED = process.env.MKVDRAMA_PREFETCH_ENABLED === 'true';
const PREFETCH_BATCH_SIZE = parseInt(process.env.MKVDRAMA_PREFETCH_BATCH_SIZE || '50', 10);
const PREFETCH_INTERVAL_MS = parseInt(process.env.MKVDRAMA_PREFETCH_INTERVAL_MS || '3600000', 10); // 1 hour
const PREFETCH_DELAY_BETWEEN_MS = parseInt(process.env.MKVDRAMA_PREFETCH_DELAY_MS || '15000', 10); // 15s between pages
const PREFETCH_CPU_THRESHOLD = parseFloat(process.env.MKVDRAMA_PREFETCH_CPU_THRESHOLD || '0.7'); // 70% load
const PREFETCH_INITIAL_DELAY_MS = parseInt(process.env.MKVDRAMA_PREFETCH_INITIAL_DELAY_MS || '120000', 10); // 2 min after startup
const PREFETCH_RESOLVE_ENABLED = process.env.MKVDRAMA_PREFETCH_RESOLVE !== 'false';
const PREFETCH_RESOLVE_DELAY_MS = parseInt(process.env.MKVDRAMA_PREFETCH_RESOLVE_DELAY_MS || '30000', 10); // 30s between resolves
const PREFETCH_SQLITE_SERVICE = 'mkvdrama';

let _prefetchOffset = 0; // How far through the catalog we've prefetched
let _prefetchRunning = false;

function isCpuBusy() {
    const cpus = os.cpus().length || 1;
    const load1m = os.loadavg()[0];
    const ratio = load1m / cpus;
    return ratio > PREFETCH_CPU_THRESHOLD;
}

async function isContentCached(slug) {
    if (!SqliteCache.isEnabled()) return false;
    try {
        const cached = await SqliteCache.getCachedRecord(PREFETCH_SQLITE_SERVICE, `mkvdrama-content:${slug}`);
        if (!cached?.data) return false;
        const updatedAt = cached.updatedAt || cached.createdAt;
        if (!updatedAt) return false;
        const age = Date.now() - new Date(updatedAt).getTime();
        return age < 24 * 60 * 60 * 1000; // 24h
    } catch {
        return false;
    }
}

/**
 * Get catalog entries sorted by recency (newest release_date first).
 */
function getSortedCatalog() {
    return [..._fullCatalog].sort((a, b) => {
        const da = a.release_date || '0000';
        const db = b.release_date || '0000';
        return db.localeCompare(da);
    });
}

/**
 * Pre-fetch a batch of content pages and cache them in SQLite.
 * Skips entries that are already cached.
 */
async function prefetchBatch() {
    if (_prefetchRunning || _fullCatalog.length === 0) return;
    _prefetchRunning = true;

    const sorted = getSortedCatalog();
    const total = sorted.length;

    // If we've covered everything, only check for new/expired entries
    if (_prefetchOffset >= total) {
        _prefetchOffset = 0; // Wrap around to refresh oldest cached entries
    }

    const batch = sorted.slice(_prefetchOffset, _prefetchOffset + PREFETCH_BATCH_SIZE);
    let fetched = 0;
    let skipped = 0;

    console.log(`[MKVDrama/Prefetch] Starting batch: offset=${_prefetchOffset}, batch=${batch.length}, total=${total}`);

    for (let i = 0; i < batch.length; i++) {
        const entry = batch[i];
        if (!entry.slug) { skipped++; continue; }

        // Check CPU before each fetch
        if (isCpuBusy()) {
            console.log(`[MKVDrama/Prefetch] CPU busy (load: ${os.loadavg()[0].toFixed(1)}), pausing batch at ${fetched}/${batch.length}`);
            // Don't advance offset past what we actually processed
            _prefetchOffset += i;
            console.log(`[MKVDrama/Prefetch] Batch paused: fetched=${fetched}, skipped=${skipped}, nextOffset=${_prefetchOffset}`);
            _prefetchRunning = false;
            return;
        }

        // Skip if already cached
        if (await isContentCached(entry.slug)) {
            skipped++;
            continue;
        }

        try {
            console.log(`[MKVDrama/Prefetch] Fetching content: ${entry.slug} (${entry.title})`);
            const result = await browserLoadContent(entry.slug);
            const linkCount = result?.downloadLinks?.length || 0;

            if (linkCount > 0) {
                // Enrich links with episode/season parsing before caching
                // (browserLoadContent returns raw links without episode info)
                const { parseEpisodeRange, parseSeasonNumber } = await import('./search.js');
                result.downloadLinks = result.downloadLinks.map(link => {
                    const episodeRange = parseEpisodeRange(link.label || '');
                    const season = parseSeasonNumber(link.label || '');
                    return {
                        ...link,
                        episodeStart: episodeRange?.start ?? null,
                        episodeEnd: episodeRange?.end ?? null,
                        season: season ?? null,
                    };
                });

                // Save to SQLite (same cache key format as search.js)
                await SqliteCache.upsertCachedMagnet({
                    service: PREFETCH_SQLITE_SERVICE,
                    hash: `mkvdrama-content:${entry.slug}`,
                    data: result,
                    releaseKey: 'mkvdrama-http-streams'
                }, { ttlMs: 48 * 60 * 60 * 1000 }).catch(() => {});
                fetched++;
                console.log(`[MKVDrama/Prefetch] Cached ${entry.slug}: ${linkCount} links`);
            } else {
                console.log(`[MKVDrama/Prefetch] No links for ${entry.slug}, skipping`);
            }
        } catch (err) {
            console.log(`[MKVDrama/Prefetch] Failed ${entry.slug}: ${err.message}`);
        }

        // Delay between fetches to avoid overwhelming the browser/proxy
        await new Promise(r => setTimeout(r, PREFETCH_DELAY_BETWEEN_MS));
    }

    _prefetchOffset += batch.length;
    console.log(`[MKVDrama/Prefetch] Batch complete: fetched=${fetched}, skipped=${skipped}, nextOffset=${_prefetchOffset}`);
    _prefetchRunning = false;
}

/**
 * Resolve _c/ links from cached content to final pixeldrain URLs.
 * Uses a stable cache key (slug:quality:linkIndex) so results persist across sessions.
 */
/**
 * Check if a URL is a resolvable shortlink (OUO, oii.la, _c/ etc.)
 */
function isResolvableLink(url) {
    if (!url) return false;
    if (url.includes('/_c/')) return true;
    if (/ouo\.(io|press)|oii\.la/i.test(url)) return true;
    return false;
}

async function prefetchResolveLinks() {
    if (!PREFETCH_RESOLVE_ENABLED || !SqliteCache.isEnabled()) return;
    if (_prefetchRunning) return; // Don't compete with content prefetch
    _prefetchRunning = true;

    const sorted = getSortedCatalog();
    let resolved = 0;
    const maxResolves = 10; // Max per cycle to limit resource usage

    // Lazy-load the HTTP resolver for OUO/oii.la links
    let resolveHttpStreamUrl = null;
    try {
        const mod = await import('../../resolvers/http-resolver.js');
        resolveHttpStreamUrl = mod.resolveHttpStreamUrl;
    } catch (err) {
        console.error(`[MKVDrama/Prefetch] Failed to load http-resolver: ${err.message}`);
    }

    console.log(`[MKVDrama/Prefetch] Starting link resolution cycle...`);

    for (const entry of sorted) {
        if (resolved >= maxResolves) break;
        if (isCpuBusy()) {
            console.log(`[MKVDrama/Prefetch] CPU busy, stopping resolve cycle at ${resolved}`);
            break;
        }
        if (!entry.slug) continue;

        // Get cached content
        let content;
        try {
            const cached = await SqliteCache.getCachedRecord(PREFETCH_SQLITE_SERVICE, `mkvdrama-content:${entry.slug}`);
            content = cached?.data;
        } catch { continue; }

        if (!content?.downloadLinks?.length) continue;

        // Check each link — only resolve uncached ones
        for (const link of content.downloadLinks) {
            if (resolved >= maxResolves) break;
            if (!isResolvableLink(link.url)) continue;

            const stableKey = `mkvdrama-resolved:${entry.slug}:${link.quality || 'unknown'}:${link.linkText || '0'}`;
            try {
                const cached = await SqliteCache.getCachedRecord('http-resolve', stableKey);
                if (cached?.data?.url) continue; // Already resolved
            } catch { /* not cached */ }

            if (isCpuBusy()) break;

            try {
                console.log(`[MKVDrama/Prefetch] Resolving ${entry.slug} ${link.quality} (${link.url.substring(0, 40)})`);
                let resolvedUrl = null;

                if (link.url.includes('/_c/')) {
                    // _c/ links need Puppeteer to resolve the redirect
                    resolvedUrl = await browserResolveProtectedLink(link.url, {
                        resolution: link.quality,
                        host: 'pixeldrain'
                    });
                } else if (resolveHttpStreamUrl) {
                    // OUO/oii.la links use the HTTP resolver chain
                    resolvedUrl = await resolveHttpStreamUrl(link.url);
                }

                if (resolvedUrl) {
                    // Cache with stable key
                    await SqliteCache.upsertCachedMagnet({
                        service: 'http-resolve',
                        hash: stableKey,
                        data: { url: resolvedUrl, slug: entry.slug, quality: link.quality },
                        releaseKey: 'mkvdrama-prefetch-resolve'
                    }, { ttlMs: 12 * 60 * 60 * 1000 }).catch(() => {}); // 12h TTL (OUO links expire)
                    resolved++;
                    console.log(`[MKVDrama/Prefetch] Resolved ${entry.slug} ${link.quality} → ${resolvedUrl.substring(0, 60)}`);
                }
            } catch (err) {
                console.log(`[MKVDrama/Prefetch] Resolve failed ${entry.slug}: ${err.message}`);
            }

            await new Promise(r => setTimeout(r, PREFETCH_RESOLVE_DELAY_MS));
        }
    }

    console.log(`[MKVDrama/Prefetch] Resolve cycle complete: ${resolved} links resolved`);
    _prefetchRunning = false;
}

/**
 * Look up a pre-resolved URL by stable key (slug + quality + linkText).
 */
export async function getPreResolvedUrl(slug, quality, linkText) {
    if (!SqliteCache.isEnabled()) return null;
    const stableKey = `mkvdrama-resolved:${slug}:${quality || 'unknown'}:${linkText || '0'}`;
    try {
        const cached = await SqliteCache.getCachedRecord('http-resolve', stableKey);
        if (cached?.data?.url) {
            const age = cached.updatedAt ? Date.now() - new Date(cached.updatedAt).getTime() : Infinity;
            if (age < 12 * 60 * 60 * 1000) { // 12h
                console.log(`[MKVDrama/Prefetch] Cache HIT for ${slug} ${quality}: ${cached.data.url.substring(0, 60)}`);
                return cached.data.url;
            }
        }
    } catch { /* miss */ }
    return null;
}

// Start prefetcher after initial catalog load (only on worker 1 or standalone mode)
const isFirstWorker = !cluster.isWorker || cluster.worker?.id === 1;
if (PREFETCH_ENABLED && isFirstWorker) {
    setTimeout(async () => {
        // Wait for catalog to be loaded
        if (_fullCatalog.length === 0 && _catalogFetchPromise) {
            await _catalogFetchPromise;
        }
        if (_fullCatalog.length === 0) {
            console.log('[MKVDrama/Prefetch] No catalog available, skipping prefetch');
            return;
        }
        console.log(`[MKVDrama/Prefetch] Starting initial prefetch (${_fullCatalog.length} titles in catalog)`);
        prefetchBatch().catch(err => console.error(`[MKVDrama/Prefetch] Initial batch failed: ${err.message}`));
    }, PREFETCH_INITIAL_DELAY_MS);

    // Run prefetch batches every hour
    setInterval(() => {
        if (isCpuBusy()) {
            console.log(`[MKVDrama/Prefetch] Skipping scheduled batch, CPU busy (load: ${os.loadavg()[0].toFixed(1)})`);
            return;
        }
        prefetchBatch().catch(err => console.error(`[MKVDrama/Prefetch] Batch failed: ${err.message}`));
    }, PREFETCH_INTERVAL_MS).unref();

    // Run link resolution 30 min after each content batch
    setInterval(() => {
        if (isCpuBusy()) return;
        prefetchResolveLinks().catch(err => console.error(`[MKVDrama/Prefetch] Resolve failed: ${err.message}`));
    }, PREFETCH_INTERVAL_MS + 30 * 60 * 1000).unref();
}

// ─── Puppeteer (only for content pages) ───

async function launchBrowser() {
    // Use FlareSolverr's proxy so CF cookies (IP-bound) work in Puppeteer too
    const proxyNormalized = normalizeProxy(FLARESOLVERR_PROXY_URL || PROXY_URL);
    const args = [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        // Note: images disabled via request interception below, not via flags
        // (disable-images flag can break some JS-heavy sites)
    ];
    if (proxyNormalized) {
        args.push(`--proxy-server=${proxyNormalized}`);
        // Note: Chromium with SOCKS5 resolves DNS locally by default.
        // The proxy must handle both IPv4/IPv6 routing correctly.
    }

    const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH
        || process.env.CHROMIUM_PATH
        || null;

    console.log(`[MKVDrama/Browser] Launching puppeteer (proxy: ${proxyNormalized || 'none'}, chromium: ${executablePath || 'default'})`);
    const launchOptions = {
        headless: 'new',
        args,
        timeout: 30000,
        protocolTimeout: 60000,
    };
    if (executablePath) {
        launchOptions.executablePath = executablePath;
    }
    const browser = await puppeteerExtra.launch(launchOptions);

    browser.on('disconnected', () => {
        console.log('[MKVDrama/Browser] Browser disconnected');
        _browser = null;
        _browserLaunchPromise = null;
        _cfCookies = null;
        _cfCookiesTs = 0;
    });

    return browser;
}

async function getBrowser() {
    _lastUsed = Date.now();
    if (_browser) return _browser;
    if (_browserLaunchPromise) return _browserLaunchPromise;

    _browserLaunchPromise = launchBrowser().then(b => {
        _browser = b;
        _browserLaunchPromise = null;
        return b;
    }).catch(err => {
        _browserLaunchPromise = null;
        throw err;
    });

    return _browserLaunchPromise;
}

// Auto-close idle browser
setInterval(() => {
    if (_browser && Date.now() - _lastUsed > BROWSER_IDLE_TIMEOUT_MS) {
        console.log('[MKVDrama/Browser] Closing idle browser');
        _browser.close().catch(() => {});
        _browser = null;
    }
}, 60000).unref();

async function newPage() {
    const browser = await getBrowser();
    let page;
    for (let i = 0; i < 3; i++) {
        try {
            page = await browser.newPage();
            break;
        } catch (err) {
            if (i < 2 && /main frame too early/i.test(err.message)) {
                await new Promise(r => setTimeout(r, 200 * (i + 1)));
                continue;
            }
            throw err;
        }
    }
    await page.setUserAgent(UA);
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
    await page.setRequestInterception(true);
    page.on('request', req => {
        const type = req.resourceType();
        if (['image', 'font', 'stylesheet', 'media'].includes(type)) {
            req.abort().catch(() => {});
        } else {
            req.continue().catch(() => {});
        }
    });
    return page;
}

async function ensureCfSession(page) {
    if (_cfCookies && (Date.now() - _cfCookiesTs) < CF_COOKIE_TTL_MS) {
        await page.setCookie(..._cfCookies);
        return true;
    }

    console.log(`[MKVDrama/Browser] Establishing CF session...`);
    const t0 = Date.now();

    // Try FlareSolverr first — more reliable for mkvdrama.net CF challenges
    const cfData = await getCatalogCfCookies();
    if (cfData) {
        const domain = new URL(API_URL).hostname;
        const puppeteerCookies = cfData.cookie.split('; ').map(pair => {
            const [name, ...rest] = pair.split('=');
            return { name, value: rest.join('='), domain: `.${domain}`, path: '/' };
        });
        // Match the UA that FlareSolverr used (cf_clearance is UA-bound)
        await page.setUserAgent(cfData.ua);
        await page.setCookie(...puppeteerCookies);
        _cfCookies = puppeteerCookies;
        _cfCookiesTs = Date.now();
        console.log(`[MKVDrama/Browser] CF session via FlareSolverr in ${Date.now() - t0}ms`);
        return false;
    }

    // Fallback: let Puppeteer solve it
    await page.goto(`${API_URL}/`, { waitUntil: 'networkidle2', timeout: BROWSER_TIMEOUT_MS });
    _cfCookies = await page.cookies();
    _cfCookiesTs = Date.now();
    console.log(`[MKVDrama/Browser] CF session established in ${Date.now() - t0}ms`);
    return false;
}

// ─── Content cache helpers ───

function getCachedContent(slug) {
    const entry = _contentCache.get(slug);
    if (!entry) return null;
    if (Date.now() - entry.ts > CONTENT_CACHE_TTL_MS) {
        _contentCache.delete(slug);
        return null;
    }
    return entry.result;
}

function setCachedContent(slug, result) {
    if (_contentCache.size >= CONTENT_CACHE_MAX) {
        const oldest = _contentCache.keys().next().value;
        _contentCache.delete(oldest);
    }
    _contentCache.set(slug, { result, ts: Date.now() });
}

// ─── Exports ───

export async function browserSearchCatalog(query, maxPages = 3, perPage = 100) {
    const queryLower = query.toLowerCase().trim();
    const queryWords = queryLower.split(/\s+/).filter(w => w.length > 1);

    // Wait for catalog if fetch is in progress and we have nothing
    if (_catalogFetchPromise && _fullCatalog.length === 0) {
        console.log(`[MKVDrama/Catalog] Waiting for catalog fetch to complete...`);
        await _catalogFetchPromise;
    }

    // Search locally if we have catalog data
    if (_fullCatalog.length > 0) {
        const t0 = Date.now();
        const matches = [];
        const seen = new Set();

        for (const entry of _fullCatalog) {
            const title = (entry.title || '').toLowerCase();
            const altTitle = (entry.alternative_title || '').toLowerCase();
            const slug = (entry.slug || '').toLowerCase();
            const combined = `${title} ${altTitle} ${slug}`;

            let score = 0;
            if (title === queryLower || slug === queryLower.replace(/\s+/g, '-')) score = 100;
            else if (title.startsWith(queryLower)) score = 90;
            else if (combined.includes(queryLower)) score = 80;
            else {
                const matched = queryWords.filter(w => combined.includes(w));
                if (matched.length === queryWords.length) score = 70;
                else if (matched.length > 0) score = 30 + (matched.length / queryWords.length) * 40;
            }

            if (score >= 30 && !seen.has(entry.slug)) {
                seen.add(entry.slug);
                matches.push({ ...entry, _score: score });
            }
        }

        matches.sort((a, b) => b._score - a._score);
        const results = matches.slice(0, 20);
        console.log(`[MKVDrama/Catalog] Local search for "${query}": ${results.length} results in ${Date.now() - t0}ms`);
        return results;
    }

    // Fallback 1: FlareSolverr site search (?s=query) — fast, targeted
    if (FLARESOLVERR_URL) {
        console.log(`[MKVDrama/Catalog] No catalog available, trying FlareSolverr site search...`);
        try {
            const { default: axios } = await import('axios');
            const proxyNorm = normalizeProxy(FLARESOLVERR_PROXY_URL);
            // Strip year from query — mkvdrama search doesn't handle year well
            const searchQuery = query.replace(/\b(19|20)\d{2}\b/g, '').trim();
            const searchUrl = `${API_URL}/?s=${encodeURIComponent(searchQuery)}`;
            const payload = {
                cmd: 'request.get',
                url: searchUrl,
                maxTimeout: 45000,
                ...(proxyNorm ? { proxy: { url: proxyNorm } } : {})
            };
            const resp = await axios.post(`${FLARESOLVERR_URL}/v1`, payload, { timeout: 50000 });
            const sol = resp.data?.solution;
            if (sol?.response && sol.status === 200) {
                const html = sol.response;
                const results = [];
                const seen = new Set();
                // Search results use class="tip" links with title attribute
                const tipRegex = /<a[^>]*href="\/([^"]+)"[^>]*title="([^"]+)"[^>]*class="tip"/g;
                let m;
                while ((m = tipRegex.exec(html)) !== null) {
                    const slug = m[1];
                    const title = m[2];
                    if (slug && !seen.has(slug) && !slug.includes('/')) {
                        seen.add(slug);
                        results.push({ title, alternative_title: '', slug, release_date: '' });
                    }
                }
                // Also try reverse order (class before href)
                const tipRegex2 = /<a[^>]*class="tip"[^>]*href="\/([^"]+)"[^>]*title="([^"]+)"/g;
                while ((m = tipRegex2.exec(html)) !== null) {
                    const slug = m[1];
                    const title = m[2];
                    if (slug && !seen.has(slug) && !slug.includes('/')) {
                        seen.add(slug);
                        results.push({ title, alternative_title: '', slug, release_date: '' });
                    }
                }
                // Also try itemprop entries (catalog-style listing on some pages)
                const itemEntries = extractEntriesFromHtml(html);
                for (const entry of itemEntries) {
                    if (entry.slug && !seen.has(entry.slug)) {
                        seen.add(entry.slug);
                        results.push(entry);
                    }
                }
                console.log(`[MKVDrama/Catalog] FlareSolverr site search for "${searchQuery}": ${results.length} results`);
                if (results.length > 0) return results;
            }
        } catch (err) {
            console.error(`[MKVDrama/Catalog] FlareSolverr site search failed: ${err.message}`);
        }
    }

    // Fallback 2: direct API catalog page search
    console.log(`[MKVDrama/Catalog] Trying direct API search...`);
    try {
        const data = await fetchOnePage(1, perPage);
        const pageResults = data._fromHtml ? (data.results || []) : extractEntries(data.results || []);
        const results = pageResults.filter(entry => {
            const title = (entry.title || '').toLowerCase();
            const altTitle = (entry.alternative_title || '').toLowerCase();
            const combined = `${title} ${altTitle}`;
            return combined.includes(queryLower) || queryWords.every(w => combined.includes(w));
        }).slice(0, 20);
        console.log(`[MKVDrama/Catalog] Direct API search for "${query}": ${results.length} results`);
        return results;
    } catch (err) {
        console.error(`[MKVDrama/Catalog] Direct API search failed: ${err.message}`);
        return [];
    }
}

export async function browserLoadContent(slug) {
    const cached = getCachedContent(slug);
    if (cached) {
        console.log(`[MKVDrama/Browser] Content cache HIT for "${slug}" (${cached.downloadLinks?.length || 0} links)`);
        return cached;
    }

    let page;
    try {
        const t0 = Date.now();
        const url = `${API_URL}/titles/${slug}/`;

        // Strategy: FlareSolverr first (its own CF session matches its TLS fingerprint,
        // so both page GET and _l_krc_uo POST XHR work). Puppeteer fallback second.
        // FlareSolverr cookies DON'T work in Puppeteer for XHR due to TLS fingerprint mismatch.

        // --- Attempt 1: FlareSolverr with wait=15s for XHR to complete ---
        if (FLARESOLVERR_URL) {
            try {
                const { default: axios } = await import('axios');
                const proxyNorm = normalizeProxy(FLARESOLVERR_PROXY_URL);
                const payload = {
                    cmd: 'request.get',
                    url,
                    maxTimeout: 60000,
                    wait: 15000, // Wait for JS to fire XHR and render download links
                    ...(proxyNorm ? { proxy: { url: proxyNorm } } : {})
                };
                console.log(`[MKVDrama/Browser] FlareSolverr loading content (wait=15s): ${url}`);
                const resp = await axios.post(`${FLARESOLVERR_URL}/v1`, payload, { timeout: 65000 });
                const sol = resp.data?.solution;
                if (sol?.response && sol.status === 200) {
                    // Update CF cookies
                    if (sol.cookies?.length) {
                        const cookie = sol.cookies.map(c => `${c.name}=${c.value}`).join('; ');
                        const ua = sol.userAgent || UA;
                        _catalogCfCookies = { cookie, ua, ts: Date.now() };
                    }

                    const html = sol.response;
                    const links = _extractLinksFromHtml(html);
                    // Extract title from HTML
                    let title = '';
                    if (_cheerioMod) {
                        const $ = _cheerioMod.load(html);
                        title = ($('h1.entry-title').text() || $('h1').first().text() || $('title').text() || '').trim();
                    }
                    console.log(`[MKVDrama/Browser] FlareSolverr extracted ${links.length} links for "${title.substring(0, 40)}" in ${Date.now() - t0}ms`);

                    if (links.length > 0) {
                        const result = { title, downloadLinks: links };
                        setCachedContent(slug, result);
                        return result;
                    }
                } else {
                    console.log(`[MKVDrama/Browser] FlareSolverr content load failed: status=${sol?.status}`);
                }
            } catch (err) {
                console.log(`[MKVDrama/Browser] FlareSolverr content load error: ${err.message}`);
            }
        }

        // --- Attempt 2: Puppeteer with FlareSolverr cookies (page GET works, XHR may not) ---
        page = await newPage();
        await ensureCfSession(page);
        console.log(`[MKVDrama/Browser] Puppeteer loading content: ${url}`);

        // Wait for the download-data XHR in parallel with page load
        let xhrStatus = null;
        const downloadDataPromise = page.waitForResponse(
            resp => {
                if (resp.url().includes('_l_krc_uo') || resp.url().includes('oe_pq_invxe_l')) {
                    xhrStatus = resp.status();
                    return resp.status() === 200;
                }
                return false;
            },
            { timeout: PAGE_WAIT_MS + 10000 }
        ).catch(() => null);

        let navResponse;
        try {
            navResponse = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: BROWSER_TIMEOUT_MS });
            console.log(`[MKVDrama/Browser] Navigation to ${slug}: HTTP ${navResponse?.status() || 'unknown'} in ${Date.now() - t0}ms`);
        } catch (navErr) {
            console.error(`[MKVDrama/Browser] Navigation failed for ${slug}: ${navErr.message}`);
            throw navErr;
        }

        // On 403, invalidate CF cookies and retry once
        if (navResponse?.status() === 403) {
            console.log(`[MKVDrama/Browser] Got 403, refreshing CF session...`);
            _cfCookies = null;
            _cfCookiesTs = 0;
            _catalogCfCookies = null;
            await ensureCfSession(page);
            try {
                navResponse = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: BROWSER_TIMEOUT_MS });
                console.log(`[MKVDrama/Browser] Retry ${slug}: HTTP ${navResponse?.status() || 'unknown'} in ${Date.now() - t0}ms`);
                if (navResponse?.status() === 403) {
                    return { title: '', downloadLinks: [] };
                }
            } catch {
                return { title: '', downloadLinks: [] };
            }
        }

        // Check for 404
        const pageTitle = await page.title();
        if (pageTitle.toLowerCase().includes('not found') || pageTitle.toLowerCase().includes('404')) {
            console.log(`[MKVDrama/Browser] Page not found for slug: ${slug}`);
            return { title: '', downloadLinks: [] };
        }

        // Wait for download data XHR
        const downloadResponse = await downloadDataPromise;
        if (downloadResponse) {
            console.log(`[MKVDrama/Browser] Download data XHR completed in ${Date.now() - t0}ms`);
            await new Promise(r => setTimeout(r, 1500));
        } else {
            console.log(`[MKVDrama/Browser] Download XHR not detected (xhr status: ${xhrStatus}), waiting for selectors...`);
            try {
                await page.waitForSelector('.soraddlx, .soraddl, .soradd', { timeout: PAGE_WAIT_MS });
                await new Promise(r => setTimeout(r, 500));
            } catch {
                console.log(`[MKVDrama/Browser] No download sections appeared within ${PAGE_WAIT_MS}ms`);
            }
        }

        // Extract download links from rendered page
        const rawResult = await page.evaluate(() => {
            const links = [];
            const seen = new Set();

            document.querySelectorAll('.soraddlx, .soraddl, .soradd').forEach(block => {
                const episodeLabel = (block.querySelector('.sorattlx h3, .sorattlx h4, .sorattlx, .sorattl, .soratt, h3, h4')?.textContent || '').trim();
                block.querySelectorAll('.soraurlx, .soraurl').forEach(urlBox => {
                    const quality = (urlBox.querySelector('strong, b')?.textContent || '').trim();
                    urlBox.querySelectorAll('a[href]').forEach(a => {
                        const href = a.href;
                        if (!href || href === '#' || href.startsWith('javascript:') || seen.has(href)) return;
                        seen.add(href);
                        links.push({ url: href, label: episodeLabel, quality, linkText: a.textContent.trim() });
                    });
                });
            });

            if (links.length === 0) {
                document.querySelectorAll('a[href]').forEach(a => {
                    const href = a.href || '';
                    if (/(ouo\.|oii\.la|pixeldrain|viewcrate|filecrypt)/.test(href) && !seen.has(href)) {
                        seen.add(href);
                        const container = a.closest('li, div, p');
                        const label = (container?.querySelector('strong, b, h3, h4')?.textContent || '').trim();
                        links.push({ url: href, label, quality: '', linkText: a.textContent.trim() });
                    }
                });
            }

            const title = (document.querySelector('h1.entry-title, h1, .series-title')?.textContent || document.title || '').trim();
            return { title, downloadLinks: links };
        });

        // If no links extracted from page but we have DB-cached _c/ links,
        // use this authenticated page context to resolve them via CDP.
        let linksToResolve = rawResult.downloadLinks;
        if (linksToResolve.length === 0 && SqliteCache.isEnabled()) {
            try {
                const dbCached = await SqliteCache.getCachedRecord('mkvdrama', `mkvdrama-content:${slug}`);
                if (dbCached?.data?.downloadLinks?.length) {
                    const dbCLinks = dbCached.data.downloadLinks.filter(l => l.url?.includes('/_c/'));
                    if (dbCLinks.length > 0) {
                        console.log(`[MKVDrama/Browser] Page had 0 links, using ${dbCLinks.length} DB-cached _c/ links for CDP resolution`);
                        linksToResolve = dbCached.data.downloadLinks;
                    }
                }
            } catch {}
        }

        // Resolve /_c/ redirect links via CDP network interception.
        // fetch() fails with CORS error because _c/ does a 302 to cross-origin (ouo.io).
        // CDP captures the Location header at the network level, bypassing CORS.
        const cLinks = linksToResolve.filter(l => l.url.includes('/_c/'));
        const resolvedLinks = [...linksToResolve.filter(l => !l.url.includes('/_c/'))];

        if (cLinks.length > 0) {
            console.log(`[MKVDrama/Browser] Resolving ${cLinks.length} _c links via CDP...`);
            const cT0 = Date.now();

            try {
                const client = await page.createCDPSession();
                await client.send('Network.enable');

                for (const link of cLinks) {
                    let redirectLocation = null;

                    const onRequestSent = (params) => {
                        // Capture redirect response Location header
                        if (params.redirectResponse) {
                            const loc = params.redirectResponse.headers?.location ||
                                        params.redirectResponse.headers?.Location || '';
                            if (loc && !loc.includes('mkvdrama.net')) {
                                redirectLocation = loc.split('?__cf_chl')[0];
                            }
                        }
                        // Also capture any request to an external domain (follow-up after redirect)
                        const reqUrl = params.request?.url || '';
                        if (reqUrl.startsWith('http') && !reqUrl.includes('mkvdrama.net') &&
                            !reqUrl.includes('cloudflare') && !reqUrl.includes('google') &&
                            !reqUrl.includes('gstatic') && !reqUrl.includes('jsdelivr')) {
                            if (!redirectLocation) redirectLocation = reqUrl.split('?__cf_chl')[0];
                        }
                    };

                    client.on('Network.requestWillBeSent', onRequestSent);

                    try {
                        // Trigger a navigation to the _c/ URL via fetch (it will fail due to CORS,
                        // but CDP captures the redirect before the CORS error)
                        await page.evaluate(async (url) => {
                            try { await fetch(url, { redirect: 'follow' }); } catch {}
                        }, link.url);
                        // Brief wait for CDP events to arrive
                        await new Promise(r => setTimeout(r, 300));
                    } catch {}

                    client.off('Network.requestWillBeSent', onRequestSent);

                    if (redirectLocation) {
                        console.log(`[MKVDrama/Browser] _c resolved (CDP): ${link.url.split('/_c/')[1]?.substring(0, 12)} → ${redirectLocation.substring(0, 80)}`);
                        resolvedLinks.push({ ...link, url: redirectLocation });
                    } else {
                        resolvedLinks.push(link);
                    }
                }

                await client.detach().catch(() => {});
            } catch (cdpErr) {
                console.log(`[MKVDrama/Browser] CDP resolution failed: ${cdpErr.message}`);
                // Keep remaining unresolved _c/ links as-is
                for (const link of cLinks) {
                    if (!resolvedLinks.some(r => r.url === link.url)) {
                        resolvedLinks.push(link);
                    }
                }
            }
            console.log(`[MKVDrama/Browser] Resolved ${resolvedLinks.filter(l => !l.url.includes('/_c/')).length}/${cLinks.length} _c links in ${Date.now() - cT0}ms`);
        }

        const result = { title: rawResult.title, downloadLinks: resolvedLinks };
        console.log(`[MKVDrama/Browser] Extracted ${result.downloadLinks.length} links for "${result.title}" in ${Date.now() - t0}ms`);
        setCachedContent(slug, result);
        return result;
    } catch (err) {
        console.error(`[MKVDrama/Browser] Content load failed for ${slug}: ${err.message}`);
        return { title: '', downloadLinks: [] };
    } finally {
        if (page) await page.close().catch(() => {});
    }
}

export async function closeBrowser() {
    if (_browser) {
        await _browser.close().catch(() => {});
        _browser = null;
    }
}

/**
 * Get CF cookies for mkvdrama.net — shared with the HTTP resolver.
 * Returns { cookie, ua } or null.
 */
export async function getMkvDramaCfSession() {
    return getCatalogCfCookies();
}

/**
 * Resolve a single /_c/ protected link using the Puppeteer browser session.
 * This is called at click-time by the HTTP resolver when raw HTTP fails.
 * @param {string} protectedUrl - The full mkvdrama.net /_c/ URL
 * @returns {string|null} - The resolved external URL, or null
 */
// Limit concurrent _c/ resolutions to avoid overwhelming the browser
let _resolveActive = 0;
const MAX_CONCURRENT_RESOLVES = 2;

// Per-title-page deduplication: when multiple resolutions request the same page,
// only one Puppeteer session loads it. Others wait and pick their link from the result.
const _titlePagePromises = new Map(); // titlePageUrl -> Promise<pageLinks[]>
const _titlePageLinksCache = new Map(); // titlePageUrl -> { links, ts }
const TITLE_PAGE_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Load a title page in Puppeteer and extract all download links.
 * Used by the dedup system so only one browser session loads a given page.
 */
/**
 * Extract download links from raw HTML (used by FlareSolverr path).
 */
function _extractLinksFromHtml(html) {
    const cheerio = _cheerioMod || null;
    if (!cheerio) return [];

    const $ = cheerio.load(html);
    const results = [];
    const seen = new Set();

    $('.soraddlx, .soraddl, .soradd').each((_, block) => {
        const episodeLabel = ($(block).find('.sorattlx h3, .sorattlx h4, .sorattlx, .sorattl, h3, h4').first().text() || '').trim();
        $(block).find('.soraurlx, .soraurl').each((_, urlBox) => {
            const quality = ($(urlBox).find('strong, b').first().text() || '').trim();
            $(urlBox).find('a[href]').each((_, a) => {
                const href = $(a).attr('href') || '';
                if (!href || href === '#' || href.startsWith('javascript:') || seen.has(href)) return;
                seen.add(href);
                results.push({ url: href, label: episodeLabel, quality, linkText: $(a).text().trim() });
            });
        });
    });

    // Fallback: look for external links directly
    if (results.length === 0) {
        $('a[href]').each((_, a) => {
            const href = $(a).attr('href') || '';
            if (/(ouo\.|oii\.la|pixeldrain|viewcrate|filecrypt)/.test(href) && !seen.has(href)) {
                seen.add(href);
                const container = $(a).closest('li, div, p');
                const label = (container.find('strong, b, h3, h4').first().text() || '').trim();
                results.push({ url: href, label, quality: '', linkText: $(a).text().trim() });
            }
        });
    }

    return results;
}

let _cheerioMod = null;
import('cheerio').then(m => { _cheerioMod = m; }).catch(() => {});

/**
 * Try FlareSolverr to load a title page and extract links.
 * Returns links array or null if FlareSolverr is unavailable/fails.
 */
async function _loadTitlePageViaFlaresolverr(titlePageUrl) {
    if (!FLARESOLVERR_URL) return null;
    const t0 = Date.now();
    try {
        const { default: axios } = await import('axios');
        const proxyNorm = normalizeProxy(FLARESOLVERR_PROXY_URL);
        const payload = {
            cmd: 'request.get',
            url: titlePageUrl,
            maxTimeout: 60000,
            // Wait 25s after page load for JS to fire XHR and render download links
            // (XHR to _l_krc_uo can take 15-25s after page load)
            wait: 25000,
            ...(proxyNorm ? { proxy: { url: proxyNorm } } : {})
        };
        console.log(`[MKVDrama/Browser] FlareSolverr loading title page (wait=15s): ${titlePageUrl}`);
        const resp = await axios.post(`${FLARESOLVERR_URL}/v1`, payload, { timeout: 65000 });
        const sol = resp.data?.solution;
        if (!sol?.response || sol.status !== 200) {
            console.log(`[MKVDrama/Browser] FlareSolverr failed: status=${sol?.status}, msg=${resp.data?.message || 'unknown'}`);
            return null;
        }

        // Update CF cookies from the successful solve
        if (sol.cookies?.length) {
            const cookie = sol.cookies.map(c => `${c.name}=${c.value}`).join('; ');
            const ua = sol.userAgent || UA;
            _catalogCfCookies = { cookie, ua, ts: Date.now() };
        }

        // The response HTML should contain the download links rendered by JS
        // However, mkvdrama loads download links via XHR after page load.
        // The FlareSolverr response may or may not include them depending on timing.
        const html = sol.response;
        const links = _extractLinksFromHtml(html);
        console.log(`[MKVDrama/Browser] FlareSolverr extracted ${links.length} links in ${Date.now() - t0}ms`);

        if (links.length > 0) return links;

        // If no download sections in the initial HTML, we need to fetch the XHR data.
        // Extract the dataPath and guardKey from the page to make the API call.
        const dataPathMatch = html.match(/['"](\/titles\/[^'"]+\/_l_krc_uo)['"]/);
        const guardKeyMatch = html.match(/['"](_[a-f0-9]{16,})['"]/);
        if (dataPathMatch && guardKeyMatch) {
            console.log(`[MKVDrama/Browser] FlareSolverr: fetching download XHR data...`);
            const dataPath = dataPathMatch[1];
            const guardKey = guardKeyMatch[1];
            const xhrPayload = {
                cmd: 'request.post',
                url: `${API_URL}${dataPath}`,
                maxTimeout: 30000,
                postData: JSON.stringify({ [guardKey]: 1 }),
                ...(proxyNorm ? { proxy: { url: proxyNorm } } : {})
            };
            try {
                const xhrResp = await axios.post(`${FLARESOLVERR_URL}/v1`, xhrPayload, {
                    timeout: 35000,
                    headers: { 'Content-Type': 'application/json' }
                });
                const xhrSol = xhrResp.data?.solution;
                if (xhrSol?.response) {
                    // Try to parse the XHR response which should contain download HTML
                    let xhrData;
                    try { xhrData = JSON.parse(xhrSol.response); } catch { xhrData = null; }
                    if (xhrData?.data) {
                        const xhrLinks = _extractLinksFromHtml(xhrData.data);
                        if (xhrLinks.length > 0) {
                            console.log(`[MKVDrama/Browser] FlareSolverr XHR extracted ${xhrLinks.length} links in ${Date.now() - t0}ms`);
                            return xhrLinks;
                        }
                    }
                }
            } catch (xhrErr) {
                console.log(`[MKVDrama/Browser] FlareSolverr XHR failed: ${xhrErr.message}`);
            }
        }

        console.log(`[MKVDrama/Browser] FlareSolverr: no download links found in page`);
        return null;
    } catch (err) {
        console.log(`[MKVDrama/Browser] FlareSolverr title page failed: ${err.message}`);
        return null;
    }
}

async function _loadTitlePageLinks(titlePageUrl) {
    // Try FlareSolverr first — it can reliably bypass CF with proxy
    const flareLinks = await _loadTitlePageViaFlaresolverr(titlePageUrl);
    if (flareLinks && flareLinks.length > 0) {
        return flareLinks;
    }

    // Fallback: Puppeteer
    let page;
    try {
        const t0 = Date.now();
        page = await newPage();
        await ensureCfSession(page);

        console.log(`[MKVDrama/Browser] Puppeteer loading title page: ${titlePageUrl}`);

        // Wait for the download-data XHR in parallel with page load
        const downloadDataPromise = page.waitForResponse(
            resp => resp.url().includes('oe_pq_invxe_l') && resp.status() === 200,
            { timeout: PAGE_WAIT_MS }
        ).catch(() => null);

        let navResponse;
        try {
            navResponse = await page.goto(titlePageUrl, { waitUntil: 'domcontentloaded', timeout: BROWSER_TIMEOUT_MS });
            console.log(`[MKVDrama/Browser] Title page nav: HTTP ${navResponse?.status() || 'unknown'} in ${Date.now() - t0}ms`);
        } catch (navErr) {
            console.log(`[MKVDrama/Browser] Title page nav warning: ${navErr.message}`);
        }

        // On 403 or CF challenge title, invalidate cookies and retry
        const isCfBlocked = navResponse?.status() === 403;
        let pageTitle = await page.title().catch(() => 'unknown');
        const isCfChallenge = pageTitle.includes('Just a moment') || pageTitle.includes('Checking');

        if (isCfBlocked || isCfChallenge) {
            console.log(`[MKVDrama/Browser] CF block on title page (status=${navResponse?.status()}, title="${pageTitle}"), refreshing cookies...`);
            _cfCookies = null;
            _cfCookiesTs = 0;
            _catalogCfCookies = null;
            await ensureCfSession(page);

            try {
                navResponse = await page.goto(titlePageUrl, { waitUntil: 'domcontentloaded', timeout: BROWSER_TIMEOUT_MS });
                console.log(`[MKVDrama/Browser] Title page retry: HTTP ${navResponse?.status() || 'unknown'} in ${Date.now() - t0}ms`);
            } catch { /* ignore nav timeout */ }

            pageTitle = await page.title().catch(() => 'unknown');
            if (navResponse?.status() === 403 || pageTitle.includes('Just a moment') || pageTitle.includes('Checking')) {
                console.log(`[MKVDrama/Browser] Still blocked after CF refresh, waiting for stealth (15s)...`);
                try {
                    await page.waitForFunction(
                        () => !document.title.includes('Just a moment') && !document.title.includes('Checking'),
                        { timeout: 15000 }
                    );
                    _cfCookies = await page.cookies();
                    _cfCookiesTs = Date.now();
                    console.log(`[MKVDrama/Browser] CF challenge cleared: ${await page.title().catch(() => '?')}`);
                } catch {
                    console.log(`[MKVDrama/Browser] CF challenge did not clear after 15s`);
                    return [];
                }
            }
        }

        // Wait for download data XHR
        const downloadResponse = await downloadDataPromise;
        if (downloadResponse) {
            console.log(`[MKVDrama/Browser] Download XHR completed in ${Date.now() - t0}ms`);
            await new Promise(r => setTimeout(r, 1500));
        } else {
            console.log(`[MKVDrama/Browser] Download XHR not detected, waiting for selectors...`);
            try {
                await page.waitForSelector('.soraddlx, .soraddl, .soradd', { timeout: PAGE_WAIT_MS });
                await new Promise(r => setTimeout(r, 500));
            } catch {
                const currentTitle = await page.title().catch(() => '');
                console.log(`[MKVDrama/Browser] No download sections appeared (page title: "${currentTitle}")`);
            }
        }

        // Extract all links from the rendered page
        const links = await page.evaluate(() => {
            const results = [];
            const seen = new Set();
            document.querySelectorAll('.soraddlx, .soraddl, .soradd').forEach(block => {
                const episodeLabel = (block.querySelector('.sorattlx h3, .sorattlx h4, .sorattlx, .sorattl, h3, h4')?.textContent || '').trim();
                block.querySelectorAll('.soraurlx, .soraurl').forEach(urlBox => {
                    const quality = (urlBox.querySelector('strong, b')?.textContent || '').trim();
                    urlBox.querySelectorAll('a[href]').forEach(a => {
                        const href = a.href;
                        if (!href || href === '#' || href.startsWith('javascript:') || seen.has(href)) return;
                        seen.add(href);
                        results.push({ url: href, label: episodeLabel, quality, linkText: a.textContent.trim() });
                    });
                });
            });

            if (results.length === 0) {
                document.querySelectorAll('a[href]').forEach(a => {
                    const href = a.href || '';
                    if (/(ouo\.|oii\.la|pixeldrain|viewcrate|filecrypt)/.test(href) && !seen.has(href)) {
                        seen.add(href);
                        const container = a.closest('li, div, p');
                        const label = (container?.querySelector('strong, b, h3, h4')?.textContent || '').trim();
                        results.push({ url: href, label, quality: '', linkText: a.textContent.trim() });
                    }
                });
            }

            return results;
        });

        console.log(`[MKVDrama/Browser] Extracted ${links.length} raw links from ${titlePageUrl} in ${Date.now() - t0}ms`);

        // If no links from page, try DB-cached _c/ links (resolve via CDP on this authenticated page)
        let linksForCdp = links;
        if (links.length === 0 && SqliteCache.isEnabled()) {
            try {
                const slug = titlePageUrl.split('/titles/')[1]?.replace(/\/$/, '') || '';
                if (slug) {
                    const dbCached = await SqliteCache.getCachedRecord('mkvdrama', `mkvdrama-content:${slug}`);
                    if (dbCached?.data?.downloadLinks?.length) {
                        const dbCLinks = dbCached.data.downloadLinks.filter(l => l.url?.includes('/_c/'));
                        if (dbCLinks.length > 0) {
                            console.log(`[MKVDrama/Browser] Page had 0 links, using ${dbCLinks.length} DB-cached _c/ links for CDP resolution`);
                            linksForCdp = dbCached.data.downloadLinks;
                        }
                    }
                }
            } catch {}
        }

        // Resolve _c/ links within the same page context (CF cookies are valid here)
        const cLinks = linksForCdp.filter(l => l.url.includes('/_c/'));
        if (cLinks.length > 0) {
            console.log(`[MKVDrama/Browser] Resolving ${cLinks.length} _c/ links via CDP...`);
            const resolvedLinks = [...links.filter(l => !l.url.includes('/_c/'))];
            try {
                const client = await page.createCDPSession();
                await client.send('Network.enable');

                for (const link of cLinks) {
                    let redirectLocation = null;
                    const onRequestSent = (params) => {
                        if (params.redirectResponse) {
                            const loc = params.redirectResponse.headers?.location ||
                                        params.redirectResponse.headers?.Location || '';
                            if (loc && !loc.includes('mkvdrama.net')) {
                                redirectLocation = loc.split('?__cf_chl')[0];
                            }
                        }
                        const reqUrl = params.request?.url || '';
                        if (reqUrl.startsWith('http') && !reqUrl.includes('mkvdrama.net') &&
                            !reqUrl.includes('cloudflare') && !reqUrl.includes('google') &&
                            !reqUrl.includes('gstatic') && !reqUrl.includes('jsdelivr')) {
                            if (!redirectLocation) redirectLocation = reqUrl.split('?__cf_chl')[0];
                        }
                    };
                    client.on('Network.requestWillBeSent', onRequestSent);
                    try {
                        await page.evaluate(async (url) => {
                            try { await fetch(url, { redirect: 'follow' }); } catch {}
                        }, link.url);
                        await new Promise(r => setTimeout(r, 300));
                    } catch {}
                    client.off('Network.requestWillBeSent', onRequestSent);

                    if (redirectLocation) {
                        console.log(`[MKVDrama/Browser] _c/ resolved (CDP): ${link.url.split('/_c/')[1]?.substring(0, 12)} → ${redirectLocation.substring(0, 80)}`);
                        resolvedLinks.push({ ...link, url: redirectLocation });
                    } else {
                        resolvedLinks.push(link);
                    }
                }
                await client.detach().catch(() => {});
            } catch (cdpErr) {
                console.log(`[MKVDrama/Browser] CDP resolution failed: ${cdpErr.message}`);
                for (const link of cLinks) {
                    if (!resolvedLinks.some(r => r.url === link.url)) resolvedLinks.push(link);
                }
            }
            console.log(`[MKVDrama/Browser] Resolved ${cLinks.length} _c/ links in ${Date.now() - t0}ms`);
            return resolvedLinks;
        }

        return links;
    } catch (err) {
        console.error(`[MKVDrama/Browser] Failed to load title page ${titlePageUrl}: ${err.message}`);
        return [];
    } finally {
        if (page) await page.close().catch(() => {});
    }
}

/**
 * Navigate to a single link (either external or _c/ redirect) and return the final URL.
 * Opens its own Puppeteer page for the _c/ navigation.
 */
async function _navigateToLink(targetLink, hints, protectedUrl) {
    // If the link is already an external URL, return it directly
    if (!targetLink.url.includes('mkvdrama.net')) {
        console.log(`[MKVDrama/Browser] Link is already external: ${targetLink.url.substring(0, 100)}`);
        return targetLink.url;
    }

    if (!targetLink.url.includes('/_c/')) {
        console.log(`[MKVDrama/Browser] Link is not a _c/ link, returning as-is: ${targetLink.url.substring(0, 100)}`);
        return targetLink.url;
    }

    // Try FlareSolverr first for _c/ resolution (follows redirects reliably through CF)
    if (FLARESOLVERR_URL) {
        try {
            const { default: axios } = await import('axios');
            const proxyNorm = normalizeProxy(FLARESOLVERR_PROXY_URL);
            const t0 = Date.now();
            console.log(`[MKVDrama/Browser] FlareSolverr resolving _c link: ${targetLink.url.substring(0, 100)}`);
            const resp = await axios.post(`${FLARESOLVERR_URL}/v1`, {
                cmd: 'request.get',
                url: targetLink.url,
                maxTimeout: 30000,
                ...(proxyNorm ? { proxy: { url: proxyNorm } } : {})
            }, { timeout: 35000 });
            const sol = resp.data?.solution;
            if (sol) {
                // Check if FlareSolverr followed the redirect to an external URL
                const finalUrl = sol.url || '';
                if (finalUrl && !finalUrl.includes('mkvdrama.net')) {
                    console.log(`[MKVDrama/Browser] FlareSolverr _c resolved to: ${finalUrl.substring(0, 100)} in ${Date.now() - t0}ms`);
                    return finalUrl.split('?__cf_chl')[0];
                }
                // Check response body for redirect URLs
                const body = sol.response || '';
                const urlMatch = body.match(/(https?:\/\/(?:ouo\.|oii\.la|pixeldrain|viewcrate|filecrypt)[^\s"'<>]+)/i);
                if (urlMatch) {
                    console.log(`[MKVDrama/Browser] FlareSolverr found redirect in body: ${urlMatch[1].substring(0, 100)} in ${Date.now() - t0}ms`);
                    return urlMatch[1];
                }
                console.log(`[MKVDrama/Browser] FlareSolverr _c: no external redirect found (finalUrl: ${finalUrl.substring(0, 80)})`);
            }
        } catch (err) {
            console.log(`[MKVDrama/Browser] FlareSolverr _c failed: ${err.message}`);
        }
    }

    // Fallback: Puppeteer
    let page;
    try {
        const t0 = Date.now();
        page = await newPage();
        await ensureCfSession(page);

        console.log(`[MKVDrama/Browser] Puppeteer navigating to _c link: ${targetLink.url.substring(0, 100)}`);

        try {
            const response = await page.goto(targetLink.url, {
                waitUntil: 'domcontentloaded',
                timeout: 30000
            });

            let currentUrl = page.url();
            console.log(`[MKVDrama/Browser] After _c navigation: ${currentUrl.substring(0, 120)} (status: ${response?.status()})`);

            if (currentUrl.includes('mkvdrama.net')) {
                const title = await page.title().catch(() => '');
                if (title.includes('Just a moment') || title.includes('Checking') || response?.status() === 403) {
                    console.log(`[MKVDrama/Browser] CF challenge on _c link, waiting for clearance...`);
                    try {
                        await page.waitForFunction(
                            () => !window.location.href.includes('mkvdrama.net') ||
                                  (!document.title.includes('Just a moment') && !document.title.includes('Checking')),
                            { timeout: 30000 }
                        );
                        currentUrl = page.url();
                        console.log(`[MKVDrama/Browser] After CF wait: ${currentUrl.substring(0, 120)}`);
                    } catch {
                        console.log(`[MKVDrama/Browser] CF wait timed out on _c link`);
                    }
                }

                if (!currentUrl.includes('mkvdrama.net')) {
                    console.log(`[MKVDrama/Browser] _c resolved to external in ${Date.now() - t0}ms: ${currentUrl.substring(0, 100)}`);
                    return currentUrl.split('?__cf_chl')[0];
                }

                const bodyUrl = await page.evaluate(() => {
                    const meta = document.querySelector('meta[http-equiv="refresh"]');
                    if (meta) {
                        const match = meta.content.match(/url=(.+)/i);
                        if (match) return match[1];
                    }
                    const text = document.body?.innerText || '';
                    const urlMatch = text.match(/(https?:\/\/(?:ouo\.|pixeldrain|viewcrate|filecrypt)[^\s"'<>]+)/i);
                    return urlMatch?.[1] || null;
                }).catch(() => null);

                if (bodyUrl) {
                    console.log(`[MKVDrama/Browser] Found redirect URL in page: ${bodyUrl.substring(0, 100)}`);
                    return bodyUrl;
                }
            } else {
                console.log(`[MKVDrama/Browser] _c resolved to external in ${Date.now() - t0}ms: ${currentUrl.substring(0, 100)}`);
                return currentUrl.split('?__cf_chl')[0];
            }
        } catch (navErr) {
            const currentUrl = page.url();
            if (!currentUrl.includes('mkvdrama.net') && currentUrl.startsWith('http')) {
                console.log(`[MKVDrama/Browser] _c resolved (via nav error): ${currentUrl.substring(0, 100)}`);
                return currentUrl.split('?__cf_chl')[0];
            }
            console.log(`[MKVDrama/Browser] _c navigation failed: ${navErr.message}`);
        }

        console.log(`[MKVDrama/Browser] _c link resolution failed`);
        return null;
    } catch (err) {
        console.error(`[MKVDrama/Browser] _navigateToLink failed: ${err.message}`);
        return null;
    } finally {
        if (page) await page.close().catch(() => {});
    }
}

export async function browserResolveProtectedLink(protectedUrl, hints = {}) {
    if (!protectedUrl || !protectedUrl.includes('/_c/')) return null;

    // Extract the title page URL for deduplication
    const titlePageUrl = protectedUrl.split('/_c/')[0] + '/';

    // Check if we already have fresh links for this title page
    const cachedPage = _titlePageLinksCache.get(titlePageUrl);
    if (cachedPage && Date.now() - cachedPage.ts < TITLE_PAGE_CACHE_TTL && cachedPage.links.length > 0) {
        console.log(`[MKVDrama/Browser] Using cached page links for ${titlePageUrl} (${cachedPage.links.length} links)`);
        const targetLink = pickBestMatchingLink(cachedPage.links, hints, protectedUrl);
        if (targetLink) {
            return await _navigateToLink(targetLink, hints, protectedUrl);
        }
        console.log(`[MKVDrama/Browser] No matching link in cached page for hints: ${JSON.stringify(hints)}`);
        return null;
    }

    // Check if another resolve is already loading this title page
    const inFlight = _titlePagePromises.get(titlePageUrl);
    if (inFlight) {
        console.log(`[MKVDrama/Browser] Waiting for in-flight page load: ${titlePageUrl}`);
        const pageLinks = await inFlight;
        if (pageLinks && pageLinks.length > 0) {
            const targetLink = pickBestMatchingLink(pageLinks, hints, protectedUrl);
            if (targetLink) {
                return await _navigateToLink(targetLink, hints, protectedUrl);
            }
        }
        console.log(`[MKVDrama/Browser] In-flight load returned no matching link for hints: ${JSON.stringify(hints)}`);
        return null;
    }

    // Wait if too many concurrent resolutions
    if (_resolveActive >= MAX_CONCURRENT_RESOLVES) {
        console.log(`[MKVDrama/Browser] Resolve queue full (${_resolveActive}/${MAX_CONCURRENT_RESOLVES}), waiting...`);
        await new Promise(r => {
            const check = () => {
                if (_resolveActive < MAX_CONCURRENT_RESOLVES) r();
                else setTimeout(check, 500);
            };
            check();
        });
        // After waiting, check if someone else loaded the page while we waited
        const freshCached = _titlePageLinksCache.get(titlePageUrl);
        if (freshCached && Date.now() - freshCached.ts < TITLE_PAGE_CACHE_TTL && freshCached.links.length > 0) {
            console.log(`[MKVDrama/Browser] Page loaded while waiting in queue: ${titlePageUrl}`);
            const targetLink = pickBestMatchingLink(freshCached.links, hints, protectedUrl);
            if (targetLink) {
                return await _navigateToLink(targetLink, hints, protectedUrl);
            }
            return null;
        }
    }
    _resolveActive++;

    // Load the title page and extract all links (with dedup promise)
    const pageLoadPromise = _loadTitlePageLinks(titlePageUrl);
    _titlePagePromises.set(titlePageUrl, pageLoadPromise);

    let pageLinks;
    try {
        pageLinks = await pageLoadPromise;
    } finally {
        _titlePagePromises.delete(titlePageUrl);
    }

    if (!pageLinks || pageLinks.length === 0) {
        _resolveActive--;
        const slug = titlePageUrl.split('/titles/')[1]?.replace(/\/$/, '') || '';
        if (slug) {
            // Use browserLoadContent which opens a fresh page and resolves DB-cached _c/ links via CDP
            try {
                console.log(`[MKVDrama/Browser] No live links from title page, trying browserLoadContent for ${slug}...`);
                const content = await browserLoadContent(slug);
                if (content?.downloadLinks?.length) {
                    console.log(`[MKVDrama/Browser] browserLoadContent got ${content.downloadLinks.length} links for ${slug}`);
                    pageLinks = content.downloadLinks;
                    _titlePageLinksCache.set(titlePageUrl, { links: pageLinks, ts: Date.now() });
                }
            } catch (err) {
                console.log(`[MKVDrama/Browser] browserLoadContent fallback failed: ${err.message}`);
            }
            // If browserLoadContent also failed, try DB/memory caches as last resort
            if (!pageLinks || pageLinks.length === 0) {
                try {
                    if (SqliteCache.isEnabled()) {
                        const dbCached = await SqliteCache.getCachedRecord('mkvdrama', `mkvdrama-content:${slug}`);
                        if (dbCached?.data?.downloadLinks?.length) {
                            console.log(`[MKVDrama/Browser] Using ${dbCached.data.downloadLinks.length} DB-cached content links for ${slug}`);
                            pageLinks = dbCached.data.downloadLinks;
                            _titlePageLinksCache.set(titlePageUrl, { links: pageLinks, ts: Date.now() });
                        }
                    }
                } catch {}
                if (!pageLinks || pageLinks.length === 0) {
                    const cached = getCachedContent(slug);
                    if (cached?.downloadLinks?.length) {
                        console.log(`[MKVDrama/Browser] Using ${cached.downloadLinks.length} in-memory cached links for ${slug}`);
                        pageLinks = cached.downloadLinks;
                        _titlePageLinksCache.set(titlePageUrl, { links: pageLinks, ts: Date.now() });
                    }
                }
            }
        }
        if (!pageLinks || pageLinks.length === 0) {
            console.log(`[MKVDrama/Browser] No links extracted from page: ${titlePageUrl}`);
            return null;
        }
    }

    // Cache the extracted links for other resolutions
    _titlePageLinksCache.set(titlePageUrl, { links: pageLinks, ts: Date.now() });
    console.log(`[MKVDrama/Browser] Cached ${pageLinks.length} links for ${titlePageUrl}`);

    // Find the best matching link based on hints (episode, resolution, host)
    const targetLink = pickBestMatchingLink(pageLinks, hints, protectedUrl);
    _resolveActive--;

    if (!targetLink) {
        console.log(`[MKVDrama/Browser] No matching link found for hints: ${JSON.stringify(hints)}`);
        return null;
    }

    console.log(`[MKVDrama/Browser] Matched link: ${targetLink.url.substring(0, 80)} (label: ${targetLink.label}, quality: ${targetLink.quality})`);
    return await _navigateToLink(targetLink, hints, protectedUrl);
}

/**
 * Pick the best matching link from page links based on hints from the original URL.
 */
function pickBestMatchingLink(pageLinks, hints, originalUrl) {
    if (!pageLinks || pageLinks.length === 0) return null;

    // Parse hints from the URL fragment (e.g., #ep=S01E03&res=480p&host=pixeldrain)
    const fragment = originalUrl.split('#')[1] || '';
    const params = new URLSearchParams(fragment);
    const hintEp = hints.episode || params.get('ep') || '';
    const hintRes = hints.resolution || params.get('res') || '';
    const hintHost = hints.host || params.get('host') || '';

    // Score each link
    let bestScore = -1;
    let bestLink = null;

    for (const link of pageLinks) {
        let score = 0;
        const labelLower = (link.label + ' ' + link.quality + ' ' + link.linkText).toLowerCase();

        // Episode match
        if (hintEp) {
            const epLower = hintEp.toLowerCase();
            if (labelLower.includes(epLower)) score += 10;
            // Try just the episode number (e.g., "E03" or "03")
            const epNum = epLower.replace(/.*e(\d+).*/, '$1');
            if (epNum && labelLower.includes(epNum)) score += 5;
        }

        // Resolution match
        if (hintRes) {
            if (labelLower.includes(hintRes.toLowerCase())) score += 5;
        }

        // Host match (prefer pixeldrain over OUO, etc.)
        if (hintHost) {
            if (link.linkText.toLowerCase().includes(hintHost.toLowerCase())) score += 3;
            if (link.url.toLowerCase().includes(hintHost.toLowerCase())) score += 3;
        }

        if (score > bestScore) {
            bestScore = score;
            bestLink = link;
        }
    }

    // If no hints matched at all, return the first _c/ link
    if (bestScore <= 0) {
        return pageLinks.find(l => l.url.includes('/_c/')) || pageLinks[0];
    }

    return bestLink;
}
