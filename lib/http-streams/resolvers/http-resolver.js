/**
 * HTTP Stream URL Resolver
 * Resolves redirect URLs to final streaming links
 * Handles lazy-load mode for 4KHDHub, HDHub4u, and UHDMovies
 */

import axios from 'axios';
import * as cheerio from 'cheerio';
import crypto from 'crypto';
import fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as config from '../../config.js';
import { getRedirectLinks, processExtractorLinkWithAwait } from '../providers/4khdhub/extraction.js';
import { validateSeekableUrl } from '../utils/validation.js';
import { makeRequest } from '../utils/http.js';
import { tryDecodeBase64 } from '../utils/encoding.js';
import { getResolutionFromName } from '../utils/parsing.js';
import { resolveUHDMoviesUrl } from '../../uhdmovies/index.js';
import * as CacheStore from '../../util/cache-store.js';
import { resolveXDMoviesProtectedUrl } from '../providers/xdmovies/protector.js';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';

const FAST_SEEK_TIMEOUT_MS = parseInt(process.env.HTTP_STREAM_SEEK_TIMEOUT_MS, 10) || 1500;
const MAX_PARALLEL_VALIDATIONS = parseInt(process.env.HTTP_STREAM_MAX_PARALLEL, 10) || 2;
const RESOLVE_CACHE_TTL = parseInt(process.env.HTTP_STREAM_RESOLVE_CACHE_TTL, 10) || (5 * 60 * 1000); // 5 minutes
const PERSISTED_RESOLVE_CACHE_TTL = parseInt(process.env.HTTP_STREAM_RESOLVE_PERSIST_TTL_MS, 10) || (24 * 60 * 60 * 1000);
const RESOLVE_CACHE_SERVICE = 'http-resolve';
const RESOLVE_CACHE_RELEASE_KEY = 'http-stream-url';
const FILECRYPT_COOLDOWN_SERVICE = 'filecrypt-cooldown';
const FILECRYPT_COOLDOWN_RELEASE_KEY = 'cloudflare-block';
const FILECRYPT_BLOCK_COOLDOWN_MS = parseInt(process.env.FILECRYPT_BLOCK_COOLDOWN_MS, 10) || 60 * 1000;

const resolveCache = new Map(); // key -> { promise, value, ts }
const filecryptContainerCache = new Map(); // containerUrl -> { promise, ts }
const DIRECT_HOST_HINTS = ['workers.dev', 'hubcdn.fans', 'r2.dev'];
const OUO_HOSTS = ['ouo.io', 'ouo.press', 'oii.la'];
const OUO_BUTTON_ID = 'btn-main';
const DEFAULT_HTTP_STREAM_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const OUO_USER_AGENT = config.HTTP_STREAM_USER_AGENT || DEFAULT_HTTP_STREAM_USER_AGENT;
const VIEWCRATE_HOSTS = ['viewcrate.cc'];
const PIXELDRAIN_HOSTS = ['pixeldrain.com', 'pixeldrain.net', 'pixeldrain.dev'];
const FILECRYPT_HOSTS = ['filecrypt.cc', 'filecrypt.co'];
const SHORTLINK_INTERSTITIAL_HOSTS = [
    'advertisingcamps.com',
    'crn77.com',
    'clk.sh',
    'belalasr.github.io',
    'pcdelv.com'
];
const XDMOVIES_LINK_HOSTS = ['link.xdmovies.site', 'link.xdmovies.wtf'];
const PROVIDER_ARCHIVE_HOST_HINTS = ['modpro.blog', 'leechpro.blog', 'animeflix.'];
const PROVIDER_ARCHIVE_TARGET_HOST_HINTS = [
    'hubcloud',
    'hubdrive',
    'hubcdn',
    'driveseed',
    'driveleech',
    'tech.unblockedgames.world',
    'tech.creativeexpressionsblog.com',
    'tech.examzculture.in',
    'gdflix',
    'gdlink.dev',
    'urlflix.xyz',
    'gdrivepro.xyz',
    'pixeldrain',
    'workers.dev',
    'r2.dev',
    'googleusercontent.com',
    ...OUO_HOSTS,
    ...VIEWCRATE_HOSTS,
    ...FILECRYPT_HOSTS
];
const UHDMOVIES_SID_HOSTS = [
    'tech.unblockedgames.world',
    'tech.creativeexpressionsblog.com',
    'tech.examzculture.in',
    'driveseed.org',
    'driveleech.net'
];
const FLARESOLVERR_URL = config.FLARESOLVERR_URL || process.env.FLARESOLVERR_URL || 'http://127.0.0.1:8191';
const FLARESOLVERR_V2 = config.FLARESOLVERR_V2 === true;
const FLARESOLVERR_PROXY_URL = config.FLARESOLVERR_PROXY_URL || '';
const FLARESOLVERR_PROXY_ALLOW_HUBCLOUD = process.env.FLARESOLVERR_PROXY_HUBCLOUD !== 'false';
const FLARESOLVERR_PROXY_SHORTLINKS = process.env.HTTP_FLARESOLVERR_PROXY_SHORTLINKS === 'true';
const FLARESOLVERR_SHORTLINK_PROXY_URL =
    process.env.HTTP_FLARESOLVERR_SHORTLINK_PROXY_URL ||
    process.env.MKVDRAMA_DIRECT_PROXY_URL ||
    FLARESOLVERR_PROXY_URL ||
    '';
const FLARESOLVERR_TIMEOUT = parseInt(process.env.HTTP_FLARESOLVERR_TIMEOUT, 10) || 65000;
const BYPARR_URL = process.env.BYPARR_URL || config.BYPARR_URL || (
    FLARESOLVERR_URL.includes(':8191')
        ? FLARESOLVERR_URL.replace(':8191', ':8192')
        : ''
);
const BYPARR_PROXY_URL = process.env.BYPARR_PROXY_URL || process.env.MKVDRAMA_DIRECT_PROXY_URL || FLARESOLVERR_PROXY_URL || '';
const BYPARR_TIMEOUT = Math.max(
    20000,
    parseInt(process.env.HTTP_BYPARR_TIMEOUT || process.env.HTTP_FLARESOLVERR_TIMEOUT || '90000', 10) || 90000
);
const BYPARR_ENABLED = process.env.HTTP_BYPARR_ENABLED !== 'false';
const OUO_COOKIE = config.OUO_COOKIE || '';
const VIEWCRATE_COOKIE = config.VIEWCRATE_COOKIE || '';
const MKVDRAMA_BASE_URL = 'https://mkvdrama.net';
const MKVDRAMA_TOKEN_PARAM = 'mkv_token';
const MKVDRAMA_PROXY_URL = process.env.MKVDRAMA_DIRECT_PROXY_URL || '';
const RESOLVER_BROWSER_PROXY_URL = process.env.HTTP_RESOLVER_BROWSER_PROXY_URL || process.env.MKVDRAMA_DIRECT_PROXY_URL || FLARESOLVERR_PROXY_URL || '';
let mkvDramaResolverProxyAgent = null;
let mkvDramaResolverProxyAgentUrl = '';
const VIEWCRATE_BROWSER_FALLBACK_ENABLED = process.env.HTTP_RESOLVER_BROWSER_FALLBACK_ENABLED !== 'false';
const VIEWCRATE_BROWSER_TIMEOUT_MS = Math.max(
    15000,
    parseInt(
        process.env.HTTP_RESOLVER_BROWSER_FALLBACK_TIMEOUT_MS ||
        process.env.MKVDRAMA_BROWSER_FALLBACK_TIMEOUT_MS ||
        '45000',
        10
    ) || 45000
);
const FLARE_SESSION_TTL = 10 * 60 * 1000;
const flareSessionCache = new Map(); // domain -> { sessionId, ts }
let flareSessionCommandsSupported = null; // null=unknown, true=supported, false=unsupported (Solvearr-style API)
const flareSolverrLocks = new Map(); // domain -> Promise (prevents thundering herd)
const CF_COOKIE_CACHE_TTL = parseInt(process.env.CF_COOKIE_CACHE_TTL, 10) || 0; // 0 = reuse until denied
const cfCookieCache = new Map(); // domain -> { cookies, userAgent, ts }
let viewcrateStealthPuppeteerPromise = null;
let viewcrateStealthPluginApplied = false;
const VIEWCRATE_BROWSER_EXECUTABLE_CANDIDATES = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    process.env.CHROME_PATH,
    process.env.GOOGLE_CHROME_BIN,
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium'
].filter(Boolean);
let viewcrateResolvedBrowserExecutable = undefined; // undefined = unresolved, null = not found
const execFileAsync = promisify(execFile);
const SUBPROCESS_RESOLVE_FALLBACK_ENABLED = process.env.HTTP_RESOLVE_SUBPROCESS !== '1';

// Known dead HubCloud domains that should be skipped (no DNS records)
const DEAD_HUBCLOUD_DOMAINS = new Set([
    'hubcloud.ink',
    'hubcloud.co',
    'hubcloud.cc',
    'hubcloud.me',
    'hubcloud.xyz'
]);

/**
 * Check if a URL is from a known dead HubCloud domain
 * @param {string} url - URL to check
 * @returns {boolean} True if the domain is dead and should be skipped
 */
function isDeadHubcloudDomain(url) {
    if (!url) return false;
    try {
        const hostname = new URL(url).hostname.toLowerCase();
        return DEAD_HUBCLOUD_DOMAINS.has(hostname);
    } catch {
        return false;
    }
}

function normalizeSolverProxyUrl(proxyUrl = '') {
    const raw = String(proxyUrl || '').trim();
    if (!raw) return '';
    // Byparr accepts socks5, while many configs here use socks5h for remote DNS.
    // Keep auth/host/port intact and only normalize the scheme when needed.
    if (raw.toLowerCase().startsWith('socks5h://')) {
        return `socks5://${raw.slice('socks5h://'.length)}`;
    }
    return raw;
}

function parseBrowserProxyConfig(proxyUrl = '') {
    const normalized = normalizeSolverProxyUrl(proxyUrl);
    if (!normalized) {
        return { proxyServer: null, username: null, password: null };
    }

    try {
        const parsed = new URL(normalized);
        const protocol = parsed.protocol.replace(/:$/, '');
        if (!['socks5', 'http', 'https'].includes(protocol)) {
            return { proxyServer: null, username: null, password: null };
        }

        const authUser = decodeURIComponent(parsed.username || '');
        const authPass = decodeURIComponent(parsed.password || '');
        const host = parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;
        const proxyServer = `${protocol}://${host}`;

        return {
            proxyServer,
            username: authUser || null,
            password: authPass || null
        };
    } catch {
        return { proxyServer: null, username: null, password: null };
    }
}

function sleep(ms = 0) {
    return new Promise(resolve => setTimeout(resolve, Math.max(0, ms || 0)));
}

function getFlareProxyConfigForDomain(domain) {
    if (!domain) return null;
    const lower = domain.toLowerCase();
    if (!FLARESOLVERR_PROXY_ALLOW_HUBCLOUD && (lower.includes('hubcloud') || lower.includes('hubdrive') || lower.includes('hubcdn'))) {
        return null;
    }

    // OUO and ViewCrate work better without proxy — WARP proxy triggers Chrome download
    // interstitial in FlareSolverr, while native IP bypasses CF JS challenges fine
    if (OUO_HOSTS.some(host => lower.includes(host))) return null;
    if (VIEWCRATE_HOSTS.some(host => lower.includes(host))) return null;

    const isShortlinkOrContainer =
        FILECRYPT_HOSTS.some(host => lower.includes(host));

    if (isShortlinkOrContainer) {
        if (!FLARESOLVERR_PROXY_SHORTLINKS || !FLARESOLVERR_SHORTLINK_PROXY_URL) {
            return null;
        }
        return { url: FLARESOLVERR_SHORTLINK_PROXY_URL };
    }

    if (!FLARESOLVERR_PROXY_URL) return null;
    return { url: FLARESOLVERR_PROXY_URL };
}

function shouldUseFlareSessionForDomain(domain) {
    if (!domain) return true;
    const lower = domain.toLowerCase();
    // Skip sessions for shortlink/container domains — proxy must be sent per-request
    if (OUO_HOSTS.some(host => lower.includes(host))) return false;
    if (VIEWCRATE_HOSTS.some(host => lower.includes(host))) return false;
    return true;
}

function isCloudflareBlockedFlareError(error) {
    const message = String(
        error?.response?.data?.message ||
        error?.response?.data ||
        error?.message ||
        ''
    ).toLowerCase();
    return message.includes('cloudflare has blocked this request')
        || message.includes('probably your ip is banned')
        || message.includes('error solving the challenge');
}

async function getFilecryptCooldown(filecryptUrl) {
    if (!CacheStore.isEnabled()) return null;
    try {
        const cached = await CacheStore.getCachedRecord(FILECRYPT_COOLDOWN_SERVICE, filecryptUrl, {
            releaseKey: FILECRYPT_COOLDOWN_RELEASE_KEY
        });
        return cached?.data || null;
    } catch {
        return null;
    }
}

async function setFilecryptCooldown(filecryptUrl, reason = 'blocked') {
    if (!CacheStore.isEnabled()) return;
    try {
        await CacheStore.upsertCachedMagnet({
            service: FILECRYPT_COOLDOWN_SERVICE,
            hash: filecryptUrl,
            data: { reason, ts: Date.now() },
            releaseKey: FILECRYPT_COOLDOWN_RELEASE_KEY
        }, { ttlMs: FILECRYPT_BLOCK_COOLDOWN_MS });
    } catch {
        // Ignore cache backend errors.
    }
}

async function clearFilecryptCooldown(filecryptUrl) {
    if (!CacheStore.isEnabled()) return;
    try {
        await CacheStore.deleteCachedHash(FILECRYPT_COOLDOWN_SERVICE, filecryptUrl);
    } catch {
        // Ignore cache backend errors.
    }
}

const VIDEO_EXTENSIONS = new Set([
    '.mp4',
    '.mkv',
    '.avi',
    '.webm',
    '.mov',
    '.m4v',
    '.ts',
    '.m3u8'
]);

const NON_VIDEO_EXTENSIONS = new Set([
    '.zip',
    '.rar',
    '.7z',
    '.iso',
    '.exe',
    '.tar',
    '.gz',
    '.bz2',
    '.xz',
    '.js',
    '.css',
    '.png',
    '.jpg',
    '.jpeg',
    '.gif',
    '.webp',
    '.svg',
    '.ico',
    '.woff',
    '.woff2',
    '.ttf',
    '.eot',
    '.map',
    '.json'
]);

const VIDEO_EXTENSION_LIST = Array.from(VIDEO_EXTENSIONS);
const NON_VIDEO_EXTENSION_LIST = Array.from(NON_VIDEO_EXTENSIONS);

const TRUSTED_VIDEO_HOST_HINTS = [
    'pixeldrain',
    'workers.dev',
    'hubcdn.fans',
    'r2.dev',
    'googleusercontent.com'
];

const VIDEO_TYPE_HINTS = ['mp4', 'mkv', 'webm', 'm3u8', 'avi', 'mov', 'ts', 'm4v'];

function isAssetUrl(candidate) {
    if (!candidate) return true;
    const lower = candidate.toLowerCase();
    return /\.(?:js|css|png|jpe?g|gif|webp|svg|ico|woff2?|ttf|eot|map|json)(?:$|[?#])/.test(lower);
}

function normalizeAbsoluteUrl(href, baseUrl) {
    if (!href) return null;
    try {
        return new URL(href, baseUrl).toString();
    } catch {
        return null;
    }
}

function extractCookies(setCookieHeader) {
    if (!setCookieHeader) return [];
    const values = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
    return values.map(cookie => cookie.split(';')[0].trim()).filter(Boolean);
}

function mergeCookieHeader(existing, setCookieHeader) {
    const cookieMap = new Map();
    if (existing) {
        existing.split(';').forEach(cookie => {
            const [name, ...rest] = cookie.trim().split('=');
            if (!name || rest.length === 0) return;
            cookieMap.set(name, rest.join('='));
        });
    }
    extractCookies(setCookieHeader).forEach(cookie => {
        const [name, ...rest] = cookie.split('=');
        if (!name || rest.length === 0) return;
        cookieMap.set(name, rest.join('='));
    });
    return Array.from(cookieMap.entries())
        .map(([name, value]) => `${name}=${value}`)
        .join('; ');
}

function parseCookieHeader(cookieHeader = '', domain = null) {
    if (!cookieHeader) return [];
    return cookieHeader.split(';').map(part => part.trim()).map((part) => {
        if (!part) return null;
        const [name, ...rest] = part.split('=');
        if (!name || rest.length === 0) return null;
        return {
            name,
            value: rest.join('='),
            ...(domain ? { domain } : {})
        };
    }).filter(Boolean);
}

/**
 * Get cached Cloudflare cookies for a domain
 * @param {string} domain - The domain to get cookies for
 * @returns {{ cookies: string, userAgent: string } | null}
 */
function getCachedCfCookies(domain) {
    if (!domain) return null;
    const cached = cfCookieCache.get(domain);
    if (!cached) return null;
    if (CF_COOKIE_CACHE_TTL > 0 && (Date.now() - cached.ts > CF_COOKIE_CACHE_TTL)) {
        cfCookieCache.delete(domain);
        return null;
    }
    return { cookies: cached.cookies, userAgent: cached.userAgent };
}

/**
 * Get related domains that should share cookies (e.g., ouo.io and ouo.press)
 */
function getRelatedDomains(domain) {
    if (!domain) return [domain];
    const relatedGroups = [
        ['ouo.io', 'ouo.press'],
        ['viewcrate.cc', 'viewcrate.xyz']
    ];
    for (const group of relatedGroups) {
        if (group.some(d => domain.includes(d))) {
            return group;
        }
    }
    return [domain];
}

/**
 * Cache Cloudflare cookies from FlareSolverr response
 * FlareSolverr returns cookies as array: [{ name, value, domain, ... }]
 * @param {string} domain - The domain to cache cookies for
 * @param {Array} cookies - Array of cookie objects from FlareSolverr
 * @param {string} userAgent - The user agent used (cookies are tied to UA)
 */
function cacheCfCookies(domain, cookies, userAgent) {
    if (!domain || !cookies || !Array.isArray(cookies) || cookies.length === 0) return;

    // Cache all cookies (not only cf_*). Some providers require session cookies
    // across archive -> getlink -> redirect hops even after the Cloudflare challenge.
    const cookieString = cookies
        .filter(c => c?.name && c?.value !== undefined)
        .map(c => `${c.name}=${c.value}`)
        .join('; ');
    if (!cookieString) return;

    const cacheEntry = {
        cookies: cookieString,
        userAgent: userAgent || OUO_USER_AGENT,
        ts: Date.now()
    };

    // Cache for the domain and all related domains
    const domains = getRelatedDomains(domain);
    for (const d of domains) {
        cfCookieCache.set(d, cacheEntry);
    }

    console.log(`[HTTP-RESOLVE] Cached cookies for ${domains.join(', ')}: ${cookies.map(c => c.name).join(', ')}`);
}

function extractRedirectCandidates(body = '', document = null, baseUrl = '') {
    const candidates = [];

    if (document) {
        const refresh = document('meta[http-equiv=\"refresh\"]').attr('content') || '';
        const refreshMatch = refresh.match(/url=([^;]+)/i);
        if (refreshMatch?.[1]) {
            const resolved = normalizeAbsoluteUrl(refreshMatch[1].trim(), baseUrl);
            if (resolved) candidates.push(resolved);
        }

        document('a[href]').each((_, el) => {
            const href = document(el).attr('href');
            const resolved = normalizeAbsoluteUrl(href, baseUrl);
            if (resolved) candidates.push(resolved);
        });
    }

    const scriptMatches = body.match(/location\.(?:href|replace|assign)\s*(?:\(\s*)?['"]([^'"]+)['"]\s*\)?/i);
    if (scriptMatches?.[1]) {
        const resolved = normalizeAbsoluteUrl(scriptMatches[1], baseUrl);
        if (resolved) candidates.push(resolved);
    }

    const windowOpenMatch = body.match(/window\.open\(\s*['"]([^'"]+)['"]/i);
    if (windowOpenMatch?.[1]) {
        const resolved = normalizeAbsoluteUrl(windowOpenMatch[1], baseUrl);
        if (resolved) candidates.push(resolved);
    }

    const urlMatches = body.match(/https?:\/\/[^\s"'<>]+/gi) || [];
    urlMatches.forEach(match => {
        const resolved = normalizeAbsoluteUrl(match, baseUrl);
        if (resolved) candidates.push(resolved);
    });

    const base64Matches = body.match(/[A-Za-z0-9+/=]{40,}/g) || [];
    base64Matches.forEach(raw => {
        const decoded = tryDecodeBase64(raw);
        if (decoded && decoded.startsWith('http')) {
            const resolved = normalizeAbsoluteUrl(decoded.trim(), baseUrl);
            if (resolved) candidates.push(resolved);
        }
    });

    return candidates;
}

/**
 * Check if a URL is just a homepage without a meaningful path
 * e.g., http://pixeldrain.com/ or https://gofile.io/home
 */
function isHomepageUrl(url) {
    try {
        const parsed = new URL(url);
        // Root path URLs with query params can still be real redirect endpoints
        // (e.g. tech.* /?sid=... used by MoviesMod/MoviesLeech wrappers).
        if (parsed.search && parsed.search !== '?') {
            return false;
        }
        const path = parsed.pathname.replace(/\/+$/, ''); // Remove trailing slashes
        // Homepage patterns: empty path, just /, /home, /index, /index.html
        if (!path || path === '' || path === '/home' || path === '/index' || path === '/index.html') {
            return true;
        }
        return false;
    } catch {
        return false;
    }
}

function pickFirstExternalCandidate(candidates, baseUrl, allowedHosts = []) {
    const baseHost = (() => {
        try {
            return new URL(baseUrl).hostname.toLowerCase();
        } catch {
            return '';
        }
    })();
    const normalizedAllowed = (allowedHosts || []).filter(Boolean).map(host => host.toLowerCase());

    for (const candidate of candidates) {
        if (!candidate) continue;
        const lower = candidate.toLowerCase();
        if (OUO_HOSTS.some(host => lower.includes(host))) continue;
        if (baseHost && lower.includes(baseHost)) continue;
        if (SHORTLINK_INTERSTITIAL_HOSTS.some(host => lower.includes(host))) continue;
        if (isAssetUrl(candidate)) continue;
        if (isHomepageUrl(candidate)) continue; // Skip homepage-only URLs
        if (normalizedAllowed.length && !normalizedAllowed.some(host => lower.includes(host))) continue;
        return candidate;
    }
    return null;
}

function isShortlinkInterstitialUrl(url) {
    if (!url) return false;
    try {
        const parsed = new URL(url);
        const lowerHost = parsed.hostname.toLowerCase();
        const lowerHref = parsed.toString().toLowerCase();
        if (SHORTLINK_INTERSTITIAL_HOSTS.some(host => lowerHost === host || lowerHost.endsWith(`.${host}`))) {
            return true;
        }
        if (lowerHref.includes('bemobdata=')) return true;
        if (lowerHost.endsWith('github.io') && lowerHref.includes('/tools/browser-')) return true;
        return false;
    } catch {
        const lower = String(url).toLowerCase();
        if (SHORTLINK_INTERSTITIAL_HOSTS.some(host => lower.includes(host))) return true;
        if (lower.includes('bemobdata=')) return true;
        if (lower.includes('/tools/browser-') && lower.includes('github.io')) return true;
        return false;
    }
}

function decodeBase64UrlSuffix(value = '') {
    const raw = String(value || '').trim();
    if (!raw || raw.length < 16) return null;

    for (let i = 0; i < raw.length; i += 1) {
        const suffix = raw.slice(i);
        if (!/^[A-Za-z0-9+/=]+$/.test(suffix)) continue;
        if (suffix.length % 4 !== 0) continue;
        const decoded = tryDecodeBase64(suffix);
        if (decoded && /^https?:\/\//i.test(decoded)) {
            return decoded.trim();
        }
    }

    return null;
}

function extractEmbeddedShortlinkTargets(document, body = '', baseUrl = '') {
    const candidates = [];
    const seen = new Set();

    const addCandidate = (candidate) => {
        const normalized = normalizeAbsoluteUrl(candidate, baseUrl);
        if (!normalized || seen.has(normalized) || isShortlinkInterstitialUrl(normalized)) return;
        seen.add(normalized);
        candidates.push(normalized);
    };

    if (document) {
        document('input[type="hidden"], input[name]').each((_, el) => {
            const value = document(el).attr('value') || '';
            if (!value) return;

            if (/^https?:\/\//i.test(value)) {
                addCandidate(value);
                return;
            }

            const decoded = decodeBase64UrlSuffix(value);
            if (decoded) {
                addCandidate(decoded);
            }
        });
    }

    const encodedMatches = body.match(/[A-Za-z0-9+/=]{32,}/g) || [];
    for (const match of encodedMatches) {
        const decoded = decodeBase64UrlSuffix(match);
        if (decoded) {
            addCandidate(decoded);
        }
    }

    return candidates;
}

function pickPixeldrainCandidate(candidates) {
    return candidates.find(candidate =>
        candidate && PIXELDRAIN_HOSTS.some(host => candidate.toLowerCase().includes(host))
    ) || null;
}

function normalizeHintText(value = '') {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizePasswordHints(values = []) {
    const normalized = [];
    const seen = new Set();

    for (const value of values) {
        const text = normalizeHintText(value);
        if (!text) continue;
        const key = text.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        normalized.push(text);
    }

    return normalized;
}

function parseStreamHints(rawUrl) {
    if (!rawUrl) {
        return { baseUrl: rawUrl, hints: {} };
    }

    let baseUrl = rawUrl;
    let hashParams = new URLSearchParams();
    const hashIndex = rawUrl.indexOf('#');
    if (hashIndex >= 0) {
        baseUrl = rawUrl.slice(0, hashIndex);
        hashParams = new URLSearchParams(rawUrl.slice(hashIndex + 1));
    }

    let queryEpisodeHint = null;
    let queryResolutionHint = null;
    let queryHostHint = null;
    let queryPasswordHints = [];

    try {
        const parsed = new URL(baseUrl);
        queryEpisodeHint = parsed.searchParams.get('sootio_ep') || null;
        queryResolutionHint = parsed.searchParams.get('sootio_res') || null;
        queryHostHint = parsed.searchParams.get('sootio_host') || null;
        queryPasswordHints = parsed.searchParams.getAll('sootio_pwd');

        // Strip internal hint params before making network requests to the source site.
        parsed.searchParams.delete('sootio_ep');
        parsed.searchParams.delete('sootio_res');
        parsed.searchParams.delete('sootio_host');
        parsed.searchParams.delete('sootio_pwd');
        baseUrl = parsed.toString();
    } catch {
        // Leave baseUrl untouched if it is not a valid URL.
    }

    return {
        baseUrl,
        hints: {
            episode: hashParams.get('ep') || queryEpisodeHint || null,
            resolution: hashParams.get('res') || queryResolutionHint || null,
            host: hashParams.get('host') || queryHostHint || null,
            passwords: normalizePasswordHints([
                ...hashParams.getAll('pwd'),
                ...queryPasswordHints
            ])
        }
    };
}

function getEpisodeNumberFromHint(episodeHint = null) {
    if (!episodeHint) return null;
    const match = String(episodeHint).match(/E(\d{1,3})/i);
    if (!match) return null;
    const value = parseInt(match[1], 10);
    return Number.isFinite(value) ? value : null;
}

function isProviderArchiveDomain(hostname = '') {
    const lower = hostname.toLowerCase();
    return PROVIDER_ARCHIVE_HOST_HINTS.some(hint => lower.includes(hint));
}

function isProviderArchiveWrapperUrl(url) {
    if (!url) return false;
    try {
        const parsed = new URL(url);
        return isProviderArchiveDomain(parsed.hostname) && /\/archives\//i.test(parsed.pathname);
    } catch {
        return false;
    }
}

function isProviderArchiveGetLinkUrl(url) {
    if (!url) return false;
    try {
        const parsed = new URL(url);
        return isProviderArchiveDomain(parsed.hostname) && /\/getlink\//i.test(parsed.pathname);
    } catch {
        return false;
    }
}

function isViewcrateGetUrl(url) {
    if (!url) return false;
    try {
        const parsed = new URL(url);
        return parsed.hostname.includes('viewcrate.') && /\/get\/[A-Za-z0-9]+/i.test(parsed.pathname || '');
    } catch {
        return /viewcrate\.[^/]+\/get\/[A-Za-z0-9]+/i.test(String(url || ''));
    }
}

function rankProviderArchiveCandidate(candidate, baseUrl, hints = {}) {
    if (!candidate) return -1;
    let score = 0;
    const lower = candidate.toLowerCase();
    const isUhdSid = /\?sid=/i.test(candidate) && UHDMOVIES_SID_HOSTS.some(h => lower.includes(h));
    const isGdriveProRedirect = lower.includes('gdrivepro.') && /\/r\.php\?id=/i.test(lower);
    const isUrlFlixGet = lower.includes('urlflix.xyz') && /\/gets?\//i.test(lower);

    if (isProviderArchiveGetLinkUrl(candidate)) score += 500;
    if (isUhdSid) score += 480;
    if (isProviderArchiveWrapperUrl(candidate)) score += 400;
    if (PROVIDER_ARCHIVE_TARGET_HOST_HINTS.some(h => lower.includes(h))) score += 300;
    if (isUrlFlixGet) score += 220;
    if (isGdriveProRedirect) score += 180;
    if (DIRECT_HOST_HINTS.some(h => lower.includes(h))) score += 250;
    if (hints?.host && lower.includes(String(hints.host).toLowerCase())) score += 50;

    try {
        const candidateHost = new URL(candidate).hostname.toLowerCase();
        const baseHost = new URL(baseUrl).hostname.toLowerCase();
        if (candidateHost !== baseHost) score += 40;
    } catch {
        // ignore parse failures
    }

    if (isAssetUrl(candidate) || isHomepageUrl(candidate)) score -= 1000;
    return score;
}

function isPromisingProviderArchiveCandidate(candidate) {
    if (!candidate) return false;
    const lower = candidate.toLowerCase();
    if (isAssetUrl(candidate) || isHomepageUrl(candidate)) return false;
    if (isProviderArchiveWrapperUrl(candidate) || isProviderArchiveGetLinkUrl(candidate)) return true;
    if (/\?sid=/i.test(candidate) && UHDMOVIES_SID_HOSTS.some(h => lower.includes(h))) return true;
    if (/\/r\.php\?id=/i.test(lower) && lower.includes('gdrivepro.')) return true;
    if (/urlflix\.xyz\/gets?\//i.test(lower)) return true;
    if (PROVIDER_ARCHIVE_TARGET_HOST_HINTS.some(h => lower.includes(h))) return true;
    return false;
}

function collectProviderArchiveCandidates(response, requestUrl) {
    const base = response?.url || requestUrl;
    const rawCandidates = [];

    const location = response?.headers?.location || response?.headers?.Location;
    if (location) {
        const resolved = normalizeAbsoluteUrl(location, base);
        if (resolved) rawCandidates.push(resolved);
    }

    if (response?.url) {
        rawCandidates.push(response.url);
    }

    rawCandidates.push(...extractRedirectCandidates(response?.body || '', response?.document || null, base));

    const seen = new Set();
    const deduped = [];
    for (const candidate of rawCandidates) {
        if (!candidate || seen.has(candidate)) continue;
        seen.add(candidate);
        deduped.push(candidate);
    }
    return deduped;
}

function collectProviderArchiveEpisodeLinks(response, requestUrl, hints = {}) {
    const episodeNumber = getEpisodeNumberFromHint(hints?.episode);
    const $ = response?.document;
    if (!$ || !episodeNumber) return [];

    const matches = [];
    $('a[href]').each((_, el) => {
        const href = $(el).attr('href');
        if (!href) return;
        const text = ($(el).text() || '').replace(/\s+/g, ' ').trim();
        const textMatch = text.match(/\bEpisode\s*(\d{1,3})\b/i) || text.match(/\bEp(?:isode)?\.?\s*(\d{1,3})\b/i);
        if (!textMatch) return;
        const foundEpisode = parseInt(textMatch[1], 10);
        if (!Number.isFinite(foundEpisode) || foundEpisode !== episodeNumber) return;
        const resolved = normalizeAbsoluteUrl(href, response?.url || requestUrl);
        if (!resolved) return;
        matches.push({ url: resolved, text });
    });

    // Provider archive pages often contain duplicate "Episode N" links; prefer later entries first.
    const seen = new Set();
    const ordered = [];
    for (let i = matches.length - 1; i >= 0; i -= 1) {
        const candidate = matches[i];
        if (!candidate?.url || seen.has(candidate.url)) continue;
        seen.add(candidate.url);
        ordered.push(candidate.url);
    }
    return ordered;
}

async function resolveProviderArchiveGetLink(getLinkUrl, referer = null, hints = {}) {
    const response = await fetchWithCloudflare(getLinkUrl, {
        timeout: 15000,
        allowRedirects: false,
        preferFlareSolverr: true,
        headers: {
            'User-Agent': OUO_USER_AGENT,
            'Referer': referer || getLinkUrl,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.5'
        }
    });

    const location = response?.headers?.location || response?.headers?.Location;
    if (location) {
        const resolved = normalizeAbsoluteUrl(location, response?.url || getLinkUrl);
        if (resolved) {
            return resolved;
        }
    }

    const candidates = collectProviderArchiveCandidates(response, getLinkUrl)
        .filter(candidate => candidate && candidate !== getLinkUrl && isPromisingProviderArchiveCandidate(candidate))
        .sort((a, b) => rankProviderArchiveCandidate(b, getLinkUrl, hints) - rankProviderArchiveCandidate(a, getLinkUrl, hints));

    for (const candidate of candidates) {
        if (isProviderArchiveGetLinkUrl(candidate)) continue;
        if (isProviderArchiveWrapperUrl(candidate)) return candidate;
        return candidate;
    }

    if (response?.url && response.url !== getLinkUrl) {
        return response.url;
    }

    return null;
}

async function resolveProviderArchiveWrapper(archiveUrl, hints = {}, depth = 0, visited = new Set()) {
    if (!archiveUrl) return null;
    if (depth > 3) return null;
    if (visited.has(archiveUrl)) return null;
    visited.add(archiveUrl);

    console.log(`[HTTP-RESOLVE] Expanding provider archive wrapper (depth ${depth + 1}): ${archiveUrl.substring(0, 100)}...`);

    const response = await fetchWithCloudflare(archiveUrl, {
        timeout: 15000,
        preferFlareSolverr: true,
        headers: {
            'User-Agent': OUO_USER_AGENT,
            'Referer': archiveUrl,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.5',
            'Connection': 'keep-alive',
            'Upgrade-Insecure-Requests': '1'
        }
    });

    if (response?.url && response.url !== archiveUrl && !isProviderArchiveDomain((() => {
        try { return new URL(response.url).hostname; } catch { return ''; }
    })())) {
        return response.url;
    }

    // Provider archive pages (AnimeFlix / Episodes.ModPro) often contain episode-labeled links.
    // If we have an episode hint, try exact matching episode entries first.
    try {
        const episodeCandidates = collectProviderArchiveEpisodeLinks(response, archiveUrl, hints);
        if (episodeCandidates.length) {
            console.log(`[HTTP-RESOLVE] Provider episode hint ${hints.episode}: trying ${episodeCandidates.length} candidate(s)`);
            for (const candidate of episodeCandidates) {
                if (visited.has(candidate)) continue;
                let resolved = candidate;

                if (isProviderArchiveGetLinkUrl(candidate)) {
                    resolved = await resolveProviderArchiveGetLink(candidate, response?.url || archiveUrl, hints);
                }

                if (!resolved) continue;
                if (isProviderArchiveWrapperUrl(resolved)) {
                    const nested = await resolveProviderArchiveWrapper(resolved, hints, depth + 1, visited);
                    if (nested) return nested;
                    continue;
                }
                if (isProviderArchiveGetLinkUrl(resolved)) {
                    const nested = await resolveProviderArchiveGetLink(resolved, response?.url || archiveUrl, hints);
                    if (nested) return nested;
                    continue;
                }
                return resolved;
            }
        }
    } catch (err) {
        console.log(`[HTTP-RESOLVE] Provider episode candidate parse failed: ${err.message}`);
    }

    const candidates = collectProviderArchiveCandidates(response, archiveUrl)
        .filter(candidate => candidate && candidate !== archiveUrl && isPromisingProviderArchiveCandidate(candidate))
        .sort((a, b) => rankProviderArchiveCandidate(b, archiveUrl, hints) - rankProviderArchiveCandidate(a, archiveUrl, hints));

    for (const candidate of candidates) {
        if (!candidate || visited.has(candidate)) continue;

        if (isProviderArchiveGetLinkUrl(candidate)) {
            try {
                const resolved = await resolveProviderArchiveGetLink(candidate, response?.url || archiveUrl, hints);
                if (!resolved) continue;
                if (isProviderArchiveWrapperUrl(resolved) || isProviderArchiveGetLinkUrl(resolved)) {
                    const nested = isProviderArchiveWrapperUrl(resolved)
                        ? await resolveProviderArchiveWrapper(resolved, hints, depth + 1, visited)
                        : await resolveProviderArchiveGetLink(resolved, response?.url || archiveUrl, hints);
                    if (nested) return nested;
                    continue;
                }
                return resolved;
            } catch (err) {
                console.log(`[HTTP-RESOLVE] Provider getlink resolution failed: ${err.message}`);
                continue;
            }
        }

        if (isProviderArchiveWrapperUrl(candidate)) {
            const nested = await resolveProviderArchiveWrapper(candidate, hints, depth + 1, visited);
            if (nested) return nested;
            continue;
        }

        if (!isAssetUrl(candidate) && !isHomepageUrl(candidate)) {
            return candidate;
        }
    }

    return null;
}

function extractMkvDramaToken(url) {
    if (!url) return null;
    try {
        const parsed = new URL(url);
        return parsed.searchParams.get(MKVDRAMA_TOKEN_PARAM);
    } catch {
        return null;
    }
}

function isMkvDramaProtectedLink(url) {
    if (!url) return false;
    try {
        const parsed = new URL(url);
        return (parsed.hostname.includes('mkvdrama.net') || parsed.hostname.includes('mkvdrama.org')) && /\/_c\//.test(parsed.pathname || '');
    } catch {
        return false;
    }
}

function extractMkvDramaDynamicApiInfo(html = '') {
    const body = String(html || '');
    if (!body) return null;

    const dataPathMatch = body.match(/data-k=["']([^"']+)["']/i);
    const guardKeyMatch = body.match(/data-k3=["']([^"']+)["']/i);
    const dataPath = dataPathMatch?.[1] || '';
    const guardKey = guardKeyMatch?.[1] || '';

    if (!dataPath || !guardKey) return null;
    return { dataPath, guardKey };
}

function buildMkvDramaAuthPath(dataPath = '') {
    const normalized = String(dataPath || '').trim();
    if (!normalized) return null;

    const absolute = normalized.startsWith('/') ? normalized : `/${normalized}`;
    if (absolute.endsWith('/_l_krc_uo')) {
        return `${absolute.slice(0, -10)}/oe_pq_invxe_l`;
    }

    if (absolute.endsWith('/')) {
        return `${absolute}oe_pq_invxe_l`;
    }

    return `${absolute}/oe_pq_invxe_l`;
}

function buildMkvDramaPostCandidatesFromProtectedLink(protectedUrl) {
    const candidates = [];
    const seen = new Set();

    const addCandidate = (candidate) => {
        const normalized = normalizeAbsoluteUrl(candidate, MKVDRAMA_BASE_URL);
        if (!normalized || seen.has(normalized)) return;
        seen.add(normalized);
        candidates.push(normalized);
    };

    try {
        const parsed = new URL(protectedUrl);
        const beforeToken = (parsed.pathname || '').split('/_c/')[0] || '';
        const trimmed = beforeToken.replace(/\/+$/, '');

        if (trimmed.startsWith('/titles/')) {
            const slug = trimmed.slice('/titles/'.length).replace(/^\/+/, '');
            if (slug) {
                addCandidate(`/${slug}/`);
                addCandidate(`/${slug}`);
            }
        }

        if (trimmed) {
            addCandidate(`${trimmed}/`);
            addCandidate(trimmed);
        }
    } catch {
        // Ignore invalid URL and return empty list.
    }

    return candidates;
}

function decryptMkvDramaDynamicPayload(encData, dataPath = '') {
    if (!encData?.d || !encData?.s || !dataPath) return '';

    try {
        const normalizedPath = dataPath.startsWith('/') ? dataPath : `/${dataPath}`;
        const material = `access-payload:${normalizedPath}`;
        const key = crypto.createHash('sha256').update(material).digest();
        const iv = Buffer.from(encData.s, 'hex');
        const raw = Buffer.from(encData.d, 'base64');
        const authTag = raw.subarray(raw.length - 16);
        const ciphertext = raw.subarray(0, raw.length - 16);
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(authTag);
        return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    } catch {
        return '';
    }
}

function collectMkvDramaProtectedCandidates(html = '') {
    const body = String(html || '');
    if (!body) return [];

    const $ = cheerio.load(body);
    const candidates = [];
    const seen = new Set();

    const addCandidate = (href, quality = '') => {
        const url = normalizeAbsoluteUrl(href, MKVDRAMA_BASE_URL);
        if (!url || seen.has(url)) return;
        seen.add(url);
        candidates.push({
            url,
            quality: String(quality || '').trim().toLowerCase()
        });
    };

    $('.soraurlx, .soraurl').each((_, box) => {
        const quality = $(box).find('strong, b').first().text();
        $(box).find('a[href*="/_c/"]').each((__, link) => {
            addCandidate($(link).attr('href'), quality);
        });
    });

    if (candidates.length === 0) {
        $('a[href*="/_c/"]').each((_, link) => addCandidate($(link).attr('href'), ''));
    }

    return candidates;
}

function pickMkvDramaProtectedCandidate(candidates = [], hints = {}, fallbackUrl = '') {
    if (!Array.isArray(candidates) || candidates.length === 0) return fallbackUrl || null;

    const targetResolutionRaw = String(hints?.resolution || '').trim().toLowerCase();
    if (targetResolutionRaw) {
        const targetResolution = targetResolutionRaw === '4k' ? '2160p' : targetResolutionRaw;
        const matched = candidates.find((candidate) => {
            const quality = String(candidate?.quality || '').toLowerCase();
            if (!quality) return false;
            if (quality === targetResolution) return true;
            if (quality.includes(targetResolution)) return true;
            if (targetResolution === '2160p' && quality.includes('4k')) return true;
            return false;
        });
        if (matched?.url) return matched.url;
    }

    return candidates[0]?.url || fallbackUrl || null;
}

function getMkvDramaResolverProxyAgent() {
    if (!MKVDRAMA_PROXY_URL) return null;
    if (!mkvDramaResolverProxyAgent || mkvDramaResolverProxyAgentUrl !== MKVDRAMA_PROXY_URL) {
        const scheme = MKVDRAMA_PROXY_URL.toLowerCase();
        if (scheme.startsWith('socks')) {
            const url = scheme.startsWith('socks5://')
                ? `socks5h://${MKVDRAMA_PROXY_URL.slice('socks5://'.length)}`
                : MKVDRAMA_PROXY_URL;
            mkvDramaResolverProxyAgent = new SocksProxyAgent(url);
        } else {
            mkvDramaResolverProxyAgent = new HttpsProxyAgent(MKVDRAMA_PROXY_URL);
        }
        mkvDramaResolverProxyAgentUrl = MKVDRAMA_PROXY_URL;
    }
    return mkvDramaResolverProxyAgent;
}

let _getMkvDramaCfSessionFn = null;

async function getMkvDramaCfCookies(proxyAgent) {
    const domain = (() => {
        try { return new URL(MKVDRAMA_BASE_URL).hostname; } catch { return 'mkvdrama.net'; }
    })();

    // Fast path: use resolver's own cached CF cookies
    const cached = getCachedCfCookies(domain);
    if (cached?.cookies) {
        console.log(`[HTTP-RESOLVE] Using cached CF cookies for ${domain}`);
        return { cookies: cached.cookies, userAgent: cached.userAgent };
    }

    // Use the browser module's CF cookie provider (it has its own FlareSolverr integration
    // with the right proxy config for mkvdrama.net and caches cookies for 30 min)
    if (!_getMkvDramaCfSessionFn) {
        try {
            const browserMod = await import('../providers/mkvdrama/browser.js');
            _getMkvDramaCfSessionFn = browserMod.getMkvDramaCfSession || null;
        } catch (err) {
            console.log(`[HTTP-RESOLVE] Failed to load mkvdrama browser module: ${err.message}`);
        }
    }

    if (_getMkvDramaCfSessionFn) {
        console.log(`[HTTP-RESOLVE] Obtaining CF cookies for ${domain} via browser module...`);
        try {
            const cfData = await _getMkvDramaCfSessionFn();
            if (cfData?.cookie && cfData?.ua) {
                // Also cache in the resolver's own cookie cache for fast reuse
                const cookieObjs = cfData.cookie.split('; ').map(pair => {
                    const [name, ...rest] = pair.split('=');
                    return { name, value: rest.join('='), domain: `.${domain}` };
                });
                cacheCfCookies(domain, cookieObjs, cfData.ua);
                console.log(`[HTTP-RESOLVE] Got CF cookies for ${domain} via browser module`);
                return { cookies: cfData.cookie, userAgent: cfData.ua };
            }
        } catch (err) {
            console.log(`[HTTP-RESOLVE] Browser module CF cookie fetch failed: ${err.message}`);
        }
    }

    // Fallback: try FlareSolverr directly
    if (FLARESOLVERR_URL) {
        console.log(`[HTTP-RESOLVE] Obtaining CF cookies for ${domain} via FlareSolverr (fallback)...`);
        try {
            await fetchWithFlareSolverr(`${MKVDRAMA_BASE_URL}/`, {
                method: 'GET',
                timeout: FLARESOLVERR_TIMEOUT
            });
            const freshCached = getCachedCfCookies(domain);
            if (freshCached?.cookies) {
                console.log(`[HTTP-RESOLVE] Got CF cookies for ${domain} via FlareSolverr`);
                return { cookies: freshCached.cookies, userAgent: freshCached.userAgent };
            }
        } catch (err) {
            console.log(`[HTTP-RESOLVE] FlareSolverr CF bypass for ${domain} failed: ${err.message}`);
        }
    }

    return null;
}

async function resolveMkvDramaProtectedLink(protectedUrl, hints = {}) {
    if (!isMkvDramaProtectedLink(protectedUrl)) return null;

    const proxyAgent = getMkvDramaResolverProxyAgent();
    if (!proxyAgent) {
        console.log('[HTTP-RESOLVE] MKVDrama protected link requires MKVDRAMA_DIRECT_PROXY_URL');
        return null;
    }

    // Obtain CF cookies before making any requests to mkvdrama.net
    const cfSession = await getMkvDramaCfCookies(proxyAgent);
    const cfUserAgent = cfSession?.userAgent || OUO_USER_AGENT;
    const cfCookieString = cfSession?.cookies || '';

    if (!cfCookieString) {
        console.log('[HTTP-RESOLVE] MKVDrama: no CF cookies available, resolution will likely fail');
    }

    const postCandidates = buildMkvDramaPostCandidatesFromProtectedLink(protectedUrl);
    for (const postUrl of postCandidates) {
        let cookieHeader = cfCookieString;
        const origin = (() => {
            try { return new URL(postUrl).origin; } catch { return MKVDRAMA_BASE_URL; }
        })();

        try {
            const pageResponse = await axios.get(postUrl, {
                timeout: 20000,
                validateStatus: () => true,
                headers: {
                    'User-Agent': cfUserAgent,
                    'Accept': 'text/html,application/xhtml+xml',
                    ...(cookieHeader ? { 'Cookie': cookieHeader } : {})
                },
                httpAgent: proxyAgent,
                httpsAgent: proxyAgent,
                proxy: false
            });

            cookieHeader = mergeCookieHeader(cookieHeader, pageResponse.headers?.['set-cookie']);
            const pageHtml = typeof pageResponse.data === 'string'
                ? pageResponse.data
                : JSON.stringify(pageResponse.data || {});

            console.log(`[HTTP-RESOLVE] MKVDrama page ${postUrl}: status=${pageResponse.status}, length=${pageHtml.length}`);

            // Check if we got a CF challenge despite having cookies
            if (pageResponse.status === 403 || isCloudflareChallenge(pageHtml, pageResponse.status)) {
                console.log(`[HTTP-RESOLVE] MKVDrama page ${postUrl} returned CF challenge (status ${pageResponse.status})`);
                continue;
            }

            const apiInfo = extractMkvDramaDynamicApiInfo(pageHtml);
            if (!apiInfo) {
                const titleMatch = pageHtml.match(/<title[^>]*>([^<]*)/i);
                console.log(`[HTTP-RESOLVE] MKVDrama page ${postUrl}: no apiInfo (data-k/data-k3 not found), title: ${titleMatch?.[1] || 'none'}`);
                continue;
            }
            console.log(`[HTTP-RESOLVE] MKVDrama apiInfo found: dataPath=${apiInfo.dataPath}, guardKey=${apiInfo.guardKey}`);

            const apiUrl = normalizeAbsoluteUrl(apiInfo.dataPath, MKVDRAMA_BASE_URL);
            const authPath = buildMkvDramaAuthPath(apiInfo.dataPath);
            const authUrl = authPath ? normalizeAbsoluteUrl(authPath, MKVDRAMA_BASE_URL) : null;
            if (!apiUrl || !authUrl) continue;

            const step1Attempts = [
                { r: null, i: false, w: false, [apiInfo.guardKey]: '' },
                { r: null, i: true, w: false, [apiInfo.guardKey]: '' }
            ];

            let step1Ok = false;
            for (const payload of step1Attempts) {
                const step1 = await axios.post(apiUrl, payload, {
                    timeout: 20000,
                    validateStatus: () => true,
                    headers: {
                        'User-Agent': cfUserAgent,
                        'Accept': 'application/json, text/plain, */*',
                        'Content-Type': 'application/json',
                        'Origin': origin,
                        'Referer': postUrl,
                        ...(cookieHeader ? { 'Cookie': cookieHeader } : {})
                    },
                    httpAgent: proxyAgent,
                    httpsAgent: proxyAgent,
                    proxy: false
                });
                cookieHeader = mergeCookieHeader(cookieHeader, step1.headers?.['set-cookie']);
                console.log(`[HTTP-RESOLVE] MKVDrama step1 POST ${apiUrl}: status=${step1.status}`);
                if ([200, 201, 202, 204].includes(step1.status)) {
                    step1Ok = true;
                    break;
                }
            }
            if (!step1Ok) {
                console.log(`[HTTP-RESOLVE] MKVDrama step1 failed for ${postUrl}`);
                continue;
            }

            const step2 = await axios.post(authUrl, {
                r: null,
                w: false,
                [apiInfo.guardKey]: ''
            }, {
                timeout: 20000,
                validateStatus: () => true,
                headers: {
                    'User-Agent': cfUserAgent,
                    'Accept': 'application/json, text/plain, */*',
                    'Content-Type': 'application/json',
                    'Origin': origin,
                    'Referer': postUrl,
                    ...(cookieHeader ? { 'Cookie': cookieHeader } : {})
                },
                httpAgent: proxyAgent,
                httpsAgent: proxyAgent,
                proxy: false
            });
            cookieHeader = mergeCookieHeader(cookieHeader, step2.headers?.['set-cookie']);
            console.log(`[HTTP-RESOLVE] MKVDrama step2 POST: status=${step2.status}, hasData=${!!(step2.data?.d && step2.data?.s)}`);
            if (step2.status >= 400) {
                console.log(`[HTTP-RESOLVE] MKVDrama step2 failed (status ${step2.status})`);
                continue;
            }

            let activeProtectedUrl = protectedUrl;
            if (step2.status === 200 && step2.data?.d && step2.data?.s) {
                const dynamicHtml = decryptMkvDramaDynamicPayload(step2.data, apiInfo.dataPath);
                console.log(`[HTTP-RESOLVE] MKVDrama decrypted payload: ${dynamicHtml ? dynamicHtml.length + ' chars' : 'failed'}`);
                if (dynamicHtml) {
                    const freshCandidates = collectMkvDramaProtectedCandidates(dynamicHtml);
                    const selected = pickMkvDramaProtectedCandidate(freshCandidates, hints, protectedUrl);
                    if (selected) {
                        activeProtectedUrl = selected;
                    }
                }
            }

            const protectedResponse = await axios.get(activeProtectedUrl, {
                timeout: 20000,
                maxRedirects: 0,
                validateStatus: () => true,
                headers: {
                    'User-Agent': cfUserAgent,
                    'Accept': 'text/html,application/xhtml+xml',
                    'Referer': postUrl,
                    ...(cookieHeader ? { 'Cookie': cookieHeader } : {})
                },
                httpAgent: proxyAgent,
                httpsAgent: proxyAgent,
                proxy: false
            });

            const location = protectedResponse.headers?.location || protectedResponse.headers?.Location;
            if (location) {
                const redirect = normalizeAbsoluteUrl(location, activeProtectedUrl);
                if (redirect && !redirect.includes('mkvdrama.net')) {
                    return redirect;
                }
            }

            const finalUrl = protectedResponse.request?.res?.responseUrl || '';
            if (finalUrl && !finalUrl.includes('mkvdrama.net')) {
                return finalUrl;
            }

            const body = typeof protectedResponse.data === 'string'
                ? protectedResponse.data
                : JSON.stringify(protectedResponse.data || {});
            const doc = body ? cheerio.load(body) : null;
            const extracted = pickFirstExternalCandidate(
                extractRedirectCandidates(body, doc, activeProtectedUrl),
                activeProtectedUrl,
                [...OUO_HOSTS, ...VIEWCRATE_HOSTS, ...FILECRYPT_HOSTS, ...PIXELDRAIN_HOSTS]
            );
            if (extracted) {
                return extracted;
            }

            const embedded = pickFirstExternalCandidate(
                extractEmbeddedShortlinkTargets(doc, body, activeProtectedUrl),
                activeProtectedUrl,
                [...OUO_HOSTS, ...VIEWCRATE_HOSTS, ...FILECRYPT_HOSTS, ...PIXELDRAIN_HOSTS]
            );
            if (embedded) {
                return embedded;
            }
        } catch (error) {
            console.log(`[HTTP-RESOLVE] MKVDrama protected link resolution failed for ${postUrl}: ${error.message}`);
        }
    }

    // Fallback: use Puppeteer browser session to resolve the _c/ link
    console.log(`[HTTP-RESOLVE] MKVDrama HTTP resolution failed, trying Puppeteer fallback for ${protectedUrl}`);
    try {
        const browserMod = await import('../providers/mkvdrama/browser.js');
        if (browserMod.browserResolveProtectedLink) {
            const resolved = await browserMod.browserResolveProtectedLink(protectedUrl, hints);
            if (resolved) {
                console.log(`[HTTP-RESOLVE] MKVDrama Puppeteer fallback resolved: ${resolved.substring(0, 80)}...`);
                return resolved;
            }
        }
    } catch (err) {
        console.log(`[HTTP-RESOLVE] MKVDrama Puppeteer fallback failed: ${err.message}`);
    }

    return null;
}

async function resolveMkvDramaToken(token) {
    if (!token) return null;
    const candidates = [
        `${MKVDRAMA_BASE_URL}/?download=${token}`,
        `${MKVDRAMA_BASE_URL}/?go=${token}`,
        `${MKVDRAMA_BASE_URL}/?dl=${token}`,
        `${MKVDRAMA_BASE_URL}/?link=${token}`,
        `${MKVDRAMA_BASE_URL}/?r=${token}`,
        `${MKVDRAMA_BASE_URL}/?id=${token}`
    ];

    const proxyAgent = getMkvDramaResolverProxyAgent();

    // Get CF cookies for mkvdrama.net
    const cfSession = await getMkvDramaCfCookies(proxyAgent);
    const cfUserAgent = cfSession?.userAgent || OUO_USER_AGENT;
    const cfCookieString = cfSession?.cookies || '';

    for (const candidate of candidates) {
        try {
            const axiosConfig = {
                method: 'GET',
                url: candidate,
                headers: {
                    'User-Agent': cfUserAgent,
                    'Referer': MKVDRAMA_BASE_URL,
                    ...(cfCookieString ? { 'Cookie': cfCookieString } : {})
                },
                timeout: 15000,
                maxRedirects: 5,
                validateStatus: () => true
            };
            if (proxyAgent) {
                axiosConfig.httpAgent = proxyAgent;
                axiosConfig.httpsAgent = proxyAgent;
                axiosConfig.proxy = false;
            }
            const resp = await axios.request(axiosConfig);
            const body = typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data || {});
            const response = {
                statusCode: resp.status,
                body,
                document: cheerio.load(body),
                url: resp.request?.res?.responseUrl || candidate
            };

            const resolvedUrl = response?.url;
            if (resolvedUrl && !resolvedUrl.includes('mkvdrama.net')) {
                return resolvedUrl;
            }

            const extracted = extractRedirectCandidates(response?.body || '', response?.document || null, candidate)
                .filter(url => url && !url.includes('mkvdrama.net'));
            if (extracted.length) {
                return extracted[0];
            }
        } catch (err) {
            console.log(`[HTTP-RESOLVE] MKVDrama token resolution failed for ${candidate}: ${err.message}`);
        }
    }

    return null;
}

async function resolveXDMoviesRedirect(url) {
    if (!url || !XDMOVIES_LINK_HOSTS.some(host => url.includes(host))) {
        return url;
    }

    try {
        const response = await makeRequest(url, {
            allowRedirects: false,
            parseHTML: false,
            timeout: 8000
        });

        const location = response.headers?.location || response.headers?.['Location'];
        if (location) {
            return new URL(location, url).toString();
        }

        if (response.url && response.url !== url) {
            return response.url;
        }

        const body = response.body || '';
        const hubMatch = body.match(/https?:\/\/[^\s"'<>]*(?:hubcloud|hubdrive|hubcdn)[^\s"'<>]*/i);
        if (hubMatch?.[0]) {
            return hubMatch[0];
        }
    } catch (err) {
        console.log(`[HTTP-RESOLVE] XDMovies redirect resolution failed: ${err.message}`);
    }

    return url;
}

async function resolveXDMoviesProtectorUrl(url) {
    if (!url) return url;

    try {
        return await resolveXDMoviesProtectedUrl(url, {
            userAgent: OUO_USER_AGENT
        });
    } catch (err) {
        console.log(`[HTTP-RESOLVE] XDMovies protector resolution failed: ${err.message}`);
    }

    return url;
}

function normalizePixeldrainUrl(url) {
    if (!url) return null;
    try {
        const parsed = new URL(url);
        if (!PIXELDRAIN_HOSTS.includes(parsed.hostname)) {
            return url;
        }
        if (parsed.pathname.startsWith('/api/file/')) {
            return parsed.toString();
        }
        const match = parsed.pathname.match(/\/u\/([^/]+)/);
        if (match?.[1]) {
            return `https://pixeldrain.com/api/file/${match[1]}?download`;
        }
        return parsed.toString();
    } catch {
        return url;
    }
}

function collectViewcrateEntries(document, baseUrl) {
    const candidates = [];
    const seen = new Set();

    if (!document) return candidates;

    const decodeViewcrateToken = (raw = '') => {
        const encoded = String(raw || '').trim();
        if (!encoded) return null;
        try {
            const normalized = encoded
                .replace(/-/g, '+')
                .replace(/_/g, '/')
                .padEnd(Math.ceil(encoded.length / 4) * 4, '=');
            const decoded = Buffer.from(normalized, 'base64').toString('utf8').trim();
            return /^[a-f0-9]{16,}$/i.test(decoded) ? decoded : null;
        } catch {
            return null;
        }
    };

    const findDataAttributeValue = ($node, matcher) => {
        const attrs = $node?.get(0)?.attribs || {};
        for (const [attr, value] of Object.entries(attrs)) {
            if (!attr.startsWith('data-')) continue;
            if (matcher(value, attr)) return value;
        }
        return null;
    };

    // Current ViewCrate pages randomize attribute names, but download buttons still expose
    // a base64-encoded /get token in a data-* attribute alongside data-opts.
    document('[data-opts], [class^="v_"]').each((_, el) => {
        const $el = document(el);
        const encodedToken = findDataAttributeValue($el, (value) => Boolean(decodeViewcrateToken(value)));
        const token = decodeViewcrateToken(encodedToken);
        if (!token) return;

        const getUrl = normalizeAbsoluteUrl(`/get/${token}`, baseUrl);
        if (!getUrl || seen.has(getUrl)) return;
        seen.add(getUrl);

        const $entry = $el.closest('[class^="y_"], [data-0225s], [data-n053d]');
        const $episode = $el.closest('[class^="z_"], [data-mwuab], [data-0tglq]');
        const hostAttr = findDataAttributeValue($entry, (value) => {
            const lower = String(value || '').toLowerCase();
            return lower.includes('.') || PIXELDRAIN_HOSTS.some(h => lower.includes(h));
        });
        const episodeAttr = findDataAttributeValue($episode, (value) => /^S\d{1,2}E\d{1,3}$/i.test(String(value || '').trim()));
        const host = (hostAttr || $entry.find('[class^="w_"]').first().text() || '').trim().toLowerCase() || null;
        const filename = ($entry.find('[class^="x_"], span').first().text() || '').trim() || null;
        const episodeKey = (episodeAttr || $episode.find('h2, h3').first().text() || '').trim().toUpperCase() || null;

        candidates.push({
            episodeKey,
            host,
            filename,
            resolution: getResolutionFromName(filename || ''),
            getUrl
        });
    });

    if (candidates.length > 0) {
        return candidates;
    }

    // Strategy 1: Find all onclick handlers that contain /get/ URLs (most robust)
    // This works regardless of class name changes
    document('[onclick*="/get/"]').each((_, el) => {
        const $el = document(el);
        const onclick = $el.attr('onclick') || '';
        const getMatch = onclick.match(/\/get\/[A-Za-z0-9]+/);
        if (!getMatch) return;

        const getPath = getMatch[0];
        const getUrl = normalizeAbsoluteUrl(getPath, baseUrl);
        if (!getUrl || seen.has(getUrl)) return;
        seen.add(getUrl);

        // Walk up to find episode and host info from parent containers
        let episodeKey = null;
        let host = null;
        let filename = null;

        // Look for episode info in parent elements (check data attributes and text)
        const $parent = $el.closest('[class^="z_"]');
        if ($parent.length) {
            // Try data attributes first
            const dataAttrs = $parent.get(0)?.attribs || {};
            for (const [attr, val] of Object.entries(dataAttrs)) {
                if (attr.startsWith('data-') && /^S\d{1,2}E\d{1,3}$/i.test(val)) {
                    episodeKey = val.toUpperCase();
                    break;
                }
            }
            // Try text content
            if (!episodeKey) {
                const text = $parent.find('h2, h3, [class^="x_"]').first().text().trim();
                const epMatch = text.match(/S\d{1,2}E\d{1,3}/i);
                if (epMatch) episodeKey = epMatch[0].toUpperCase();
            }
        }

        // Look for host info in sibling/parent elements
        const $entry = $el.closest('[class^="y_"]');
        if ($entry.length) {
            // Check data attributes for host
            const dataAttrs = $entry.get(0)?.attribs || {};
            for (const [attr, val] of Object.entries(dataAttrs)) {
                if (attr.startsWith('data-') && val && !val.startsWith('S')) {
                    const lower = val.toLowerCase();
                    if (lower.includes('.') || PIXELDRAIN_HOSTS.some(h => lower.includes(h))) {
                        host = lower;
                        break;
                    }
                }
            }
            // Try text content for host
            if (!host) {
                const hostText = $entry.find('[class^="w_"]').first().text().trim().toLowerCase();
                if (hostText && (hostText.includes('.') || hostText.includes('pixeldrain'))) {
                    host = hostText;
                }
            }
            // Try to extract filename
            filename = $entry.find('[class^="x_"], span').first().text().trim();
        }

        const resolution = getResolutionFromName(filename || '');

        candidates.push({
            episodeKey,
            host,
            filename,
            resolution,
            getUrl
        });
    });

    // Strategy 2: Legacy selectors (fallback for older page versions)
    if (candidates.length === 0) {
        const blockSelectors = [
            { selector: '.z_qmnyt', episodeAttr: 'data-8wg7v' },
            { selector: '.z_w78ax', episodeAttr: 'data-rjcoq' },
            { selector: '.z_26tgx', episodeAttr: 'data-pirz6' },
            { selector: '[data-8wg7v]', episodeAttr: 'data-8wg7v' },
            { selector: '[data-rjcoq]', episodeAttr: 'data-rjcoq' },
            { selector: '[data-pirz6]', episodeAttr: 'data-pirz6' }
        ];

        blockSelectors.forEach(({ selector, episodeAttr }) => {
            document(selector).each((_, block) => {
                const $block = document(block);
                const episodeKey = $block.attr(episodeAttr) ||
                    $block.find('h2').first().text().trim();

                $block.find('.y_u5qme, .y_tpl1j, .y_vbmuk, [data-ogehf], [data-7kuiu], [data-s5t96]').each((__, entry) => {
                    const $entry = document(entry);
                    const hostAttr = $entry.attr('data-ogehf') || $entry.attr('data-7kuiu') || $entry.attr('data-s5t96') || '';
                    let host = hostAttr.toLowerCase();
                    if (!host) {
                        const hostText = $entry.find('.w_po9rr, .w_4vj7h, .w_t2b66').first().text().trim();
                        host = hostText.toLowerCase();
                    }

                    const filename = $entry.find('.x_qwwj2, .x_i29qt, .x_aegdv').first().text().trim() ||
                        $entry.find('span').first().text().trim();
                    const resolution = getResolutionFromName(filename);
                    const opener = $entry.find('.v_wldd7, .v_65zvr, [onclick*="/get/"]').attr('onclick') || '';
                    const getMatch = opener.match(/\/get\/[A-Za-z0-9]+/);
                    const getPath = getMatch ? getMatch[0] : null;
                    const getUrl = normalizeAbsoluteUrl(getPath, baseUrl);

                    if (!getUrl) return;
                    const key = `${episodeKey || ''}|${host || ''}|${getUrl}`;
                    if (seen.has(key)) return;
                    seen.add(key);

                    candidates.push({
                        episodeKey,
                        host,
                        filename,
                        resolution,
                        getUrl
                    });
                });
            });
        });
    }

    return candidates;
}

function parseViewcrateEncryptedPayload(body = '') {
    if (!body) return null;

    const extract = (key) => {
        // Fix: use correct escaping for RegExp constructor
        // \\.  -> \.  in regex (matches literal dot)
        // \\s  -> \s  in regex (matches whitespace)
        const pattern = new RegExp(`window\\.${key}\\s*=\\s*["']([^"']+)["']`);
        const match = body.match(pattern);
        return match?.[1] || null;
    };

    const encodedKey = extract('_k');
    const encodedIv = extract('_i');
    const encodedCiphertext = extract('_c');

    if (!encodedKey || !encodedIv || !encodedCiphertext) {
        console.log('[HTTP-RESOLVE] ViewCrate encrypted payload missing keys', {
            hasKey: Boolean(encodedKey),
            hasIv: Boolean(encodedIv),
            hasCiphertext: Boolean(encodedCiphertext)
        });
        return null;
    }

    try {
        const key = Buffer.from(encodedKey, 'base64');
        const iv = Buffer.from(encodedIv, 'base64');
        const data = Buffer.from(encodedCiphertext, 'base64');
        if (key.length !== 32) {
            console.log(`[HTTP-RESOLVE] ViewCrate key length unexpected: ${key.length}`);
        }
        if (iv.length < 12) {
            console.log(`[HTTP-RESOLVE] ViewCrate IV length unexpected: ${iv.length}`);
        }
        if (data.length <= 16) {
            return null;
        }

        const tag = data.slice(data.length - 16);
        const ciphertext = data.slice(0, data.length - 16);
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(tag);
        const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
        return JSON.parse(decrypted);
    } catch (error) {
        console.log(`[HTTP-RESOLVE] ViewCrate decrypt failed: ${error.message}`);
        return null;
    }
}

function collectViewcrateEncryptedEntries(body, baseUrl) {
    const payload = parseViewcrateEncryptedPayload(body);
    if (!payload || !Array.isArray(payload.d)) {
        return [];
    }

    const candidates = [];

    payload.d.forEach(entry => {
        const episodeKey = entry?.t || null;
        const links = Array.isArray(entry?.l) ? entry.l : [];
        links.forEach(link => {
            const filename = link?.n || '';
            const host = (link?.h || '').toLowerCase();
            const token = link?.u || '';
            if (!token) return;

            const getPath = token.startsWith('/get/')
                ? token
                : `/get/${token.replace(/^\/+/, '')}`;
            const getUrl = normalizeAbsoluteUrl(getPath, baseUrl);
            if (!getUrl) return;

            candidates.push({
                episodeKey,
                host,
                filename,
                resolution: getResolutionFromName(filename),
                getUrl
            });
        });
    });

    return candidates;
}

function normalizeHostHint(host) {
    if (!host) return null;
    const lower = host.toLowerCase();
    if (lower.includes('pixeldrain')) return 'pixeldrain';
    return lower;
}

function candidateMatchesHost(candidate, hostHint) {
    if (!hostHint || !candidate?.host) return false;
    const host = candidate.host.toLowerCase();
    if (hostHint === 'pixeldrain') return host.includes('pixeldrain');
    return host.includes(hostHint);
}

function orderViewcrateCandidates(candidates, hints = {}) {
    if (!candidates.length) return [];

    let filtered = candidates;

    if (hints.episode) {
        filtered = filtered.filter(candidate => candidate.episodeKey === hints.episode);
    }

    if (hints.resolution) {
        const normalizedResolution = hints.resolution === '4k' ? '2160p' : hints.resolution;
        filtered = filtered.filter(candidate => candidate.resolution === normalizedResolution);
    }

    const hostHint = normalizeHostHint(hints.host || null);
    if (hostHint) {
        const hostFiltered = filtered.filter(candidate => candidateMatchesHost(candidate, hostHint));
        if (hostFiltered.length) {
            filtered = hostFiltered;
        } else {
            return [];
        }
    }

    if (!filtered.length) {
        filtered = candidates;
    }

    const preferredHost = normalizeHostHint(hints.host || 'pixeldrain.com');
    const matchesHost = (candidate) => {
        if (!preferredHost || !candidate?.host) return false;
        const host = candidate.host.toLowerCase();
        if (preferredHost === 'pixeldrain') return host.includes('pixeldrain');
        return host.includes(preferredHost);
    };

    const preferred = filtered.filter(matchesHost);
    const fallback = filtered.filter(candidate => !matchesHost(candidate));
    return [...preferred, ...fallback];
}

function extractViewcrateCandidatesFromHtml(body, baseUrl) {
    if (!body) return [];

    const $ = cheerio.load(body);
    let candidates = collectViewcrateEntries($, baseUrl);
    if (candidates.length === 0) {
        candidates = collectViewcrateEncryptedEntries(body, baseUrl);
    }
    return candidates;
}

function isViewcrateProtectedPage(document, body = '') {
    if (document?.('form[action*="/unlock/"] input[name="password"]').length) {
        return true;
    }

    const lower = String(body || '').toLowerCase();
    return lower.includes('protected content') && lower.includes('password protected');
}

function resolveViewcrateBrowserExecutablePath() {
    if (viewcrateResolvedBrowserExecutable !== undefined) {
        return viewcrateResolvedBrowserExecutable;
    }

    for (const candidate of VIEWCRATE_BROWSER_EXECUTABLE_CANDIDATES) {
        try {
            if (candidate && fs.existsSync(candidate)) {
                viewcrateResolvedBrowserExecutable = candidate;
                console.log(`[HTTP-RESOLVE] Browser fallback using executable: ${candidate}`);
                return candidate;
            }
        } catch {
            // Ignore invalid candidate paths.
        }
    }

    viewcrateResolvedBrowserExecutable = null;
    return null;
}

function getViewcrateBrowserLaunchOptions() {
    const options = {
        headless: 'new',
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
        timeout: VIEWCRATE_BROWSER_TIMEOUT_MS,
        protocolTimeout: 180000
    };

    const browserProxy = parseBrowserProxyConfig(RESOLVER_BROWSER_PROXY_URL);
    if (browserProxy.proxyServer) {
        options.args.push(`--proxy-server=${browserProxy.proxyServer}`);
    }

    const executablePath = resolveViewcrateBrowserExecutablePath();
    if (executablePath) {
        options.executablePath = executablePath;
    }

    return options;
}

async function getViewcrateStealthPuppeteer() {
    if (!VIEWCRATE_BROWSER_FALLBACK_ENABLED) return null;
    if (!viewcrateStealthPuppeteerPromise) {
        viewcrateStealthPuppeteerPromise = (async () => {
            const [{ default: puppeteerExtra }, { default: StealthPlugin }] = await Promise.all([
                import('puppeteer-extra'),
                import('puppeteer-extra-plugin-stealth')
            ]);
            if (!viewcrateStealthPluginApplied) {
                puppeteerExtra.use(StealthPlugin());
                viewcrateStealthPluginApplied = true;
            }
            return puppeteerExtra;
        })().catch((error) => {
            viewcrateStealthPuppeteerPromise = null;
            throw error;
        });
    }
    return viewcrateStealthPuppeteerPromise;
}

async function newPageWithRetry(browser, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            return await browser.newPage();
        } catch (err) {
            if (i < retries - 1 && /main frame too early/i.test(err.message)) {
                await new Promise(r => setTimeout(r, 200 * (i + 1)));
                continue;
            }
            throw err;
        }
    }
}

async function unlockViewcrateWithBrowser(viewcrateUrl, hints = {}) {
    const passwords = normalizePasswordHints(hints.passwords || []);
    if (!passwords.length || !VIEWCRATE_BROWSER_FALLBACK_ENABLED) return [];

    let browser = null;

    try {
        const puppeteerExtra = await getViewcrateStealthPuppeteer();
        if (!puppeteerExtra) return [];

        browser = await puppeteerExtra.launch(getViewcrateBrowserLaunchOptions());

        const page = await newPageWithRetry(browser);
        const browserProxy = parseBrowserProxyConfig(RESOLVER_BROWSER_PROXY_URL);
        if (browserProxy.username || browserProxy.password) {
            await page.authenticate({
                username: browserProxy.username || '',
                password: browserProxy.password || ''
            });
        }
        await page.setUserAgent(OUO_USER_AGENT).catch(() => {});
        await page.goto(viewcrateUrl, {
            waitUntil: 'domcontentloaded',
            timeout: VIEWCRATE_BROWSER_TIMEOUT_MS
        });

        const tryExtract = async () => {
            const html = await page.content().catch(() => '');
            return extractViewcrateCandidatesFromHtml(html, page.url());
        };

        let candidates = await tryExtract();
        if (candidates.length > 0) {
            return candidates;
        }

        for (let index = 0; index < passwords.length; index++) {
            const hasPasswordInput = await page.$('form[action*="/unlock/"] input[name="password"]');
            if (!hasPasswordInput) break;

            await page.$eval('input[name="password"]', (input) => {
                input.value = '';
                input.dispatchEvent(new Event('input', { bubbles: true }));
            }).catch(() => {});
            await page.type('input[name="password"]', passwords[index], { delay: 35 });

            await Promise.allSettled([
                page.click('button[type="submit"], form[action*="/unlock/"] button'),
                page.waitForNavigation({
                    waitUntil: 'domcontentloaded',
                    timeout: 8000
                })
            ]);
            await page.waitForNetworkIdle({
                idleTime: 500,
                timeout: 5000
            }).catch(() => {});

            candidates = await tryExtract();
            if (candidates.length > 0) {
                console.log(`[HTTP-RESOLVE] ViewCrate browser unlock succeeded with password candidate ${index + 1}/${passwords.length}`);
                return candidates;
            }
        }
    } catch (error) {
        console.log(`[HTTP-RESOLVE] ViewCrate browser unlock failed: ${error.message}`);
    } finally {
        if (browser) {
            await browser.close().catch(() => {});
        }
    }

    return [];
}

async function resolveViewcrateLinkWithBrowser(viewcrateUrl, hints = {}) {
    if (!VIEWCRATE_BROWSER_FALLBACK_ENABLED || !viewcrateUrl) return null;

    let browser = null;
    const deadlineMs = Date.now() + Math.max(20000, VIEWCRATE_BROWSER_TIMEOUT_MS + 15000);

    try {
        const puppeteerExtra = await getViewcrateStealthPuppeteer();
        if (!puppeteerExtra) return null;

        browser = await puppeteerExtra.launch(getViewcrateBrowserLaunchOptions());
        const page = await newPageWithRetry(browser);

        const browserProxy = parseBrowserProxyConfig(RESOLVER_BROWSER_PROXY_URL);
        if (browserProxy.username || browserProxy.password) {
            await page.authenticate({
                username: browserProxy.username || '',
                password: browserProxy.password || ''
            });
        }
        await page.setUserAgent(OUO_USER_AGENT).catch(() => {});

        const networkCandidates = [];
        const seenCandidates = new Set();
        const addCandidate = (candidate) => {
            const normalized = normalizeAbsoluteUrl(candidate, page.url() || viewcrateUrl);
            if (!normalized || seenCandidates.has(normalized)) return;
            seenCandidates.add(normalized);
            networkCandidates.push(normalized);
        };

        page.on('request', (request) => addCandidate(request?.url?.() || request?.url));
        page.on('response', (response) => addCandidate(response?.url?.() || response?.url));

        const resolveBrowserGetLink = async (getLink) => {
            if (!getLink || Date.now() > deadlineMs) return null;

            const beforeUrl = page.url() || viewcrateUrl;
            try {
                await page.goto(getLink, {
                    waitUntil: 'domcontentloaded',
                    timeout: Math.min(10000, VIEWCRATE_BROWSER_TIMEOUT_MS)
                });
            } catch {
                return null;
            }

            await page.waitForNetworkIdle({
                idleTime: 500,
                timeout: 4000
            }).catch(() => {});

            const currentUrl = page.url() || getLink;
            if (!currentUrl.includes('viewcrate.')) {
                const normalized = normalizePixeldrainUrl(currentUrl);
                if (normalized && PIXELDRAIN_HOSTS.some(host => normalized.toLowerCase().includes(host))) {
                    return resolvePixeldrainDownload(normalized);
                }
                if (!isShortlinkInterstitialUrl(currentUrl)) {
                    return currentUrl;
                }
            }

            // Attempt to recover direct links from the landing page body.
            const html = await page.content().catch(() => '');
            if (html) {
                const $ = cheerio.load(html);
                const redirectCandidate = pickFirstExternalCandidate(
                    [
                        ...extractEmbeddedShortlinkTargets($, html, currentUrl),
                        ...extractRedirectCandidates(html, $, currentUrl)
                    ],
                    currentUrl,
                    [...PIXELDRAIN_HOSTS, ...VIEWCRATE_HOSTS, ...FILECRYPT_HOSTS, hints.host]
                );
                if (redirectCandidate && !isViewcrateGetUrl(redirectCandidate)) {
                    const normalized = normalizePixeldrainUrl(redirectCandidate);
                    if (normalized && PIXELDRAIN_HOSTS.some(host => normalized.toLowerCase().includes(host))) {
                        return resolvePixeldrainDownload(normalized);
                    }
                    if (!isShortlinkInterstitialUrl(redirectCandidate)) {
                        return redirectCandidate;
                    }
                }
            }

            // Reset back to the main ViewCrate page so subsequent get attempts start from a stable state.
            if ((page.url() || '') !== beforeUrl) {
                await page.goto(beforeUrl, {
                    waitUntil: 'domcontentloaded',
                    timeout: Math.min(10000, VIEWCRATE_BROWSER_TIMEOUT_MS)
                }).catch(() => {});
                await page.waitForNetworkIdle({
                    idleTime: 500,
                    timeout: 3000
                }).catch(() => {});
            }

            return null;
        };

        const tryResolveFromHtml = async () => {
            const html = await page.content().catch(() => '');
            if (!html) return null;

            const candidates = extractViewcrateCandidatesFromHtml(html, page.url() || viewcrateUrl);
            if (candidates.length) {
                const ordered = orderViewcrateCandidates(candidates, hints).slice(0, 8);
                for (const entry of ordered) {
                    if (!entry?.getUrl) continue;
                    const direct = await resolveBrowserGetLink(entry.getUrl);
                    if (direct) return direct;
                }
            }

            const $ = cheerio.load(html);
            const redirectCandidate = pickFirstExternalCandidate(
                [
                    ...extractEmbeddedShortlinkTargets($, html, page.url() || viewcrateUrl),
                    ...extractRedirectCandidates(html, $, page.url() || viewcrateUrl)
                ],
                page.url() || viewcrateUrl,
                [...PIXELDRAIN_HOSTS, ...VIEWCRATE_HOSTS, ...FILECRYPT_HOSTS, hints.host]
            );
            if (redirectCandidate) {
                if (isViewcrateGetUrl(redirectCandidate)) {
                    const fromGet = await resolveBrowserGetLink(redirectCandidate);
                    if (fromGet) return fromGet;
                    return null;
                }
                const normalized = normalizePixeldrainUrl(redirectCandidate);
                if (normalized && PIXELDRAIN_HOSTS.some(host => normalized.toLowerCase().includes(host))) {
                    return resolvePixeldrainDownload(normalized);
                }
                return redirectCandidate;
            }

            return null;
        };

        const tryResolveFromNetwork = async () => {
            const direct = pickFirstExternalCandidate(
                networkCandidates,
                page.url() || viewcrateUrl,
                [...PIXELDRAIN_HOSTS, ...VIEWCRATE_HOSTS, ...FILECRYPT_HOSTS, hints.host]
            );
            if (direct) {
                if (isViewcrateGetUrl(direct)) {
                    const fromGet = await resolveBrowserGetLink(direct);
                    if (fromGet) return fromGet;
                }
                const normalized = normalizePixeldrainUrl(direct);
                if (normalized && PIXELDRAIN_HOSTS.some(host => normalized.toLowerCase().includes(host))) {
                    return resolvePixeldrainDownload(normalized);
                }
                return direct;
            }

            const getLinks = networkCandidates
                .filter(candidate => /viewcrate\.[^/]+\/get\/[A-Za-z0-9]+/i.test(candidate))
                .slice(0, 8);
            for (const getLink of getLinks) {
                const directFromGet = await resolveBrowserGetLink(getLink);
                if (directFromGet) return directFromGet;
            }

            return null;
        };

        await page.goto(viewcrateUrl, {
            waitUntil: 'domcontentloaded',
            timeout: VIEWCRATE_BROWSER_TIMEOUT_MS
        });

        for (let step = 0; step < 4; step += 1) {
            if (Date.now() > deadlineMs) break;

            await page.waitForNetworkIdle({
                idleTime: 500,
                timeout: 5000
            }).catch(() => {});

            const fromHtml = await tryResolveFromHtml();
            if (fromHtml) {
                console.log('[HTTP-RESOLVE] ViewCrate browser fallback resolved from page HTML');
                return fromHtml;
            }

            const fromNetwork = await tryResolveFromNetwork();
            if (fromNetwork) {
                console.log('[HTTP-RESOLVE] ViewCrate browser fallback resolved from network trace');
                return fromNetwork;
            }

            await sleep(1500);
        }
    } catch (error) {
        console.log(`[HTTP-RESOLVE] ViewCrate browser fallback failed: ${error.message}`);
    } finally {
        if (browser) {
            await Promise.race([
                browser.close().catch(() => {}),
                sleep(3000)
            ]);
        }
    }

    return null;
}

async function resolveOuoLinkWithBrowser(shortUrl, hints = {}) {
    if (!VIEWCRATE_BROWSER_FALLBACK_ENABLED || !shortUrl) return null;

    let browser = null;
    const fallbackDeadlineMs = Date.now() + Math.max(20000, VIEWCRATE_BROWSER_TIMEOUT_MS + 15000);

    try {
        const puppeteerExtra = await getViewcrateStealthPuppeteer();
        if (!puppeteerExtra) return null;

        browser = await puppeteerExtra.launch(getViewcrateBrowserLaunchOptions());

        const page = await newPageWithRetry(browser);
        const networkCandidates = [];
        const seenCandidates = new Set();
        const addCandidate = (candidate) => {
            const normalized = normalizeAbsoluteUrl(candidate, page.url() || shortUrl);
            if (!normalized || seenCandidates.has(normalized)) return;
            seenCandidates.add(normalized);
            networkCandidates.push(normalized);
        };
        page.on('request', (request) => addCandidate(request?.url?.() || request?.url));
        page.on('response', (response) => addCandidate(response?.url?.() || response?.url));
        const pickNetworkCandidate = () => pickFirstExternalCandidate(
            networkCandidates,
            page.url() || shortUrl,
            [...PIXELDRAIN_HOSTS, ...VIEWCRATE_HOSTS, ...FILECRYPT_HOSTS, hints.host]
        );

        const browserProxy = parseBrowserProxyConfig(RESOLVER_BROWSER_PROXY_URL);
        if (browserProxy.username || browserProxy.password) {
            await page.authenticate({
                username: browserProxy.username || '',
                password: browserProxy.password || ''
            });
        }
        await page.setUserAgent(OUO_USER_AGENT).catch(() => {});
        await page.goto(shortUrl, {
            waitUntil: 'domcontentloaded',
            timeout: VIEWCRATE_BROWSER_TIMEOUT_MS
        });
        const initialNetworkCandidate = pickNetworkCandidate();
        if (initialNetworkCandidate) {
            console.log('[HTTP-RESOLVE] OUO browser fallback found candidate from network trace');
            return initialNetworkCandidate;
        }

        for (let step = 0; step < 5; step += 1) {
            if (Date.now() > fallbackDeadlineMs) {
                console.log('[HTTP-RESOLVE] OUO browser fallback reached deadline');
                break;
            }
            await page.waitForNetworkIdle({
                idleTime: 500,
                timeout: 5000
            }).catch(() => {});

            const networkCandidate = pickNetworkCandidate();
            if (networkCandidate) {
                console.log('[HTTP-RESOLVE] OUO browser fallback found candidate from network trace');
                return networkCandidate;
            }

            const currentUrl = page.url() || shortUrl;
            const html = await page.content().catch(() => '');
            const document = html ? cheerio.load(html) : null;

            const direct = pickFirstExternalCandidate(
                [
                    ...extractEmbeddedShortlinkTargets(document, html, currentUrl),
                    ...extractRedirectCandidates(html, document, currentUrl)
                ],
                currentUrl,
                [...PIXELDRAIN_HOSTS, ...VIEWCRATE_HOSTS, ...FILECRYPT_HOSTS, hints.host]
            );
            if (direct) {
                console.log('[HTTP-RESOLVE] OUO browser fallback extracted direct candidate');
                return direct;
            }

            if (currentUrl && !OUO_HOSTS.some(host => currentUrl.includes(host))) {
                if (isLikelyOuoTargetUrl(currentUrl, hints)) {
                    console.log('[HTTP-RESOLVE] OUO browser fallback exited shortlink host');
                    return currentUrl;
                }
                console.log('[HTTP-RESOLVE] OUO browser fallback exited to non-target host, continuing');
                const beforeWaitUrl = currentUrl;
                await sleep(2500);
                const postWaitCandidate = pickNetworkCandidate();
                if (postWaitCandidate) {
                    console.log('[HTTP-RESOLVE] OUO browser fallback found candidate after non-target wait');
                    return postWaitCandidate;
                }
                const afterWaitUrl = page.url() || beforeWaitUrl;
                if (afterWaitUrl !== beforeWaitUrl) {
                    continue;
                }
            }

            const buttonHandle = await page.$(`#${OUO_BUTTON_ID}`) || await page.$('button[type="submit"], input[type="submit"]');
            if (buttonHandle) {
                const buttonState = await page.evaluate((selector) => {
                    const btn = document.querySelector(selector) || document.querySelector('button[type="submit"], input[type="submit"]');
                    if (!btn) return null;
                    return {
                        className: btn.className || '',
                        disabledAttr: btn.hasAttribute('disabled'),
                        disabledProp: Boolean(btn.disabled),
                        text: (btn.textContent || btn.value || '').trim()
                    };
                }, `#${OUO_BUTTON_ID}`).catch(() => null);

                // OUO "Get Link" is temporarily disabled by CSS class; clicking too early
                // often leads to ad/interstitial exits instead of xreallcygo/viewcrate.
                if (buttonState && /disabled/i.test(buttonState.className || '')) {
                    await page.waitForFunction((selector) => {
                        const btn = document.querySelector(selector);
                        if (!btn) return false;
                        const cls = btn.className || '';
                        return !/disabled/i.test(cls);
                    }, { timeout: 5000 }, `#${OUO_BUTTON_ID}`).catch(() => {});
                }

                await Promise.allSettled([
                    page.evaluate((selector) => {
                        const btn = document.querySelector(selector) || document.querySelector('button[type="submit"], input[type="submit"]');
                        if (btn) btn.click();
                    }, `#${OUO_BUTTON_ID}`),
                    page.waitForNavigation({
                        waitUntil: 'domcontentloaded',
                        timeout: 8000
                    })
                ]);
                await sleep(1200);
                continue;
            }

            const formHandle = await page.$('form');
            if (formHandle) {
                await page.$eval('form', form => form.submit()).catch(() => {});
                await page.waitForNavigation({
                    waitUntil: 'domcontentloaded',
                    timeout: 8000
                }).catch(() => {});
                continue;
            }

            const actionMatch = html.match(/\/go\/[A-Za-z0-9]+/);
            if (actionMatch?.[0]) {
                const derivedUrl = normalizeAbsoluteUrl(actionMatch[0], currentUrl);
                if (derivedUrl) {
                    await page.goto(derivedUrl, {
                        waitUntil: 'domcontentloaded',
                        timeout: 8000
                    });
                    continue;
                }
            }

            break;
        }

        const trailingCandidate = pickNetworkCandidate();
        if (trailingCandidate) {
            console.log('[HTTP-RESOLVE] OUO browser fallback returning trailing network candidate');
            return trailingCandidate;
        }
    } catch (error) {
        console.log(`[HTTP-RESOLVE] OUO browser fallback failed: ${error.message}`);
    } finally {
        if (browser) {
            await Promise.race([
                browser.close().catch(() => {}),
                sleep(3000)
            ]);
        }
    }

    return null;
}

async function resolveOuoLinkInSubprocess(shortUrl) {
    if (!SUBPROCESS_RESOLVE_FALLBACK_ENABLED || !shortUrl) return null;

    try {
        const { stdout } = await execFileAsync(
            process.execPath,
            [
                '--input-type=module',
                '-e',
                "globalThis.File = class File {}; const mod = await import('./lib/http-streams/resolvers/http-resolver.js'); const resolved = await mod.resolveHttpStreamUrl(process.argv[1]); console.log(JSON.stringify({ resolved })); process.exit(0);",
                shortUrl
            ],
            {
                cwd: process.cwd(),
                env: {
                    ...process.env,
                    HTTP_RESOLVE_SUBPROCESS: '1',
                    DEBRID_HTTP_PROXY: '',
                    DEBRID_PER_SERVICE_PROXIES: '',
                    DEBRID_PROXY_SERVICES: '*:false'
                },
                timeout: Math.max(VIEWCRATE_BROWSER_TIMEOUT_MS, 30000),
                maxBuffer: 1024 * 1024
            }
        );

        const stdoutText = String(stdout || '');
        const jsonLine = stdoutText
            .split(/\r?\n/)
            .map(line => line.trim())
            .filter(Boolean)
            .reverse()
            .find(line => line.startsWith('{') && line.endsWith('}'));
        const parsed = JSON.parse(jsonLine || '{}');
        return typeof parsed?.resolved === 'string' && parsed.resolved ? parsed.resolved : null;
    } catch (error) {
        console.log(`[HTTP-RESOLVE] OUO subprocess fallback failed: ${error.message}`);
        return null;
    }
}

function extractKeyFromJk(jkSource = '') {
    if (!jkSource) return null;
    const match = jkSource.match(/return\s+['"]([0-9a-f]{32})['"]/i);
    return match ? match[1] : null;
}

async function fetchViewcrateCnlLinks(viewcrateUrl) {
    if (!viewcrateUrl) return [];
    let publicId = null;
    try {
        const url = new URL(viewcrateUrl);
        const parts = url.pathname.replace(/\/+$/, '').split('/').filter(Boolean);
        publicId = parts[parts.length - 1] || null;
    } catch {
        return [];
    }
    if (!publicId) return [];

    const apiUrl = `https://viewcrate.cc/api/cnl_encrypt/${publicId}`;
    const response = await fetchWithCloudflare(apiUrl, {
        method: 'POST',
        timeout: 12000,
        headers: {
            'User-Agent': OUO_USER_AGENT,
            'Referer': viewcrateUrl,
            ...(VIEWCRATE_COOKIE ? { 'Cookie': VIEWCRATE_COOKIE } : {})
        }
    });

    if (!response?.body) return [];
    let payload = null;
    try {
        // FlareSolverr wraps API responses in <html><pre>...</pre></html>
        let jsonStr = response.body;
        const preMatch = jsonStr.match(/<pre[^>]*>([\s\S]*?)<\/pre>/);
        if (preMatch) jsonStr = preMatch[1];
        payload = JSON.parse(jsonStr);
    } catch {
        return [];
    }
    if (!payload?.crypted || !payload?.jk) return [];

    const keyHex = extractKeyFromJk(payload.jk);
    if (!keyHex) return [];

    try {
        const key = Buffer.from(keyHex, 'hex');
        const encrypted = Buffer.from(payload.crypted, 'base64');
        const decipher = crypto.createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, 0));
        decipher.setAutoPadding(false);
        const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
        const text = decrypted.toString('utf8');
        const links = text.match(/https?:\/\/[^\s"'<>]+/g) || [];
        return links;
    } catch {
        return [];
    }
}

async function resolveViewcrateGetLink(getUrl, referer, hints = {}) {
    if (!getUrl) return null;
    const resolved = await fetchWithCloudflare(getUrl, {
        timeout: 12000,
        allowRedirects: false,
        headers: {
            'User-Agent': OUO_USER_AGENT,
            'Referer': referer || getUrl,
            ...(VIEWCRATE_COOKIE ? { 'Cookie': VIEWCRATE_COOKIE } : {})
        }
    });

    let directUrl = null;
    const status = resolved?.statusCode || null;
    if (status && [301, 302, 307, 308].includes(status) && resolved.headers?.location) {
        directUrl = normalizeAbsoluteUrl(resolved.headers.location, getUrl);
        if (directUrl) {
            console.log(`[HTTP-RESOLVE] ViewCrate get redirected to ${directUrl.substring(0, 80)}...`);
        }
    }

    if (!directUrl) {
        const candidates = extractRedirectCandidates(resolved.body, resolved.document, getUrl);
        directUrl = pickPixeldrainCandidate(candidates) || resolved.url;
    }

    const normalized = normalizePixeldrainUrl(directUrl);
    if (!normalized) return null;

    // ViewCrate /get links are intermediate endpoints, not playable targets.
    if (isViewcrateGetUrl(normalized)) {
        return null;
    }

    // If not a Pixeldrain URL, return as-is (might be another host)
    if (!PIXELDRAIN_HOSTS.some(host => normalized.toLowerCase().includes(host))) {
        return normalized;
    }

    return resolvePixeldrainDownload(normalized);
}

async function resolvePixeldrainDownload(pixeldrainUrl) {
    if (!pixeldrainUrl) return null;
    const normalized = normalizePixeldrainUrl(pixeldrainUrl);

    if (normalized && normalized.includes('/api/file/')) {
        return normalized;
    }

    const response = await makeRequest(pixeldrainUrl, {
        parseHTML: true,
        timeout: 12000,
        headers: { 'User-Agent': OUO_USER_AGENT, 'Referer': pixeldrainUrl }
    });

    const direct = pickPixeldrainCandidate(
        extractRedirectCandidates(response.body, response.document, response.url || pixeldrainUrl)
    ) || response.url;

    return normalizePixeldrainUrl(direct);
}

function isCloudflareChallenge(body = '', statusCode = null) {
    const lower = (body || '').toLowerCase();
    // Note: removed 'cf_clearance' check as it causes false positives on valid pages
    // that mention the cookie name in JavaScript
    return lower.includes('cf-mitigated') ||
        lower.includes('just a moment') ||
        lower.includes('cf_chl') ||
        (lower.includes('challenge-platform') && lower.includes('cf_chl')) ||
        lower.includes('cf-turnstile') ||
        lower.includes('verify_turnstile') ||
        (lower.includes('security check') && lower.includes('cloudflare'));
}

function shouldBypassFlareSolverr(domain) {
    if (!domain) return false;
    const lower = domain.toLowerCase();
    return lower.includes('hubcloud') || lower.includes('hubdrive') || lower.includes('hubcdn');
}

function getCloudflareMarkers(body = '') {
    const lower = (body || '').toLowerCase();
    const markers = [];
    if (lower.includes('cf-mitigated')) markers.push('cf-mitigated');
    if (lower.includes('just a moment')) markers.push('just-a-moment');
    if (lower.includes('cf_chl')) markers.push('cf_chl');
    if (lower.includes('challenge-platform')) markers.push('challenge-platform');
    if (lower.includes('cf-turnstile')) markers.push('cf-turnstile');
    if (lower.includes('verify_turnstile')) markers.push('verify_turnstile');
    if (lower.includes('security check')) markers.push('security-check');
    if (lower.includes('cloudflare')) markers.push('cloudflare');
    return markers;
}

async function fetchWithUndici(url, { method = 'GET', headers = {}, timeout = 12000, body = null } = {}) {
    if (typeof fetch !== 'function') return null;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
        const response = await fetch(url, {
            method,
            headers,
            body,
            redirect: 'follow',
            signal: controller.signal
        });
        const text = await response.text();
        return {
            body: text,
            url: response.url || url,
            document: cheerio.load(text),
            statusCode: response.status,
            headers: Object.fromEntries(response.headers.entries())
        };
    } catch (error) {
        console.log(`[HTTP-RESOLVE] Undici fetch error: ${error.message}`);
        return null;
    } finally {
        clearTimeout(timer);
    }
}

async function getOrCreateFlareSession(domain) {
    if (!FLARESOLVERR_URL || !domain) return null;
    if (!shouldUseFlareSessionForDomain(domain)) return null;
    if (flareSessionCommandsSupported === false) return null;
    const cached = flareSessionCache.get(domain);
    if (cached && (Date.now() - cached.ts) < FLARE_SESSION_TTL) {
        return cached.sessionId;
    }

    const sessionId = `sootio_http_${domain.replace(/\./g, '_')}`;
    const proxyConfig = getFlareProxyConfigForDomain(domain);

    try {
        const list = await axios.post(`${FLARESOLVERR_URL}/v1`, { cmd: 'sessions.list' }, {
            timeout: 10000,
            headers: { 'Content-Type': 'application/json' }
        });
        if (list.data?.status === 'error' && String(list.data?.message || '').toLowerCase().includes('unknown cmd')) {
            flareSessionCommandsSupported = false;
            return null;
        }
        if (list.data?.sessions?.includes(sessionId)) {
            flareSessionCommandsSupported = true;
            flareSessionCache.set(domain, { sessionId, ts: Date.now() });
            return sessionId;
        }
    } catch {
        // ignore list errors
    }

    try {
        const createBody = {
            cmd: 'sessions.create',
            session: sessionId
        };
        if (proxyConfig) {
            createBody.proxy = proxyConfig;
        }
        const create = await axios.post(`${FLARESOLVERR_URL}/v1`, createBody, {
            timeout: 30000,
            headers: { 'Content-Type': 'application/json' }
        });
        if (create.data?.status === 'error' && String(create.data?.message || '').toLowerCase().includes('unknown cmd')) {
            flareSessionCommandsSupported = false;
            return null;
        }
        if (create.data?.status === 'ok') {
            flareSessionCommandsSupported = true;
            flareSessionCache.set(domain, { sessionId, ts: Date.now() });
            return sessionId;
        }
    } catch (error) {
        const message = String(error?.response?.data?.message || error?.message || '').toLowerCase();
        if (message.includes('unknown cmd')) {
            flareSessionCommandsSupported = false;
            return null;
        }
        if (error.response?.data?.message?.includes('already exists')) {
            flareSessionCommandsSupported = true;
            flareSessionCache.set(domain, { sessionId, ts: Date.now() });
            return sessionId;
        }
        console.log(`[HTTP-RESOLVE] FlareSolverr session create failed: ${error.message}`);
    }

    return null;
}

// Internal function that actually calls FlareSolverr
async function _doFlareSolverrRequest(url, { method = 'GET', postData = null, headers = {}, timeout = FLARESOLVERR_TIMEOUT } = {}) {
    const domain = (() => {
        try { return new URL(url).hostname; } catch { return null; }
    })();
    const sessionId = await getOrCreateFlareSession(domain);
    const hasSession = Boolean(sessionId);
    const proxyConfig = getFlareProxyConfigForDomain(domain);

    const flareTimeout = hasSession
        ? Math.max(timeout || 0, 30000)
        : Math.max((timeout || 0) * 4, 60000);

    const requestBody = {
        cmd: method === 'POST' ? 'request.post' : 'request.get',
        url,
        maxTimeout: flareTimeout
    };
    if (headers && Object.keys(headers).length) {
        requestBody.headers = headers;
    }

    const cookieHeader = headers['Cookie'] || headers['cookie'] || '';
    const flareCookies = parseCookieHeader(cookieHeader, domain);
    if (flareCookies.length) {
        requestBody.cookies = flareCookies;
    }

    if (sessionId) {
        requestBody.session = sessionId;
    }
    if (postData != null) {
        requestBody.postData = postData;
    } else if (method === 'POST') {
        // FlareSolverr requires postData for request.post commands
        requestBody.postData = '';
    }
    if (!sessionId && proxyConfig) {
        requestBody.proxy = proxyConfig;
    }

    try {
        const response = await axios.post(`${FLARESOLVERR_URL}/v1`, requestBody, {
            timeout: flareTimeout + 5000,
            headers: { 'Content-Type': 'application/json' }
        });

        if (response.data?.status === 'ok' && response.data?.solution?.response) {
            const body = response.data.solution.response;
            const finalUrl = response.data.solution.url || url;
            const statusCode = response.data.solution.status;
            const responseHeaders = response.data.solution.headers || {};

            // Cache CF cookies from FlareSolverr for future direct requests
            const solutionCookies = response.data.solution.cookies;
            const solverUserAgent = response.data.solution.userAgent || headers['User-Agent'] || headers['user-agent'] || OUO_USER_AGENT;
            if (domain && solutionCookies) {
                cacheCfCookies(domain, solutionCookies, solverUserAgent);
            }

            return {
                success: true,
                result: {
                    body,
                    url: finalUrl,
                    document: cheerio.load(body),
                    statusCode,
                    headers: responseHeaders
                }
            };
        }

        if (proxyConfig && !requestBody.proxy) {
            const retryBody = { ...requestBody, proxy: proxyConfig };
            if (retryBody.session) delete retryBody.session;
            const retryResponse = await axios.post(`${FLARESOLVERR_URL}/v1`, retryBody, {
                timeout: flareTimeout + 5000,
                headers: { 'Content-Type': 'application/json' }
            });
            if (retryResponse.data?.status === 'ok' && retryResponse.data?.solution?.response) {
                const body = retryResponse.data.solution.response;
                const finalUrl = retryResponse.data.solution.url || url;
                const statusCode = retryResponse.data.solution.status;
                const responseHeaders = retryResponse.data.solution.headers || {};

                const solutionCookies = retryResponse.data.solution.cookies;
                const solverUserAgent = retryResponse.data.solution.userAgent || headers['User-Agent'] || headers['user-agent'] || OUO_USER_AGENT;
                if (domain && solutionCookies) {
                    cacheCfCookies(domain, solutionCookies, solverUserAgent);
                }

                return {
                    success: true,
                    result: {
                        body,
                        url: finalUrl,
                        document: cheerio.load(body),
                        statusCode,
                        headers: responseHeaders
                    }
                };
            }
        }

        console.log(`[HTTP-RESOLVE] FlareSolverr response status: ${response.data?.status} message: ${response.data?.message || 'n/a'}`);
        if (hasSession && domain) {
            flareSessionCache.delete(domain);
        }
    } catch (error) {
        console.log(`[HTTP-RESOLVE] FlareSolverr error: ${error.message}`);
        if (hasSession && domain) {
            flareSessionCache.delete(domain);
        }
    }

    return { success: false, result: null };
}

// Wrapper that prevents thundering herd - only one FlareSolverr call per domain at a time
async function fetchWithFlareSolverr(url, options = {}) {
    if (!FLARESOLVERR_URL) return null;

    const domain = (() => {
        try { return new URL(url).hostname; } catch { return null; }
    })();

    // If there's already a FlareSolverr request in progress for this domain, wait for it
    const existingLock = domain ? flareSolverrLocks.get(domain) : null;
    if (existingLock) {
        console.log(`[HTTP-RESOLVE] Waiting for existing FlareSolverr request for ${domain}...`);
        try {
            await existingLock;
            // After waiting, check if we now have cached cookies
            const cached = getCachedCfCookies(domain);
            if (cached?.cookies) {
                console.log(`[HTTP-RESOLVE] Using cookies from completed FlareSolverr request for ${domain}`);
                return null; // Return null to signal caller should retry with cached cookies
            }
        } catch {
            // Lock failed, continue to make our own request
        }
    }

    // Create a lock for this domain
    let resolveLock;
    const lockPromise = new Promise(resolve => { resolveLock = resolve; });
    if (domain) {
        flareSolverrLocks.set(domain, lockPromise);
    }

    try {
        const { success, result } = await _doFlareSolverrRequest(url, options);
        return success ? result : null;
    } finally {
        // Release the lock
        if (domain) {
            flareSolverrLocks.delete(domain);
        }
        resolveLock?.();
    }
}

async function fetchWithCloudflare(url, options = {}) {
    const {
        preferFlareSolverr = false,
        method = 'GET',
        headers = {},
        timeout,
        body,
        ...rest
    } = options;

    // Extract domain for cookie caching
    const domain = (() => {
        try { return new URL(url).hostname; } catch { return null; }
    })();
    const shouldDisableProxy = domain
        ? [...VIEWCRATE_HOSTS, ...FILECRYPT_HOSTS, ...PIXELDRAIN_HOSTS]
            .some(host => domain.toLowerCase().includes(host))
        : false;

    const requestOptions = {
        method,
        headers,
        timeout,
        body,
        ...rest,
        parseHTML: true,
        disableProxy: shouldDisableProxy
    };
    const shouldForceFlareFirst = preferFlareSolverr && domain && OUO_HOSTS.some(host => domain.toLowerCase().includes(host));

    let sawChallenge = false;
    let sawError = false;

    const runFlareSolverr = async () => {
        const flareResponse = await fetchWithFlareSolverr(url, {
            method,
            headers,
            timeout,
            postData: body || null
        });

        // FlareSolverr returned null - maybe we waited for another request that got cookies
        // Check if we now have cached cookies and retry the direct request
        if (!flareResponse) {
            const newCached = getCachedCfCookies(domain);
            if (newCached?.cookies) {
                console.log(`[HTTP-RESOLVE] Retrying with fresh CF cookies for ${domain}`);
                const cookieHeader = headers['Cookie'] || headers['cookie'] || '';
                const mergedCookies = cookieHeader ? `${cookieHeader}; ${newCached.cookies}` : newCached.cookies;
                try {
                    const retryResponse = await makeRequest(url, {
                        ...requestOptions,
                        headers: {
                            ...headers,
                            'Cookie': mergedCookies,
                            'User-Agent': newCached.userAgent
                        }
                    });
                    if (retryResponse && !isCloudflareChallenge(retryResponse.body || '', retryResponse.statusCode)) {
                        console.log(`[HTTP-RESOLVE] Retry with fresh cookies succeeded for ${domain}`);
                        return retryResponse;
                    }
                } catch (retryErr) {
                    console.log(`[HTTP-RESOLVE] Retry with fresh cookies failed: ${retryErr.message}`);
                }
            }
            return null;
        }
        if (isCloudflareChallenge(flareResponse.body || '', flareResponse.statusCode)) {
            const snippet = (flareResponse.body || '').replace(/\s+/g, ' ').slice(0, 160);
            console.log(`[HTTP-RESOLVE] FlareSolverr still blocked for ${url}: ${snippet}`);
        }
        return flareResponse;
    };

    if (shouldForceFlareFirst) {
        const flareFirstResponse = await runFlareSolverr();
        if (flareFirstResponse && !isCloudflareChallenge(flareFirstResponse.body || '', flareFirstResponse.statusCode)) {
            return flareFirstResponse;
        }
    }

    // Try cached CF cookies first (fast path - avoids FlareSolverr)
    const cachedCf = getCachedCfCookies(domain);
    if (cachedCf) {
        console.log(`[HTTP-RESOLVE] Using cached CF cookies for ${domain}`);
        const cookieHeader = headers['Cookie'] || headers['cookie'] || '';
        const mergedCookies = cookieHeader ? `${cookieHeader}; ${cachedCf.cookies}` : cachedCf.cookies;
        const cachedRequestOptions = {
            ...requestOptions,
            headers: {
                ...headers,
                'Cookie': mergedCookies,
                'User-Agent': cachedCf.userAgent // Use same UA as when cookie was obtained
            }
        };

        try {
            const cachedResponse = await makeRequest(url, cachedRequestOptions);
            if (cachedResponse && !isCloudflareChallenge(cachedResponse.body || '', cachedResponse.statusCode)) {
                console.log(`[HTTP-RESOLVE] Cached CF cookies worked for ${domain}`);
                return cachedResponse;
            }
            // Cookies didn't work, clear the cache for this domain and related domains
            console.log(`[HTTP-RESOLVE] Cached CF cookies expired/invalid for ${domain}`);
            for (const d of getRelatedDomains(domain)) {
                cfCookieCache.delete(d);
            }
            sawChallenge = true;
        } catch (error) {
            console.log(`[HTTP-RESOLVE] Cached CF cookies request failed: ${error.message}`);
            for (const d of getRelatedDomains(domain)) {
                cfCookieCache.delete(d);
            }
            sawError = true;
        }
    }

    let response = null;
    try {
        response = await makeRequest(url, requestOptions);
    } catch (error) {
        sawError = true;
    }

    if (response && !isCloudflareChallenge(response.body || '', response.statusCode)) {
        return response;
    }

    if (response && isCloudflareChallenge(response.body || '', response.statusCode)) {
        sawChallenge = true;
        const undiciResponse = await fetchWithUndici(url, { method, headers, timeout, body });
        if (undiciResponse && !isCloudflareChallenge(undiciResponse.body || '', undiciResponse.statusCode)) {
            return undiciResponse;
        }
    }

    if (!FLARESOLVERR_URL) {
        return response;
    }

    const allowFlareSolverr = !shouldBypassFlareSolverr(domain);
    if ((sawChallenge || sawError || preferFlareSolverr) && allowFlareSolverr) {
        const reasonParts = [];
        if (sawChallenge) reasonParts.push('challenge-detected');
        if (sawError) reasonParts.push('request-error');
        if (preferFlareSolverr) reasonParts.push('prefer-flare');
        const reason = reasonParts.join(',') || 'unknown';
        const markers = sawChallenge && response?.body ? getCloudflareMarkers(response.body) : [];
        const status = response?.statusCode || 'n/a';
        console.error(`[HTTP-RESOLVE] Using FlareSolverr reason=${reason} status=${status} markers=${markers.join('|') || 'none'} domain=${domain || 'n/a'} url=${url}`);
        const flareResponse = await runFlareSolverr();
        if (flareResponse) {
            return flareResponse;
        }
    }

    if (response) {
        return response;
    }

    throw new Error('FlareSolverr failed to fetch Cloudflare-protected page');
}

function isOuoFormLikeResponse(response = null) {
    if (!response?.body) return false;
    try {
        const $ = response.document || cheerio.load(response.body);
        if (($(`#${OUO_BUTTON_ID}`).length || 0) > 0) return true;
        if (($('form').length || 0) > 0) return true;
    } catch {
        // Ignore parse errors and fallback to string checks.
    }
    const body = String(response.body || '').toLowerCase();
    if (body.includes('/go/') || body.includes('/xreallcygo/')) return true;
    return false;
}

async function fetchWithByparr(url, {
    method = 'GET',
    headers = {},
    timeout = BYPARR_TIMEOUT
} = {}) {
    if (!BYPARR_ENABLED || !BYPARR_URL) return null;
    if (!url) return null;
    if (String(method || 'GET').toUpperCase() !== 'GET') return null;

    const domain = (() => {
        try { return new URL(url).hostname; } catch { return null; }
    })();

    const requestBody = {
        cmd: 'request.get',
        url,
        // Byparr's FastAPI schema uses max_timeout (seconds).
        max_timeout: Math.max(30, Math.ceil((timeout || BYPARR_TIMEOUT) / 1000))
    };

    if (headers && Object.keys(headers).length > 0) {
        requestBody.headers = headers;
    }

    const byparrProxy = parseBrowserProxyConfig(BYPARR_PROXY_URL);
    const byparrHeaders = { 'Content-Type': 'application/json' };
    if (byparrProxy.proxyServer) {
        byparrHeaders['X-Proxy-Server'] = byparrProxy.proxyServer;
    }
    if (byparrProxy.username) {
        byparrHeaders['X-Proxy-Username'] = byparrProxy.username;
    }
    if (byparrProxy.password) {
        byparrHeaders['X-Proxy-Password'] = byparrProxy.password;
    }

    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
            const response = await axios.post(`${BYPARR_URL}/v1`, requestBody, {
                timeout: Math.max(timeout || 0, 35000),
                headers: byparrHeaders,
                validateStatus: () => true
            });

            if (response.status >= 400 || response.data?.status !== 'ok' || !response.data?.solution) {
                const status = response.status;
                const message = String(response.data?.message || response.data || '').slice(0, 120);
                console.log(`[HTTP-RESOLVE] Byparr non-ok response (${status}) attempt ${attempt}/${maxAttempts} for ${url}: ${message}`);
                if (attempt < maxAttempts) {
                    await sleep(300 * attempt);
                    continue;
                }
                return null;
            }

            const solution = response.data.solution || {};
            const responseBody = String(solution.response || '');
            const responseHeaders = solution.headers || {};
            const normalizedHeaders = {};
            for (const [key, value] of Object.entries(responseHeaders)) {
                normalizedHeaders[String(key).toLowerCase()] = value;
            }

            if (Array.isArray(solution.cookies) && solution.cookies.length > 0) {
                const fromSolution = solution.cookies
                    .filter(cookie => cookie?.name)
                    .map(cookie => `${cookie.name}=${cookie.value || ''}`);
                const existing = normalizedHeaders['set-cookie'];
                const existingList = Array.isArray(existing) ? existing : (existing ? [existing] : []);
                const merged = new Set([...existingList, ...fromSolution]);
                if (merged.size > 0) {
                    normalizedHeaders['set-cookie'] = Array.from(merged);
                }
            }

            if (domain && Array.isArray(solution.cookies) && solution.cookies.length > 0) {
                const solverUserAgent = solution.userAgent || headers['User-Agent'] || headers['user-agent'] || OUO_USER_AGENT;
                cacheCfCookies(domain, solution.cookies, solverUserAgent);
            }

            return {
                body: responseBody,
                url: solution.url || url,
                document: cheerio.load(responseBody),
                statusCode: solution.status || null,
                headers: normalizedHeaders
            };
        } catch (error) {
            const message = String(error?.response?.data || error?.message || '').slice(0, 160);
            console.log(`[HTTP-RESOLVE] Byparr request failed attempt ${attempt}/${maxAttempts} for ${url}: ${message}`);
            if (attempt < maxAttempts) {
                await sleep(300 * attempt);
                continue;
            }
            return null;
        }
    }

    return null;
}

async function fetchOuoPage(url, options = {}) {
    if (String(options?.method || 'GET').toUpperCase() === 'GET') {
        const byparrResponse = await fetchWithByparr(url, options);
        if (byparrResponse) {
            if (isOuoFormLikeResponse(byparrResponse) || !isCloudflareChallenge(byparrResponse.body || '', byparrResponse.statusCode)) {
                return byparrResponse;
            }
            const snippet = String(byparrResponse.body || '').replace(/\s+/g, ' ').slice(0, 140);
            console.log(`[HTTP-RESOLVE] Byparr returned challenge-like OUO page, falling back: ${snippet}`);
        }
    }

    return fetchWithCloudflare(url, { ...options, preferFlareSolverr: true });
}

function getNextOuoStepUrl(url) {
    if (!url) return null;
    try {
        const parsed = new URL(url);
        const shortMatch = parsed.pathname.match(/^\/([A-Za-z0-9]+)$/);
        if (shortMatch?.[1]) {
            return new URL(`/go/${shortMatch[1]}`, `${parsed.protocol}//${parsed.host}`).toString();
        }
        const goMatch = parsed.pathname.match(/^\/go\/([A-Za-z0-9]+)$/);
        if (goMatch?.[1]) {
            return new URL(`/xreallcygo/${goMatch[1]}`, `${parsed.protocol}//${parsed.host}`).toString();
        }
    } catch {
        return null;
    }
    return null;
}

function isOuoHomepageOrShorten(url) {
    if (!url) return false;
    try {
        const parsed = new URL(url);
        if (!OUO_HOSTS.some(host => parsed.hostname.includes(host))) return false;
        const path = (parsed.pathname || '/').replace(/\/+$/, '') || '/';
        return path === '/' || path === '/shorten';
    } catch {
        return false;
    }
}

function isLikelyOuoTargetUrl(url, hints = {}) {
    if (!url) return false;
    if (isShortlinkInterstitialUrl(url)) return false;

    const lower = String(url).toLowerCase();
    const hintHost = normalizeHostHint(hints?.host || null);

    const allowedHostHints = [
        ...PIXELDRAIN_HOSTS,
        ...VIEWCRATE_HOSTS,
        ...FILECRYPT_HOSTS,
        ...DIRECT_HOST_HINTS,
        'hubcloud',
        'hubdrive',
        'hubcdn',
        'driveseed',
        'driveleech',
        'googleusercontent.com',
        hintHost
    ].filter(Boolean);

    if (allowedHostHints.some(host => lower.includes(String(host).toLowerCase()))) {
        return true;
    }

    if (VIDEO_EXTENSION_LIST.some(ext => lower.includes(ext))) {
        return true;
    }

    return false;
}

// Cache for resolved OUO links - saves 30-60 seconds per link
const OUO_RESOLVE_CACHE = new Map(); // shortUrl path -> { value, ts }
const OUO_CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days - short links rarely change

async function resolveOuoLink(shortUrl, hints = {}) {
    // Extract cache key at start
    let ouoCacheKey = null;
    try {
        ouoCacheKey = new URL(shortUrl).pathname;
        // Check in-memory cache first (fastest)
        const memCached = OUO_RESOLVE_CACHE.get(ouoCacheKey);
        if (memCached?.value && Date.now() - memCached.ts < OUO_CACHE_TTL && !isShortlinkInterstitialUrl(memCached.value)) {
            console.log(`[HTTP-RESOLVE] Using cached OUO resolution for ${ouoCacheKey} (memory)`);
            return memCached.value;
        }
        // Check database cache (survives restarts)
        if (CacheStore.isEnabled()) {
            const dbCached = await CacheStore.getCachedRecord('ouo-resolve', ouoCacheKey);
            if (dbCached?.data?.url && !isShortlinkInterstitialUrl(dbCached.data.url)) {
                // Populate in-memory cache
                OUO_RESOLVE_CACHE.set(ouoCacheKey, { value: dbCached.data.url, ts: Date.now() });
                console.log(`[HTTP-RESOLVE] Using cached OUO resolution for ${ouoCacheKey} (DB)`);
                return dbCached.data.url;
            }
        }
    } catch (e) {
        // Continue without cache
    }

    // Helper to cache and return result
    const cacheAndReturn = (result) => {
        if (result && isShortlinkInterstitialUrl(result)) {
            console.log('[HTTP-RESOLVE] Ignoring interstitial shortlink candidate');
            return null;
        }
        if (result && !isLikelyOuoTargetUrl(result, hints)) {
            console.log('[HTTP-RESOLVE] Ignoring non-target OUO exit candidate');
            return null;
        }
        if (result && ouoCacheKey) {
            // Save to in-memory cache
            OUO_RESOLVE_CACHE.set(ouoCacheKey, { value: result, ts: Date.now() });
            // Save to database (async, don't wait)
            if (CacheStore.isEnabled()) {
                CacheStore.upsertCachedMagnet({
                    service: 'ouo-resolve',
                    hash: ouoCacheKey,
                    data: { url: result },
                    releaseKey: 'ouo-resolution'
                }, { ttlMs: OUO_CACHE_TTL }).catch(() => {});
            }
            console.log(`[HTTP-RESOLVE] Cached OUO resolution for ${ouoCacheKey}`);
        }
        return result;
    };

    let cookieHeader = OUO_COOKIE || '';
    if (cookieHeader) {
        console.log('[HTTP-RESOLVE] Using OUO cookie for resolution');
    }
    let request = { url: shortUrl, method: 'GET', body: null, referer: null };
    const visited = new Set();
    const maxSteps = 3; // Reduced from 4 - most resolutions complete in 2-3 steps

    for (let step = 0; step < maxSteps; step += 1) {
        const visitKey = `${request.method}:${request.url}:${request.body || ''}`;
        if (visited.has(visitKey)) {
            console.log('[HTTP-RESOLVE] Ouo loop detected, aborting');
            return null;
        }
        visited.add(visitKey);

        const requestOrigin = (() => {
            try { return new URL(request.url).origin; } catch { return null; }
        })();

        const response = await fetchOuoPage(request.url, {
            method: request.method,
            body: request.body,
            headers: {
                'User-Agent': OUO_USER_AGENT,
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.5',
                'Referer': request.referer || request.url,
                ...(request.method === 'POST' && requestOrigin ? { 'Origin': requestOrigin } : {}),
                ...(cookieHeader ? { 'Cookie': cookieHeader } : {}),
                ...(request.method === 'POST' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {})
            }
        });

        cookieHeader = mergeCookieHeader(cookieHeader, response.headers?.['set-cookie']);

        // OUO returns the homepage/shorten form when anti-bot fields are rejected.
        // At that point, continue with browser fallback from the original short URL.
        if (request.method === 'POST' && isOuoHomepageOrShorten(response.url || request.url)) {
            console.log('[HTTP-RESOLVE] Ouo POST collapsed to homepage/shorten, switching to browser fallback');
            const browserResolved = await resolveOuoLinkWithBrowser(shortUrl, hints);
            if (browserResolved) {
                return cacheAndReturn(browserResolved);
            }
        }

        const embeddedTargets = extractEmbeddedShortlinkTargets(response.document, response.body, response.url || request.url);
        const preferredEmbeddedTarget = pickFirstExternalCandidate(
            embeddedTargets,
            response.url || request.url,
            [...PIXELDRAIN_HOSTS, ...VIEWCRATE_HOSTS, ...FILECRYPT_HOSTS, hints.host]
        );
        if (preferredEmbeddedTarget) {
            return cacheAndReturn(preferredEmbeddedTarget);
        }

        const directFromPage = pickFirstExternalCandidate(
            extractRedirectCandidates(response.body, response.document, response.url || request.url),
            response.url || request.url,
            [...PIXELDRAIN_HOSTS, ...VIEWCRATE_HOSTS, ...FILECRYPT_HOSTS, hints.host]
        );
        if (directFromPage) {
            const directHost = normalizeHostHint(directFromPage);
            const hintHost = normalizeHostHint(hints.host || null);
            if (hintHost && directHost && directHost !== hintHost) {
                console.log(`[HTTP-RESOLVE] Skipping ${directHost} link due to host hint`);
            } else {
                return cacheAndReturn(directFromPage);
            }
        }

        const viewcrateCandidates = collectViewcrateEntries(response.document, response.url || request.url);
        const orderedCandidates = orderViewcrateCandidates(viewcrateCandidates, hints);
        for (const entry of orderedCandidates) {
            if (!entry?.getUrl) continue;
            const direct = await resolveViewcrateGetLink(entry.getUrl, response.url || request.url, hints);
            if (direct) return cacheAndReturn(direct);
            if (entry.host) {
                console.log(`[HTTP-RESOLVE] ViewCrate candidate failed for host ${entry.host}`);
            }
        }

        if (response.url && !OUO_HOSTS.some(host => response.url.includes(host))) {
            if (isLikelyOuoTargetUrl(response.url, hints)) {
                return cacheAndReturn(response.url);
            }
            console.log('[HTTP-RESOLVE] Ouo exited to non-target host, continuing');
        }

        const $ = response.document;
        const button = $ ? $(`#${OUO_BUTTON_ID}`) : null;
        let form = button && button.length ? button.closest('form') : null;
        if (!form || !form.length) {
            form = $ ? $('form').first() : null;
        }

        if (!form || !form.length) {
            const snippet = (response.body || '').replace(/\s+/g, ' ').slice(0, 160);
            console.log(`[HTTP-RESOLVE] Ouo page missing form (status ${response.statusCode || 'unknown'}): ${snippet}`);
            const subprocessResolved = await resolveOuoLinkInSubprocess(shortUrl);
            if (subprocessResolved) {
                return cacheAndReturn(subprocessResolved);
            }
            const browserResolved = await resolveOuoLinkWithBrowser(shortUrl, hints);
            if (browserResolved) {
                return cacheAndReturn(browserResolved);
            }
            const nextStepUrl = getNextOuoStepUrl(request.url);
            if (nextStepUrl && nextStepUrl !== request.url) {
                request = { url: nextStepUrl, method: 'GET', body: null, referer: request.url };
                continue;
            }
            return null;
        }

        const actionHint = button?.attr('formaction') || null;
        const action = form.attr('action') || actionHint || request.url;
        const method = (form.attr('method') || 'POST').toUpperCase();
        const actionUrl = normalizeAbsoluteUrl(action, request.url) || request.url;

        const formData = {};
        const inputs = form.find('input[name]').length ? form.find('input[name]') : ($ ? $('input[name]') : []);
        inputs.each((_, input) => {
            const name = $(input).attr('name');
            const value = $(input).attr('value') || '';
            if (name) formData[name] = value;
        });

        const submitButton = button && button.length ? button : form.find('button[type="submit"], input[type="submit"]').first();
        if (submitButton?.length) {
            const name = submitButton.attr('name');
            const value = submitButton.attr('value') || submitButton.text().trim() || '1';
            if (name && !formData[name]) {
                formData[name] = value;
            }
        }

        if (!actionUrl || actionUrl === request.url) {
            const actionMatch = response.body?.match(/\/go\/[A-Za-z0-9]+/);
            const derived = actionMatch ? normalizeAbsoluteUrl(actionMatch[0], request.url) : null;
            if (derived) {
                request = { url: derived, method: 'GET', body: null, referer: request.url };
                continue;
            }
        }

        const body = new URLSearchParams(formData).toString();
        if (method === 'GET') {
            const connector = actionUrl.includes('?') ? '&' : '?';
            const urlWithQuery = body ? `${actionUrl}${connector}${body}` : actionUrl;
            request = { url: urlWithQuery, method: 'GET', body: null, referer: request.url };
        } else {
            request = { url: actionUrl, method: 'POST', body, referer: request.url };
        }
    }

    const subprocessResolved = await resolveOuoLinkInSubprocess(shortUrl);
    if (subprocessResolved) {
        return cacheAndReturn(subprocessResolved);
    }

    const browserResolved = await resolveOuoLinkWithBrowser(shortUrl, hints);
    if (browserResolved) {
        return cacheAndReturn(browserResolved);
    }

    return null;
}

async function resolveViewcrateLink(viewcrateUrl, hints = {}) {
    if (VIEWCRATE_COOKIE) {
        console.log('[HTTP-RESOLVE] Using ViewCrate cookie for resolution');
    }
    const response = await fetchWithCloudflare(viewcrateUrl, {
        timeout: 12000,
        headers: {
            'User-Agent': OUO_USER_AGENT,
            ...(VIEWCRATE_COOKIE ? { 'Cookie': VIEWCRATE_COOKIE } : {})
        },
        // When cookie is provided, try direct request first (cookie is tied to User-Agent)
        preferFlareSolverr: !VIEWCRATE_COOKIE
    });

    const $ = response.document;
    if (!$) {
        return null;
    }

    let candidates = extractViewcrateCandidatesFromHtml(response.body || $.html(), response.url || viewcrateUrl);
    if (candidates.length === 0 && isViewcrateProtectedPage($, response.body || '')) {
        const browserCandidates = await unlockViewcrateWithBrowser(response.url || viewcrateUrl, hints);
        if (browserCandidates.length > 0) {
            console.log(`[HTTP-RESOLVE] ViewCrate browser unlock returned ${browserCandidates.length} entries`);
            candidates = browserCandidates;
        }
    } else if (candidates.length > 0 && collectViewcrateEntries($, response.url || viewcrateUrl).length === 0) {
        console.log(`[HTTP-RESOLVE] ViewCrate decrypted ${candidates.length} entries`);
    }

    if (candidates.length === 0) {
        const cnlLinks = await fetchViewcrateCnlLinks(viewcrateUrl);
        if (cnlLinks.length) {
            console.log(`[HTTP-RESOLVE] ViewCrate CNL returned ${cnlLinks.length} links`);
            const preferredHost = normalizeHostHint(hints.host || 'pixeldrain.com');
            const preferred = cnlLinks.find(link => {
                const lower = link.toLowerCase();
                if (preferredHost === 'pixeldrain') return lower.includes('pixeldrain');
                return preferredHost ? lower.includes(preferredHost) : false;
            });
            const fallback = preferredHost === 'pixeldrain'
                ? cnlLinks.find(link => link.toLowerCase().includes('pixeldrain'))
                : (cnlLinks.find(link => link.toLowerCase().includes('pixeldrain')) || cnlLinks[0]);
            const chosen = preferred || fallback;
            if (!chosen) {
                console.log(`[HTTP-RESOLVE] ViewCrate CNL had no ${preferredHost || 'preferred'} link`);
                return null;
            }
            const normalized = normalizePixeldrainUrl(chosen);
            if (normalized && PIXELDRAIN_HOSTS.some(host => normalized.toLowerCase().includes(host))) {
                return resolvePixeldrainDownload(normalized);
            }
            if (preferredHost === 'pixeldrain') {
                console.log('[HTTP-RESOLVE] ViewCrate CNL returned no Pixeldrain link');
                return null;
            }
            return chosen;
        }

        const browserResolved = await resolveViewcrateLinkWithBrowser(response.url || viewcrateUrl, hints);
        if (browserResolved) {
            return browserResolved;
        }

        console.log('[HTTP-RESOLVE] ViewCrate entries not found in HTML/encrypted payload/browser fallback');
        return null;
    }

    const ordered = orderViewcrateCandidates(candidates, hints);
    if (normalizeHostHint(hints.host || null) && ordered.length === 0) {
        console.log(`[HTTP-RESOLVE] ViewCrate entries found, but none matched requested host ${hints.host}`);
        return null;
    }
    for (const entry of ordered) {
        if (!entry?.getUrl) continue;
        const direct = await resolveViewcrateGetLink(entry.getUrl, viewcrateUrl, hints);
        if (direct) return direct;
        if (entry.host) {
            console.log(`[HTTP-RESOLVE] ViewCrate candidate failed for host ${entry.host}`);
        }
    }

    const browserResolved = await resolveViewcrateLinkWithBrowser(response.url || viewcrateUrl, hints);
    if (browserResolved) {
        return browserResolved;
    }

    return null;
}

/**
 * Collect download entries from a Filecrypt container page
 * Each entry has: host, filename, size, linkId
 */
function collectFilecryptEntries(document, baseUrl) {
    const entries = [];
    if (!document) return entries;

    // Find all download buttons in table rows
    document('tr.kwj3').each((_, row) => {
        const $row = document(row);
        const button = $row.find('button.download');
        if (!button.length) return;

        // Extract the link ID from the data-* attribute
        // Button has data-{id}="{linkId}" where id is lowercase version of the button's id
        const buttonId = button.attr('id');
        if (!buttonId) return;
        const dataAttr = `data-${buttonId.toLowerCase()}`;
        const linkId = button.attr(dataAttr);
        if (!linkId) return;

        // Extract host from the external_link anchor
        const hostLink = $row.find('a.external_link');
        const hostHref = hostLink.attr('href') || '';
        let host = '';
        try {
            host = new URL(hostHref).hostname.toLowerCase();
        } catch {
            host = hostHref.replace(/^https?:\/\//, '').split('/')[0].toLowerCase();
        }

        // Extract filename from title attribute
        const titleCell = $row.find('td[title]');
        const filename = titleCell.attr('title') || '';

        // Extract file size
        const cells = $row.find('td');
        let size = '';
        cells.each((i, cell) => {
            const text = document(cell).text().trim();
            if (/^\d+(\.\d+)?\s*(GB|MB|KB|TB)$/i.test(text)) {
                size = text;
            }
        });

        // Check online status
        const isOnline = $row.find('i.online').length > 0;

        entries.push({
            linkId,
            host,
            filename,
            size,
            isOnline,
            linkUrl: `https://filecrypt.cc/Link/${linkId}.html`
        });
    });

    return entries;
}

function collectFilecryptEntriesFromHtml(body = '', baseUrl = '') {
    const entries = [];
    if (!body) return entries;

    const rows = body.match(/<tr[^>]*class="[^"]*\bkwj3\b[^"]*"[\s\S]*?<\/tr>/gi) || [];
    for (const row of rows) {
        const buttonId = row.match(/<button[^>]*\bid="([A-F0-9]+)"/i)?.[1];
        if (!buttonId) continue;

        const attrPattern = new RegExp(`data-${buttonId.toLowerCase()}="([^"]+)"`, 'i');
        const linkId = row.match(attrPattern)?.[1];
        if (!linkId) continue;

        const hostHref = row.match(/<a[^>]*class="[^"]*\bexternal_link\b[^"]*"[^>]*href="([^"]+)"/i)?.[1] || '';
        let host = '';
        try {
            host = new URL(hostHref, baseUrl).hostname.toLowerCase();
        } catch {
            host = hostHref.replace(/^https?:\/\//i, '').split('/')[0].toLowerCase();
        }

        const filename = row.match(/<td[^>]*title="([^"]+)"/i)?.[1] || '';
        const size = row.match(/>\s*(\d+(?:\.\d+)?\s*(?:GB|MB|KB|TB))\s*<\/td>/i)?.[1] || '';
        const isOnline = /<i[^>]*class="[^"]*\bonline\b/i.test(row);

        entries.push({
            linkId,
            host,
            filename,
            size,
            isOnline,
            linkUrl: `https://filecrypt.cc/Link/${linkId}.html`
        });
    }

    return entries;
}

function collectFilecryptScriptEntries(body = '', baseUrl = '') {
    const entries = [];
    if (!body) return entries;

    const seen = new Set();
    const matches = body.matchAll(/top\.location\.href\s*=\s*['"]([^'"]*\/Link\/([A-Za-z0-9]+)\.html[^'"]*)['"]/gi);
    for (const match of matches) {
        const rawUrl = match[1];
        const linkId = match[2];
        if (!linkId || seen.has(linkId)) continue;
        seen.add(linkId);

        const linkUrl = rawUrl.startsWith('http')
            ? rawUrl
            : normalizeAbsoluteUrl(rawUrl, baseUrl || 'https://filecrypt.cc/');
        if (!linkUrl) continue;

        entries.push({
            linkId,
            host: '',
            filename: '',
            size: '',
            isOnline: true,
            linkUrl
        });
    }

    return entries;
}

/**
 * Order Filecrypt entries by preferred hosts
 */
function orderFilecryptEntries(entries, hints = {}) {
    const preferred = [];
    const fallback = [];

    for (const entry of entries) {
        // Skip offline entries
        if (!entry.isOnline) {
            fallback.push(entry);
            continue;
        }

        // Prefer pixeldrain
        if (PIXELDRAIN_HOSTS.some(h => entry.host.includes(h))) {
            preferred.unshift(entry);
        } else if (hints.host && entry.host.includes(hints.host)) {
            preferred.push(entry);
        } else {
            fallback.push(entry);
        }
    }

    return [...preferred, ...fallback];
}

// Ad/tracking domains to skip
const FILECRYPT_BLOCKED_DOMAINS = ['linkonclick.com', 'adf.ly', 'bc.vc', 'sh.st', 'ouo.io', 'ouo.press', ...SHORTLINK_INTERSTITIAL_HOSTS];

/**
 * Check if a URL is an invalid filecrypt redirect target
 */
function isInvalidFilecryptRedirect(url) {
    if (!url) return true;
    const lower = url.toLowerCase();
    // Check for 404 page
    if (lower.includes('/404') || lower.includes('not-found') || lower.includes('notfound')) {
        return true;
    }
    // Check for blocked ad/tracking domains
    if (FILECRYPT_BLOCKED_DOMAINS.some(d => lower.includes(d))) {
        return true;
    }
    // Check for pixeldrain homepage (no file ID) - these are invalid
    // Valid pixeldrain URLs have /u/{id} or /api/file/{id}
    if (lower.includes('pixeldrain.com')) {
        try {
            const parsed = new URL(url);
            const path = parsed.pathname;
            // Homepage or generic paths are invalid
            if (path === '/' || path === '/home' || path === '') {
                return true;
            }
            // Must have /u/ or /api/file/ with an ID
            if (!path.includes('/u/') && !path.includes('/api/file/')) {
                return true;
            }
        } catch {
            return true;
        }
    }
    return false;
}

/**
 * Resolve a single Filecrypt link to get the final download URL
 */
async function resolveFilecryptLink(linkUrl, referer, cookies = '') {
    if (!linkUrl) return null;

    try {
        // First fetch the Link page to get the redirect
        const linkResponse = await axios.get(linkUrl, {
            timeout: 10000,
            maxRedirects: 0,
            validateStatus: () => true,
            headers: {
                'User-Agent': OUO_USER_AGENT,
                'Referer': referer,
                ...(cookies ? { 'Cookie': cookies } : {})
            }
        });
        const nextCookies = mergeCookieHeader(
            cookies,
            linkResponse.headers?.['set-cookie'] || linkResponse.headers?.['Set-Cookie'] || ''
        );

        // Check if we got an HTTP redirect
        const httpRedirect = linkResponse.headers?.location || linkResponse.headers?.Location;
        if (httpRedirect) {
            if (isInvalidFilecryptRedirect(httpRedirect)) {
                return null; // Skip invalid redirects silently
            }
        }

        // Check if the response URL itself is invalid (in case redirects were followed)
        if (linkResponse.url && isInvalidFilecryptRedirect(linkResponse.url)) {
            return null;
        }

        // Extract the redirect URL from the JS: top.location.href='...'
        const responseBody = typeof linkResponse.data === 'string' ? linkResponse.data : String(linkResponse.data || '');
        const redirectMatch = responseBody.match(/top\.location\.href\s*=\s*['"]([^'"]+)['"]/);
        if (!redirectMatch?.[1]) {
            // Maybe it's a direct redirect in the location header
            if (httpRedirect && !isInvalidFilecryptRedirect(httpRedirect)) {
                const fullRedirect = httpRedirect.startsWith('http') ? httpRedirect : `https://filecrypt.cc${httpRedirect}`;
                // Check if it's a Go page
                if (fullRedirect.includes('/Go/')) {
                    return await resolveFilecryptGoPage(fullRedirect, linkUrl, nextCookies);
                }
            }
            return null;
        }

        const goUrl = redirectMatch[1].startsWith('http')
            ? redirectMatch[1]
            : `https://filecrypt.cc${redirectMatch[1]}`;

        if (isInvalidFilecryptRedirect(goUrl)) {
            return null;
        }

        return await resolveFilecryptGoPage(goUrl, linkUrl, nextCookies);
    } catch (err) {
        // Don't log every failure - too noisy
        return null;
    }
}

/**
 * Resolve a Filecrypt Go page to extract the final URL
 */
async function resolveFilecryptGoPage(goUrl, referer, cookies = '') {
    try {
        const goResponse = await axios.get(goUrl, {
            timeout: 10000,
            maxRedirects: 0,
            validateStatus: () => true,
            headers: {
                'User-Agent': OUO_USER_AGENT,
                'Referer': referer,
                ...(cookies ? { 'Cookie': cookies } : {})
            }
        });
        const responseBody = typeof goResponse.data === 'string' ? goResponse.data : String(goResponse.data || '');
        const httpRedirect = goResponse.headers?.location || goResponse.headers?.Location;
        if (httpRedirect && !isInvalidFilecryptRedirect(httpRedirect)) {
            const fullRedirect = httpRedirect.startsWith('http') ? httpRedirect : new URL(httpRedirect, goUrl).toString();
            console.log(`[HTTP-RESOLVE] Filecrypt: Go redirect -> ${fullRedirect.substring(0, 60)}...`);
            return fullRedirect;
        }

        // Check if we got redirected to an invalid URL
        if (goResponse.request?.res?.responseUrl && isInvalidFilecryptRedirect(goResponse.request.res.responseUrl)) {
            return null;
        }

        const $ = responseBody ? cheerio.load(responseBody) : null;
        if (!$) {
            return null;
        }

        // Try to extract the final URL from meta tags
        const ogUrl = $('meta[property="og:url"]').attr('content');
        if (ogUrl && !ogUrl.includes('filecrypt.cc') && !isInvalidFilecryptRedirect(ogUrl)) {
            console.log(`[HTTP-RESOLVE] Filecrypt: Found og:url -> ${ogUrl.substring(0, 60)}...`);
            return ogUrl;
        }

        // Try og:video
        const ogVideo = $('meta[property="og:video"]').attr('content');
        if (ogVideo && !ogVideo.includes('filecrypt.cc') && !isInvalidFilecryptRedirect(ogVideo)) {
            console.log(`[HTTP-RESOLVE] Filecrypt: Found og:video -> ${ogVideo.substring(0, 60)}...`);
            return ogVideo;
        }

        // Try to extract from viewer_data JSON (pixeldrain embeds)
        const viewerDataMatch = responseBody.match(/window\.viewer_data\s*=\s*(\{[^;]+\});/);
        if (viewerDataMatch?.[1]) {
            try {
                const viewerData = JSON.parse(viewerDataMatch[1]);
                if (viewerData?.api_response?.id) {
                    const fileId = viewerData.api_response.id;
                    const directUrl = `https://pixeldrain.com/api/file/${fileId}?download`;
                    console.log(`[HTTP-RESOLVE] Filecrypt: Extracted from viewer_data -> ${directUrl}`);
                    return directUrl;
                }
            } catch {
                // Ignore JSON parse errors
            }
        }

        // Check if we got redirected to a valid different host
        const finalUrl = goResponse.request?.res?.responseUrl || '';
        if (finalUrl && !finalUrl.includes('filecrypt.cc') && !isInvalidFilecryptRedirect(finalUrl)) {
            console.log(`[HTTP-RESOLVE] Filecrypt: Redirected to -> ${finalUrl.substring(0, 60)}...`);
            return finalUrl;
        }

        return null;
    } catch {
        return null;
    }
}

/**
 * Filter filecrypt entries by episode hint
 */
function filterFilecryptEntriesByEpisode(entries, hints) {
    if (!hints.episode) return entries;

    // Parse episode hint (e.g., "S01E06" -> { season: 1, episode: 6 })
    const epMatch = hints.episode.match(/S(\d+)E(\d+)/i);
    if (!epMatch) return entries;

    const targetSeason = parseInt(epMatch[1], 10);
    const targetEpisode = parseInt(epMatch[2], 10);

    // Filter entries whose filename matches the episode
    const filtered = entries.filter(entry => {
        if (!entry.filename) return false;
        const fnMatch = entry.filename.match(/S(\d+)E(\d+)/i);
        if (!fnMatch) return false;
        const season = parseInt(fnMatch[1], 10);
        const episode = parseInt(fnMatch[2], 10);
        return season === targetSeason && episode === targetEpisode;
    });

    return filtered.length > 0 ? filtered : entries;
}

async function fetchFilecryptContainerSnapshot(filecryptUrl) {
    const cooldown = await getFilecryptCooldown(filecryptUrl);
    if (cooldown) {
        console.log(`[HTTP-RESOLVE] Filecrypt: cooldown active for container (${cooldown.reason || 'blocked'})`);
        return null;
    }

    const modeSequence = FLARESOLVERR_PROXY_URL
        ? ['direct', 'proxy', 'direct', 'proxy']
        : ['direct', 'direct', 'direct'];
    let blockedAttempts = 0;
    let emptyAttempts = 0;

    for (let attempt = 1; attempt <= modeSequence.length; attempt++) {
        const mode = modeSequence[attempt - 1];
        try {
            const requestBody = {
                cmd: 'request.get',
                url: filecryptUrl,
                maxTimeout: FLARESOLVERR_TIMEOUT
            };
            if (mode === 'proxy' && FLARESOLVERR_PROXY_URL) {
                requestBody.proxy = { url: FLARESOLVERR_PROXY_URL };
            }

            const flare = await axios.post(`${FLARESOLVERR_URL}/v1`, requestBody, {
                timeout: FLARESOLVERR_TIMEOUT + 5000,
                headers: { 'Content-Type': 'application/json' }
            });

            const body = flare.data?.solution?.response || '';
            const finalUrl = flare.data?.solution?.url || filecryptUrl;
            const document = body ? cheerio.load(body) : null;
            let entries = document ? collectFilecryptEntries(document, finalUrl) : [];
            if (entries.length === 0) {
                entries = collectFilecryptEntriesFromHtml(body, finalUrl);
            }
            if (entries.length === 0) {
                entries = collectFilecryptScriptEntries(body, finalUrl);
            }

            const cookieHeader = mergeCookieHeader(
                '',
                (flare.data?.solution?.cookies || []).map(cookie => `${cookie.name}=${cookie.value}`).join('; ')
            );
            const looksBlocked = entries.length === 0 && /cutcaptcha|puzzle-captcha|cap_token/i.test(body);
            const looksNetError = entries.length === 0 && /<body[^>]*class="[^"]*\bneterror\b/i.test(body);

            if (entries.length > 0) {
                await clearFilecryptCooldown(filecryptUrl);
                return {
                    response: {
                        body,
                        url: finalUrl,
                        headers: {},
                        document
                    },
                    entries,
                    cookieHeader
                };
            }

            if (!looksBlocked && !looksNetError) {
                emptyAttempts += 1;
                return {
                    response: {
                        body,
                        url: finalUrl,
                        headers: {},
                        document
                    },
                    entries,
                    cookieHeader
                };
            }

            emptyAttempts += 1;
            if (looksNetError) {
                console.log(`[HTTP-RESOLVE] Filecrypt: neterror shell on ${mode} attempt ${attempt}/${modeSequence.length}`);
            } else {
                console.log(`[HTTP-RESOLVE] Filecrypt: captcha shell on ${mode} attempt ${attempt}/${modeSequence.length}`);
            }
        } catch (error) {
            if (isCloudflareBlockedFlareError(error)) {
                blockedAttempts += 1;
                console.log(`[HTTP-RESOLVE] Filecrypt: Cloudflare blocked ${mode} attempt ${attempt}/${modeSequence.length}`);
            } else {
                console.log(`[HTTP-RESOLVE] Filecrypt: explicit FlareSolverr ${mode} attempt ${attempt}/${modeSequence.length} failed: ${error.message}`);
            }
        }

        if (attempt < modeSequence.length) {
            await new Promise(resolve => setTimeout(resolve, 400 * attempt));
        }
    }

    if (blockedAttempts >= Math.min(2, modeSequence.length)) {
        await setFilecryptCooldown(filecryptUrl, 'cloudflare-block');
    } else if (emptyAttempts >= modeSequence.length) {
        await setFilecryptCooldown(filecryptUrl, 'empty-shell');
    }

    return null;
}

/**
 * Resolve a Filecrypt container URL to get download links
 */
async function resolveFilecryptContainer(filecryptUrl, hints = {}) {
    const inFlight = filecryptContainerCache.get(filecryptUrl);
    if (inFlight?.promise) {
        console.log('[HTTP-RESOLVE] Filecrypt: Joining in-flight container resolve');
        return inFlight.promise;
    }

    const resolverPromise = (async () => {
    console.log('[HTTP-RESOLVE] Filecrypt container detected, extracting links...');

    let response = null;
    let cookieHeader = '';
    let entries = [];

    const snapshot = await fetchFilecryptContainerSnapshot(filecryptUrl);
    if (snapshot) {
        response = snapshot.response;
        cookieHeader = snapshot.cookieHeader;
        entries = snapshot.entries;
    }

    if (!response || entries.length === 0) {
        response = await fetchWithCloudflare(filecryptUrl, {
            timeout: 15000,
            preferFlareSolverr: true,
            headers: {
                'User-Agent': OUO_USER_AGENT
            }
        });

        const $ = response.document;
        if (!$) {
            console.log('[HTTP-RESOLVE] Filecrypt: Failed to parse container page');
            return null;
        }

        entries = collectFilecryptEntries($, response.url || filecryptUrl);
        if (entries.length === 0) {
            entries = collectFilecryptEntriesFromHtml(response.body || '', response.url || filecryptUrl);
        }
        if (entries.length === 0) {
            entries = collectFilecryptScriptEntries(response.body || '', response.url || filecryptUrl);
        }
        cookieHeader = mergeCookieHeader(cookieHeader, response.headers?.['set-cookie'] || response.headers?.['Set-Cookie'] || '');
    }

    const filecryptDomain = (() => {
        try { return new URL(response?.url || filecryptUrl).hostname; } catch { return 'filecrypt.cc'; }
    })();
    const cachedCookies = getCachedCfCookies(filecryptDomain);
    if (!cookieHeader && cachedCookies?.cookies) {
        cookieHeader = mergeCookieHeader(cookieHeader, cachedCookies.cookies);
    }

    if (entries.length === 0) {
        console.log('[HTTP-RESOLVE] Filecrypt: No download entries found');
        return null;
    }

    console.log(`[HTTP-RESOLVE] Filecrypt: Found ${entries.length} entries`);

    // Filter by episode if hint provided
    entries = filterFilecryptEntriesByEpisode(entries, hints);
    if (entries.length < 150) {
        console.log(`[HTTP-RESOLVE] Filecrypt: Filtered to ${entries.length} entries for episode ${hints.episode || 'all'}`);
    }

    // Order entries by preference
    const ordered = orderFilecryptEntries(entries, hints);

    // Limit how many entries we try to avoid too many requests
    const maxTries = 10;
    let tries = 0;

    // Try to resolve each entry until we get a working one
    for (const entry of ordered) {
        if (tries >= maxTries) {
            console.log(`[HTTP-RESOLVE] Filecrypt: Reached max tries (${maxTries}), stopping`);
            break;
        }
        tries++;

        const directUrl = await resolveFilecryptLink(entry.linkUrl, response?.url || filecryptUrl, cookieHeader);
        if (directUrl) {
            console.log(`[HTTP-RESOLVE] Filecrypt: Success with ${entry.host} -> ${directUrl.substring(0, 60)}...`);
            // If it's a pixeldrain URL, resolve it further
            if (PIXELDRAIN_HOSTS.some(h => directUrl.includes(h))) {
                const pixeldrainResolved = await resolvePixeldrainDownload(directUrl);
                if (pixeldrainResolved) {
                    return pixeldrainResolved;
                }
            }
            return directUrl;
        }
    }

    console.log('[HTTP-RESOLVE] Filecrypt: All entries failed to resolve');
    await setFilecryptCooldown(filecryptUrl, 'link-failed');
    return null;
    })();

    filecryptContainerCache.set(filecryptUrl, { promise: resolverPromise, ts: Date.now() });
    try {
        return await resolverPromise;
    } finally {
        const current = filecryptContainerCache.get(filecryptUrl);
        if (current?.promise === resolverPromise) {
            filecryptContainerCache.delete(filecryptUrl);
        }
    }
}

function getFileExtension(urlString) {
    try {
        const cleanedUrl = urlString.split('?')[0].split('#')[0];
        const lastSlash = cleanedUrl.lastIndexOf('/');
        const filename = lastSlash >= 0 ? cleanedUrl.slice(lastSlash + 1) : cleanedUrl;
        const lastDot = filename.lastIndexOf('.');
        if (lastDot === -1) {
            return '';
        }
        return filename.slice(lastDot);
    } catch {
        return '';
    }
}

function evaluateVideoCandidate(candidate) {
    if (!candidate?.url) {
        return { isVideo: false, reason: 'missing URL' };
    }

    const urlLower = candidate.url.toLowerCase();
    const extension = getFileExtension(urlLower);
    if (extension) {
        if (NON_VIDEO_EXTENSIONS.has(extension)) {
            return { isVideo: false, reason: `${extension} file` };
        }
        if (VIDEO_EXTENSIONS.has(extension)) {
            return { isVideo: true };
        }
    }

    if (TRUSTED_VIDEO_HOST_HINTS.some(host => urlLower.includes(host))) {
        return { isVideo: true };
    }

    const label = `${candidate.title || ''} ${candidate.name || ''}`.toLowerCase();
    if (label) {
        if (VIDEO_EXTENSION_LIST.some(ext => label.includes(ext))) {
            return { isVideo: true };
        }
        if (NON_VIDEO_EXTENSION_LIST.some(ext => label.includes(ext))) {
            return { isVideo: false, reason: 'non-video label' };
        }
    }

    if (candidate.type) {
        const typeLower = candidate.type.toLowerCase();
        if (VIDEO_TYPE_HINTS.some(type => typeLower.includes(type))) {
            return { isVideo: true };
        }
        if (typeLower.includes('zip') || typeLower.includes('rar')) {
            return { isVideo: false, reason: 'non-video type' };
        }
    }

    // Default to video when we can't confidently determine the file type
    return { isVideo: true };
}

async function findSeekableLink(results, { timeoutMs = FAST_SEEK_TIMEOUT_MS, maxParallel = MAX_PARALLEL_VALIDATIONS } = {}) {
    if (!Array.isArray(results) || results.length === 0) {
        return null;
    }

    const cache = new Map();

    const checkUrl = async (candidate, label) => {
        if (!candidate?.url) return false;
        if (cache.has(candidate.url)) {
            return cache.get(candidate.url);
        }

        const { isVideo, reason } = evaluateVideoCandidate(candidate);
        if (!isVideo) {
            console.log(`[HTTP-RESOLVE] Skipping ${label} link because it is not a video file${reason ? ` (${reason})` : ''}`);
            cache.set(candidate.url, false);
            return false;
        }

        try {
            const validation = await validateSeekableUrl(candidate.url, {
                requirePartialContent: true,
                timeout: timeoutMs
            });

            // Check if the extracted filename reveals this is actually a non-video file (e.g., .zip)
            // This catches cases where trusted hosts serve ZIP files with obfuscated URLs
            if (validation.filename) {
                const filenameLower = validation.filename.toLowerCase();
                const isNonVideoFile = NON_VIDEO_EXTENSION_LIST.some(ext => filenameLower.endsWith(ext));
                if (isNonVideoFile) {
                    console.log(`[HTTP-RESOLVE] Skipping ${label} link - Content-Disposition reveals non-video file: ${validation.filename}`);
                    cache.set(candidate.url, false);
                    return false;
                }
            }

            if (validation.isValid) {
                console.log(`[HTTP-RESOLVE] Selected ${label} link with confirmed 206 support`);
                cache.set(candidate.url, true);
                return true;
            }
            const hostname = (() => {
                try { return new URL(candidate.url).hostname.toLowerCase(); } catch { return ''; }
            })();
            const isPixeldrain = hostname.includes('pixeldrain');
            const isHubCdn = hostname.includes('hubcdn.fans');
            if (isPixeldrain && [403, 451].includes(validation.statusCode)) {
                console.log(`[HTTP-RESOLVE] Allowing ${label} Pixeldrain link despite ${validation.statusCode} (likely proxy restriction)`);
                cache.set(candidate.url, true);
                return true;
            }
            if (isHubCdn && [301, 302, 307, 308].includes(validation.statusCode)) {
                console.log(`[HTTP-RESOLVE] Allowing ${label} HubCDN redirect link despite ${validation.statusCode}`);
                cache.set(candidate.url, true);
                return true;
            }
            console.log(`[HTTP-RESOLVE] Rejected ${label} link (status: ${validation.statusCode || 'unknown'}) due to missing 206 support`);
            cache.set(candidate.url, false);
            return false;
        } catch (error) {
            console.error(`[HTTP-RESOLVE] Error validating ${label} link: ${error.message}`);
            cache.set(candidate.url, false);
            return false;
        }
    };

    // Sort by priority field from extraction (higher priority first), then deduplicate by URL
    const seen = new Set();
    const candidates = [];

    // Sort results by priority (descending) - extraction already set priority based on button labels
    const sortedResults = [...results].sort((a, b) => {
        const priorityA = a.priority ?? 0;
        const priorityB = b.priority ?? 0;
        return priorityB - priorityA; // Higher priority first
    });

    for (const candidate of sortedResults) {
        if (!candidate?.url || seen.has(candidate.url)) {
            continue;
        }

        const label = candidate.serverType || candidate.name || 'Unknown';
        candidates.push({ candidate, label });
        seen.add(candidate.url);
    }

    console.log(`[HTTP-RESOLVE] Testing ${candidates.length} candidates in priority order:`);
    candidates.forEach((entry, idx) => {
        console.log(`[HTTP-RESOLVE]   ${idx + 1}. [${entry.label}] priority=${entry.candidate.priority ?? 0}`);
    });

    // Validate candidates in small parallel batches to cut down total resolve time
    const batchSize = Math.max(1, maxParallel);
    for (let i = 0; i < candidates.length; i += batchSize) {
        const batch = candidates.slice(i, i + batchSize);
        const validationResults = await Promise.all(
            batch.map(entry => checkUrl(entry.candidate, entry.label))
        );
        const winnerIndex = validationResults.findIndex(Boolean);
        if (winnerIndex !== -1) {
            return batch[winnerIndex].candidate.url;
        }
    }

    return null;
}

/**
 * Resolve a redirect URL to its final direct streaming link
 * Handles lazy-load resolution for 4KHDHub, HDHub4u, and UHDMovies
 * This is called when the user selects a stream, providing lazy resolution
 * Steps: 1) Resolve redirect to file hosting URL, 2) Extract/decrypt to final stream URL, 3) Validate with 206 check
 * @param {string} redirectUrl - Original redirect URL that needs resolution + decryption
 * @returns {Promise<string|null>} - Final direct streaming URL with confirmed 206 support
 */
export async function resolveHttpStreamUrl(redirectUrl) {
    const decodedUrl = decodeURIComponent(redirectUrl);

    // Skip known dead HubCloud domains early
    if (isDeadHubcloudDomain(decodedUrl)) {
        console.log(`[HTTP-RESOLVE] Skipping dead HubCloud domain: ${decodedUrl.substring(0, 60)}...`);
        return null;
    }

    const { baseUrl, hints } = parseStreamHints(decodedUrl);
    const cacheKey = decodedUrl;

    const now = Date.now();
    const cached = resolveCache.get(cacheKey);
    if (cached) {
        if (cached.value && now - cached.ts < RESOLVE_CACHE_TTL) {
            console.log('[HTTP-RESOLVE] Using cached result');
            return cached.value;
        }
        if (cached.promise) {
            console.log('[HTTP-RESOLVE] Joining in-flight resolve');
            return cached.promise;
        }
    }

    if (CacheStore.isEnabled()) {
        try {
            const persisted = await CacheStore.getCachedRecord(RESOLVE_CACHE_SERVICE, cacheKey, {
                releaseKey: RESOLVE_CACHE_RELEASE_KEY
            });
            if (persisted?.data?.url) {
                console.log('[HTTP-RESOLVE] Using persisted cached result');
                resolveCache.set(cacheKey, { value: persisted.data.url, ts: Date.now() });
                return persisted.data.url;
            }
        } catch {
            // Ignore cache backend errors and continue resolving normally.
        }
    }

    const resolverPromise = (async () => {
        console.log('[HTTP-RESOLVE] Starting lazy resolution (on-demand extraction + validation)');
        let workingUrl = baseUrl;
        console.log('[HTTP-RESOLVE] Redirect URL:', decodedUrl.substring(0, 100) + '...');

        if (isMkvDramaProtectedLink(workingUrl)) {
            console.log('[HTTP-RESOLVE] MKVDrama protected _c link detected, priming session...');
            const resolvedProtected = await resolveMkvDramaProtectedLink(workingUrl, hints);
            if (!resolvedProtected) {
                console.log('[HTTP-RESOLVE] MKVDrama protected link resolution failed');
                resolveCache.set(cacheKey, { value: null, ts: Date.now() });
                return null;
            }
            workingUrl = resolvedProtected;
            console.log('[HTTP-RESOLVE] MKVDrama protected link resolved to:', workingUrl.substring(0, 100) + '...');
        }

        const mkvDramaToken = extractMkvDramaToken(workingUrl);
        if (mkvDramaToken) {
            console.log('[HTTP-RESOLVE] MKVDrama token detected, resolving...');
            const resolved = await resolveMkvDramaToken(mkvDramaToken);
            if (!resolved) {
                console.log('[HTTP-RESOLVE] MKVDrama token resolution failed');
                resolveCache.set(cacheKey, { value: null, ts: Date.now() });
                return null;
            }
            workingUrl = resolved;
            console.log('[HTTP-RESOLVE] MKVDrama token resolved to:', workingUrl.substring(0, 100) + '...');
        }

        if (isMkvDramaProtectedLink(workingUrl)) {
            console.log('[HTTP-RESOLVE] MKVDrama protected _c link detected after token resolution, priming session...');
            const resolvedProtected = await resolveMkvDramaProtectedLink(workingUrl, hints);
            if (!resolvedProtected) {
                console.log('[HTTP-RESOLVE] MKVDrama protected link resolution failed after token resolution');
                resolveCache.set(cacheKey, { value: null, ts: Date.now() });
                return null;
            }
            workingUrl = resolvedProtected;
            console.log('[HTTP-RESOLVE] MKVDrama protected link resolved to:', workingUrl.substring(0, 100) + '...');
        }

        if (isProviderArchiveWrapperUrl(workingUrl) || isProviderArchiveGetLinkUrl(workingUrl)) {
            console.log('[HTTP-RESOLVE] Provider archive URL detected, resolving to hoster link...');
            try {
                const resolved = isProviderArchiveGetLinkUrl(workingUrl)
                    ? await resolveProviderArchiveGetLink(workingUrl, workingUrl, hints)
                    : await resolveProviderArchiveWrapper(workingUrl, hints);
                if (!resolved) {
                    console.log('[HTTP-RESOLVE] Provider archive resolution failed');
                    resolveCache.set(cacheKey, { value: null, ts: Date.now() });
                    return null;
                }
                workingUrl = resolved;
                console.log('[HTTP-RESOLVE] Provider archive resolved to:', workingUrl.substring(0, 100) + '...');
            } catch (err) {
                console.log(`[HTTP-RESOLVE] Provider archive resolution error: ${err.message}`);
                resolveCache.set(cacheKey, { value: null, ts: Date.now() });
                return null;
            }
        }

        if (OUO_HOSTS.some(host => workingUrl.includes(host))) {
            console.log('[HTTP-RESOLVE] Ouo short link detected, resolving...');
            try {
                const resolved = await resolveOuoLink(workingUrl, hints);
                if (!resolved) {
                    console.log('[HTTP-RESOLVE] Failed to resolve Ouo link');
                    resolveCache.set(cacheKey, { value: null, ts: Date.now() });
                    return null;
                }
                workingUrl = resolved;
                console.log('[HTTP-RESOLVE] Ouo link resolved to:', workingUrl.substring(0, 100) + '...');
            } catch (err) {
                console.log(`[HTTP-RESOLVE] Ouo resolution failed: ${err.message}`);
                resolveCache.set(cacheKey, { value: null, ts: Date.now() });
                return null;
            }
        }

        if (VIEWCRATE_HOSTS.some(host => workingUrl.includes(host))) {
            console.log('[HTTP-RESOLVE] ViewCrate link detected, extracting Pixeldrain URL...');
            try {
                const resolved = await resolveViewcrateLink(workingUrl, hints);
                if (!resolved) {
                    console.log('[HTTP-RESOLVE] Failed to extract Pixeldrain link from ViewCrate');
                    resolveCache.set(cacheKey, { value: null, ts: Date.now() });
                    return null;
                }
                workingUrl = resolved;
                console.log('[HTTP-RESOLVE] ViewCrate resolved to:', workingUrl.substring(0, 100) + '...');
            } catch (err) {
                console.log(`[HTTP-RESOLVE] ViewCrate resolution failed: ${err.message}`);
                resolveCache.set(cacheKey, { value: null, ts: Date.now() });
                return null;
            }
        }

        if (FILECRYPT_HOSTS.some(host => workingUrl.includes(host))) {
            console.log('[HTTP-RESOLVE] Filecrypt link detected, extracting download URL...');
            try {
                const resolved = await resolveFilecryptContainer(workingUrl, hints);
                if (!resolved) {
                    console.log('[HTTP-RESOLVE] Failed to extract download link from Filecrypt');
                    resolveCache.set(cacheKey, { value: null, ts: Date.now() });
                    return null;
                }
                workingUrl = resolved;
                console.log('[HTTP-RESOLVE] Filecrypt resolved to:', workingUrl.substring(0, 100) + '...');
            } catch (err) {
                console.log(`[HTTP-RESOLVE] Filecrypt resolution failed: ${err.message}`);
                resolveCache.set(cacheKey, { value: null, ts: Date.now() });
                return null;
            }
        }

        if (PIXELDRAIN_HOSTS.some(host => workingUrl.includes(host))) {
            console.log('[HTTP-RESOLVE] Pixeldrain link detected, returning direct download URL...');
            try {
                const resolved = await resolvePixeldrainDownload(workingUrl);
                if (resolved) {
                    resolveCache.set(cacheKey, { value: resolved, ts: Date.now() });
                    return resolved;
                }
            } catch (err) {
                console.log(`[HTTP-RESOLVE] Pixeldrain resolution failed: ${err.message}`);
            }
        }

        if (XDMOVIES_LINK_HOSTS.some(host => workingUrl.includes(host))) {
            console.log('[HTTP-RESOLVE] XDMovies redirect detected, resolving...');
            const resolved = await resolveXDMoviesRedirect(workingUrl);
            if (resolved && resolved !== workingUrl) {
                console.log('[HTTP-RESOLVE] XDMovies resolved to:', resolved.substring(0, 100) + '...');
                workingUrl = resolved;
            }
        }

        // XDMovies redirectors often land on a protector (/r/CODE) that requires an extra API session hop.
        if (/\/r\/[A-Za-z0-9_-]+(?:$|[/?#])/.test(workingUrl)) {
            const resolvedProtectorUrl = await resolveXDMoviesProtectorUrl(workingUrl);
            if (resolvedProtectorUrl && resolvedProtectorUrl !== workingUrl) {
                console.log('[HTTP-RESOLVE] XDMovies protector resolved to:', resolvedProtectorUrl.substring(0, 100) + '...');
                workingUrl = resolvedProtectorUrl;
            }
        }

        if (UHDMOVIES_SID_HOSTS.some(host => workingUrl.includes(host))) {
            console.log('[HTTP-RESOLVE] UHDMovies SID detected, resolving via UHDMovies resolver...');
            try {
                const resolved = await resolveUHDMoviesUrl(workingUrl);
                const finalUrl = typeof resolved === 'string' ? resolved : resolved?.url;
                if (!finalUrl) {
                    console.log('[HTTP-RESOLVE] UHDMovies resolution failed');
                    resolveCache.set(cacheKey, { value: null, ts: Date.now() });
                    return null;
                }
                try {
                    const videoCheck = evaluateVideoCandidate({
                        url: finalUrl,
                        title: typeof resolved === 'object' ? (resolved.fileName || '') : '',
                        name: typeof resolved === 'object' ? (resolved.fileName || '') : ''
                    });
                    if (!videoCheck.isVideo) {
                        console.log(`[HTTP-RESOLVE] UHDMovies resolved URL rejected as non-video: ${videoCheck.reason || 'unknown'}`);
                        resolveCache.set(cacheKey, { value: null, ts: Date.now() });
                        return null;
                    }
                    const validation = await validateSeekableUrl(finalUrl, { requirePartialContent: true, timeout: FAST_SEEK_TIMEOUT_MS });
                    if (!validation.isValid) {
                        console.log('[HTTP-RESOLVE] UHDMovies resolved URL failed 206 validation');
                        resolveCache.set(cacheKey, { value: null, ts: Date.now() });
                        return null;
                    }
                } catch (err) {
                    console.log(`[HTTP-RESOLVE] UHDMovies 206 validation error: ${err.message}`);
                    resolveCache.set(cacheKey, { value: null, ts: Date.now() });
                    return null;
                }

                resolveCache.set(cacheKey, { value: finalUrl, ts: Date.now() });
                return finalUrl;
            } catch (err) {
                console.log(`[HTTP-RESOLVE] UHDMovies resolution error: ${err.message}`);
                resolveCache.set(cacheKey, { value: null, ts: Date.now() });
                return null;
            }
        }

        // Detect provider type from URL
        let provider = 'Unknown';
        if (workingUrl.includes('hubcloud') || workingUrl.includes('hubdrive') || workingUrl.includes('4khdhub')) {
            provider = '4KHDHub/HDHub4u';
        } else if (workingUrl.includes('hubcdn.fans')) {
            provider = 'HDHub4u';
        }
        console.log('[HTTP-RESOLVE] Detected provider:', provider);

        // Handle gdlink.dev directly via extractor path
        if (workingUrl.includes('gdlink.dev')) {
            console.log('[HTTP-RESOLVE] gdlink.dev detected, attempting extractor resolution');
            try {
                const extracted = await processExtractorLinkWithAwait(workingUrl, 99) || [];
                const seekable = await findSeekableLink(extracted);
                resolveCache.set(cacheKey, { value: seekable, ts: Date.now() });
                return seekable;
            } catch (err) {
                console.log(`[HTTP-RESOLVE] gdlink.dev resolution failed: ${err.message}`);
                resolveCache.set(cacheKey, { value: null, ts: Date.now() });
                return null;
            }
        }

        // Handle CineDoze links (cinedoze.tv/links/xxx -> savelinks.me -> hubcloud)
        if (workingUrl.includes('cinedoze.tv/links/')) {
            console.log('[HTTP-RESOLVE] CineDoze link detected, expanding to HubCloud URL...');
            try {
                // Follow redirect to savelinks.me and extract HubCloud link
                const response = await makeRequest(workingUrl, { parseHTML: false, timeout: 12000 });
                const body = response.body || '';

                // Extract hubcloud/hubdrive links from the page
                const hubcloudMatch = body.match(/https?:\/\/[^\s"'<>]*(?:hubcloud|hubdrive|hubcdn)[^\s"'<>]*/gi);
                if (hubcloudMatch && hubcloudMatch.length > 0) {
                    const hubcloudUrl = hubcloudMatch[0];
                    console.log(`[HTTP-RESOLVE] Extracted HubCloud URL: ${hubcloudUrl.substring(0, 80)}...`);

                    // Now process the HubCloud URL through the extractor
                    const extracted = await processExtractorLinkWithAwait(hubcloudUrl, 99) || [];
                    const seekable = await findSeekableLink(extracted);
                    resolveCache.set(cacheKey, { value: seekable, ts: Date.now() });
                    return seekable;
                }
                console.log('[HTTP-RESOLVE] No HubCloud link found in CineDoze page');
                resolveCache.set(cacheKey, { value: null, ts: Date.now() });
                return null;
            } catch (err) {
                console.log(`[HTTP-RESOLVE] CineDoze resolution failed: ${err.message}`);
                resolveCache.set(cacheKey, { value: null, ts: Date.now() });
                return null;
            }
        }

        // Fast-path: direct hosts (workers/hubcdn/r2) — validate and return without extractor
        if (DIRECT_HOST_HINTS.some(h => workingUrl.includes(h))) {
            console.log('[HTTP-RESOLVE] Direct host detected, performing fast 206 validation');
            try {
                const validation = await validateSeekableUrl(workingUrl, { requirePartialContent: true, timeout: FAST_SEEK_TIMEOUT_MS });
                if (validation.isValid) {
                    resolveCache.set(cacheKey, { value: workingUrl, ts: Date.now() });
                    return workingUrl;
                }
                console.log('[HTTP-RESOLVE] Direct host failed 206 validation');
            } catch (err) {
                console.log(`[HTTP-RESOLVE] Direct host validation error: ${err.message}`);
            }
        }

        // Step 1: Resolve redirect to file hosting URL (hubcloud/hubdrive)
        let fileHostingUrl;
        const hasRedirectParam = /[?&]id=/i.test(workingUrl);
        if (hasRedirectParam) {
            console.log('[HTTP-RESOLVE] Resolving redirect to file hosting URL...');
            fileHostingUrl = await getRedirectLinks(workingUrl);
            if (!fileHostingUrl || !fileHostingUrl.trim()) {
                console.log('[HTTP-RESOLVE] Failed to resolve redirect');
                return null;
            }
            console.log('[HTTP-RESOLVE] Resolved to file hosting URL:', fileHostingUrl.substring(0, 100) + '...');
        } else {
            // Already a direct URL
            fileHostingUrl = workingUrl;
            console.log('[HTTP-RESOLVE] URL is already a file hosting URL');
        }

        // Step 2: Decrypt file hosting URL to final streaming URL
        console.log('[HTTP-RESOLVE] Decrypting file hosting URL...');
        const result = await processExtractorLinkWithAwait(fileHostingUrl, 99);  // Get ALL results, not just 1

        if (!result || !Array.isArray(result) || result.length === 0) {
            console.log('[HTTP-RESOLVE] No valid stream found after decryption');
            return null;
        }

        // Filter out null/empty entries defensively before logging/validation
        const sanitizedResults = result.filter(r => r && r.url);
        if (sanitizedResults.length === 0) {
            console.log('[HTTP-RESOLVE] No usable streams after filtering null/empty results');
            return null;
        }

        console.log(`[HTTP-RESOLVE] Found ${sanitizedResults.length} potential stream(s), selecting best one...`);

        // Log all results for debugging
        sanitizedResults.forEach((r, idx) => {
            const type = r.url.includes('pixeldrain') ? 'Pixeldrain' :
                r.url.includes('googleusercontent') ? 'GoogleUserContent' :
                    r.url.includes('workers.dev') ? 'Workers.dev' :
                        r.url.includes('hubcdn') ? 'HubCDN' :
                            r.url.includes('r2.dev') ? 'R2' : 'Other';
            console.log(`[HTTP-RESOLVE]   ${idx + 1}. [${type}] ${r.url.substring(0, 80)}...`);
        });

        const seekableLink = await findSeekableLink(sanitizedResults);
        if (seekableLink) {
            console.log(`[HTTP-RESOLVE] Returning seekable link: ${seekableLink.substring(0, 100)}...`);
            return seekableLink;
        }

        console.log('[HTTP-RESOLVE] No links with confirmed 206 support were found');
        return null;
    })();

    resolveCache.set(cacheKey, { promise: resolverPromise, ts: now });

    const result = await resolverPromise;
    resolveCache.set(cacheKey, { value: result, ts: Date.now() });
    if (result && CacheStore.isEnabled()) {
        CacheStore.upsertCachedMagnet({
            service: RESOLVE_CACHE_SERVICE,
            hash: cacheKey,
            data: { url: result },
            releaseKey: RESOLVE_CACHE_RELEASE_KEY
        }, { ttlMs: PERSISTED_RESOLVE_CACHE_TTL }).catch(() => {});
    }
    return result;
}

export function prewarmHttpStreamUrls(urls = []) {
    for (const url of urls) {
        if (!url) continue;
        resolveHttpStreamUrl(url).catch(() => {});
    }
}
