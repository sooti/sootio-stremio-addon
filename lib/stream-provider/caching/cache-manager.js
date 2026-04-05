/**
 * Cache management for torrent search results
 * Handles SQLite caching with TTL and Torz API integration
 */

import * as SqliteCache from '../../util/cache-store.js';
import PTT from '../../util/parse-torrent-title.js';
import { SEARCH_CACHE_VERSION } from '../config/timeouts.js';
import { refreshCacheInBackground } from './background-refresh.js';

// Cache TTL configuration
const SCRAPER_CACHE_TTL_SERIES_MIN = process.env.SCRAPER_CACHE_TTL_SERIES_MIN || 43200; // 30 days in minutes
const SCRAPER_CACHE_TTL_MOVIE_MIN = process.env.SCRAPER_CACHE_TTL_MOVIE_MIN || 43200; // 30 days in minutes
const MIN_RESULTS_PER_SERVICE = Math.max(
  1,
  parseInt(process.env.MIN_RESULTS_PER_SERVICE || process.env.EARLY_RETURN_MIN_STREAMS || '1', 10)
);
const CACHE_URL_ALLOWED_PROVIDERS = new Set(['easynews', 'debriderapp', 'personalcloud']);

function allowsUrlCaching(provider) {
  const key = String(provider || '').toLowerCase();
  return key === 'httpstreaming' || CACHE_URL_ALLOWED_PROVIDERS.has(key);
}

function isM3U8Url(url) {
  return typeof url === 'string' && /\.m3u8(\?|$)/i.test(url);
}

function normalizeHttpStreamingUrl(url) {
  if (!url || typeof url !== 'string') return null;

  let normalized = url.trim();
  const hashIndex = normalized.indexOf('#');
  if (hashIndex !== -1) {
    normalized = normalized.slice(0, hashIndex);
  }

  if (isM3U8Url(normalized)) {
    try {
      const parsed = new URL(normalized);
      const params = new URLSearchParams(parsed.search);
      const volatileKeys = new Set([
        'token',
        'expires',
        'signature',
        'sig',
        'signed',
        'auth',
        'hdntl',
        'hash',
        'key',
        'policy',
        'exp',
        'ts'
      ]);

      const stableParams = [];
      params.forEach((value, key) => {
        if (volatileKeys.has(key.toLowerCase())) return;
        stableParams.push([key, value]);
      });

      stableParams.sort((a, b) => {
        if (a[0] === b[0]) return a[1].localeCompare(b[1]);
        return a[0].localeCompare(b[0]);
      });

      const stableSearch = stableParams.length
        ? `?${stableParams.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')}`
        : '';

      normalized = `${parsed.origin}${parsed.pathname}${stableSearch}`;
    } catch (err) {
      // fall back to trimmed URL
    }
  }

  return normalized.toLowerCase();
}

function sanitizeHttpStreamingCache(results) {
  if (!Array.isArray(results)) {
    return { cleanedResults: [], removedDuplicates: 0, removedM3u8: 0 };
  }

  const seenKeys = new Set();
  let removedDuplicates = 0;
  let removedM3u8 = 0;
  const cleanedResults = [];

  for (const item of results) {
    if (!item) continue;

    const url = item.url;
    const key = url ? normalizeHttpStreamingUrl(url) : null;

    if (key && seenKeys.has(key)) {
      removedDuplicates += 1;
      continue;
    }

    if (key) seenKeys.add(key);
    cleanedResults.push(item);
  }

  return { cleanedResults, removedDuplicates, removedM3u8 };
}

function getCacheResultKey(item, provider) {
  if (!item) return null;
  const providerKey = String(provider || '').toLowerCase();

  // For HTTP streaming: dedupe by normalized title + size + resolution
  // This prevents duplicate entries when same file is on multiple CDN workers
  if (providerKey === 'httpstreaming') {
    const title = (item.title || item.name || '').toLowerCase()
      .replace(/\s+/g, ' ')  // normalize whitespace
      .replace(/[^\w\s]/g, '') // remove special chars
      .trim();
    const size = item.size || item._size || '';
    const resolution = item.resolution || '';
    const httpProvider = (item.httpProvider || '').toLowerCase();

    // For HLS streams that don't have size, use title + quality + provider
    if (!size && title) {
      return `http:${httpProvider}:${title}:${resolution}`;
    }
    // For direct download streams, use title + size + resolution
    if (title && size) {
      return `http:${httpProvider}:${title}:${size}:${resolution}`;
    }
  }

  if ((providerKey === 'easynews' || providerKey === 'debriderapp' || providerKey === 'personalcloud') && item.url) {
    return `url:${String(item.url).toLowerCase()}`;
  }
  const hash = item.hash || item.infoHash || item.InfoHash;
  if (hash) return `hash:${String(hash).toLowerCase()}`;
  const name = item.name || item.title || item.Title;
  if (name) return `name:${String(name).toLowerCase()}`;
  return null;
}

function extractTrackerLabel(item) {
  if (!item || typeof item !== 'object') return '';
  const value = [item.tracker, item.Tracker, item.originalSource]
    .find(entry => typeof entry === 'string' && entry.trim());
  return value ? value.trim() : '';
}

function mergeCacheResults(existingResults, freshResults, provider) {
  const merged = [];
  const indexByKey = new Map();
  const preferFresh = provider === 'httpstreaming';

  const addResult = (item, allowOverwrite) => {
    const key = getCacheResultKey(item, provider);
    if (!key) {
      merged.push(item);
      return false;
    }
    if (!indexByKey.has(key)) {
      indexByKey.set(key, merged.length);
      merged.push(item);
      return true;
    }
    const existingIndex = indexByKey.get(key);
    const existingItem = merged[existingIndex];
    if (allowOverwrite) {
      merged[existingIndex] = item;
      return false;
    }

    // Self-heal stale cache rows that are missing tracker labels.
    const existingTracker = extractTrackerLabel(existingItem);
    const incomingTracker = extractTrackerLabel(item);
    if (!existingTracker && incomingTracker) {
      merged[existingIndex] = { ...existingItem, tracker: incomingTracker };
    }
    return false;
  };

  (existingResults || []).forEach(item => addResult(item, false));
  let newCount = 0;
  (freshResults || []).forEach(item => {
    const wasNew = addResult(item, preferFresh);
    if (wasNew) newCount += 1;
  });

  return { merged, newCount };
}

function attachCacheKey(results, cacheKey) {
  if (!Array.isArray(results) || !cacheKey) return results;
  results.forEach(item => {
    if (!item || item.isPersonal || item._cacheKey) return;
    item._cacheKey = cacheKey;
  });
  return results;
}

/**
 * New caching flow that returns cached results immediately and refreshes in background.
 * This function checks SQLite for cached results first, returns them immediately,
 * and then runs a background task to refresh with fresh data.
 *
 * @param {string} provider - Debrid provider name (e.g., 'RealDebrid')
 * @param {string} type - Content type ('movie' or 'series')
 * @param {string} id - Content ID (IMDB ID or IMDB:season:episode)
 * @param {Object} config - User configuration
 * @param {Function} searchFn - Function to execute the actual search
 * @returns {Promise<Array>} - Array of search results
 */
export async function getCachedTorrents(provider, type, id, config, searchFn) {
  if (!SqliteCache.isEnabled()) {
    return searchFn();
  }

  const langKey = (config.Languages || []).join(',');
  const providerKey = String(provider).toLowerCase().replace(/[^a-z0-9]/g, '');
  // For series, replace colons in id (like tt1234567:1:5) with underscores to maintain consistent cache key format
  const normalizedId = type === 'series' ? id.replace(/:/g, '_') : id;
  const cacheKey = `${providerKey}-search-${SEARCH_CACHE_VERSION}:${type}:${normalizedId}:${langKey}`;

  console.log(`[CACHE] Checking cache for ${provider} - ${type}:${id}`);

  // ONLY check Torz API for RealDebrid (fast, ~500ms)
  // For all other services, rely on SQLite cache + background refresh
  let torzResults = [];
  if (provider === 'RealDebrid' && config.IndexerScrapers?.includes('stremthru')) {
    try {
      const stremThru = await import('../../util/stremthru.js');
      const debridService = 'realdebrid';
      const apiKey = config.DebridApiKey || config.DebridServices?.find(s => s.provider === provider)?.apiKey;

      if (apiKey && stremThru.isEnabled()) {
        console.log(`[TORZ] Checking Torz API for RealDebrid - fresh confirmed cached results BEFORE SQLite cache...`);

        // Build stremId based on type
        let stremId, mediaType;
        if (type === 'series') {
          const [imdbId, season, episode] = id.split(':');
          if (season && episode) {
            stremId = `${imdbId}:${season}:${episode}`;
            mediaType = 'series';
          }
        } else if (type === 'movie') {
          stremId = id; // For movies, just use imdbId
          mediaType = 'movie';
        }

        if (stremId && mediaType) {
          const rawTorzResults = await stremThru.getCombinedTorrents(
            mediaType,
            stremId,
            debridService,
            apiKey,
            config
          );

          if (rawTorzResults && rawTorzResults.length > 0) {
            console.log(`[TORZ] API returned ${rawTorzResults.length} confirmed cached results`);
            // Convert Torz results to raw torrent format (remove url field, normalize field names)
            // This allows toStream() to generate proper /resolve/ URLs
            torzResults = rawTorzResults
              .filter(t => {
                // Filter out 0B results
                const size = t.Size || t.size || 0;
                return size > 0;
              })
              .map(t => {
                const torrentName = t.name || t.Title || 'Unknown';

                // Parse torrent title to extract season/episode info for series filtering
                const parsed = PTT.parse(torrentName) || {};

                const normalized = {
                  name: torrentName,
                  title: t.Title || t.name || 'Unknown',
                  hash: (t.InfoHash || t.hash || '').toLowerCase(),
                  infoHash: (t.InfoHash || t.hash || '').toLowerCase(),
                  size: t.Size || t.size || 0,
                  _size: t.Size || t.size || 0,
                  seeders: t.Seeders || 0,
                  tracker: t.Tracker || 'Torz',
                  isConfirmedCached: true,
                  isCached: true,
                  source: provider.toLowerCase(),
                  // Include parsed info for series episode filtering
                  info: {
                    season: parsed.season,
                    episode: parsed.episode,
                    seasons: parsed.seasons
                  }
                  // Explicitly NOT including url field so toStream() generates the proper resolve URL
                };
                return normalized;
              });

            const filteredCount = rawTorzResults.length - torzResults.length;
            if (filteredCount > 0) {
              console.log(`[TORZ] Filtered out ${filteredCount} results with 0B size`);
            }
            console.log(`[TORZ] Converted ${torzResults.length} Torz results to raw torrent format with parsed metadata`);
          } else {
            console.log(`[TORZ] API returned 0 results`);
          }
        }
      }
    } catch (torzError) {
      console.error(`[TORZ] Error checking Torz API: ${torzError.message}`);
      // Continue with cache check
    }
  }

  // Query SQLite for cached results matching the title/type/episode and debrid service
  const cached = await SqliteCache.getCachedRecord('search', cacheKey);
  let searchResults = [];
  let resultCount = 0;
  const minResultsRequired = MIN_RESULTS_PER_SERVICE;

  if (cached) {
    // Handle data structure from SQLite cache
    if (cached.data && typeof cached.data === 'object' && !Array.isArray(cached.data) && cached.data.data) {
      cached.data = cached.data.data;
    }

    if (Array.isArray(cached.data)) {
      searchResults = cached.data;
      resultCount = cached.data.length;
    } else if (cached.data && typeof cached.data === 'object' && Array.isArray(cached.data.data)) {
      searchResults = cached.data.data;
      resultCount = cached.data.resultCount || cached.data.data.length;
    } else {
      searchResults = cached.data || [];
      resultCount = searchResults.length;
    }

    const cacheAge = Date.now() - new Date(cached.updatedAt || cached.createdAt).getTime();
    const cacheAgeMinutes = Math.floor(cacheAge / 60000);
    console.log(`[CACHE] HIT: ${cacheKey} (${resultCount} non-personal results, age: ${cacheAgeMinutes}m)`);
  } else {
    console.log(`[CACHE] MISS: ${cacheKey} - no cached results found`);
  }

  if (providerKey === 'httpstreaming' && searchResults.length > 0) {
    const { cleanedResults, removedDuplicates, removedM3u8 } = sanitizeHttpStreamingCache(searchResults);
    if (removedDuplicates || removedM3u8) {
      console.log(`[CACHE] Cleaned HTTP streaming cache for ${cacheKey}: removed ${removedDuplicates} duplicate(s), dropped ${removedM3u8} stale m3u8 link(s)`);
      searchResults = cleanedResults;
      resultCount = cleanedResults.length;
      await storeCacheResults(null, cacheKey, cleanedResults, type, provider);
    }
  }

  // Combine Torz results with SQLite cache results
  // Deduplicate by hash (prefer Torz over SQLite cache)
  let combinedResults = [];
  const torzHashes = new Set(torzResults.map(r => (r.InfoHash || r.hash || '').toLowerCase()));

  // Add Torz results first (they are fresh and confirmed)
  combinedResults.push(...torzResults);

  // Add SQLite cache results that are not already in Torz results
  // For HTTP streaming: results don't have hash/infoHash, they use URLs instead
  // For debrid/torrent services: deduplicate by hash
  const uniqueCacheResults = searchResults.filter(r => {
    // For HTTP streaming services, always include cached results (no hash-based deduplication)
    if (provider === 'httpstreaming') {
      return true;
    }
    // For torrent/debrid services, require hash and deduplicate against Torz
    const hash = (r.hash || r.infoHash || '').toLowerCase();
    return hash && !torzHashes.has(hash);
  });
  combinedResults.push(...uniqueCacheResults);

  console.log(`[CACHE] Combined results: ${torzResults.length} from Torz + ${uniqueCacheResults.length} unique from SQLite = ${combinedResults.length} total`);

  // If there are NO cached results, do a full live scrape before returning.
  if (combinedResults.length === 0) {
    console.log(`[CACHE] No cached results for ${cacheKey} - performing full live scrape for ${provider}`);
    const prevForceFullScrape = config.ForceFullScrape;
    config.ForceFullScrape = true;
    try {
      const rawFreshResults = await searchFn();
      const freshResults = Array.isArray(rawFreshResults) ? rawFreshResults : [];
      const { merged } = mergeCacheResults([], freshResults, provider);

      if (freshResults.length > 0) {
        console.log(`[CACHE] Live scrape found ${freshResults.length} results, updating cache`);
        await storeCacheResults(null, cacheKey, merged, type, provider);
      } else {
        console.log(`[CACHE] Live scrape returned 0 results - NOT caching empty result to ensure future checks remain live`);
      }

      return attachCacheKey(merged, cacheKey);
    } finally {
      if (prevForceFullScrape === undefined) {
        delete config.ForceFullScrape;
      } else {
        config.ForceFullScrape = prevForceFullScrape;
      }
    }
  }

  // Deduplicate combined results before returning
  const seenKeys = new Set();
  const dedupedResults = combinedResults.filter(item => {
    const key = getCacheResultKey(item, provider);
    if (!key) return true;
    if (seenKeys.has(key)) return false;
    seenKeys.add(key);
    return true;
  });

  if (combinedResults.length !== dedupedResults.length) {
    console.log(`[CACHE] Deduplication on return: ${combinedResults.length} -> ${dedupedResults.length} results`);
  }

  console.log(`[CACHE] Returning ${dedupedResults.length} cached results immediately for ${cacheKey}`);

  // Trigger background refresh to update cache (don't await)
  refreshCacheInBackground(provider, type, id, config, searchFn, cacheKey, searchResults)
    .catch(err => console.error(`[CACHE] Background refresh error for ${cacheKey}:`, err.message));

  return attachCacheKey(dedupedResults, cacheKey);
}

/**
 * Store search results in cache
 * Filters out personal files and already-resolved streams before caching
 *
 * @param {*} collection - Unused (legacy parameter)
 * @param {string} cacheKey - Cache key for storage
 * @param {Array} results - Search results to cache
 * @param {string} type - Content type ('movie' or 'series')
 * @param {string} provider - Provider name
 */
export async function storeCacheResults(collection, cacheKey, results, type, provider) {
  // Allow empty results to update cache timestamp
  if (!results) return;

  const providerKey = String(provider || '').toLowerCase();

  // Filter out personal cloud files and stream objects unless the provider expects URL-based results.
  const filteredData = results.filter(item => {
    if (!item) return false; // Changed from true - null items shouldn't be cached
    if (item.isPersonal) return false;

    const allowUrlCache = allowsUrlCaching(provider);
    if (!allowUrlCache && typeof item.url === 'string' && item.url) {
      return !(item.url.startsWith('http') || item.url.startsWith('/resolve/'));
    }

    return true;
  });

  // Deduplicate before caching to prevent duplicate entries
  const seenKeys = new Set();
  const cacheableData = filteredData.filter(item => {
    const key = getCacheResultKey(item, provider);
    if (!key) return true; // Keep items without keys
    if (seenKeys.has(key)) {
      return false; // Skip duplicates
    }
    seenKeys.add(key);
    return true;
  });

  if (filteredData.length !== cacheableData.length) {
    console.log(`[CACHE] Deduplication: ${filteredData.length} -> ${cacheableData.length} items (removed ${filteredData.length - cacheableData.length} duplicates)`);
  }

  // Don't cache empty results - this ensures future requests will do live checks
  // and discover new content when it becomes available (e.g., new episodes)
  if (cacheableData.length === 0) {
    console.log(`[CACHE] Skipping cache write for ${cacheKey}: no results to cache`);
    return;
  }

  const ttlMinutes = type === 'series' ? SCRAPER_CACHE_TTL_SERIES_MIN : SCRAPER_CACHE_TTL_MOVIE_MIN;

  try {
    // Store search results using SQLite cache
    const success = await SqliteCache.upsertCachedMagnet({
      service: 'search',
      hash: cacheKey, // Use the full cache key as hash for lookup
      fileName: null,
      size: cacheableData.length, // Store result count
      data: {
        data: cacheableData, // Actual search results
        resultCount: cacheableData.length
      },
      releaseKey: `search-${type}` // Use releaseKey for categorization
    });

    if (success) {
      console.log(`[CACHE] STORED: ${cacheKey} (${cacheableData.length} results, TTL: ${ttlMinutes}m)`);
    } else {
      console.log(`[CACHE] FAILED to store ${cacheKey}: upsert failed`);
    }
  } catch (e) {
    console.error(`[CACHE] FAILED to store ${cacheKey}:`, e.message);
  }
}

/**
 * Verification functions for cached torrents
 * Logs torrents that need verification (actual verification happens on access)
 *
 * @param {string} apiKey - Debrid service API key
 * @param {string} provider - Provider name
 * @param {Array} cachedResults - Cached results to verify
 */
export async function verifyCachedTorrents(apiKey, provider, cachedResults) {
  if (!apiKey || !cachedResults || cachedResults.length === 0) return;

  console.log(`[VERIFICATION] Marking ${cachedResults.length} cached ${provider} torrents for verification (background process)`);

  // Instead of directly verifying here (which requires complex rate limiting setup),
  // we log that verification is needed. The actual verification typically happens
  // when torrents are accessed/resolved, leveraging the existing debrid service logic.
  try {
    const torrentsToVerify = cachedResults.filter(item => item.hash);
    console.log(`[VERIFICATION] ${provider}: ${torrentsToVerify.length} torrents have hashes for verification`);

    // In practice, when a cached torrent URL is resolved via the /resolve endpoint,
    // it will naturally verify availability in the debrid service
    // This can be enhanced later with more sophisticated verification as needed
  } catch (error) {
    console.error(`[VERIFICATION] Error noting ${provider} cached torrents for verification:`, error.message);
  }
}

/**
 * Refresh HTTP streaming links in background
 * Links are refreshed automatically when accessed via resolver endpoint
 *
 * @param {Array} cachedResults - Cached HTTP streaming results
 */
export async function refreshHttpStreamLinks(cachedResults) {
  if (!cachedResults || cachedResults.length === 0) return;

  console.log(`[VERIFICATION] Preparing to refresh ${cachedResults.length} HTTP stream links (background process)`);

  try {
    // HTTP streaming links are typically refreshed automatically when accessed
    // via the resolver endpoint, which fetches fresh URLs from the source
    const httpStreamingLinks = cachedResults.filter(item =>
      item.url && item.url.includes('/resolve/httpstreaming/')
    );

    console.log(`[VERIFICATION] ${httpStreamingLinks.length} HTTP streaming links will be refreshed on access`);
  } catch (error) {
    console.error('[VERIFICATION] Error noting HTTP stream links for refresh:', error.message);
  }
}
