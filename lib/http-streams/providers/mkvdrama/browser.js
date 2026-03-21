/**
 * MKVDrama Puppeteer browser singleton.
 * Provides CF-bypassed access to mkvdrama.org via a persistent browser instance.
 */

import puppeteerExtra from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

puppeteerExtra.use(StealthPlugin());

const PROXY_URL = process.env.MKVDRAMA_BROWSER_PROXY_URL
    || process.env.MKVDRAMA_DIRECT_PROXY_URL
    || 'socks5://100.109.163.45:1080';
const BROWSER_TIMEOUT_MS = parseInt(process.env.MKVDRAMA_BROWSER_TIMEOUT_MS || '60000', 10);
const PAGE_WAIT_MS = parseInt(process.env.MKVDRAMA_PAGE_WAIT_MS || '15000', 10);
const API_URL = (process.env.MKVDRAMA_API_URL || 'https://mkvdrama.org').replace(/\/+$/, '');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';

let _browser = null;
let _browserLaunchPromise = null;
let _lastUsed = 0;
const BROWSER_IDLE_TIMEOUT_MS = 5 * 60 * 1000; // Close browser after 5min idle

function normalizeProxy(url) {
    if (!url) return null;
    // Puppeteer's --proxy-server doesn't support socks5h, use socks5
    return url.replace('socks5h://', 'socks5://');
}

async function launchBrowser() {
    const proxyNormalized = normalizeProxy(PROXY_URL);
    const args = [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
    ];
    if (proxyNormalized) {
        args.push(`--proxy-server=${proxyNormalized}`);
    }

    // Use system Chromium if available (Docker Alpine), otherwise puppeteer's bundled one
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
    return page;
}

/**
 * Search the mkvdrama.org catalog API for titles matching a query.
 * Uses Puppeteer browser context to bypass CF.
 * Returns array of { title, slug, ... } objects.
 */
export async function browserSearchCatalog(query, maxPages = 3, perPage = 100) {
    const queryLower = query.toLowerCase().trim();
    const queryWords = queryLower.split(/\s+/).filter(w => w.length > 1);
    let page;

    try {
        page = await newPage();

        // Navigate to homepage to establish CF session
        console.log(`[MKVDrama/Browser] Establishing CF session...`);
        await page.goto(`${API_URL}/`, { waitUntil: 'networkidle2', timeout: BROWSER_TIMEOUT_MS });

        // Search catalog API from browser context
        const results = await page.evaluate(async (params) => {
            const { queryLower, queryWords, maxPages, perPage } = params;
            const matches = [];
            const seen = new Set();

            function scoreMatch(entry) {
                const title = (entry.title || '').toLowerCase();
                const altTitle = (entry.alternative_title || '').toLowerCase();
                const slug = (entry.slug || '').toLowerCase();
                const combined = `${title} ${altTitle} ${slug}`;

                if (title === queryLower || slug === queryLower.replace(/\s+/g, '-')) return 100;
                if (title.startsWith(queryLower)) return 90;
                if (combined.includes(queryLower)) return 80;

                const matched = queryWords.filter(w => combined.includes(w));
                if (matched.length === queryWords.length) return 70;
                if (matched.length > 0) return 30 + (matched.length / queryWords.length) * 40;
                return 0;
            }

            for (let p = 1; p <= maxPages; p++) {
                const resp = await fetch(`/titles/?page=${p}&per_page=${perPage}`);
                if (!resp.ok) break;
                const data = await resp.json();
                const entries = data.results || [];
                if (entries.length === 0) break;

                for (const entry of entries) {
                    const score = scoreMatch(entry);
                    if (score < 30 || seen.has(entry.slug)) continue;
                    seen.add(entry.slug);
                    matches.push({ ...entry, _score: score });
                }

                // Stop early if we have good matches
                if (matches.some(m => m._score >= 70)) break;
                if (p * perPage >= (data.total || 0)) break;
            }

            matches.sort((a, b) => b._score - a._score);
            return matches.slice(0, 20);
        }, { queryLower, queryWords, maxPages, perPage });

        console.log(`[MKVDrama/Browser] Catalog search for "${query}" returned ${results.length} results`);
        return results;
    } catch (err) {
        console.error(`[MKVDrama/Browser] Catalog search failed: ${err.message}`);
        return [];
    } finally {
        if (page) await page.close().catch(() => {});
    }
}

/**
 * Load a title page on mkvdrama.org and extract download links.
 * Waits for the page JS to auto-load downloads (POST _l_krc_uo + GET oe_pq_invxe_l).
 * Returns { title, downloadLinks: [{ url, label, quality, linkText }] }
 */
export async function browserLoadContent(slug) {
    let page;

    try {
        page = await newPage();
        const url = `${API_URL}/titles/${slug}/`;
        console.log(`[MKVDrama/Browser] Loading content: ${url}`);

        await page.goto(url, { waitUntil: 'networkidle2', timeout: BROWSER_TIMEOUT_MS });

        // Check for 404
        const pageTitle = await page.title();
        if (pageTitle.toLowerCase().includes('not found') || pageTitle.toLowerCase().includes('404')) {
            console.log(`[MKVDrama/Browser] Page not found for slug: ${slug}`);
            return { title: '', downloadLinks: [] };
        }

        // Wait for download links to render (the page JS auto-triggers the download endpoints)
        console.log(`[MKVDrama/Browser] Waiting for download links to render...`);
        try {
            await page.waitForSelector('.soraddlx, .soraddl, .soradd', { timeout: PAGE_WAIT_MS });
            // Give a bit more time for all links to populate
            await new Promise(r => setTimeout(r, 3000));
        } catch {
            // Links may not appear if the title has no downloads
            console.log(`[MKVDrama/Browser] No download sections appeared within ${PAGE_WAIT_MS}ms`);
        }

        // Extract download links from rendered DOM
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
                        links.push({
                            url: href,
                            label: episodeLabel,
                            quality,
                            linkText: a.textContent.trim(),
                        });
                    });
                });
            });

            // Fallback: look for loose OUO/shortlink links
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

        // Resolve /_c/ redirect links to their actual OUO destinations
        // These links need the browser session cookies to work
        const cLinks = rawResult.downloadLinks.filter(l => l.url.includes('/_c/'));
        const resolvedLinks = [...rawResult.downloadLinks.filter(l => !l.url.includes('/_c/'))];

        if (cLinks.length > 0) {
            const browser = await getBrowser();
            const cookies = await page.cookies();

            // Resolve each _c link by navigating in a new page and capturing the redirect
            for (const link of cLinks) {
                try {
                    const redirectPage = await browser.newPage();
                    await redirectPage.setUserAgent(UA);
                    await redirectPage.setCookie(...cookies);
                    await redirectPage.setRequestInterception(true);

                    let redirectUrl = null;
                    redirectPage.on('request', req => {
                        if (req.isNavigationRequest() && req.url() !== link.url && !redirectUrl) {
                            redirectUrl = req.url();
                        }
                        req.continue();
                    });

                    try {
                        await redirectPage.goto(link.url, { waitUntil: 'domcontentloaded', timeout: 15000 });
                    } catch {
                        // Navigation may fail after redirect to blocked domain - that's ok
                    }

                    if (!redirectUrl) redirectUrl = redirectPage.url();
                    await redirectPage.close().catch(() => {});

                    if (redirectUrl && redirectUrl !== link.url) {
                        // Strip CF challenge token from URL
                        const cleanUrl = redirectUrl.split('?__cf_chl')[0];
                        resolvedLinks.push({ ...link, url: cleanUrl });
                    } else {
                        resolvedLinks.push(link);
                    }
                } catch {
                    resolvedLinks.push(link);
                }
            }
        }

        const result = { title: rawResult.title, downloadLinks: resolvedLinks };
        console.log(`[MKVDrama/Browser] Extracted ${result.downloadLinks.length} download links for "${result.title}"`);
        return result;
    } catch (err) {
        console.error(`[MKVDrama/Browser] Content load failed for ${slug}: ${err.message}`);
        return { title: '', downloadLinks: [] };
    } finally {
        if (page) await page.close().catch(() => {});
    }
}

/**
 * Close the shared browser instance.
 */
export async function closeBrowser() {
    if (_browser) {
        await _browser.close().catch(() => {});
        _browser = null;
    }
}
