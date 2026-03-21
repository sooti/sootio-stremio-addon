/**
 * MKVDrama Streams
 * Builds HTTP streams from mkvdrama.net download pages (Ouo short links).
 *
 * Search phase: Find page, extract OUO links with resolutions
 * Resolution phase (user clicks): Resolve OUO → viewcrate → pixeldrain
 */

import Cinemeta from '../../../util/cinemeta.js';
import { execFile } from 'child_process';
import { scrapeMkvDramaSearch, loadMkvDramaContent, getMkvDramaLastBlock } from './search.js';
import { renderLanguageFlags, detectLanguagesFromTitle } from '../../../util/language-mapping.js';
import { removeYear, generateAlternativeQueries, getSortedMatches, getResolutionFromName } from '../../utils/parsing.js';
import { encodeUrlForStreaming } from '../../utils/encoding.js';
import { isLazyLoadEnabled, createPreviewStream, formatPreviewStreams } from '../../utils/preview-mode.js';
import { prewarmHttpStreamUrls } from '../../resolvers/http-resolver.js';
import { promisify } from 'util';

const PROVIDER = 'MkvDrama';
const MKVDRAMA_MAX_QUERY_VARIANTS = Math.max(
    1,
    parseInt(process.env.MKVDRAMA_MAX_QUERY_VARIANTS || '5', 10) || 5
);
const MKVDRAMA_MAX_CONTENT_CANDIDATES = Math.max(
    1,
    parseInt(process.env.MKVDRAMA_MAX_CONTENT_CANDIDATES || '3', 10) || 3
);
const MKVDRAMA_USER_RATE_LIMIT_ENABLED = process.env.MKVDRAMA_USER_RATE_LIMIT_ENABLED !== 'false';
const MKVDRAMA_USER_RATE_LIMIT_MAX_REQUESTS = Math.max(
    1,
    parseInt(process.env.MKVDRAMA_USER_RATE_LIMIT_MAX_REQUESTS || '4', 10) || 4
);
const MKVDRAMA_USER_RATE_LIMIT_WINDOW_MS = Math.max(
    1000,
    parseInt(process.env.MKVDRAMA_USER_RATE_LIMIT_WINDOW_MS || '60000', 10) || 60000
);
const MKVDRAMA_USER_RATE_LIMIT_CLEANUP_MS = Math.max(
    30000,
    parseInt(process.env.MKVDRAMA_USER_RATE_LIMIT_CLEANUP_MS || '300000', 10) || 300000
);
const MKVDRAMA_USER_REQUESTS = new Map(); // clientIp -> { count, windowStart, lastSeen }
let mkvDramaRateLimitLastCleanup = 0;
const MKVDRAMA_PREWARM_LIMIT = Math.max(
    0,
    parseInt(process.env.MKVDRAMA_PREWARM_LIMIT || '0', 10) || 0
);
const MKVDRAMA_EAGER_RESOLVE_ENABLED = process.env.MKVDRAMA_EAGER_RESOLVE_ENABLED === 'true';
const MKVDRAMA_EAGER_RESOLVE_TIMEOUT_MS = Math.max(
    5000,
    parseInt(process.env.MKVDRAMA_EAGER_RESOLVE_TIMEOUT_MS || '10000', 10) || 10000
);
const MKVDRAMA_DIRECT_WORKER_ENABLED = process.env.MKVDRAMA_DIRECT_WORKER_ENABLED !== 'false';
const MKVDRAMA_DIRECT_WORKER_MAX_LINKS = Math.max(
    1,
    parseInt(process.env.MKVDRAMA_DIRECT_WORKER_MAX_LINKS || '2', 10) || 2
);
const MKVDRAMA_DIRECT_WORKER_TIMEOUT_MS = Math.max(
    5000,
    parseInt(process.env.MKVDRAMA_DIRECT_WORKER_TIMEOUT_MS || '20000', 10) || 20000
);
const MKVDRAMA_DIRECT_WORKER_CACHE_TTL_MS = Math.max(
    60000,
    parseInt(process.env.MKVDRAMA_DIRECT_WORKER_CACHE_TTL_MS || String(6 * 60 * 60 * 1000), 10) || (6 * 60 * 60 * 1000)
);
const MKVDRAMA_PROXY_ROTATION_ENABLED = process.env.MKVDRAMA_SOCKS5_ROTATION_ENABLED !== 'false';
const MKVDRAMA_RETRY_ATTEMPTS = Math.max(
    1,
    parseInt(
        process.env.MKVDRAMA_RETRY_ATTEMPTS ||
        (MKVDRAMA_PROXY_ROTATION_ENABLED ? '2' : '1'),
        10
    ) || 1
);
const MKVDRAMA_RETRY_DELAY_MS = Math.max(
    0,
    parseInt(process.env.MKVDRAMA_RETRY_DELAY_MS || '800', 10) || 800
);
const MKVDRAMA_RETRY_ON_EMPTY = process.env.MKVDRAMA_RETRY_ON_EMPTY !== 'false';
const execFileAsync = promisify(execFile);
const MKVDRAMA_DIRECT_URL_CACHE = new Map();
const MKVDRAMA_DIRECT_URL_IN_FLIGHT = new Map();

async function waitForRetry(attempt, reason = '') {
    if (attempt >= MKVDRAMA_RETRY_ATTEMPTS) return false;
    const backoffMs = Math.max(0, MKVDRAMA_RETRY_DELAY_MS * attempt);
    const reasonSuffix = reason ? ` (${reason})` : '';
    console.log(`[${PROVIDER}] Retrying attempt ${attempt + 1}/${MKVDRAMA_RETRY_ATTEMPTS}${reasonSuffix} after ${backoffMs}ms`);
    if (backoffMs > 0) {
        await new Promise(resolve => setTimeout(resolve, backoffMs));
    }
    return true;
}

function getCachedDirectMkvDramaUrl(hintedUrl) {
    const entry = MKVDRAMA_DIRECT_URL_CACHE.get(hintedUrl);
    if (!entry) return null;
    if (Date.now() - entry.ts > MKVDRAMA_DIRECT_WORKER_CACHE_TTL_MS) {
        MKVDRAMA_DIRECT_URL_CACHE.delete(hintedUrl);
        return null;
    }
    return entry.url || null;
}

function setCachedDirectMkvDramaUrl(hintedUrl, url) {
    if (!hintedUrl || !url) return;
    MKVDRAMA_DIRECT_URL_CACHE.set(hintedUrl, { url, ts: Date.now() });
}

async function resolveMkvDramaUrlInWorker(hintedUrl, timeoutMs = MKVDRAMA_DIRECT_WORKER_TIMEOUT_MS) {
    if (!MKVDRAMA_DIRECT_WORKER_ENABLED || !hintedUrl) return null;

    const cached = getCachedDirectMkvDramaUrl(hintedUrl);
    if (cached) return cached;

    const inFlight = MKVDRAMA_DIRECT_URL_IN_FLIGHT.get(hintedUrl);
    if (inFlight) return inFlight;

    const workerPromise = (async () => {
        for (let attempt = 1; attempt <= 2; attempt += 1) {
            try {
                const { stdout } = await execFileAsync(
                    process.execPath,
                    [
                        '--input-type=module',
                        '-e',
                        "globalThis.File = class File {}; const mod = await import('./lib/http-streams/resolvers/http-resolver.js'); const resolved = await mod.resolveHttpStreamUrl(process.argv[1]); console.log(JSON.stringify({ resolved })); process.exit(0);",
                        hintedUrl
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
                        timeout: timeoutMs,
                        maxBuffer: 1024 * 1024
                    }
                );

                const jsonLine = String(stdout || '')
                    .split(/\r?\n/)
                    .map(line => line.trim())
                    .filter(Boolean)
                    .reverse()
                    .find(line => line.startsWith('{') && line.endsWith('}'));
                const parsed = JSON.parse(jsonLine || '{}');
                const resolvedUrl = typeof parsed?.resolved === 'string' && parsed.resolved ? parsed.resolved : null;
                if (resolvedUrl) {
                    setCachedDirectMkvDramaUrl(hintedUrl, resolvedUrl);
                    return resolvedUrl;
                }
            } catch (error) {
                console.log(`[${PROVIDER}] Direct worker resolve failed for ${hintedUrl} (attempt ${attempt}): ${error.message}`);
            }

            if (attempt < 2) {
                await new Promise(resolve => setTimeout(resolve, 400));
            }
        }

        return null;
    })();

    MKVDRAMA_DIRECT_URL_IN_FLIGHT.set(hintedUrl, workerPromise);
    try {
        return await workerPromise;
    } finally {
        if (MKVDRAMA_DIRECT_URL_IN_FLIGHT.get(hintedUrl) === workerPromise) {
            MKVDRAMA_DIRECT_URL_IN_FLIGHT.delete(hintedUrl);
        }
    }
}

function getDescriptorPriority(descriptor = {}) {
    const resolution = String(descriptor.resolution || '').toLowerCase();
    if (resolution === '4k') return 400;
    if (resolution === '1080p') return 300;
    if (resolution === '720p') return 200;
    if (resolution === '480p') return 100;
    return 0;
}

function extractMkvDramaReleaseYear(meta = {}) {
    const candidates = [
        meta?.year,
        meta?.releaseYear,
        meta?.releaseInfo,
        meta?.release_date,
        meta?.released
    ];

    if (Array.isArray(meta?.videos) && meta.videos.length > 0) {
        candidates.push(meta.videos[0]?.released);
    }

    for (const candidate of candidates) {
        if (candidate === null || candidate === undefined) continue;
        const match = String(candidate).match(/\b(19|20)\d{2}\b/);
        if (match) {
            const parsed = parseInt(match[0], 10);
            if (Number.isFinite(parsed)) return parsed;
        }
    }

    return null;
}

function buildMkvDramaQueries(meta = {}) {
    const title = String(meta?.name || '').trim();
    const baseTitle = removeYear(title);
    const releaseYear = extractMkvDramaReleaseYear(meta);
    const alternativeTitles = Array.isArray(meta?.alternativeTitles) ? meta.alternativeTitles : [];

    const yearVariants = releaseYear
        ? [
            title ? `${removeYear(title)} ${releaseYear}`.trim() : null,
            baseTitle ? `${baseTitle} ${releaseYear}`.trim() : null,
            ...alternativeTitles.map((alt) => `${removeYear(String(alt || ''))} ${releaseYear}`.trim())
        ]
        : [];

    return Array.from(new Set([
        title,
        baseTitle,
        ...alternativeTitles,
        ...yearVariants,
        ...generateAlternativeQueries(title, meta?.original_title)
    ].filter(Boolean))).slice(0, MKVDRAMA_MAX_QUERY_VARIANTS);
}

function cleanupMkvDramaUserRateLimit(now = Date.now()) {
    if (now - mkvDramaRateLimitLastCleanup < MKVDRAMA_USER_RATE_LIMIT_CLEANUP_MS) return;
    mkvDramaRateLimitLastCleanup = now;

    const staleAfterMs = Math.max(
        MKVDRAMA_USER_RATE_LIMIT_WINDOW_MS * 2,
        MKVDRAMA_USER_RATE_LIMIT_CLEANUP_MS * 2
    );
    for (const [clientIp, record] of MKVDRAMA_USER_REQUESTS.entries()) {
        if (!record || (now - (record.lastSeen || 0)) > staleAfterMs) {
            MKVDRAMA_USER_REQUESTS.delete(clientIp);
        }
    }
}

function consumeMkvDramaUserRequest(clientIp) {
    const now = Date.now();
    cleanupMkvDramaUserRateLimit(now);

    const record = MKVDRAMA_USER_REQUESTS.get(clientIp);
    if (!record || (now - record.windowStart) >= MKVDRAMA_USER_RATE_LIMIT_WINDOW_MS) {
        MKVDRAMA_USER_REQUESTS.set(clientIp, {
            count: 1,
            windowStart: now,
            lastSeen: now
        });
        return {
            allowed: true,
            remaining: Math.max(0, MKVDRAMA_USER_RATE_LIMIT_MAX_REQUESTS - 1),
            retryAfterMs: MKVDRAMA_USER_RATE_LIMIT_WINDOW_MS
        };
    }

    record.lastSeen = now;
    if (record.count >= MKVDRAMA_USER_RATE_LIMIT_MAX_REQUESTS) {
        return {
            allowed: false,
            remaining: 0,
            retryAfterMs: Math.max(1000, MKVDRAMA_USER_RATE_LIMIT_WINDOW_MS - (now - record.windowStart))
        };
    }

    record.count += 1;
    return {
        allowed: true,
        remaining: Math.max(0, MKVDRAMA_USER_RATE_LIMIT_MAX_REQUESTS - record.count),
        retryAfterMs: Math.max(0, MKVDRAMA_USER_RATE_LIMIT_WINDOW_MS - (now - record.windowStart))
    };
}

/**
 * Creates a user-visible error stream when FlareSolverr is unavailable
 * @param {string} reason - Reason for unavailability ('overloaded' or 'rate_limited')
 * @param {Object} options - Additional options
 * @returns {Object} A Stremio-formatted error stream
 */
function createFlareSolverrErrorStream(reason = 'overloaded', options = {}) {
    const { remaining = 0 } = options;
    let title, description;

    if (reason === 'rate_limited') {
        title = '⏳ Rate Limit Reached';
        description = `You've used your FlareSolverr quota for this hour.\n${remaining > 0 ? `${remaining} requests remaining.` : 'Please try again later.'}\n\nMkvDrama | Debrid streams unaffected`;
    } else {
        title = '⚠️ Server Busy';
        description = 'FlareSolverr is processing many requests.\nPlease try again in a moment.\n\nMkvDrama | Debrid streams unaffected';
    }

    return {
        name: `[HS+] Sootio\nBusy`,
        title: `${title}\n${description}`,
        externalUrl: 'https://github.com/sootio/stremio-addon',
        behaviorHints: { notWebReady: true }
    };
}

function createMkvDramaUserRateLimitStream(retryAfterMs = 0) {
    const retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
    const windowSeconds = Math.max(1, Math.ceil(MKVDRAMA_USER_RATE_LIMIT_WINDOW_MS / 1000));
    return {
        name: `[HS+] Sootio\nLimited`,
        title: `⏳ MkvDrama Rate Limited\nToo many MkvDrama requests from your IP.\nTry again in ${retryAfterSeconds}s.\nLimit: ${MKVDRAMA_USER_RATE_LIMIT_MAX_REQUESTS} per ${windowSeconds}s`,
        externalUrl: 'https://github.com/sootio/stremio-addon',
        behaviorHints: { notWebReady: true }
    };
}

function createMkvDramaBlockedStream(reason = 'wordfence') {
    if (reason === 'cloudflare') {
        return {
            name: `[HS+] Sootio\nBlocked`,
            title: '⚠️ MkvDrama Blocked\nCloudflare challenge is blocking the server IP.\nTry again later or use a working proxy for mkvdrama.net.',
            externalUrl: 'https://github.com/sootio/stremio-addon',
            behaviorHints: { notWebReady: true }
        };
    }
    return {
        name: `[HS+] Sootio\nBlocked`,
        title: '⚠️ MkvDrama Blocked\nmkvdrama.net returned a Wordfence/WAF block page for the current proxy IP.\nThis is IP-based and cannot be solved by fingerprinting.\nWait for the block to clear or rotate the proxy IP.',
        externalUrl: 'https://github.com/sootio/stremio-addon',
        behaviorHints: { notWebReady: true }
    };
}

// Supported download hosts - each link generates streams for all hosts
const DOWNLOAD_HOSTS = [
    { id: 'pixeldrain.com', label: 'Pixeldrain' }
];

/**
 * Check if an entry could be a pixeldrain link.
 * Returns true if:
 * - Host is explicitly pixeldrain.com, OR
 * - Host is not set (will be resolved via OUO -> viewcrate chain)
 * Returns false if host is explicitly set to a different provider.
 */
function isPixeldrainLink(entry) {
    if (!entry) return false;
    if (entry.host) {
        const host = entry.host.toLowerCase();
        // Explicitly pixeldrain
        if (host === 'pixeldrain.com' || host.includes('pixeldrain')) return true;
        // Explicitly a different host - exclude it
        return false;
    }
    // No host info - assume it could be pixeldrain (most mkvdrama OUO links resolve to pixeldrain)
    return true;
}

function normalizeResolution(label = '') {
    const resolution = getResolutionFromName(label);
    if (resolution === '2160p') return '4k';
    if (['1080p', '720p', '540p', '480p'].includes(resolution)) return resolution;
    return 'HTTP';
}

function buildHintedUrl(url, hints = {}) {
    const params = new URLSearchParams();
    if (hints.episode) params.set('ep', hints.episode);
    if (hints.resolution) params.set('res', hints.resolution);
    if (hints.host) params.set('host', hints.host);
    if (Array.isArray(hints.passwords)) {
        hints.passwords
            .map(value => String(value || '').trim())
            .filter(Boolean)
            .forEach(value => params.append('pwd', value));
    }
    const hash = params.toString();
    return hash ? `${url}#${hash}` : url;
}

function formatEpisodeKey(season, episode) {
    if (!season || !episode) return null;
    const s = String(season).padStart(2, '0');
    const e = String(episode).padStart(2, '0');
    return `S${s}E${e}`;
}

function formatEpisodeKeyFromEntry(entry) {
    if (!entry) return null;
    if (entry.episodeStart && entry.episodeEnd && entry.episodeStart === entry.episodeEnd) {
        const e = String(entry.episodeStart).padStart(2, '0');
        if (entry.season) {
            const s = String(entry.season).padStart(2, '0');
            return `S${s}E${e}`;
        }
        return `E${e}`;
    }
    return null;
}

function extractEpisodeKeyFromText(text = '') {
    const match = text.match(/\bS(\d{1,2})E(\d{1,3})\b/i);
    if (!match) return null;
    const s = String(match[1]).padStart(2, '0');
    const e = String(match[2]).padStart(2, '0');
    return `S${s}E${e}`;
}

function buildDedupKey(entry, episodeKey, hostId) {
    const text = `${entry?.linkText || ''} ${entry?.label || ''} ${entry?.quality || ''}`.trim();
    const resolution = getResolutionFromName(text);
    const entryEpisodeKey = episodeKey ||
        formatEpisodeKeyFromEntry(entry) ||
        extractEpisodeKeyFromText(text);
    return `${entryEpisodeKey || 'unknown'}|${resolution || 'other'}|${hostId || 'host'}`;
}

function buildDisplayLabel(entry, episodeKey = null) {
    const label = episodeKey || entry.label;
    const parts = [label, entry.quality].filter(Boolean);
    return parts.join(' ').trim() || 'Download';
}

function matchesEpisode(entry, season, episode) {
    if (!episode) return true;
    const episodeNumber = parseInt(episode, 10);
    if (Number.isNaN(episodeNumber)) return true;
    if (entry.season && season && entry.season !== parseInt(season, 10)) return false;
    if (entry.episodeStart !== null && entry.episodeEnd !== null) {
        return episodeNumber >= entry.episodeStart && episodeNumber <= entry.episodeEnd;
    }
    // Entry has no episode info — when a specific episode is requested, reject it
    // to avoid returning season packs or unrelated episodes
    return false;
}

function selectEpisodeLinks(links, season, episode) {
    if (!episode) return links;
    const episodeNumber = parseInt(episode, 10);
    if (Number.isNaN(episodeNumber)) return links;
    const seasonNumber = season ? parseInt(season, 10) : null;

    const seasonFiltered = links.filter((entry) => {
        if (entry.season && seasonNumber && entry.season !== seasonNumber) return false;
        return true;
    });

    const withEpisodeInfo = seasonFiltered.filter((entry) =>
        entry.episodeStart !== null || entry.episodeEnd !== null
    );

    const exactMatches = withEpisodeInfo.filter((entry) =>
        entry.episodeStart === episodeNumber && entry.episodeEnd === episodeNumber
    );
    if (exactMatches.length) return exactMatches;

    const rangedMatches = withEpisodeInfo.filter((entry) => {
        if (entry.episodeStart === null && entry.episodeEnd === null) return false;
        const start = entry.episodeStart ?? entry.episodeEnd;
        const end = entry.episodeEnd ?? entry.episodeStart;
        if (start === null || end === null) return false;
        return episodeNumber >= start && episodeNumber <= end;
    });
    if (rangedMatches.length) return rangedMatches;

    // No exact or ranged matches found — return empty instead of falling back
    // to all links without episode info (which would yield season packs or wrong episodes)
    return [];
}

function normalizeLinkUrl(url = '') {
    if (!url) return '';
    try {
        const parsed = new URL(url);
        parsed.hash = '';
        return parsed.toString();
    } catch {
        return url;
    }
}

function rankLinkSource(url = '') {
    const lower = String(url || '').toLowerCase();
    if (!lower) return 0;
    if (lower.includes('pixeldrain')) return 400;
    if (lower.includes('ouo.io')) return 320;
    if (lower.includes('ouo.press')) return 300;
    if (lower.includes('oii.la')) return 260;
    if (lower.includes('filecrypt')) return 180;
    return 0;
}

function sortLinksByPreference(links = []) {
    return [...links].sort((a, b) => {
        const scoreDiff = rankLinkSource(b?.url) - rankLinkSource(a?.url);
        if (scoreDiff !== 0) return scoreDiff;
        return String(a?.url || '').localeCompare(String(b?.url || ''));
    });
}

function dedupeLinks(links) {
    const seen = new Set();
    return links.filter((entry) => {
        const key = normalizeLinkUrl(entry.url);
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

// Exported for unit testing
export { matchesEpisode, selectEpisodeLinks };

export async function getMkvDramaStreams(tmdbId, type, season = null, episode = null, config = {}, prefetchedMeta = null) {
    console.log(`[${PROVIDER}] Starting search for ${tmdbId} (${type}${season ? ` S${season}` : ''}${episode ? `E${episode}` : ''})`);

    // Extract clientIp from config for per-IP rate limiting
    const clientIp = config?.clientIp || null;

    // Apply MKVDrama per-user limiter before any expensive search/fetch work
    if (MKVDRAMA_USER_RATE_LIMIT_ENABLED && clientIp) {
        const userAllowance = consumeMkvDramaUserRequest(clientIp);
        if (!userAllowance.allowed) {
            console.warn(`[${PROVIDER}] MKVDrama user rate limited for ${clientIp} (limit: ${MKVDRAMA_USER_RATE_LIMIT_MAX_REQUESTS}/${Math.ceil(MKVDRAMA_USER_RATE_LIMIT_WINDOW_MS / 1000)}s, retry in ${Math.ceil(userAllowance.retryAfterMs / 1000)}s)`);
            return [createMkvDramaUserRateLimitStream(userAllowance.retryAfterMs)];
        }
    }

    let meta = prefetchedMeta;
    if (!meta) {
        console.log(`[${PROVIDER}] No pre-fetched metadata, fetching from Cinemeta...`);
        meta = await Cinemeta.getMeta(type, tmdbId);
    } else {
        console.log(`[${PROVIDER}] Using pre-fetched Cinemeta metadata: "${meta.name}"`);
    }

    if (!meta?.name) {
        console.log(`[${PROVIDER}] Missing metadata for ${tmdbId}`);
        return [];
    }

    const queries = buildMkvDramaQueries(meta);

    for (let attempt = 1; attempt <= MKVDRAMA_RETRY_ATTEMPTS; attempt += 1) {
        try {
            if (attempt > 1) {
                console.log(`[${PROVIDER}] Attempt ${attempt}/${MKVDRAMA_RETRY_ATTEMPTS}`);
            }

            // Keep MKVDrama query fanout sequential to avoid hammering anti-bot on a single solver/proxy session.
            console.log(`[${PROVIDER}] Searching ${queries.length} query variants (sequential)...`);
            let searchResults = [];
            let earlyExitTriggered = false;

            for (const query of queries) {
                if (earlyExitTriggered) break;
                console.log(`[${PROVIDER}] Searching for: "${query}"`);
                try {
                    const results = await scrapeMkvDramaSearch(query);
                    if (results.length > 0) {
                        searchResults.push(...results);
                    }
                    // Check for early exit condition
                    if (results.length > 0) {
                        const matches = getSortedMatches(results, meta.name);
                        if (matches.length > 0 && matches[0].score >= 50) {
                            earlyExitTriggered = true;
                            console.log(`[${PROVIDER}] Found good match for "${query}", signaling early exit`);
                        }
                    }
                } catch (err) {
                    console.log(`[${PROVIDER}] Search failed for "${query}": ${err.message}`);
                }
            }

            if (searchResults.length === 0) {
                const block = getMkvDramaLastBlock();
                console.log(`[${PROVIDER}] No search results found${block?.reason ? ` (last block: ${block.reason})` : ''}`);
                if (MKVDRAMA_RETRY_ON_EMPTY && await waitForRetry(attempt, 'no search results')) {
                    continue;
                }
                return [];
            }

            const seenUrls = new Set();
            const uniqueResults = searchResults.filter(result => {
                if (!result?.url || seenUrls.has(result.url)) return false;
                seenUrls.add(result.url);
                return true;
            });

            const sortedMatches = getSortedMatches(uniqueResults, meta.name);
            if (!sortedMatches[0]?.url) {
                console.log(`[${PROVIDER}] No suitable match found for ${meta.name}`);
                if (MKVDRAMA_RETRY_ON_EMPTY && await waitForRetry(attempt, 'no suitable match')) {
                    continue;
                }
                return [];
            }

            let content = null;
            let uniqueLinks = [];
            const candidateMatches = sortedMatches.slice(0, MKVDRAMA_MAX_CONTENT_CANDIDATES).filter(m => m?.url);

            // PERFORMANCE FIX: Load all candidates in parallel, use first with results
            console.log(`[${PROVIDER}] Loading ${candidateMatches.length} content candidates in parallel...`);
            const candidatePromises = candidateMatches.map(async (match) => {
                console.log(`[${PROVIDER}] Loading content from: ${match.url}`);
                try {
                    const currentContent = await loadMkvDramaContent(match.url, null, {
                        season,
                        episode
                    });
                    const downloadLinks = currentContent.downloadLinks || [];

                    if (downloadLinks.length === 0) {
                        console.log(`[${PROVIDER}] No download links found on ${match.url}`);
                        if (currentContent?.blockedReason) {
                            return { blockedReason: currentContent.blockedReason };
                        }
                        return null;
                    }

                    const candidateLinks = downloadLinks.filter(isPixeldrainLink);
                    const filteredLinks = (type === 'series' || type === 'tv') && episode
                        ? selectEpisodeLinks(candidateLinks.filter(entry => matchesEpisode(entry, season, episode)), season, episode)
                        : candidateLinks;
                    const deduped = dedupeLinks(sortLinksByPreference(filteredLinks));
                    if (!deduped.length) {
                        console.log(`[${PROVIDER}] No usable episode links on ${match.url}`);
                        return null;
                    }

                    return { content: currentContent, links: deduped };
                } catch (err) {
                    console.log(`[${PROVIDER}] Failed to load ${match.url}: ${err.message}`);
                    return null;
                }
            });

            const candidateResults = await Promise.allSettled(candidatePromises);
            let blockedReason = null;
            for (const result of candidateResults) {
                if (result.status === 'fulfilled' && result.value) {
                    if (result.value.blockedReason) {
                        blockedReason = blockedReason || result.value.blockedReason;
                        continue;
                    }
                    content = result.value.content;
                    uniqueLinks = result.value.links;
                    break;
                }
            }

            if (uniqueLinks.length === 0) {
                console.log(`[${PROVIDER}] No pixeldrain links found for S${season}E${episode}`);
                if (blockedReason) {
                    console.log(`[${PROVIDER}] No pixeldrain links found, blocked reason: ${blockedReason}`);
                }
                if (MKVDRAMA_RETRY_ON_EMPTY && await waitForRetry(attempt, blockedReason ? `no links (${blockedReason})` : 'no links')) {
                    continue;
                }
                return [];
            }

            const detectedLanguages = detectLanguagesFromTitle(content.title || meta.name || '');
            const episodeKey = (type === 'series' || type === 'tv') && episode
                ? formatEpisodeKey(season, episode)
                : null;

            if (isLazyLoadEnabled() && !MKVDRAMA_EAGER_RESOLVE_ENABLED) {
                const previewStreams = [];
                const previewUrlsToWarm = [];
                const seenKeys = new Set();
                for (const link of uniqueLinks) {
                    const label = buildDisplayLabel(link, episodeKey);
                    const resolutionHint = getResolutionFromName(label);

                    // Generate a stream for each supported host
                    for (const host of DOWNLOAD_HOSTS) {
                        const dedupeKey = buildDedupKey(link, episodeKey, host.id);
                        if (seenKeys.has(dedupeKey)) continue;
                        seenKeys.add(dedupeKey);
                        const hintedUrl = buildHintedUrl(link.url, {
                            episode: episodeKey,
                            resolution: resolutionHint !== 'other' ? resolutionHint : null,
                            host: host.id,
                            passwords: link.passwords
                        });
                        previewUrlsToWarm.push(hintedUrl);
                        previewStreams.push(createPreviewStream({
                            url: hintedUrl,
                            label: `${label} [${host.label}]`,
                            provider: PROVIDER,
                            languages: detectedLanguages
                        }));
                    }
                }

                if (MKVDRAMA_PREWARM_LIMIT > 0) {
                    prewarmHttpStreamUrls(previewUrlsToWarm.slice(0, MKVDRAMA_PREWARM_LIMIT));
                }
                return formatPreviewStreams(previewStreams, encodeUrlForStreaming, renderLanguageFlags);
            }

            const streamDescriptors = [];
            const streamUrlsToWarm = [];
            const seenKeys = new Set();
            for (const link of uniqueLinks) {
                const label = buildDisplayLabel(link, episodeKey);
                const resolutionLabel = normalizeResolution(label);
                const languageFlags = renderLanguageFlags(detectedLanguages);
                const resolutionHint = getResolutionFromName(label);

                // Generate a stream for each supported host
                for (const host of DOWNLOAD_HOSTS) {
                    const dedupeKey = buildDedupKey(link, episodeKey, host.id);
                    if (seenKeys.has(dedupeKey)) continue;
                    seenKeys.add(dedupeKey);
                    const hintedUrl = buildHintedUrl(link.url, {
                        episode: episodeKey,
                        resolution: resolutionHint !== 'other' ? resolutionHint : null,
                        host: host.id,
                        passwords: link.passwords
                    });
                    streamUrlsToWarm.push(hintedUrl);

                    streamDescriptors.push({
                        hintedUrl,
                        name: `[HS+] Sootio\n${resolutionLabel}`,
                        title: `${label} [${host.label}]${languageFlags}\n${PROVIDER}`,
                        resolution: resolutionLabel,
                        isPreview: true,
                        behaviorHints: {
                            bingeGroup: 'mkvdrama-streams'
                        }
                    });
                }
            }

            let firstResolved = null;
            if (MKVDRAMA_EAGER_RESOLVE_ENABLED && streamDescriptors.length > 0) {
                const deadline = Date.now() + MKVDRAMA_EAGER_RESOLVE_TIMEOUT_MS;
                const candidates = streamDescriptors
                    .map((descriptor, index) => ({ descriptor, index }))
                    .sort((a, b) => getDescriptorPriority(b.descriptor) - getDescriptorPriority(a.descriptor))
                    .slice(0, MKVDRAMA_DIRECT_WORKER_MAX_LINKS);
                for (const candidate of candidates) {
                    const remainingMs = deadline - Date.now();
                    if (remainingMs <= 2000) break;
                    const resolvedUrl = await resolveMkvDramaUrlInWorker(
                        candidate.descriptor.hintedUrl,
                        Math.min(remainingMs, MKVDRAMA_DIRECT_WORKER_TIMEOUT_MS)
                    );
                    if (resolvedUrl) {
                        firstResolved = { index: candidate.index, resolvedUrl };
                        break;
                    }
                }
            }

            const streams = streamDescriptors.map((descriptor, index) => {
                if (firstResolved?.index === index && firstResolved.resolvedUrl) {
                    return {
                        ...descriptor,
                        url: encodeUrlForStreaming(firstResolved.resolvedUrl)
                    };
                }

                return {
                    ...descriptor,
                    url: encodeUrlForStreaming(descriptor.hintedUrl),
                    needsResolution: true
                };
            });

            if (MKVDRAMA_PREWARM_LIMIT > 0) {
                prewarmHttpStreamUrls(streamUrlsToWarm.slice(0, MKVDRAMA_PREWARM_LIMIT));
            }
            console.log(`[${PROVIDER}] Returning ${streams.length} streams`);
            return streams;
        } catch (error) {
            console.error(`[${PROVIDER}] Failed to fetch streams (attempt ${attempt}/${MKVDRAMA_RETRY_ATTEMPTS}): ${error.message}`);
            if (await waitForRetry(attempt, 'error')) {
                continue;
            }
            return [];
        }
    }

    return [];
}
