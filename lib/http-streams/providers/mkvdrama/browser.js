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
const API_URL = (process.env.MKVDRAMA_API_URL || 'https://mkvdrama.org').replace(/\/+$/, '');
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

function fetchOnePage(pageNum, perPage) {
    return new Promise((resolve, reject) => {
        const agent = createProxyAgent();
        const url = `${API_URL}/titles/?page=${pageNum}&per_page=${perPage}`;
        const timer = setTimeout(() => {
            req.destroy();
            reject(new Error(`Timeout on page ${pageNum}`));
        }, 20000);

        const req = https.get(url, {
            agent,
            headers: { 'User-Agent': UA, 'Accept': 'application/json' },
        }, (res) => {
            if (res.statusCode !== 200) {
                clearTimeout(timer);
                res.resume(); // drain
                reject(new Error(`HTTP ${res.statusCode} on page ${pageNum}`));
                return;
            }
            let body = '';
            res.on('data', chunk => { body += chunk; });
            res.on('end', () => {
                clearTimeout(timer);
                try { resolve(JSON.parse(body)); }
                catch (e) { reject(new Error(`JSON parse error on page ${pageNum}`)); }
            });
        });
        req.on('error', err => { clearTimeout(timer); reject(err); });
    });
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
    const page = await browser.newPage();
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
            // On timeout, capture page state for debugging
            const currentUrl = page.url();
            const title = await page.title().catch(() => 'unknown');
            console.error(`[MKVDrama/Browser] Navigation failed for ${slug}: ${navErr.message} (currentUrl: ${currentUrl}, title: ${title})`);
            throw navErr;
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

        // Resolve /_c/ redirect links via HTTP (much faster than Puppeteer pages)
        const cLinks = rawResult.downloadLinks.filter(l => l.url.includes('/_c/'));
        const resolvedLinks = [...rawResult.downloadLinks.filter(l => !l.url.includes('/_c/'))];

        if (cLinks.length > 0) {
            const cookies = await page.cookies();
            const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
            console.log(`[MKVDrama/Browser] Resolving ${cLinks.length} _c links via HTTP...`);
            const cT0 = Date.now();

            const resolveCLink = (link) => {
                return new Promise((resolve) => {
                    const agent = createProxyAgent();
                    const parsed = new URL(link.url);
                    const options = {
                        hostname: parsed.hostname,
                        port: parsed.port || 443,
                        path: parsed.pathname + parsed.search,
                        method: 'GET',
                        agent,
                        headers: {
                            'User-Agent': UA,
                            'Accept': '*/*',
                            'Cookie': cookieHeader,
                            'Referer': `${API_URL}/${slug}`,
                        },
                    };
                    const timer = setTimeout(() => {
                        req.destroy();
                        resolve(link);
                    }, 8000);

                    // Use https.request to avoid auto-redirect following
                    const req = https.request(options, (res) => {
                        clearTimeout(timer);
                        res.resume(); // drain body
                        const location = res.headers['location'];
                        if (location && location !== link.url) {
                            const cleanUrl = location.split('?__cf_chl')[0];
                            resolve({ ...link, url: cleanUrl });
                        } else {
                            resolve(link);
                        }
                    });
                    req.on('error', () => { clearTimeout(timer); resolve(link); });
                    req.end();
                });
            };

            // Resolve in batches
            for (let i = 0; i < cLinks.length; i += C_LINK_CONCURRENCY) {
                const batch = cLinks.slice(i, i + C_LINK_CONCURRENCY);
                const results = await Promise.all(batch.map(resolveCLink));
                resolvedLinks.push(...results);
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
