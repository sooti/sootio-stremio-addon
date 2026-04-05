/**
 * MKVDrama search helpers
 * Provides search and post parsing utilities for mkvdrama.org
 */

import { cleanTitle } from '../../utils/parsing.js';
import * as SqliteCache from '../../../util/cache-store.js';
import { browserSearchCatalog, browserLoadContent } from './browser.js';

const API_URL = (process.env.MKVDRAMA_API_URL || 'https://mkvdrama.net').replace(/\/+$/, '');

const MKVDRAMA_CACHE_DISABLED = process.env.MKVDRAMA_CACHE_DISABLED === 'true';
const MKVDRAMA_RESULT_CACHE_ENABLED = process.env.MKVDRAMA_RESULT_CACHE_ENABLED === 'true';

const SQLITE_SERVICE_KEY = 'mkvdrama';

export function getMkvDramaLastBlock() {
    return null;
}

// --- DB cache helpers ---

async function getDbCached(hashKey, ttl) {
    if (MKVDRAMA_CACHE_DISABLED) return null;
    if (!SqliteCache.isEnabled()) return null;
    try {
        const cached = await SqliteCache.getCachedRecord(SQLITE_SERVICE_KEY, hashKey);
        if (!cached?.data) return null;
        const updatedAt = cached.updatedAt || cached.createdAt;
        if (updatedAt && (!ttl || ttl <= 0)) return cached.data;
        if (updatedAt) {
            const age = Date.now() - new Date(updatedAt).getTime();
            if (age <= ttl) return cached.data;
        }
    } catch (error) {
        console.error(`[MKVDrama] Failed to read db cache: ${error.message}`);
    }
    return null;
}

async function setDbCache(hashKey, data, ttlMs) {
    if (MKVDRAMA_CACHE_DISABLED) return;
    if (!SqliteCache.isEnabled()) return;
    try {
        await SqliteCache.upsertCachedMagnet({
            service: SQLITE_SERVICE_KEY,
            hash: hashKey,
            data,
            releaseKey: 'mkvdrama-http-streams'
        }, { ttlMs });
    } catch (error) {
        console.error(`[MKVDrama] Failed to write db cache: ${error.message}`);
    }
}

// --- Text helpers ---

function cleanText(text = '') {
    return text.replace(/\s+/g, ' ').trim();
}

// --- Episode & season parsing ---

export function parseEpisodeRange(label = '') {
    const normalized = label || '';
    const match = normalized.match(/(?:episode|episodes|ep|eps)\.?\s*(\d{1,3})(?:\s*(?:-|to|–|—|&|and)\s*(\d{1,3}))?/i);
    if (match) {
        const start = parseInt(match[1], 10);
        const end = match[2] ? parseInt(match[2], 10) : start;
        if (Number.isNaN(start)) return null;
        return { start, end };
    }

    const seMatch = normalized.match(/\bS(\d{1,2})E(\d{1,3})\b/i);
    if (seMatch) {
        const episode = parseInt(seMatch[2], 10);
        if (!Number.isNaN(episode)) return { start: episode, end: episode };
    }

    const eMatch = normalized.match(/\bE(\d{1,3})\b/i);
    if (eMatch) {
        const episode = parseInt(eMatch[1], 10);
        if (!Number.isNaN(episode)) return { start: episode, end: episode };
    }

    const rangeMatch = normalized.match(/^\s*0*(\d{1,3})\s*(?:-|–|—)\s*0*(\d{1,3})\s*$/);
    if (rangeMatch) {
        const start = parseInt(rangeMatch[1], 10);
        const end = parseInt(rangeMatch[2], 10);
        if (!Number.isNaN(start) && !Number.isNaN(end) && end >= start) {
            return { start, end };
        }
    }

    return null;
}

export function parseSeasonNumber(label = '') {
    const normalized = label || '';
    const match = normalized.match(/season\s*(\d{1,2})/i) ||
        normalized.match(/\bS(\d{1,2})E\d{1,3}\b/i) ||
        normalized.match(/\bS(\d{1,2})\b/i);
    if (!match) return null;
    const season = parseInt(match[1], 10);
    return Number.isNaN(season) ? null : season;
}

// --- API search config ---

const MKVDRAMA_API_SEARCH_MAX_PAGES = Math.max(
    1,
    parseInt(process.env.MKVDRAMA_API_SEARCH_MAX_PAGES || '3', 10) || 3
);
const MKVDRAMA_API_SEARCH_PER_PAGE = Math.max(
    10,
    parseInt(process.env.MKVDRAMA_API_SEARCH_PER_PAGE || '100', 10) || 100
);

// --- Cache TTLs ---

const SEARCH_CACHE_TTL = 2 * 60 * 60 * 1000; // 2 hours
const CONTENT_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

// --- Main exports ---

export async function scrapeMkvDramaSearch(query, signal = null) {
    if (!query) return [];

    const cleanQuery = query.replace(/:/g, '').replace(/\s+/g, ' ').trim();

    // Check cache
    const searchCacheKey = `mkvdrama-search:${cleanQuery.toLowerCase()}`;
    if (MKVDRAMA_RESULT_CACHE_ENABLED) {
        try {
            const cached = await getDbCached(searchCacheKey, SEARCH_CACHE_TTL);
            if (cached?.results?.length > 0) {
                console.log(`[MKVDrama] Cached search results for "${cleanQuery}" (${cached.results.length})`);
                return cached.results;
            }
        } catch {
            // Cache miss
        }
    }

    console.log(`[MKVDrama] Search: "${cleanQuery}"`);

    try {
        // Search via Puppeteer browser (bypasses CF on mkvdrama.org)
        const apiResults = await browserSearchCatalog(
            cleanQuery,
            MKVDRAMA_API_SEARCH_MAX_PAGES,
            MKVDRAMA_API_SEARCH_PER_PAGE
        );

        const results = apiResults.map(entry => {
            const title = cleanText(entry.title || '');
            const slug = entry.slug || '';
            const contentUrl = `${API_URL}/titles/${slug}/`;
            const yearMatch = (entry.release_date || '').match(/\b(19|20)\d{2}\b/);
            const poster = entry.cover_url
                ? (entry.cover_url.startsWith('http') ? entry.cover_url : `${API_URL}${entry.cover_url}`)
                : null;

            return {
                title,
                url: contentUrl,
                year: yearMatch ? parseInt(yearMatch[0], 10) : null,
                poster,
                normalizedTitle: cleanTitle(title),
                slug,
                apiScore: entry._score || 0
            };
        });

        if (results.length > 0 && MKVDRAMA_RESULT_CACHE_ENABLED) {
            setDbCache(searchCacheKey, { results }, SEARCH_CACHE_TTL).catch(() => {});
        }

        return results;
    } catch (error) {
        console.error(`[MKVDrama] Search failed for "${query}": ${error.message}`);
        return [];
    }
}

export async function loadMkvDramaContent(postUrl, signal = null, options = {}) {
    if (!postUrl) return { title: '', downloadLinks: [] };

    // Extract slug from URL (handles both /titles/slug/ and /slug/ patterns)
    let slug = '';
    try {
        const urlPath = new URL(postUrl).pathname.replace(/\/+$/, '');
        const parts = urlPath.split('/').filter(Boolean);
        slug = parts[parts.length - 1] || '';
    } catch {
        slug = postUrl.replace(/[/]+$/, '').split('/').pop() || '';
    }

    if (!slug) return { title: '', downloadLinks: [] };

    // Check content cache
    let contentCacheKey;
    if (MKVDRAMA_RESULT_CACHE_ENABLED) {
        try {
            contentCacheKey = `mkvdrama-content:${slug}`;
            const cached = await getDbCached(contentCacheKey, CONTENT_CACHE_TTL);
            if (cached?.downloadLinks?.length > 0) {
                // Enrich cached links that are missing episode info
                // (older prefetch entries were cached without episode parsing)
                const needsEnrichment = cached.downloadLinks.some(
                    l => l.label && l.episodeStart == null && l.episodeEnd == null
                );
                if (needsEnrichment) {
                    cached.downloadLinks = cached.downloadLinks.map(entry => {
                        if (entry.episodeStart != null) return entry;
                        const episodeRange = parseEpisodeRange(entry.label || '');
                        const season = parseSeasonNumber(entry.label || '');
                        return {
                            ...entry,
                            episodeStart: episodeRange?.start ?? null,
                            episodeEnd: episodeRange?.end ?? null,
                            season: season ?? null,
                        };
                    });
                }
                console.log(`[MKVDrama] Cached content for ${slug} (${cached.downloadLinks.length} links)`);
                return cached;
            }
        } catch {
            // Cache miss
        }
    }

    try {
        // Load title page via Puppeteer browser (handles CF + Turnstile + JS rendering)
        const browserResult = await browserLoadContent(slug);
        let { title, downloadLinks } = browserResult;

        if (!title && !downloadLinks?.length) {
            return { title: '', downloadLinks: [] };
        }

        title = cleanText(title || '').replace(/\s*\|\s*MkvDrama.*$/i, '').trim();

        // Enrich download links with episode/season parsing
        downloadLinks = (downloadLinks || []).map(entry => {
            const episodeRange = parseEpisodeRange(entry.label || '');
            const season = parseSeasonNumber(entry.label || '');
            return {
                ...entry,
                episodeStart: episodeRange?.start ?? null,
                episodeEnd: episodeRange?.end ?? null,
                season: season ?? null,
            };
        });

        // Enrich episode info from title if links don't have it
        if (downloadLinks.length > 0) {
            const titleEpisodeRange = parseEpisodeRange(title);
            const titleSeason = parseSeasonNumber(title);
            if (titleEpisodeRange || titleSeason) {
                downloadLinks = downloadLinks.map(entry => {
                    if (entry.episodeStart || entry.episodeEnd || entry.season) return entry;
                    return {
                        ...entry,
                        episodeStart: titleEpisodeRange?.start ?? null,
                        episodeEnd: titleEpisodeRange?.end ?? null,
                        season: titleSeason ?? null
                    };
                });
            }
        }

        const result = { title, downloadLinks };

        // Cache
        if (downloadLinks.length > 0 && contentCacheKey && MKVDRAMA_RESULT_CACHE_ENABLED) {
            setDbCache(contentCacheKey, result, CONTENT_CACHE_TTL).catch(() => {});
        }

        return result;
    } catch (error) {
        console.error(`[MKVDrama] Failed to load content for ${slug}: ${error.message}`);
        return { title: '', downloadLinks: [] };
    }
}
