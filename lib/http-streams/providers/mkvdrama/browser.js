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
import * as SqliteCache from '../../../util/cache-store.js';

puppeteerExtra.use(StealthPlugin());

const PROXY_URL = process.env.MKVDRAMA_BROWSER_PROXY_URL
    || process.env.MKVDRAMA_DIRECT_PROXY_URL
    || 'socks5://100.109.163.45:1080';
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
            const proxyNorm = normalizeProxy(PROXY_URL);
            const payload = {
                cmd: 'request.get',
                url: `${API_URL}/titles/?page=1&per_page=1`,
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

async function fetchOnePage(pageNum, perPage) {
    const url = `${API_URL}/titles/?page=${pageNum}&per_page=${perPage}`;

    // Try direct first
    try {
        const body = await _httpGetJson(url);
        return JSON.parse(body);
    } catch (directErr) {
        // Only try CF bypass on 403
        if (!directErr.message.includes('403')) {
            throw new Error(`${directErr.message} on page ${pageNum}`);
        }
    }

    // Get CF cookies and retry
    const cf = await getCatalogCfCookies();
    if (!cf) throw new Error(`HTTP 403 on page ${pageNum}`);

    try {
        const body = await _httpGetJson(url, { 'Cookie': cf.cookie, 'User-Agent': cf.ua });
        return JSON.parse(body);
    } catch (retryErr) {
        throw new Error(`${retryErr.message} on page ${pageNum} (with CF cookies)`);
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
    const entries = extractEntries(firstData.results || []);

    if (totalPages <= 1) {
        console.log(`[MKVDrama/Catalog] Fetched ${entries.length} entries in 1 page (${Date.now() - t0}ms)`);
        return entries;
    }

    console.log(`[MKVDrama/Catalog] Total: ${total} entries across ${totalPages} pages, fetching sequentially...`);

    // Fetch remaining pages sequentially (SOCKS proxy hangs with concurrent connections)
    for (let p = 2; p <= totalPages; p++) {
        try {
            const data = await fetchOnePage(p, perPage);
            entries.push(...extractEntries(data.results || []));
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

// ─── Puppeteer (only for content pages) ───

async function launchBrowser() {
    const proxyNormalized = normalizeProxy(PROXY_URL);
    const args = [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-images',
        '--blink-settings=imagesEnabled=false',
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

    // Fallback: direct API search (no catalog available)
    console.log(`[MKVDrama/Catalog] No catalog available, trying direct API search...`);
    try {
        const data = await fetchOnePage(1, perPage);
        const results = (data.results || []).filter(entry => {
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
        page = await newPage();
        await ensureCfSession(page);
        const url = `${API_URL}/titles/${slug}/`;
        console.log(`[MKVDrama/Browser] Loading content: ${url}`);

        // Wait for the download-data XHR in parallel with page load
        const downloadDataPromise = page.waitForResponse(
            resp => resp.url().includes('oe_pq_invxe_l') && resp.status() === 200,
            { timeout: PAGE_WAIT_MS }
        ).catch(() => null);

        let navResponse;
        try {
            navResponse = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: BROWSER_TIMEOUT_MS });
            console.log(`[MKVDrama/Browser] Navigation to ${slug}: HTTP ${navResponse?.status() || 'unknown'} in ${Date.now() - t0}ms`);
        } catch (navErr) {
            const currentUrl = page.url();
            const title = await page.title().catch(() => 'unknown');
            console.error(`[MKVDrama/Browser] Navigation failed for ${slug}: ${navErr.message} (currentUrl: ${currentUrl}, title: ${title})`);
            throw navErr;
        }

        // On 403, invalidate CF cookies and retry once with fresh ones
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
                    console.log(`[MKVDrama/Browser] Still 403 after CF refresh, giving up`);
                    return { title: '', downloadLinks: [] };
                }
            } catch (retryErr) {
                console.error(`[MKVDrama/Browser] Retry navigation failed for ${slug}: ${retryErr.message}`);
                return { title: '', downloadLinks: [] };
            }
        }

        // Check for 404
        const pageTitle = await page.title();
        if (pageTitle.toLowerCase().includes('not found') || pageTitle.toLowerCase().includes('404')) {
            console.log(`[MKVDrama/Browser] Page not found for slug: ${slug}`);
            return { title: '', downloadLinks: [] };
        }

        // Wait for download data XHR, then brief pause for JS to render
        const downloadResponse = await downloadDataPromise;
        if (downloadResponse) {
            console.log(`[MKVDrama/Browser] Download data XHR completed in ${Date.now() - t0}ms`);
            await new Promise(r => setTimeout(r, 1500));
        } else {
            console.log(`[MKVDrama/Browser] Download XHR not detected, waiting for selectors...`);
            try {
                await page.waitForSelector('.soraddlx, .soraddl, .soradd', { timeout: PAGE_WAIT_MS });
                await new Promise(r => setTimeout(r, 500));
            } catch {
                console.log(`[MKVDrama/Browser] No download sections appeared within ${PAGE_WAIT_MS}ms`);
            }
        }

        // Extract download links
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

        // Resolve /_c/ redirect links via Puppeteer (CF blocks raw HTTP on .net)
        const cLinks = rawResult.downloadLinks.filter(l => l.url.includes('/_c/'));
        const resolvedLinks = [...rawResult.downloadLinks.filter(l => !l.url.includes('/_c/'))];

        if (cLinks.length > 0) {
            console.log(`[MKVDrama/Browser] Resolving ${cLinks.length} _c links via Puppeteer...`);
            const cT0 = Date.now();

            for (const link of cLinks) {
                try {
                    // Use page.evaluate to fetch the _c/ link with the browser's cookies/session
                    const resolved = await page.evaluate(async (url) => {
                        try {
                            const resp = await fetch(url, { method: 'GET', redirect: 'manual' });
                            const location = resp.headers.get('location');
                            if (location && !location.includes('/_c/')) {
                                return location.split('?__cf_chl')[0];
                            }
                            // If redirect didn't work, try following
                            if (resp.status >= 300 && resp.status < 400 && location) {
                                return location.split('?__cf_chl')[0];
                            }
                        } catch { /* ignore */ }
                        return null;
                    }, link.url);

                    if (resolved) {
                        resolvedLinks.push({ ...link, url: resolved });
                    } else {
                        resolvedLinks.push(link);
                    }
                } catch {
                    resolvedLinks.push(link);
                }
            }
            console.log(`[MKVDrama/Browser] Resolved ${cLinks.length} _c links in ${Date.now() - cT0}ms`);
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

export async function browserResolveProtectedLink(protectedUrl, hints = {}) {
    if (!protectedUrl || !protectedUrl.includes('/_c/')) return null;

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
    }
    _resolveActive++;

    let page;
    try {
        const t0 = Date.now();
        page = await newPage();
        await ensureCfSession(page);

        // Extract the title slug from the _c/ link
        const urlParts = protectedUrl.split('/_c/');
        const titlePageUrl = urlParts[0] + '/';
        console.log(`[MKVDrama/Browser] Resolving _c link via full page load: ${titlePageUrl}`);

        // Wait for the download-data XHR in parallel with page load
        const downloadDataPromise = page.waitForResponse(
            resp => resp.url().includes('oe_pq_invxe_l') && resp.status() === 200,
            { timeout: PAGE_WAIT_MS }
        ).catch(() => null);

        try {
            await page.goto(titlePageUrl, { waitUntil: 'domcontentloaded', timeout: BROWSER_TIMEOUT_MS });
        } catch (navErr) {
            console.log(`[MKVDrama/Browser] Title page nav warning: ${navErr.message}`);
        }

        // Wait for CF challenge to clear if present
        let pageTitle = await page.title().catch(() => 'unknown');
        if (pageTitle.includes('Just a moment') || pageTitle.includes('Checking')) {
            console.log(`[MKVDrama/Browser] CF challenge on title page, invalidating cached cookies and retrying...`);
            // Invalidate stale CF cookies
            _cfCookies = null;
            _cfCookiesTs = 0;
            _catalogCfCookies = null;

            // Get fresh cookies from FlareSolverr and retry the navigation
            const freshCf = await getCatalogCfCookies();
            if (freshCf) {
                const domain = new URL(API_URL).hostname;
                const puppeteerCookies = freshCf.cookie.split('; ').map(pair => {
                    const [name, ...rest] = pair.split('=');
                    return { name, value: rest.join('='), domain: `.${domain}`, path: '/' };
                });
                await page.setUserAgent(freshCf.ua);
                await page.setCookie(...puppeteerCookies);
                _cfCookies = puppeteerCookies;
                _cfCookiesTs = Date.now();
                console.log(`[MKVDrama/Browser] Got fresh CF cookies, retrying navigation...`);
                try {
                    await page.goto(titlePageUrl, { waitUntil: 'domcontentloaded', timeout: BROWSER_TIMEOUT_MS });
                } catch { /* ignore nav timeout */ }
                pageTitle = await page.title().catch(() => 'unknown');
            }

            // If still challenged, wait for Puppeteer stealth to handle it
            if (pageTitle.includes('Just a moment') || pageTitle.includes('Checking')) {
                console.log(`[MKVDrama/Browser] Still challenged, waiting for stealth to solve (15s)...`);
                try {
                    await page.waitForFunction(
                        () => !document.title.includes('Just a moment') && !document.title.includes('Checking'),
                        { timeout: 15000 }
                    );
                    _cfCookies = await page.cookies();
                    _cfCookiesTs = Date.now();
                    console.log(`[MKVDrama/Browser] CF challenge cleared: ${await page.title().catch(() => '?')}`);
                } catch {
                    console.log(`[MKVDrama/Browser] CF challenge did not clear`);
                    return null;
                }
            }
        }

        // Wait for download data XHR — the _c/ tokens are session-bound
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
                console.log(`[MKVDrama/Browser] No download sections appeared`);
                return null;
            }
        }

        // Extract all _c/ links from the rendered page (these are fresh session-bound tokens)
        const pageLinks = await page.evaluate(() => {
            const links = [];
            const seen = new Set();
            document.querySelectorAll('.soraddlx, .soraddl, .soradd').forEach(block => {
                const episodeLabel = (block.querySelector('.sorattlx h3, .sorattlx h4, .sorattlx, .sorattl, h3, h4')?.textContent || '').trim();
                block.querySelectorAll('.soraurlx, .soraurl').forEach(urlBox => {
                    const quality = (urlBox.querySelector('strong, b')?.textContent || '').trim();
                    urlBox.querySelectorAll('a[href]').forEach(a => {
                        const href = a.href;
                        if (!href || href === '#' || seen.has(href)) return;
                        seen.add(href);
                        links.push({ url: href, label: episodeLabel, quality, linkText: a.textContent.trim() });
                    });
                });
            });
            return links;
        });

        console.log(`[MKVDrama/Browser] Found ${pageLinks.length} links on page`);

        // Find the best matching link based on hints (episode, resolution, host)
        const targetLink = pickBestMatchingLink(pageLinks, hints, protectedUrl);
        if (!targetLink) {
            console.log(`[MKVDrama/Browser] No matching link found for hints: ${JSON.stringify(hints)}`);
            return null;
        }

        console.log(`[MKVDrama/Browser] Matched link: ${targetLink.url.substring(0, 80)} (label: ${targetLink.label}, quality: ${targetLink.quality})`);

        // If the link is already an external URL (not _c/), return it directly
        if (!targetLink.url.includes('mkvdrama.net')) {
            console.log(`[MKVDrama/Browser] Link is already external in ${Date.now() - t0}ms: ${targetLink.url.substring(0, 100)}`);
            return targetLink.url;
        }

        // Resolve the _c/ link by navigating to it and following through CF challenges
        if (targetLink.url.includes('/_c/')) {
            console.log(`[MKVDrama/Browser] Navigating to _c link: ${targetLink.url.substring(0, 100)}`);

            // Navigate and wait — the _c/ link should redirect through CF to an external URL
            try {
                const response = await page.goto(targetLink.url, {
                    waitUntil: 'domcontentloaded',
                    timeout: 30000
                });

                // Check if we ended up on an external URL
                let currentUrl = page.url();
                console.log(`[MKVDrama/Browser] After _c navigation: ${currentUrl.substring(0, 120)} (status: ${response?.status()})`);

                // If still on mkvdrama (CF challenge page), wait for it to resolve
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

                    // After CF clears, the page might have redirected or contain the target URL
                    if (!currentUrl.includes('mkvdrama.net')) {
                        console.log(`[MKVDrama/Browser] _c resolved to external in ${Date.now() - t0}ms: ${currentUrl.substring(0, 100)}`);
                        return currentUrl.split('?__cf_chl')[0];
                    }

                    // Check if the page body contains the redirect URL
                    const bodyUrl = await page.evaluate(() => {
                        // Check meta refresh
                        const meta = document.querySelector('meta[http-equiv="refresh"]');
                        if (meta) {
                            const match = meta.content.match(/url=(.+)/i);
                            if (match) return match[1];
                        }
                        // Check for JS redirect in scripts
                        const text = document.body?.innerText || '';
                        const urlMatch = text.match(/(https?:\/\/(?:ouo\.|pixeldrain|viewcrate|filecrypt)[^\s"'<>]+)/i);
                        return urlMatch?.[1] || null;
                    }).catch(() => null);

                    if (bodyUrl) {
                        console.log(`[MKVDrama/Browser] Found redirect URL in page: ${bodyUrl.substring(0, 100)}`);
                        return bodyUrl;
                    }
                } else {
                    // We landed on an external URL directly
                    console.log(`[MKVDrama/Browser] _c resolved to external in ${Date.now() - t0}ms: ${currentUrl.substring(0, 100)}`);
                    return currentUrl.split('?__cf_chl')[0];
                }
            } catch (navErr) {
                // Navigation might fail if the redirect goes cross-origin — check the URL
                const currentUrl = page.url();
                if (!currentUrl.includes('mkvdrama.net') && currentUrl.startsWith('http')) {
                    console.log(`[MKVDrama/Browser] _c resolved (via nav error) in ${Date.now() - t0}ms: ${currentUrl.substring(0, 100)}`);
                    return currentUrl.split('?__cf_chl')[0];
                }
                console.log(`[MKVDrama/Browser] _c navigation failed: ${navErr.message}`);
            }
        }

        console.log(`[MKVDrama/Browser] _c link resolution failed in ${Date.now() - t0}ms`);
        return null;
    } catch (err) {
        console.error(`[MKVDrama/Browser] _c link resolution failed: ${err.message}`);
        return null;
    } finally {
        _resolveActive--;
        if (page) await page.close().catch(() => {});
    }
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
