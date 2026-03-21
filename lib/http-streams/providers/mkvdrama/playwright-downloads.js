/**
 * MKVDrama download link fetcher using Puppeteer.
 * Loads the series page on mkvdrama.org, waits for Turnstile verification,
 * and extracts the download links from the rendered DOM.
 *
 * Usage: node lib/http-streams/providers/mkvdrama/playwright-downloads.js <slug> [proxy]
 * Output: JSON line on stdout with { title, downloadLinks: [...] }
 */

import puppeteerExtra from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

puppeteerExtra.use(StealthPlugin());

const slug = process.argv[2];
const proxyUrl = process.argv[3] || '';
const API_URL = process.env.MKVDRAMA_API_URL || 'https://mkvdrama.org';
const TIMEOUT_MS = parseInt(process.env.MKVDRAMA_PW_TIMEOUT_MS || '50000', 10);

if (!slug) {
    console.log(JSON.stringify({ error: 'No slug provided', downloadLinks: [] }));
    process.exit(1);
}

const url = `${API_URL}/${slug}`;

async function run() {
    const args = [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu'
    ];

    if (proxyUrl) {
        const normalized = proxyUrl.replace('socks5h://', 'socks5://');
        args.push(`--proxy-server=${normalized}`);
    }

    const browser = await puppeteerExtra.launch({
        headless: 'new',
        args,
        timeout: 30000
    });

    try {
        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:140.0) Gecko/20100101 Firefox/140.0');

        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });

        // Wait for download blocks to appear (loaded via JS after Turnstile solves)
        // The site shows download links in .soraddlx, .dl-item, or similar containers
        const downloadSelector = '.dl-item, .soraddlx, .soraurl, [data-riwjd], a[href*="ouo."], a[href*="oii.la"], a[href*="pixeldrain"], .download-block, .ep-download';

        try {
            await page.waitForSelector(downloadSelector, { timeout: TIMEOUT_MS });
        } catch {
            // Try waiting for any content change in the download area
            await new Promise(r => setTimeout(r, 5000));
        }

        // Extra wait for all download content to render
        await new Promise(r => setTimeout(r, 2000));

        // Extract download links
        const result = await page.evaluate(() => {
            const links = [];
            const seen = new Set();

            const addLink = (href, label, linkText, quality, host) => {
                if (!href || href === '#' || href.startsWith('javascript:') || seen.has(href)) return;
                seen.add(href);
                links.push({ url: href, label: label || '', linkText: linkText || '', quality: quality || '', host: host || null });
            };

            // Strategy 1: Structured download blocks (.soraddlx etc)
            document.querySelectorAll('.soraddlx, .soraddl, .soradd').forEach(block => {
                const episodeLabel = (block.querySelector('.sorattlx, .sorattl, .soratt, h3, h4')?.textContent || '').trim();
                block.querySelectorAll('.soraurlx, .soraurl').forEach(linkBox => {
                    const quality = (linkBox.querySelector('strong, b')?.textContent || '').trim();
                    linkBox.querySelectorAll('a[href]').forEach(a => {
                        addLink(a.href, episodeLabel, a.textContent.trim(), quality);
                    });
                });
            });

            // Strategy 2: Encoded download tokens
            document.querySelectorAll('[data-riwjd]').forEach(el => {
                const token = el.getAttribute('data-riwjd');
                if (!token) return;
                try {
                    const decoded = atob(token);
                    if (decoded.startsWith('http')) {
                        const container = el.closest('div');
                        const label = (container?.querySelector('span')?.textContent || '').trim();
                        addLink(decoded, label, label);
                    }
                } catch {}
            });

            // Strategy 3: Any download-like links (ouo, pixeldrain, viewcrate)
            document.querySelectorAll('a[href]').forEach(a => {
                const href = a.href || '';
                if (/(ouo\.|oii\.la|pixeldrain|viewcrate|filecrypt)/.test(href)) {
                    const container = a.closest('li, div, p');
                    const label = (container?.querySelector('strong, b, h3, h4')?.textContent || '').trim();
                    addLink(href, label, a.textContent.trim());
                }
            });

            // Strategy 4: Look for episode/quality download grid items
            document.querySelectorAll('.dl-item, .download-block, .ep-download').forEach(item => {
                const label = (item.querySelector('.title, .ep-title, h3, h4, strong')?.textContent || '').trim();
                item.querySelectorAll('a[href]').forEach(a => {
                    addLink(a.href, label, a.textContent.trim());
                });
            });

            const title = (document.querySelector('h1.entry-title, h1, .series-title, article h1')?.textContent || document.title || '').trim();

            return { title, downloadLinks: links };
        });

        console.log(JSON.stringify(result));
    } finally {
        await browser.close();
    }
}

run().catch(err => {
    console.log(JSON.stringify({ error: err.message, downloadLinks: [] }));
    process.exit(1);
});
