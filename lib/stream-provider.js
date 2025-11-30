import { get4KHDHubStreams, getHDHub4uStreams, getMKVCinemasStreams, getMalluMvStreams, getCineDozeStreams, getVixSrcStreams, getMkvDramaStreams, getNetflixMirrorStreams, getXDMoviesStreams, getMoviesModStreams, getMoviesLeechStreams, getAnimeFlixStreams } from './http-streams.js';
import { resolveHttpStreamUrl } from './http-streams/resolvers/http-resolver.js';
import { getUHDMoviesStreams } from './uhdmovies.js';
import { getMoviesDriveStreams } from './moviesdrive.js';
import Cinemeta from './util/cinemeta.js';
import DebridLink from './debrid-link.js';
import RealDebrid from './real-debrid.js';
import RealDebridClient from 'real-debrid-api';
import RdLimiter from './util/rd-rate-limit.js';
import AllDebrid from './all-debrid.js';
import Premiumize from './premiumize.js';
import OffCloud from './offcloud.js';
import TorBox from './torbox.js';
import DebriderApp from './debrider.app.js';
import Usenet from './usenet.js';
import Easynews from './easynews.js';
import HomeMedia from './home-media.js';
import * as SqliteCache from './util/cache-store.js';
import { BadRequestError } from './util/error-codes.js';
import { FILE_TYPES } from './util/file-types.js';
import { filterSeason, filterEpisode, filterYear, matchesSeriesTitle, hasEpisodeMarker } from './util/filter-torrents.js';
import { getResolutionFromName, formatSize, getCodec, resolutionOrder, sizeToBytes, extractFileName } from './common/torrent-utils.js';
import PTT from './util/parse-torrent-title.js';
import { renderLanguageFlags, detectLanguagesFromTitle, filterStreamsByLanguage } from './util/language-mapping.js';
import sanitizeConfig, { sanitizeToken } from './util/config-sanitizer.js';
import { filterByEpisode, filterBySize, filterByResolution } from './stream-provider/utils/filtering.js';
import * as crypto from 'crypto';
import { HTTP_STREAMS_CACHE_TTL_DAYS } from './config.js';
import { withRealDebridMagnetLock } from './util/rd-magnet-lock.js';

const ADDON_HOST = process.env.ADDON_URL;

// Service timeout configuration (in milliseconds)
// Prevents slow services from blocking fast ones
const SERVICE_TIMEOUT_MS = parseInt(process.env.SERVICE_TIMEOUT_MS) || 15000; // 15 seconds default
// Give HTTP stream extractors more room; they often need multiple redirects and validations
const HTTP_STREAMING_TIMEOUT_MS = parseInt(process.env.HTTP_STREAMING_TIMEOUT_MS) || 8000; // 8 seconds default for HTTP streams
const MKVDRAMA_MAX_TIMEOUT_MS = parseInt(process.env.HTTP_STREAMING_TIMEOUT_MS_MKVDRAMA_MAX) || 120000;
const MOVIESDRIVE_MAX_TIMEOUT_MS = parseInt(process.env.HTTP_STREAMING_TIMEOUT_MS_MOVIESDRIVE_MAX) || 45000;
const USENET_TIMEOUT_MS = parseInt(process.env.USENET_TIMEOUT_MS) || 3000; // 3 seconds for Usenet

// Early return configuration - return results as soon as we have enough quality streams
// Default disables early return (set DISABLE_EARLY_RETURN=false to re-enable)
const EARLY_RETURN_ENABLED = process.env.DISABLE_EARLY_RETURN === 'false';
const EARLY_RETURN_TIMEOUT_MS = parseInt(process.env.EARLY_RETURN_TIMEOUT_MS) || 2500; // Return after 2.5s if we have results
const EARLY_RETURN_MIN_STREAMS = parseInt(process.env.EARLY_RETURN_MIN_STREAMS) || 1; // Minimum 1 stream to trigger early return
const MIN_RESULTS_PER_SERVICE = Math.max(
  1,
  parseInt(process.env.MIN_RESULTS_PER_SERVICE || process.env.EARLY_RETURN_MIN_STREAMS || '1', 10)
);

function parseEarlyReturnTimeout(value) {
  if (value == null || value === '') return null;
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed;
}

function parseEnvBoolean(value) {
  if (value == null || value === '') return null;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return null;
}

const MKVDRAMA_ASIAN_ONLY = parseEnvBoolean(process.env.MKVDRAMA_ASIAN_ONLY) ?? false;
const MKVDRAMA_ASIAN_HINTS = [
  'anime',
  'donghua',
  'kdrama',
  'jdrama',
  'cdrama',
  'bollywood',
  'tollywood',
  'kollywood',
  'mollywood',
  'japan',
  'japanese',
  'korea',
  'korean',
  'south korea',
  'china',
  'chinese',
  'taiwan',
  'taiwanese',
  'hong kong',
  'india',
  'indian',
  'pakistan',
  'pakistani',
  'bangladesh',
  'bangladeshi',
  'nepal',
  'nepali',
  'sri lanka',
  'sri lankan',
  'thailand',
  'thai',
  'vietnam',
  'vietnamese',
  'indonesia',
  'indonesian',
  'malaysia',
  'malaysian',
  'singapore',
  'singaporean',
  'philippines',
  'filipino',
  'myanmar',
  'burma',
  'cambodia',
  'khmer',
  'laos',
  'laotian',
  'mongolia',
  'mongolian'
];

// Common East/Southeast Asian surnames used as a low-cost fallback signal when
// Cinemeta lacks country/language tags but cast/crew names are present.
const MKVDRAMA_ASIAN_SURNAME_HINTS = new Set([
  // Korean
  'kim', 'lee', 'park', 'choi', 'jung', 'jeong', 'kang', 'cho', 'yoo', 'yoon', 'lim', 'shin', 'jang', 'han', 'song', 'moon', 'hwang', 'ahn', 'an', 'oh', 'seo', 'kwon', 'hong', 'bae', 'nam', 'won',
  // Chinese
  'li', 'wang', 'zhang', 'chen', 'liu', 'yang', 'huang', 'zhao', 'wu', 'zhou', 'xu', 'sun', 'ma', 'zhu', 'hu', 'guo', 'he', 'gao', 'lin', 'luo', 'xiao', 'deng', 'yuan', 'tan', 'ng', 'ong', 'teo', 'goh', 'lim',
  // Japanese
  'sato', 'suzuki', 'takahashi', 'tanaka', 'watanabe', 'ito', 'yamamoto', 'nakamura', 'kobayashi', 'kato', 'yoshida', 'yamada', 'sasaki', 'yamaguchi', 'matsumoto', 'inoue', 'kimura', 'hayashi', 'shimizu', 'yamazaki', 'mori', 'abe', 'ikeda', 'hashimoto', 'ishikawa',
  // Vietnamese
  'nguyen', 'tran', 'le', 'pham', 'huynh', 'hoang', 'phan', 'vu', 'vo', 'dang', 'bui', 'do'
]);

// Broad Asian script coverage (CJK, Hangul, Kana, Thai, Indic ranges commonly seen in titles).
const MKVDRAMA_ASIAN_SCRIPT_REGEX = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af\u0e00-\u0e7f\u0900-\u097f\u0980-\u09ff\u0a80-\u0aff\u0b80-\u0bff\u0c80-\u0cff\u0d00-\u0d7f]/;

function flattenMetaValue(value, output) {
  if (value == null) return;
  if (Array.isArray(value)) {
    for (const item of value) flattenMetaValue(item, output);
    return;
  }
  if (typeof value === 'object') {
    if (typeof value.name === 'string') output.push(value.name);
    if (typeof value.title === 'string') output.push(value.title);
    if (typeof value.character === 'string') output.push(value.character);
    if (typeof value.job === 'string') output.push(value.job);
    return;
  }
  if (typeof value === 'string' || typeof value === 'number') {
    output.push(String(value));
  }
}

function normalizeMetaText(value = '') {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractMkvDramaCreditNames(cinemetaDetails = {}) {
  const names = [];
  flattenMetaValue(cinemetaDetails.cast, names);
  flattenMetaValue(cinemetaDetails.director, names);
  flattenMetaValue(cinemetaDetails.credits_cast, names);
  flattenMetaValue(cinemetaDetails.credits_crew, names);
  return Array.from(new Set(
    names
      .map(name => String(name || '').trim())
      .filter(Boolean)
  ));
}

function looksLikeAsianCreditName(name = '') {
  if (!name) return false;
  if (MKVDRAMA_ASIAN_SCRIPT_REGEX.test(String(name))) return true;
  const normalized = normalizeMetaText(name);
  if (!normalized) return false;
  const tokens = normalized.split(/[\s-]+/).filter(Boolean);
  return tokens.some(token => MKVDRAMA_ASIAN_SURNAME_HINTS.has(token));
}

function hasAsianScriptSignals(cinemetaDetails = {}) {
  const values = [];
  flattenMetaValue(cinemetaDetails.name, values);
  flattenMetaValue(cinemetaDetails.description, values);
  flattenMetaValue(cinemetaDetails.alternativeTitles, values);
  flattenMetaValue(cinemetaDetails.cast, values);
  flattenMetaValue(cinemetaDetails.director, values);
  return values.some(value => MKVDRAMA_ASIAN_SCRIPT_REGEX.test(String(value || '')));
}

function hasLikelyAsianCredits(cinemetaDetails = {}) {
  const names = extractMkvDramaCreditNames(cinemetaDetails);
  let hits = 0;
  for (const name of names) {
    if (looksLikeAsianCreditName(name)) {
      hits += 1;
      if (hits >= 2) return true;
    }
  }
  return false;
}

function buildMkvDramaMetaHaystack(cinemetaDetails) {
  if (!cinemetaDetails || typeof cinemetaDetails !== 'object') return '';
  const parts = [];
  flattenMetaValue(cinemetaDetails.name, parts);
  flattenMetaValue(cinemetaDetails.description, parts);
  flattenMetaValue(cinemetaDetails.country, parts);
  flattenMetaValue(cinemetaDetails.countries, parts);
  flattenMetaValue(cinemetaDetails.genre, parts);
  flattenMetaValue(cinemetaDetails.genres, parts);
  flattenMetaValue(cinemetaDetails.cast, parts);
  flattenMetaValue(cinemetaDetails.alternativeTitles, parts);
  return parts.join(' ').toLowerCase();
}

function shouldUseMkvDramaForTitle(cinemetaDetails) {
  if (!MKVDRAMA_ASIAN_ONLY) return true;
  // When Cinemeta has no data, let MKVDrama try — its own search will naturally
  // filter non-Asian content (it's an Asian drama site).
  if (!cinemetaDetails || !cinemetaDetails.name) return true;
  const haystack = buildMkvDramaMetaHaystack(cinemetaDetails);
  if (!haystack) return false;
  if (MKVDRAMA_ASIAN_HINTS.some(hint => haystack.includes(hint))) return true;
  if (hasAsianScriptSignals(cinemetaDetails)) return true;
  if (hasLikelyAsianCredits(cinemetaDetails)) return true;
  return false;
}

function getProviderEnvKey(provider) {
  return String(provider || '')
    .trim()
    .replace(/[^a-z0-9]+/gi, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
}

function parseTimeoutOverride(value) {
  if (value == null || value === '') return null;
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

function getHttpStreamingTimeout(serviceName) {
  const providerKey = getProviderEnvKey(serviceName);
  const override = providerKey
    ? parseTimeoutOverride(
      process.env[`HTTP_STREAMING_TIMEOUT_MS_${providerKey}`]
        ?? process.env[`HTTP_STREAMING_TIMEOUT_${providerKey}`]
    )
    : null;

  if (providerKey === 'MKVDRAMA') {
    const requestedTimeout = override ?? Math.max(HTTP_STREAMING_TIMEOUT_MS, 90000);
    // Protect request latency from extreme per-provider overrides under load.
    return Math.min(Math.max(requestedTimeout, 60000), MKVDRAMA_MAX_TIMEOUT_MS);
  }

  if (providerKey === 'MOVIESDRIVE') {
    const requestedTimeout = override ?? Math.max(HTTP_STREAMING_TIMEOUT_MS, 15000);
    // MoviesDrive often needs extra time for domain fallback + page extraction.
    return Math.min(Math.max(requestedTimeout, 10000), MOVIESDRIVE_MAX_TIMEOUT_MS);
  }

  if (override !== null) {
    return override;
  }

  // MKVCinemas may need FlareSolverr fallback for JS challenge pages
  if (providerKey === 'MKVCINEMAS') {
    return Math.max(HTTP_STREAMING_TIMEOUT_MS, 30000);
  }

  if (providerKey === 'NETFLIXMIRROR') {
    return Math.max(HTTP_STREAMING_TIMEOUT_MS, 15000);
  }

  return HTTP_STREAMING_TIMEOUT_MS;
}

function getServiceEarlyReturnConfig(service) {
  if (!service || typeof service !== 'object') {
    return { disableEarlyReturn: false, earlyReturnTimeoutMs: null };
  }

  let disableEarlyReturn = null;
  if (typeof service.disableEarlyReturn === 'boolean') {
    disableEarlyReturn = service.disableEarlyReturn;
  } else if (typeof service.earlyReturn === 'boolean') {
    disableEarlyReturn = !service.earlyReturn;
  } else if (typeof service.earlyReturnEnabled === 'boolean') {
    disableEarlyReturn = !service.earlyReturnEnabled;
  }

  const serviceTimeoutValue = service.earlyReturnTimeoutMs ?? service.earlyReturnTimeout ?? service.earlyReturnWaitMs;
  let earlyReturnTimeoutMs = parseEarlyReturnTimeout(serviceTimeoutValue);

  const providerKey = getProviderEnvKey(service.provider);
  if (providerKey) {
    if (disableEarlyReturn === null) {
      const envDisable = parseEnvBoolean(process.env[`EARLY_RETURN_DISABLE_${providerKey}`])
        ?? parseEnvBoolean(process.env[`DISABLE_EARLY_RETURN_${providerKey}`]);
      if (envDisable !== null) {
        disableEarlyReturn = envDisable;
      }
    }

    if (earlyReturnTimeoutMs === null) {
      const envTimeout = parseEarlyReturnTimeout(
        process.env[`EARLY_RETURN_TIMEOUT_MS_${providerKey}`]
          ?? process.env[`EARLY_RETURN_TIMEOUT_${providerKey}`]
          ?? process.env[`EARLY_RETURN_WAIT_MS_${providerKey}`]
      );
      if (envTimeout !== null) {
        earlyReturnTimeoutMs = envTimeout;
      }
    }
  }

  return {
    disableEarlyReturn: disableEarlyReturn === null ? false : disableEarlyReturn,
    earlyReturnTimeoutMs
  };
}
const BACKGROUND_REFRESH_BASE_DELAY_MS = parseInt(process.env.BACKGROUND_REFRESH_BASE_DELAY_MS || '2000', 10);
const BACKGROUND_REFRESH_MAX_DELAY_MS = parseInt(process.env.BACKGROUND_REFRESH_MAX_DELAY_MS || '30000', 10);
const BACKGROUND_REFRESH_JITTER_MS = parseInt(process.env.BACKGROUND_REFRESH_JITTER_MS || '500', 10);

// Cache version for search results - increment to invalidate all search caches
// This should be bumped when the format of cached results changes or when
// the underlying scrapers (4KHDHub, UHDMovies, etc.) are significantly updated
const SEARCH_CACHE_VERSION = 'v2';

// Minimum results per quality tier to consider cache "sufficient"
const TIER_FULFILLMENT_REQUIREMENTS = {
  '2160p': 2,  // At least 2 4K results
  '1080p': 2,  // At least 2 1080p results
  '720p': 1    // At least 1 720p result
};

// ---------------------------------------------------------------------------------
// Service Timeout Wrapper
// ---------------------------------------------------------------------------------
/**
 * Wraps a promise with a timeout to prevent slow services from blocking fast ones
 * @param {Promise} promise - The promise to wrap
 * @param {number} timeoutMs - Timeout in milliseconds
 * @param {string} serviceName - Name of the service (for logging)
 * @returns {Promise} - Promise that resolves/rejects with timeout
 */
function withTimeout(promise, timeoutMs, serviceName = 'service') {
  let timerId;
  const timeoutPromise = new Promise((_, reject) => {
    timerId = setTimeout(() => {
      reject(new Error(`${serviceName} timeout after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  return Promise.race([promise, timeoutPromise])
    .then(result => {
      clearTimeout(timerId);
      return result;
    })
    .catch(err => {
      clearTimeout(timerId);
      if (err.message.includes('timeout')) {
        console.warn(`[TIMEOUT] ${serviceName} exceeded ${timeoutMs}ms - returning empty results`);
      } else {
        console.error(`[ERROR] ${serviceName} failed:`, err.message);
      }
      return []; // Return empty array on timeout or error
    });
}

function hashToken(token) {
  if (!token) return 'no-key';
  return crypto.createHash('sha256').update(String(token)).digest('hex').slice(0, 12);
}

function buildDedupUserKey(config) {
  const parts = [];

  if (config?.DebridApiKey) parts.push(`debrid:${hashToken(config.DebridApiKey)}`);
  if (config?.DebridLinkApiKey) parts.push(`debridlink:${hashToken(config.DebridLinkApiKey)}`);
  if (config?.EasynewsUsername) parts.push(`easynews:${hashToken(config.EasynewsUsername)}`);
  if (config?.HomeMediaApiKey) parts.push(`homemedia:${hashToken(config.HomeMediaApiKey)}`);
  if (config?.NewznabApiKey) parts.push(`newznab:${hashToken(config.NewznabApiKey)}`);
  if (config?.SabnzbdApiKey) parts.push(`sabnzbd:${hashToken(config.SabnzbdApiKey)}`);

  if (Array.isArray(config?.DebridServices)) {
    const serviceKeys = config.DebridServices.map(service => {
      if (!service || typeof service !== 'object') return null;
      const provider = String(service.provider || 'unknown').toLowerCase();
      let identity = '';
      if (provider === 'easynews') {
        identity = service.username || '';
      } else if (provider === 'usenet') {
        identity = service.newznabApiKey || service.apiKey || service.sabnzbdApiKey || '';
      } else if (provider === 'homemedia') {
        identity = service.homeMediaApiKey || service.apiKey || '';
      } else {
        identity = service.apiKey || '';
      }
      return `${provider}:${hashToken(identity)}`;
    }).filter(Boolean);
    serviceKeys.sort();
    parts.push(...serviceKeys);
  }

  const uniqueParts = Array.from(new Set(parts));
  return uniqueParts.length ? uniqueParts.join('|') : 'anon';
}

// ---------------------------------------------------------------------------------
// In-Flight Request Deduplication
// ---------------------------------------------------------------------------------
// Track in-flight requests to prevent duplicate concurrent searches
// Key format: "provider:type:id:lang1,lang2"
const inFlightRequests = new Map();
const resolveInFlight = new Map();
const resolveCache = new Map();
const resolveFailCache = new Map();
const RESOLVE_CACHE_TTL_MS = parseInt(process.env.RESOLVE_CACHE_TTL_MS || '300000', 10); // 5 minutes
const RESOLVE_FAIL_TTL_MS = parseInt(process.env.RESOLVE_FAIL_TTL_MS || '30000', 10); // 30 seconds
const backgroundRefreshState = new Map();

function getCacheStats() {
  return {
    inFlightRequests: inFlightRequests.size,
    resolveInFlight: resolveInFlight.size,
    resolveCache: resolveCache.size,
    resolveFailCache: resolveFailCache.size,
    resolveCacheTtlMs: RESOLVE_CACHE_TTL_MS,
    resolveFailTtlMs: RESOLVE_FAIL_TTL_MS
  };
}

function clearInternalCaches(reason = 'manual') {
  const stats = getCacheStats();
  resolveCache.clear();
  resolveFailCache.clear();
  console.error(`[CACHE] Cleared resolve caches due to ${reason}`);
  return stats;
}

/**
 * Get or create a request promise for deduplication
 * If an identical request is already in flight, return its promise
 * Otherwise, execute the request and cache the promise
 */
async function dedupedRequest(key, requestFn) {
  // Check if this exact request is already in flight
  if (inFlightRequests.has(key)) {
    console.log(`[DEDUP] Reusing in-flight request: ${key}`);
    return inFlightRequests.get(key);
  }

  // Start new request
  const promise = requestFn().finally(() => {
    // Clean up after request completes (success or failure)
    inFlightRequests.delete(key);
  });

  // Cache the promise
  inFlightRequests.set(key, promise);
  return promise;
}

function extractMagnetHash(url = '') {
  if (typeof url !== 'string') return null;
  const match = url.match(/btih:([a-fA-F0-9]+)/i);
  return match ? match[1].toLowerCase() : null;
}

function normalizeClientIp(clientIp) {
  if (!clientIp) return '';
  const ip = String(clientIp).trim();
  if (!ip) return '';
  return ip.split(',')[0].trim();
}

function buildResolveCacheKey(provider, apiKey, hostUrl, clientIp = '') {
  const hash = extractMagnetHash(hostUrl);
  const apiKeyHash = hashToken(apiKey || 'no-key');
  const ipHash = hashToken(normalizeClientIp(clientIp) || 'no-ip');
  return `${provider}:${hash || hostUrl}:${apiKeyHash}:${ipHash}`;
}

const RD_TORRENTS_PAGE_SIZE = 100;
const RD_EXISTING_TORRENT_SCAN_PAGES = Math.max(
  1,
  Number.parseInt(process.env.RD_EXISTING_TORRENT_SCAN_PAGES || '200', 10) || 200
);

async function findExistingRdTorrentIdByHash(RD, rdCall, magnetHash, blockedStatuses) {
  if (!magnetHash) return null;

  for (let page = 1; page <= RD_EXISTING_TORRENT_SCAN_PAGES; page++) {
    const torrentsResponse = await rdCall(() => RD.torrents.get(0, page, RD_TORRENTS_PAGE_SIZE));
    const torrentsList = Array.isArray(torrentsResponse?.data) ? torrentsResponse.data : [];
    const existing = torrentsList.find(t => {
      const existingHash = String(t?.hash || '').toLowerCase();
      const existingStatus = String(t?.status || '').toLowerCase();
      return existingHash === magnetHash && !blockedStatuses.has(existingStatus);
    });
    if (existing?.id) return existing.id;
    if (torrentsList.length < RD_TORRENTS_PAGE_SIZE) break;
  }

  return null;
}

function getResolveCache(cacheKey) {
  const cached = resolveCache.get(cacheKey);
  if (cached && (Date.now() - cached.ts) < RESOLVE_CACHE_TTL_MS) {
    return { status: 'success', value: cached.value };
  }
  if (cached) resolveCache.delete(cacheKey);

  const failTs = resolveFailCache.get(cacheKey);
  if (failTs && (Date.now() - failTs) < RESOLVE_FAIL_TTL_MS) {
    return { status: 'fail', value: null };
  }
  if (failTs) resolveFailCache.delete(cacheKey);

  return { status: 'miss' };
}

function storeResolveCache(cacheKey, value) {
  if (value) {
    resolveCache.set(cacheKey, { value, ts: Date.now() });
  } else {
    resolveFailCache.set(cacheKey, Date.now());
  }
}

function scheduleBackgroundRefresh({ provider, type, id, config, searchFn, cacheKey, existingResults, reason }) {
  const now = Date.now();
  const state = backgroundRefreshState.get(cacheKey) || {
    inFlight: false,
    failures: 0,
    nextAllowedAt: 0
  };

  if (state.inFlight) {
    console.log(`[CACHE] Background refresh already in flight for ${cacheKey}`);
    return;
  }

  if (now < state.nextAllowedAt) {
    const waitMs = state.nextAllowedAt - now;
    console.log(`[CACHE] Background refresh throttled for ${cacheKey} (${waitMs}ms remaining)`);
    return;
  }

  const baseDelay = Math.min(
    BACKGROUND_REFRESH_MAX_DELAY_MS,
    BACKGROUND_REFRESH_BASE_DELAY_MS * Math.pow(2, Math.max(0, state.failures))
  );
  const jitter = BACKGROUND_REFRESH_JITTER_MS > 0
    ? Math.floor(Math.random() * BACKGROUND_REFRESH_JITTER_MS)
    : 0;
  const delay = baseDelay + jitter;

  state.inFlight = true;
  state.nextAllowedAt = now + baseDelay;
  backgroundRefreshState.set(cacheKey, state);

  console.log(`[CACHE] Scheduling background refresh for ${cacheKey} in ${delay}ms (${reason})`);

  setTimeout(async () => {
    let refreshCount = 0;
    try {
      refreshCount = await refreshCacheInBackground(
        provider,
        type,
        id,
        config,
        searchFn,
        cacheKey,
        existingResults
      );
    } catch (err) {
      console.error(`[CACHE] Background refresh failed for ${cacheKey}:`, err.message);
      refreshCount = 0;
    } finally {
      if (refreshCount > 0) {
        state.failures = 0;
      } else {
        state.failures = Math.min(state.failures + 1, 6);
      }
      state.nextAllowedAt = Date.now() + Math.min(
        BACKGROUND_REFRESH_MAX_DELAY_MS,
        BACKGROUND_REFRESH_BASE_DELAY_MS * Math.pow(2, Math.max(0, state.failures))
      );
      state.inFlight = false;
      backgroundRefreshState.set(cacheKey, state);
    }
  }, delay);
}

/**
 * Wrap HTTP streaming URLs with the resolver endpoint for lazy resolution
 * @param {Array} streams - Array of stream objects from HTTP sources
 * @returns {Array} - Streams with URLs wrapped in resolver endpoint
 */
function wrapHttpStreamsWithResolver(streams, host) {
  const base = (host && host.startsWith('http')) ? host : (ADDON_HOST || '');

  console.log(`[wrapHttpStreamsWithResolver] Processing ${streams?.length || 0} streams`);

  if (!streams || !Array.isArray(streams)) {
    console.log(`[wrapHttpStreamsWithResolver] Invalid streams input:`, streams);
    return [];
  }

  const result = streams.map(stream => {
    const normalizedStream = {
      ...stream,
      httpProvider: stream?.httpProvider || stream?.provider || 'httpstreaming',
      provider: 'httpstreaming'
    };

    const resolverMarker = '/resolve/httpstreaming/';
    const isAlreadyWrapped = typeof normalizedStream.url === 'string'
      && normalizedStream.url.includes(resolverMarker);

    // Cached items can contain resolver URLs from an old addon host.
    // Rebase them to the current host so stale cache entries stay playable.
    if (isAlreadyWrapped && base && base.startsWith('http') && !normalizedStream.url.startsWith(base)) {
      const markerIndex = normalizedStream.url.indexOf(resolverMarker);
      if (markerIndex !== -1) {
        const resolverSuffix = normalizedStream.url.slice(markerIndex);
        return {
          ...normalizedStream,
          url: `${base}${resolverSuffix}`
        };
      }
    }

    // Some older cached HTTP streams may miss `needsResolution`; auto-wrap those too.
    const shouldWrapHttpStream = Boolean(
      normalizedStream.url
      && !isAlreadyWrapped
      && (normalizedStream.needsResolution || normalizedStream.provider === 'httpstreaming')
    );

    // Check if this stream needs lazy resolution
    if (shouldWrapHttpStream) {
      const encodedUrl = encodeURIComponent(normalizedStream.url);
      if (base && base.startsWith('http')) {
        const resolverUrl = `${base}/resolve/httpstreaming/${encodedUrl}`;
        return {
          ...normalizedStream,
          url: resolverUrl,
          needsResolution: undefined, // Remove the flag
          resolverFallbackUrl: undefined
        };
      }

      if (normalizedStream.resolverFallbackUrl) {
        console.warn('[wrapHttpStreamsWithResolver] Missing addon host - using direct fallback URL');
        return {
          ...normalizedStream,
          url: normalizedStream.resolverFallbackUrl,
          needsResolution: undefined,
          resolverFallbackUrl: undefined
        };
      }

      console.warn('[wrapHttpStreamsWithResolver] Missing addon host and fallback URL - leaving stream untouched');
      return normalizedStream;
    }

    return normalizedStream;
  });

  console.log(`[wrapHttpStreamsWithResolver] Returning ${result.length} streams`);
  return result;
}

/**
 * Fire-and-forget background pre-resolution of HTTP stream resolver links.
 * Populates the resolution cache so the user's click is instant.
 * @param {Array} streams - Wrapped streams with resolver URLs
 * @param {string} provider - Provider name for logging
 */
function backgroundPreResolve(streams, provider) {
  if (!streams?.length) return;
  const resolvable = streams.filter(s =>
    s?.url && s.url.includes('/resolve/httpstreaming/')
  );
  if (!resolvable.length) return;

  for (const stream of resolvable) {
    try {
      const match = stream.url.match(/\/resolve\/httpstreaming\/(.+)$/);
      if (!match) continue;
      const encodedUrl = match[1];
      resolveHttpStreamUrl(encodedUrl).catch(() => {});
    } catch {}
  }
  console.log(`[PRE-RESOLVE] Background pre-resolving ${resolvable.length} ${provider} links`);
}

export const STREAM_NAME_MAP = {
  debridlink: "[DL+] Sootio",
  realdebrid: "[RD+] Sootio",
  alldebrid: "[AD+] Sootio",
  premiumize: "[PM+] Sootio",
  torbox: "[TB+] Sootio",
  offcloud: "[OC+] Sootio",
  debriderapp: "[DBA+] Sootio",
  personalcloud: "[PC+] Sootio",
  usenet: "[UN+] Sootio",
  easynews: "[EN+] Sootio",
  homemedia: "[HM+] Sootio",
  httpstreaming: "[HS+] Sootio"
};

// DEPRECATED: Old LANG_FLAGS mapping - now using centralized language-mapping.js
// Kept for reference only - renderLangFlags is now imported from language-mapping.js

function isValidUrl(url) {
  return url &&
    typeof url === 'string' &&
    url !== 'undefined' &&
    url !== 'null' &&
    url.length > 0 &&
    (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('magnet:') || url.startsWith('/resolve/') || url.startsWith('/torbox/') || url.startsWith('realdebrid:') || url.startsWith('nzb:'));
}

function isVideo(filename) {
  if (!filename || typeof filename !== 'string') return false;
  const exts = ['.mp4','.mkv','.avi','.mov','.wmv','.flv','.webm','.m4v','.mpg','.mpeg','.3gp','.ogv','.ts','.m2ts'];
  const i = filename.toLowerCase().lastIndexOf('.');
  if (i < 0) return false;
  return exts.includes(filename.toLowerCase().substring(i));
}

function sortTorrents(a, b) {
  const nameA = a.name || a.title || '';
  const nameB = b.name || b.title || '';
  const resA = getResolutionFromName(nameA);
  const resB = getResolutionFromName(nameB);
  const rankA = resolutionOrder[resA] || 0;
  const rankB = resolutionOrder[resB] || 0;
  if (rankA !== rankB) return rankB - rankA;
  const sizeA = a.size || 0;
  const sizeB = b.size || 0;
  return sizeB - sizeA;
}

const SCRAPER_CACHE_TTL_SERIES_MIN = process.env.SCRAPER_CACHE_TTL_SERIES_MIN || 43200; // 30 days in minutes
const SCRAPER_CACHE_TTL_MOVIE_MIN = process.env.SCRAPER_CACHE_TTL_MOVIE_MIN || 43200; // 30 days in minutes





/**
 * Check if cached results have sufficient quality tier coverage
 * Returns true if cache has enough results across different quality tiers
 * @param {Array} results - Cached results to check
 * @returns {boolean} - True if tier requirements are met
 */
function hasSufficientTierFulfillment(results) {
  if (!results || results.length === 0) return false;

  // Count results by resolution
  const tierCounts = {
    '2160p': 0,
    '1080p': 0,
    '720p': 0
  };

  for (const result of results) {
    const resolution = getResolutionFromName(result.name || result.title || '');
    if (tierCounts.hasOwnProperty(resolution)) {
      tierCounts[resolution]++;
    }
  }

  // Check if each tier meets minimum requirements
  const has4K = tierCounts['2160p'] >= TIER_FULFILLMENT_REQUIREMENTS['2160p'];
  const has1080p = tierCounts['1080p'] >= TIER_FULFILLMENT_REQUIREMENTS['1080p'];
  const has720p = tierCounts['720p'] >= TIER_FULFILLMENT_REQUIREMENTS['720p'];

  // Consider cache sufficient if we have good 4K OR 1080p coverage
  const hasGoodCoverage = has4K || has1080p;

  console.log(`[CACHE TIER CHECK] 4K: ${tierCounts['2160p']}/${TIER_FULFILLMENT_REQUIREMENTS['2160p']}, 1080p: ${tierCounts['1080p']}/${TIER_FULFILLMENT_REQUIREMENTS['1080p']}, 720p: ${tierCounts['720p']}/${TIER_FULFILLMENT_REQUIREMENTS['720p']} → ${hasGoodCoverage ? 'SUFFICIENT ✓' : 'INSUFFICIENT ✗'}`);

  return hasGoodCoverage;
}

/**
 * New caching flow that returns cached results immediately and refreshes in background.
 * This function checks SQLite for cached results first, returns them immediately,
 * and then runs a background task to refresh with fresh data.
 */
function mergePersonalResults(personalResults, baseResults) {
  if (!Array.isArray(personalResults) || personalResults.length === 0) return baseResults;

  const merged = [];
  const seen = new Set();

  personalResults.forEach(item => {
    const hash = (item.hash || item.InfoHash || item.infoHash || '').toLowerCase();
    if (hash) seen.add(hash);
    merged.push(item);
  });

  baseResults.forEach(item => {
    const hash = (item.hash || item.InfoHash || item.infoHash || '').toLowerCase();
    if (hash && seen.has(hash)) return;
    merged.push(item);
  });

  return merged;
}

async function fetchTorzResults(provider, type, id, config) {
  if (provider !== 'RealDebrid' || !config.IndexerScrapers?.includes('stremthru')) {
    return [];
  }

  try {
    const stremThru = await import('./util/stremthru.js');
    const debridService = 'realdebrid';
    const apiKey = config.DebridApiKey || config.DebridServices?.find(s => s.provider === provider)?.apiKey;

    if (!apiKey || !stremThru.isEnabled()) return [];

    console.log(`[TORZ] Checking Torz API for RealDebrid - confirmed cached results`);

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

    if (!stremId || !mediaType) return [];

    const rawTorzResults = await stremThru.getCombinedTorrents(
      mediaType,
      stremId,
      debridService,
      apiKey,
      config
    );

    if (!rawTorzResults || rawTorzResults.length === 0) {
      console.log(`[TORZ] API returned 0 results`);
      return [];
    }

    console.log(`[TORZ] API returned ${rawTorzResults.length} confirmed cached results`);

    const torzResults = rawTorzResults
      .filter(t => {
        // Filter out 0B results
        const size = t.Size || t.size || 0;
        return size > 0;
      })
      .map(t => {
        const torrentName = t.name || t.Title || 'Unknown';

        // Parse torrent title to extract season/episode info for series filtering
        const parsed = PTT.parse(torrentName) || {};

        return {
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
      });

    const filteredCount = rawTorzResults.length - torzResults.length;
    if (filteredCount > 0) {
      console.log(`[TORZ] Filtered out ${filteredCount} results with 0B size`);
    }
    console.log(`[TORZ] Converted ${torzResults.length} Torz results to raw torrent format with parsed metadata`);
    return torzResults;
  } catch (torzError) {
    console.error(`[TORZ] Error checking Torz API: ${torzError.message}`);
    return [];
  }
}

function isM3U8Url(url) {
  return typeof url === 'string' && /\.m3u8(\?|$)/i.test(url);
}

function doubleEncodeHttpStreamingResolver(url) {
  if (!url || typeof url !== 'string') return url;
  const marker = '/resolve/httpstreaming/';
  const index = url.indexOf(marker);
  if (index === -1) return url;

  const prefix = url.slice(0, index + marker.length);
  let rest = url.slice(index + marker.length);
  let query = '';

  const queryIndex = rest.indexOf('?');
  if (queryIndex !== -1) {
    query = rest.slice(queryIndex);
    rest = rest.slice(0, queryIndex);
  }

  if (rest.includes('%25')) {
    return url;
  }

  return `${prefix}${encodeURIComponent(rest)}${query}`;
}

/**
 * Apply proxy wrapping to streams from HTTP streaming and Easynews providers
 * @param {Array} streams - Array of stream objects
 * @param {Object} config - Config object containing DebridServices with proxy settings
 * @returns {Array} Streams with proxy URLs applied where configured
 */
// Cross-provider deduplication: remove non-personal streams whose hash matches a personal stream
function deduplicatePersonalStreams(streams) {
  if (!streams || streams.length === 0) return streams;
  const personalHashes = new Set();
  for (const s of streams) {
    if (s.isPersonal && s._hash) {
      personalHashes.add(s._hash);
    }
  }
  if (personalHashes.size === 0) return streams;
  const before = streams.length;
  const deduped = streams.filter(s => s.isPersonal || !s._hash || !personalHashes.has(s._hash));
  if (deduped.length < before) {
    console.log(`[DEDUP] Removed ${before - deduped.length} external streams that duplicate personal cloud items`);
  }
  return deduped;
}

function applyProxyToStreams(streams, config) {
  if (!streams || !Array.isArray(streams) || streams.length === 0) {
    return streams;
  }

  // Get proxy config for httpstreaming and easynews from DebridServices
  const services = config.DebridServices || [];
  const httpStreamingService = services.find(s => s.provider === 'httpstreaming');
  const easynewsService = services.find(s => s.provider === 'Easynews');

  const httpProxyEnabled = httpStreamingService?.enableProxy && httpStreamingService?.proxyUrl;
  const easynewsProxyEnabled = easynewsService?.enableProxy && easynewsService?.proxyUrl;

  // If neither has proxy enabled, return streams unchanged
  if (!httpProxyEnabled && !easynewsProxyEnabled) {
    return streams;
  }

  let proxyCount = 0;

  const result = streams.map(stream => {
    if (!stream.url) return stream;

    const streamProvider = stream.provider?.toLowerCase();
    let proxyUrl = null;
    let proxyPassword = '';
    let targetUrl = stream.url;

    // Check if this stream should be proxied
    if (streamProvider === 'httpstreaming' && httpProxyEnabled) {
      proxyUrl = httpStreamingService.proxyUrl.replace(/\/+$/, '');
      proxyPassword = httpStreamingService.proxyPassword || '';
      targetUrl = doubleEncodeHttpStreamingResolver(targetUrl);
    } else if (streamProvider === 'easynews' && easynewsProxyEnabled) {
      proxyUrl = easynewsService.proxyUrl.replace(/\/+$/, '');
      proxyPassword = easynewsService.proxyPassword || '';
    }

    if (!proxyUrl) {
      return stream;
    }

    // Wrap the stream URL with proxy
    const proxyParams = new URLSearchParams();
    proxyParams.set('d', targetUrl);
    if (proxyPassword) {
      proxyParams.set('api_password', proxyPassword);
    }

    const proxiedUrl = `${proxyUrl}/proxy/stream?${proxyParams.toString()}`;
    proxyCount++;

    return {
      ...stream,
      url: proxiedUrl,
      title: stream.title + '\n🔒 Proxy',
      _originalUrl: stream.url // Keep original URL for debugging
    };
  });

  if (proxyCount > 0) {
    console.log(`[PROXY] Applied proxy to ${proxyCount} HTTP streaming/Easynews streams`);
  }

  return result;
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
    // Skip items without a URL — these are error/info streams that should not be cached
    if (!url) continue;

    const key = normalizeHttpStreamingUrl(url);

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
  if (providerKey === 'httpstreaming' && item.url) {
    const normalizedUrl = normalizeHttpStreamingUrl(item.url);
    return normalizedUrl ? `url:${normalizedUrl}` : null;
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
    if (allowOverwrite) {
      merged[indexByKey.get(key)] = item;
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

function inferSearchReleaseKey(cacheKey) {
  if (!cacheKey) return 'search-unknown';
  const parts = String(cacheKey).split(':');
  const type = parts.length > 1 ? parts[1] : 'unknown';
  return `search-${type}`;
}

async function removeCachedSearchResult(cacheKey, hash) {
  if (!SqliteCache.isEnabled() || !cacheKey || !hash) return false;

  try {
    const cached = await SqliteCache.getCachedRecord('search', cacheKey);
    if (!cached) return false;

    let cachedData = cached.data;
    if (cachedData && typeof cachedData === 'object' && !Array.isArray(cachedData) && cachedData.data) {
      cachedData = cachedData.data;
    }
    const items = Array.isArray(cachedData) ? cachedData : [];
    const normalizedHash = String(hash).toLowerCase();

    const filtered = items.filter(item => {
      const itemHash = (item?.hash || item?.infoHash || item?.InfoHash || '').toLowerCase();
      return itemHash !== normalizedHash;
    });

    if (filtered.length === items.length) return false;

    const releaseKey = cached.releaseKey || inferSearchReleaseKey(cacheKey);
    await SqliteCache.upsertCachedMagnet({
      service: 'search',
      hash: cacheKey,
      fileName: null,
      size: filtered.length,
      data: {
        data: filtered,
        resultCount: filtered.length
      },
      releaseKey
    });

    console.log(`[CACHE] Removed uncached result ${normalizedHash} from ${cacheKey} (${items.length} -> ${filtered.length})`);
    return true;
  } catch (error) {
    console.error(`[CACHE] Failed to remove cached result from ${cacheKey}: ${error.message}`);
    return false;
  }
}

async function getCachedTorrents(provider, type, id, config, searchFn, personalFetchFn = null) {
  if (!SqliteCache.isEnabled()) {
    return searchFn();
  }

  const langKey = (config.Languages || []).join(',');
  const providerKey = String(provider).toLowerCase().replace(/[^a-z0-9]/g, '');
  // For series, replace colons in id (like tt1234567:1:5) with underscores to maintain consistent cache key format
  const normalizedId = type === 'series' ? id.replace(/:/g, '_') : id;
  const cacheKey = `${providerKey}-search-${SEARCH_CACHE_VERSION}:${type}:${normalizedId}:${langKey}`;

  console.log(`[CACHE] Checking cache for ${provider} - ${type}:${id}`);

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
    if (resultCount === 0) {
      console.log(`[CACHE] MISS: ${cacheKey} (cached empty result, age: ${cacheAgeMinutes}m)`);
      searchResults = [];
      resultCount = 0;
    } else {
      console.log(`[CACHE] HIT: ${cacheKey} (${resultCount} non-personal results, age: ${cacheAgeMinutes}m)`);
    }
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

  // Skip Torz for HTTP streaming — Torz is torrent-only and irrelevant for HTTP providers
  const isHttpStreaming = provider === 'httpstreaming';
  const shouldFetchTorz = !isHttpStreaming && (provider === 'RealDebrid' || searchResults.length < minResultsRequired);

  // Always check Torz for RealDebrid; otherwise only if cache doesn't meet the minimum result count
  const torzResults = shouldFetchTorz ? await fetchTorzResults(provider, type, id, config) : [];

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

  // Fetch personal cloud files in parallel (used in both cache hit and miss paths)
  const personalFilesPromise = typeof personalFetchFn === 'function'
    ? personalFetchFn().catch(err => {
        console.error(`[CACHE] Personal fetch failed for ${cacheKey}:`, err.message);
        return [];
      })
    : Promise.resolve([]);

  // If SQLite/Torz doesn't meet minimum results for this service, do a live check before returning
  // This ensures we don't return too-thin cached results and properly check all available sources
  if (combinedResults.length < minResultsRequired) {
    console.log(`[CACHE] Only ${combinedResults.length}/${minResultsRequired} cached results for ${cacheKey} - performing live check for ${provider}`);
    let freshResults = [];
    try {
      const rawFreshResults = await searchFn();
      freshResults = Array.isArray(rawFreshResults) ? rawFreshResults : [];
    } catch (error) {
      console.error(`[CACHE] Live check failed for ${cacheKey}:`, error.message);
      freshResults = [];
    }

    const { merged } = mergeCacheResults(combinedResults, freshResults, provider);

    if (freshResults.length > 0 || combinedResults.length > 0) {
      console.log(`[CACHE] Live check returned ${freshResults.length} results, updating cache`);
      await storeCacheResults(null, cacheKey, merged, type, provider);
    } else {
      console.log(`[CACHE] Live check returned 0 results, skipping empty cache write`);
      // Don't cache empty results - this ensures future requests will do live checks
      // and discover new content when it becomes available
    }

    if (freshResults.length === 0) {
      scheduleBackgroundRefresh({
        provider,
        type,
        id,
        config,
        searchFn,
        cacheKey,
        existingResults: merged,
        reason: 'miss'
      });
    }

    // Merge personal files into results (they are excluded from cache storage)
    const personalFiles = await personalFilesPromise;
    if (personalFiles.length > 0) {
      const personalHashes = new Set(personalFiles.map(f => (f.hash || f.InfoHash || '').toLowerCase()).filter(Boolean));
      const deduped = merged.filter(r => {
        const h = (r.hash || r.infoHash || '').toLowerCase();
        return !h || !personalHashes.has(h);
      });
      console.log(`[CACHE] Merging ${personalFiles.length} personal files into ${deduped.length} results (miss path)`);
      return attachCacheKey([...personalFiles, ...deduped], cacheKey);
    }

    return attachCacheKey(merged, cacheKey);
  }

  const hasTierCoverage = hasSufficientTierFulfillment(combinedResults);
  console.log(`[CACHE] Returning ${combinedResults.length} cached results immediately for ${cacheKey} (tier coverage: ${hasTierCoverage ? 'sufficient' : 'insufficient'})`);

  // Trigger background refresh to keep cache fresh (includes scrapers + Torz + personal files)
  setImmediate(() => {
    refreshCacheInBackground(provider, type, id, config, searchFn, cacheKey, searchResults)
      .catch(err => console.error(`[CACHE] Background refresh error for ${cacheKey}:`, err.message));
  });

  // Merge personal files into cached results (personal files are excluded from cache storage,
  // so they must be fetched live and merged back in on every cache hit)
  const personalFiles = await personalFilesPromise;
  if (personalFiles.length > 0) {
    const personalHashes = new Set(personalFiles.map(f => (f.hash || f.InfoHash || '').toLowerCase()).filter(Boolean));
    const deduped = combinedResults.filter(r => {
      const h = (r.hash || r.infoHash || '').toLowerCase();
      return !h || !personalHashes.has(h);
    });
    console.log(`[CACHE] Merging ${personalFiles.length} personal files into ${deduped.length} cached results (hit path)`);
    return attachCacheKey([...personalFiles, ...deduped], cacheKey);
  }

  return attachCacheKey(combinedResults, cacheKey);
}

const CACHE_URL_ALLOWED_PROVIDERS = new Set(['easynews', 'debriderapp', 'personalcloud']);

function allowsUrlCaching(provider) {
  const key = String(provider || '').toLowerCase();
  return key === 'httpstreaming' || CACHE_URL_ALLOWED_PROVIDERS.has(key);
}

// Helper function to store cache results (DRY principle)
async function storeCacheResults(collection, cacheKey, results, type, provider) {
  // Allow empty results to update cache timestamp
  if (!results) return;

  const providerKey = String(provider || '').toLowerCase();

  // Filter out personal cloud files and stream objects unless the provider expects URL-based results.
  const cacheableData = results.filter(item => {
    if (!item) return false; // Changed from true - null items shouldn't be cached
    if (item.isPersonal) return false;
    // For HTTP streaming, skip error/info streams that have no URL (e.g. blocked/rate-limited notices)
    if (providerKey === 'httpstreaming' && !item.url) return false;

    const allowUrlCache = allowsUrlCaching(provider);
    if (!allowUrlCache && typeof item.url === 'string' && item.url) {
      return !(item.url.startsWith('http') || item.url.startsWith('/resolve/'));
    }

    return true;
  });

  // Skip storing empty cache results to avoid stale zero-hit caches.
  if (cacheableData.length === 0) return;

  const ttlMinutes = type === 'series' ? SCRAPER_CACHE_TTL_SERIES_MIN : SCRAPER_CACHE_TTL_MOVIE_MIN;

  // Use HTTP streams-specific TTL for httpstreaming provider
  const isHttpStreaming = providerKey === 'httpstreaming';
  const ttlMs = isHttpStreaming
    ? HTTP_STREAMS_CACHE_TTL_DAYS * 24 * 60 * 60 * 1000
    : undefined; // Use default TTL for other providers

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
    }, { ttlMs });

    const ttlDisplay = isHttpStreaming ? `${HTTP_STREAMS_CACHE_TTL_DAYS}d` : `${ttlMinutes}m`;
    if (success) {
      console.log(`[CACHE] STORED: ${cacheKey} (${cacheableData.length} results, TTL: ${ttlDisplay})`);
    } else {
      console.log(`[CACHE] FAILED to store ${cacheKey}: upsert failed`);
    }
  } catch (e) {
    console.error(`[CACHE] FAILED to store ${cacheKey}:`, e.message);
  }
}

// Background task to refresh cache with new data
async function refreshCacheInBackground(provider, type, id, config, searchFn, cacheKey, existingResults) {
  try {
    console.log(`[CACHE] Starting background refresh for ${cacheKey}`);
    
    // Get fresh results with the search function
    // Skip Torz for HTTP streaming — Torz is torrent-only
    const isHttpProvider = provider === 'httpstreaming';
    const [freshResults, torzResults] = await Promise.all([
      searchFn(true),
      isHttpProvider ? [] : fetchTorzResults(provider, type, id, config)
    ]);
    const combinedFreshResults = [...(torzResults || []), ...(freshResults || [])];
    
    if (combinedFreshResults.length > 0) {
      // Process fresh results and update cache with any that are not already cached
      const nonPersonalFresh = combinedFreshResults.filter(r => !r.isPersonal);
      
      if (nonPersonalFresh.length > 0) {
        const existingKeys = new Set(
          (existingResults || [])
            .map(item => getCacheResultKey(item, provider))
            .filter(Boolean)
        );

        const newFreshCount = nonPersonalFresh.reduce((count, item) => {
          const key = getCacheResultKey(item, provider);
          if (!key || !existingKeys.has(key)) return count + 1;
          return count;
        }, 0);

        if (newFreshCount > 0) {
          const { merged } = mergeCacheResults(existingResults, nonPersonalFresh, provider);
          console.log(`[CACHE] Background refresh found ${newFreshCount} new results to cache for ${cacheKey}`);
          await storeCacheResults(null, cacheKey, merged, type, provider);
        } else {
          console.log(`[CACHE] Background refresh: no new results to cache for ${cacheKey}`);
        }
      }
    }
    
    console.log(`[CACHE] Background refresh completed for ${cacheKey}`);
    return combinedFreshResults.length;
  } catch (err) {
    console.error(`[CACHE] Background refresh failed for ${cacheKey}:`, err.message);
    return 0;
  }
}

// Helper to fetch movie streams from a single debrid service
async function getMovieStreamsFromProvider(debridProvider, apiKey, type, id, config, cinemetaDetails, searchKey) {
  // Create a config copy with the correct API key for this specific provider
  const providerConfig = { ...config, DebridApiKey: apiKey };
  if (debridProvider == "DebridLink") {
    const torrents = await getCachedTorrents(debridProvider, type, id, config, () => DebridLink.searchTorrents(apiKey, searchKey, 0.1));
    if (torrents.background) return [];
    if (torrents && torrents.length) {
      const torrentIds = torrents.filter(t => filterYear(t, cinemetaDetails)).map(t => t.id);
      if (torrentIds && torrentIds.length) {
        return DebridLink.getTorrentDetails(apiKey, torrentIds.join())
          .then(list => list.sort(sortTorrents).map(t => toStream(t, type, providerConfig)).filter(Boolean));
      }
    }
  } else if (debridProvider == "RealDebrid") {
    const allResults = await getCachedTorrents(
      debridProvider,
      type,
      id,
      config,
      (isBackgroundRefresh = false) => RealDebrid.searchRealDebridTorrents(apiKey, type, id, config, config.clientIp, isBackgroundRefresh),
      () => RealDebrid.searchPersonalFiles(apiKey, searchKey, 0.3, config.clientIp)
    );
    if (allResults.background) return [];
    if (!allResults || allResults.length === 0) return [];
    // Enforce movie-only semantics: apply year sanity and drop any series-like items
    let filtered = allResults.filter(item => filterYear(item, cinemetaDetails));
    filtered = filtered.filter(item => {
      const name = item?.name || item?.title || '';
      const info = item?.info || {};
      const hasSeriesInfo = (info && (info.season != null || Array.isArray(info.seasons)));
      const looksSeries = hasEpisodeMarker(name, 1, 1); // Check for S01E01 to guess if it's a series
      return !hasSeriesInfo && !looksSeries;
    });
    const wrapped = filtered.map(item => {
      // Skip cached items with invalid URLs containing 'undefined'
      if (item && typeof item.url === 'string' && item.url.includes('/resolve/')) {
        if (item.url.includes('/undefined') || item.url.endsWith('undefined')) {
          console.log(`[CACHE] Skipping cached item with invalid URL: ${item.title || item.name}`);
          return null;
        }
        return item;
      }
      return toStream(item, type, providerConfig);
    });
    return wrapped.filter(Boolean);
  } else if (debridProvider == "AllDebrid") {
    const allResults = await getCachedTorrents(debridProvider, type, id, config, (isBackgroundRefresh = false) => AllDebrid.searchAllDebridTorrents(apiKey, type, id, config, config.clientIp, isBackgroundRefresh));
    if (allResults.background) return [];
    if (!allResults || allResults.length === 0) return [];
    // Enforce movie-only semantics: apply year sanity and drop any series-like items
    let filtered = allResults.filter(item => filterYear(item, cinemetaDetails));
    filtered = filtered.filter(item => {
      const name = item?.name || item?.title || '';
      const info = item?.info || {};
      const hasSeriesInfo = (info && (info.season != null || Array.isArray(info.seasons)));
      const looksSeries = hasEpisodeMarker(name, 1, 1); // Check for S01E01 to guess if it's a series
      return !hasSeriesInfo && !looksSeries;
    });
    const wrapped = filtered.map(item => {
      // Skip cached items with invalid URLs containing 'undefined'
      if (item && typeof item.url === 'string' && item.url.includes('/resolve/')) {
        if (item.url.includes('/undefined') || item.url.endsWith('undefined')) {
          console.log(`[CACHE] Skipping cached item with invalid URL: ${item.title || item.name}`);
          return null;
        }
        return item;
      }
      return toStream(item, type, providerConfig);
    });
    return wrapped.filter(Boolean);
  } else if (debridProvider == "Premiumize") {
    const torrents = await getCachedTorrents(
      debridProvider,
      type,
      id,
      config,
      () => Premiumize.search(apiKey, type, id, config),
      () => Premiumize.searchPersonalFiles(apiKey, searchKey, 0.3)
    );
    if (torrents.background) return [];
    if (torrents && torrents.length) {
      return torrents.sort(sortTorrents)
        .map(td => toStream(td, type, providerConfig))
        .filter(Boolean);
    }
  } else if (debridProvider.toLowerCase() == "offcloud") {
    const torrents = await getCachedTorrents(
      debridProvider,
      type,
      id,
      config,
      () => OffCloud.searchOffcloudTorrents(apiKey, type, id, config),
      () => OffCloud.searchPersonalFiles(apiKey, [searchKey], searchKey, type)
    );
    if (torrents && torrents.length) {
      return torrents.sort(sortTorrents)
        .filter(t => filterYear(t, cinemetaDetails))
        .map(td => toStream(td, type, providerConfig))
        .filter(Boolean);
    }
  } else if (debridProvider == "TorBox") {
    const torrents = await getCachedTorrents(debridProvider, type, id, config, () => TorBox.searchTorboxTorrents(apiKey, type, id, config));
    if (torrents && torrents.length) {
      return torrents.sort(sortTorrents)
        .filter(t => filterYear(t, cinemetaDetails))
        .map(td => toStream(td, type, providerConfig))
        .filter(Boolean);
    }
  } else if (debridProvider == "DebriderApp") {
    // Check if this service has Newznab configured for Personal Cloud NZB support
    let serviceConfig = config;
    if (Array.isArray(config.DebridServices)) {
      const service = config.DebridServices.find(s => s.provider === 'DebriderApp');
      if (service && (service.newznabUrl || service.newznabApiKey)) {
        // Use searchWithPersonalCloud to include NZB results
        serviceConfig = {
          ...config,
          newznabUrl: service.newznabUrl,
          newznabApiKey: service.newznabApiKey
        };
        console.log(`[DBA] Newznab configured, using searchWithPersonalCloud`);
        const baseUrl = 'https://debrider.app/api/v1';
        const torrents = await getCachedTorrents(debridProvider, type, id, config, () => DebriderApp.searchWithPersonalCloud(apiKey, type, id, serviceConfig, baseUrl));
        if (torrents && torrents.length) {
          return torrents.sort(sortTorrents)
            .map(td => toDebriderStream(td, type, providerConfig))
            .filter(Boolean);
        }
      } else {
        // Regular search without Newznab
        const torrents = await getCachedTorrents(debridProvider, type, id, config, () => DebriderApp.search(apiKey, type, id, config));
        if (torrents && torrents.length) {
          return torrents.sort(sortTorrents)
            .map(td => toDebriderStream(td, type, providerConfig))
            .filter(Boolean);
        }
      }
    } else {
      // Fallback to regular search
      const torrents = await getCachedTorrents(debridProvider, type, id, config, () => DebriderApp.search(apiKey, type, id, config));
      if (torrents && torrents.length) {
        return torrents.sort(sortTorrents)
          .map(td => toDebriderStream(td, type, providerConfig))
          .filter(Boolean);
      }
    }
  } else if (debridProvider == "PersonalCloud") {
    const personalCloudConfig = {
      newznabUrl: config.PersonalCloudNewznabUrl,
      newznabApiKey: config.PersonalCloudNewznabApiKey,
      ...config
    };
    const baseUrl = config.PersonalCloudUrl || 'https://debrider.app/api/v1';
    const torrents = await getCachedTorrents(debridProvider, type, id, config, () => DebriderApp.searchWithPersonalCloud(apiKey, type, id, personalCloudConfig, baseUrl));
    if (torrents && torrents.length) {
      return torrents.sort(sortTorrents)
        .map(td => toDebriderStream(td, type, providerConfig))
        .filter(Boolean);
    }
  }
  return [];
}

async function getMovieStreams(config, type, id) {
  const cinemetaDetails = await Cinemeta.getMeta(type, id);

  const cinemetaFailed = !cinemetaDetails || !cinemetaDetails.name;

  // Handle Cinemeta failure gracefully — skip debrid/torrent providers but still
  // try HTTP streaming providers that do their own metadata lookup.
  if (cinemetaFailed) {
    console.warn(`[STREAM-PROVIDER] Cinemeta returned no metadata for ${type}:${id} - skipping debrid providers, trying HTTP streaming only`);
  }

  const searchKey = cinemetaDetails?.name || '';
  const tmdbIdFromMeta = cinemetaFailed ? null : resolveTmdbId(cinemetaDetails);

  const allStreamsPromises = [];
  const streamTasks = [];
  const addStreamTask = (promise, meta = {}) => {
    allStreamsPromises.push(promise);
    streamTasks.push({
      promise,
      provider: meta.provider || 'unknown',
      earlyReturnDisabled: meta.earlyReturnDisabled === true,
      earlyReturnTimeoutMs: meta.earlyReturnTimeoutMs
    });
  };

  // Support multiple debrid services (skip when Cinemeta failed — they need metadata for search)
  if (!cinemetaFailed && config.DebridServices && Array.isArray(config.DebridServices) && config.DebridServices.length > 0) {
    config.DebridServices.forEach(service => {
      const { disableEarlyReturn, earlyReturnTimeoutMs } = getServiceEarlyReturnConfig(service);
      const earlyReturnMeta = { earlyReturnDisabled: disableEarlyReturn, earlyReturnTimeoutMs };
      if (service.provider === 'Usenet') {
        // Handle Usenet service
        const usenetConfig = {
          NewznabUrl: service.newznabUrl,
          NewznabApiKey: service.apiKey,
          NntpAddress: service.nntpAddress,
          NntpPort: service.nntpPort,
          NntpUsername: service.nntpUsername,
          NntpPassword: service.nntpPassword,
          NntpConnections: service.nntpConnections || 4,
          NntpSsl: service.nntpSsl !== false,
          FileServerUrl: service.fileServerUrl || ''
        };
        const serviceName = 'Usenet';
        addStreamTask(
          (async () => {
            const startTime = Date.now();
            console.log(`[PARALLEL-SEARCH] 🚀 Starting ${serviceName} search at ${new Date(startTime).toISOString()}`);
            try {
              const results = await withTimeout(
                getUsenetStreams(usenetConfig, type, id),
                USENET_TIMEOUT_MS,
                'Usenet'
              );
              const duration = Date.now() - startTime;
              console.log(`[PARALLEL-SEARCH] ✅ ${serviceName} completed in ${(duration/1000).toFixed(2)}s with ${results?.length || 0} results`);
              return results;
            } catch (error) {
              const duration = Date.now() - startTime;
              console.error(`[PARALLEL-SEARCH] ❌ ${serviceName} failed after ${(duration/1000).toFixed(2)}s: ${error.message}`);
              throw error;
            }
          })(),
          { provider: serviceName, ...earlyReturnMeta }
        );
      } else if (service.provider === 'Easynews') {
        // Handle Easynews service with caching
        const easynewsConfig = {
          EasynewsUsername: service.username,
          EasynewsPassword: service.password,
          ...config
        };
        const serviceName = 'Easynews';
        addStreamTask(
          (async () => {
            const startTime = Date.now();
            console.log(`[PARALLEL-SEARCH] 🚀 Starting ${serviceName} search at ${new Date(startTime).toISOString()}`);
            try {
              const results = await withTimeout(
                getEasynewsStreams(easynewsConfig, type, id),
                SERVICE_TIMEOUT_MS,
                'Easynews'
              );
              const duration = Date.now() - startTime;
              console.log(`[PARALLEL-SEARCH] ✅ ${serviceName} completed in ${(duration/1000).toFixed(2)}s with ${results?.length || 0} results`);
              return results;
            } catch (error) {
              const duration = Date.now() - startTime;
              console.error(`[PARALLEL-SEARCH] ❌ ${serviceName} failed after ${(duration/1000).toFixed(2)}s: ${error.message}`);
              throw error;
            }
          })(),
          { provider: serviceName, ...earlyReturnMeta }
        );
      } else if (service.provider === 'HomeMedia') {
        // Handle Home Media Server
        const homeMediaConfig = {
          HomeMediaUrl: service.homeMediaUrl,
          HomeMediaApiKey: service.apiKey,
          Languages: config.Languages
        };
        const serviceName = 'HomeMedia';
        addStreamTask(
          (async () => {
            const startTime = Date.now();
            console.log(`[PARALLEL-SEARCH] 🚀 Starting ${serviceName} search at ${new Date(startTime).toISOString()}`);
            try {
              const results = await withTimeout(
                getHomeMediaStreams(homeMediaConfig, type, id),
                SERVICE_TIMEOUT_MS,
                'HomeMedia'
              );
              const duration = Date.now() - startTime;
              console.log(`[PARALLEL-SEARCH] ✅ ${serviceName} completed in ${(duration/1000).toFixed(2)}s with ${results?.length || 0} results`);
              return results;
            } catch (error) {
              const duration = Date.now() - startTime;
              console.error(`[PARALLEL-SEARCH] ❌ ${serviceName} failed after ${(duration/1000).toFixed(2)}s: ${error.message}`);
              throw error;
            }
          })(),
          { provider: serviceName, ...earlyReturnMeta }
        );
      } else if (service.provider === 'PersonalCloud') {
        // Handle Personal Cloud
        const personalCloudConfig = {
          PersonalCloudUrl: service.baseUrl,
          PersonalCloudNewznabUrl: service.newznabUrl,
          PersonalCloudNewznabApiKey: service.newznabApiKey,
          Languages: config.Languages,
          ...config
        };
        const serviceName = 'PersonalCloud';
        addStreamTask(
          (async () => {
            const startTime = Date.now();
            console.log(`[PARALLEL-SEARCH] 🚀 Starting ${serviceName} search at ${new Date(startTime).toISOString()}`);
            try {
              const results = await withTimeout(
                getMovieStreamsFromProvider('PersonalCloud', service.apiKey, type, id, personalCloudConfig, cinemetaDetails, searchKey),
                SERVICE_TIMEOUT_MS,
                'PersonalCloud'
              );
              const duration = Date.now() - startTime;
              console.log(`[PARALLEL-SEARCH] ✅ ${serviceName} completed in ${(duration/1000).toFixed(2)}s with ${results?.length || 0} results`);
              return results;
            } catch (error) {
              const duration = Date.now() - startTime;
              console.error(`[PARALLEL-SEARCH] ❌ ${serviceName} failed after ${(duration/1000).toFixed(2)}s: ${error.message}`);
              throw error;
            }
          })(),
          { provider: serviceName, ...earlyReturnMeta }
        );
      } else if (service.provider === 'httpstreaming') {
        // Fetch streams based on user's selected HTTP streaming sources with caching
        // Only enable providers explicitly set to true (not default-on)
        const use4KHDHub = service.http4khdhub === true;
        const useHDHub4u = service.httpHDHub4u === true;
        const useUHDMovies = service.httpUHDMovies === true;
        const useMoviesDrive = service.httpMoviesDrive === true;
        const useMKVCinemas = service.httpMKVCinemas === true;
        const useMkvDrama = service.httpMkvDrama === true;
        const useMalluMv = service.httpMalluMv === true;
        const useCineDoze = service.httpCineDoze === true;
        const useXDMovies = service.httpXDMovies === true;
        const useVixSrc = service.httpVixSrc === true;
        const useNetflixMirror = service.httpNetflixMirror === true;
        const useMoviesMod = service.httpMoviesMod === true;
        const useMoviesLeech = service.httpMoviesLeech === true;
        const useAnimeFlix = service.httpAnimeFlix === true;
        const allowMkvDramaForTitle = shouldUseMkvDramaForTitle(cinemetaDetails);
        const vixSrcId = tmdbIdFromMeta || id;

        // HTTP streaming services should always complete their cache check before early return
        // Each service is independent and shouldn't be cut off by early return from other services
        // HTTP streaming providers should NOT block early return — they are independent
        // fast providers that complete within their own timeouts. Blocking early return
        // forces the response to wait for all HTTP providers before returning any results,
        // even when debrid providers have already returned quality streams.
        if (use4KHDHub) {
          addStreamTask(
            withTimeout(
              getCachedTorrents('httpstreaming', type, `${id}-4khdhub`, config, () =>
                get4KHDHubStreams(id, type, null, null, config)
              ).then(streams => wrapHttpStreamsWithResolver(streams, config.host)),
              getHttpStreamingTimeout('4KHDHub'),
              '4KHDHub'
            ),
            { provider: '4KHDHub', earlyReturnDisabled: false, earlyReturnTimeoutMs: earlyReturnMeta.earlyReturnTimeoutMs }
          );
        }

        if (useHDHub4u) {
          addStreamTask(
            withTimeout(
              getCachedTorrents('httpstreaming', type, `${id}-hdhub4u`, config, () =>
                getHDHub4uStreams(id, type, null, null, config)
              ).then(streams => wrapHttpStreamsWithResolver(streams, config.host)),
              getHttpStreamingTimeout('HDHub4u'),
              'HDHub4u'
            ),
            { provider: 'HDHub4u', earlyReturnDisabled: false, earlyReturnTimeoutMs: earlyReturnMeta.earlyReturnTimeoutMs }
          );
        }

        if (useMKVCinemas) {
          addStreamTask(
            withTimeout(
              getCachedTorrents('httpstreaming', type, `${id}-mkvcinemas2`, config, () =>
                getMKVCinemasStreams(id, type, null, null, config)
              ).then(streams => {
                const wrapped = wrapHttpStreamsWithResolver(streams, config.host);
                backgroundPreResolve(wrapped, 'MKVCinemas');
                return wrapped;
              }),
              getHttpStreamingTimeout('MKVCinemas'),
              'MKVCinemas'
            ),
            { provider: 'MKVCinemas', earlyReturnDisabled: false, earlyReturnTimeoutMs: earlyReturnMeta.earlyReturnTimeoutMs }
          );
        }

        if (useMkvDrama && allowMkvDramaForTitle) {
          addStreamTask(
            withTimeout(
              getMkvDramaStreams(id, type, null, null, config)
                .then(streams => wrapHttpStreamsWithResolver(streams, config.host)),
              getHttpStreamingTimeout('MkvDrama'),
              'MkvDrama'
            ),
            { provider: 'MkvDrama', earlyReturnDisabled: true, earlyReturnTimeoutMs: earlyReturnMeta.earlyReturnTimeoutMs }
          );
        } else if (useMkvDrama) {
          console.log('[MKVDrama] Skipping MKVDrama for non-Asian title due to MKVDRAMA_ASIAN_ONLY=true');
        }

        if (useCineDoze) {
          addStreamTask(
            withTimeout(
              getCachedTorrents('httpstreaming', type, `${id}-cinedoze`, config, () =>
                getCineDozeStreams(id, type, null, null, config)
              ).then(streams => wrapHttpStreamsWithResolver(streams, config.host)),
              getHttpStreamingTimeout('CineDoze'),
              'CineDoze'
            ),
            { provider: 'CineDoze', earlyReturnDisabled: false, earlyReturnTimeoutMs: earlyReturnMeta.earlyReturnTimeoutMs }
          );
        }

        if (useMalluMv) {
          addStreamTask(
            withTimeout(
              getCachedTorrents('httpstreaming', type, `${id}-mallumv`, config, () =>
                getMalluMvStreams(id, type, null, null, config)
              ).then(streams => wrapHttpStreamsWithResolver(streams, config.host)),
              getHttpStreamingTimeout('MalluMv'),
              'MalluMv'
            ),
            { provider: 'MalluMv', earlyReturnDisabled: false, earlyReturnTimeoutMs: earlyReturnMeta.earlyReturnTimeoutMs }
          );
        }

        if (useUHDMovies) {
          addStreamTask(
            withTimeout(
              getCachedTorrents('httpstreaming', type, `${id}-uhdmovies`, config, () =>
                getUHDMoviesStreams(id, id, type, null, null, config)
              ).then(streams => wrapHttpStreamsWithResolver(streams, config.host)),
              getHttpStreamingTimeout('UHDMovies'),
              'UHDMovies'
            ),
            { provider: 'UHDMovies', earlyReturnDisabled: false, earlyReturnTimeoutMs: earlyReturnMeta.earlyReturnTimeoutMs }
          );
        }


        if (useMoviesDrive) {
          addStreamTask(
            withTimeout(
              getCachedTorrents('httpstreaming', type, `${id}-moviesdrive`, config, () =>
                getMoviesDriveStreams(id, id, type, null, null, config)
              ).then(streams => {
                console.log(`[stream-provider] MoviesDrive getCachedTorrents returned ${streams?.length || 0} streams`);
                return wrapHttpStreamsWithResolver(streams, config.host);
              }),
              getHttpStreamingTimeout('MoviesDrive'),
              'MoviesDrive'
            ),
            { provider: 'MoviesDrive', earlyReturnDisabled: false, earlyReturnTimeoutMs: earlyReturnMeta.earlyReturnTimeoutMs }
          );
        }

        if (useXDMovies) {
          addStreamTask(
            withTimeout(
              getCachedTorrents('httpstreaming', type, `${id}-xdmovies`, config, () =>
                getXDMoviesStreams(id, type, null, null, config, cinemetaDetails)
              ).then(streams => wrapHttpStreamsWithResolver(streams, config.host)),
              getHttpStreamingTimeout('XDMovies'),
              'XDMovies'
            ),
            { provider: 'XDMovies', earlyReturnDisabled: false, earlyReturnTimeoutMs: earlyReturnMeta.earlyReturnTimeoutMs }
          );
        }

        if (useVixSrc) {
          // VixSrc uses session-based URLs that expire quickly - don't cache
          addStreamTask(
            withTimeout(
              getVixSrcStreams(vixSrcId, type, null, null)
                .then(streams => wrapHttpStreamsWithResolver(streams, config.host)),
              getHttpStreamingTimeout('VixSrc'),
              'VixSrc'
            ),
            { provider: 'VixSrc', earlyReturnDisabled: false, earlyReturnTimeoutMs: earlyReturnMeta.earlyReturnTimeoutMs }
          );
        }

        if (useNetflixMirror) {
          // NetflixMirror uses session-based URLs that expire quickly - don't cache
          addStreamTask(
            withTimeout(
              getNetflixMirrorStreams(id, type, null, null, config, cinemetaDetails)
                .then(streams => wrapHttpStreamsWithResolver(streams, config.host)),
              getHttpStreamingTimeout('NetflixMirror'),
              'NetflixMirror'
            ),
            { provider: 'NetflixMirror', earlyReturnDisabled: false, earlyReturnTimeoutMs: earlyReturnMeta.earlyReturnTimeoutMs }
          );
        }

        if (useMoviesMod) {
          addStreamTask(
            withTimeout(
              getCachedTorrents('httpstreaming', type, `${id}-moviesmod`, config, () =>
                getMoviesModStreams(id, type, null, null, config, cinemetaDetails)
              ).then(streams => wrapHttpStreamsWithResolver(streams, config.host)),
              getHttpStreamingTimeout('MoviesMod'),
              'MoviesMod'
            ),
            { provider: 'MoviesMod', earlyReturnDisabled: false, earlyReturnTimeoutMs: earlyReturnMeta.earlyReturnTimeoutMs }
          );
        }

        if (useMoviesLeech) {
          addStreamTask(
            withTimeout(
              getCachedTorrents('httpstreaming', type, `${id}-moviesleech`, config, () =>
                getMoviesLeechStreams(id, type, null, null, config, cinemetaDetails)
              ).then(streams => wrapHttpStreamsWithResolver(streams, config.host)),
              getHttpStreamingTimeout('MoviesLeech'),
              'MoviesLeech'
            ),
            { provider: 'MoviesLeech', earlyReturnDisabled: false, earlyReturnTimeoutMs: earlyReturnMeta.earlyReturnTimeoutMs }
          );
        }

        if (useAnimeFlix) {
          addStreamTask(
            withTimeout(
              getCachedTorrents('httpstreaming', type, `${id}-animeflix`, config, () =>
                getAnimeFlixStreams(id, type, null, null, config, cinemetaDetails)
              ).then(streams => wrapHttpStreamsWithResolver(streams, config.host)),
              getHttpStreamingTimeout('AnimeFlix'),
              'AnimeFlix'
            ),
            { provider: 'AnimeFlix', earlyReturnDisabled: false, earlyReturnTimeoutMs: earlyReturnMeta.earlyReturnTimeoutMs }
          );
        }

      } else {
        // Handle regular debrid service
        // Merge service-specific config (like enablePersonalCloud) into the config
        const serviceConfig = {
          ...config,
          enablePersonalCloud: service.enablePersonalCloud
        };
        const serviceName = service.provider;
        addStreamTask(
          (async () => {
            const startTime = Date.now();
            console.log(`[PARALLEL-SEARCH] 🚀 Starting ${serviceName} search at ${new Date(startTime).toISOString()}`);
            try {
              const results = await getMovieStreamsFromProvider(service.provider, service.apiKey, type, id, serviceConfig, cinemetaDetails, searchKey);
              const duration = Date.now() - startTime;
              console.log(`[PARALLEL-SEARCH] ✅ ${serviceName} completed in ${(duration/1000).toFixed(2)}s with ${results?.length || 0} results`);
              return results;
            } catch (error) {
              const duration = Date.now() - startTime;
              console.error(`[PARALLEL-SEARCH] ❌ ${serviceName} failed after ${(duration/1000).toFixed(2)}s: ${error.message}`);
              throw error;
            }
          })(),
          { provider: serviceName, ...earlyReturnMeta }
        );
      }
    });
  } else if (!cinemetaFailed) {
    // Backward compatibility: single service (skip when Cinemeta failed)
    let apiKey = config.DebridLinkApiKey ? config.DebridLinkApiKey : config.DebridApiKey;
    const debridProvider = config.DebridProvider || (config.DebridLinkApiKey ? "DebridLink" : null);

    if (debridProvider) {
      addStreamTask(
        getMovieStreamsFromProvider(debridProvider, apiKey, type, id, config, cinemetaDetails, searchKey),
        { provider: debridProvider }
      );
    }
  }

  if (allStreamsPromises.length === 0) {
    if (cinemetaFailed) {
      console.warn(`[STREAM-PROVIDER] No HTTP streaming providers configured — returning empty for ${type}:${id}`);
      return [];
    }
    return Promise.reject(BadRequestError);
  }

  const totalStartTime = Date.now();
  console.log(`[PARALLEL-SEARCH] 🔥 Executing ${allStreamsPromises.length} service searches IN PARALLEL...`);

  // EARLY RETURN OPTIMIZATION: Return results as soon as we have enough quality streams
  // This significantly improves perceived performance for cold cache scenarios
  let flatStreams = [];

  if (EARLY_RETURN_ENABLED && allStreamsPromises.length > 1) {
    const completedResults = [];
    const completedIndexes = new Set();
    const blockedIndexes = streamTasks
      .map((task, index) => task.earlyReturnDisabled ? index : null)
      .filter(index => index !== null);
    const timeoutOverrides = streamTasks
      .filter(task => !task.earlyReturnDisabled)
      .map(task => task.earlyReturnTimeoutMs)
      .filter(value => Number.isFinite(value));
    const earlyReturnTimeoutMs = Math.max(EARLY_RETURN_TIMEOUT_MS, ...timeoutOverrides);

    let earlyReturnTriggered = false;
    let timerFired = false;
    let allComplete = false;
    let earlyReturnResolve;
    const earlyReturnGate = new Promise(resolve => {
      earlyReturnResolve = resolve;
    });

    const maybeTriggerEarlyReturn = () => {
      if (earlyReturnTriggered || allComplete || !timerFired) return;

      const currentStreams = completedResults.flatMap(r => r.result || []);
      const pendingBlockers = blockedIndexes.filter(index => !completedIndexes.has(index));
      if (pendingBlockers.length > 0) return;

      if (currentStreams.length >= EARLY_RETURN_MIN_STREAMS) {
        earlyReturnTriggered = true;
        earlyReturnResolve('early-return');
      }
    };

    const timerId = setTimeout(() => {
      timerFired = true;
      const currentStreams = completedResults.flatMap(r => r.result || []);
      const pendingProviders = allStreamsPromises.length - completedResults.length;
      const pendingBlockers = blockedIndexes.filter(index => !completedIndexes.has(index));
      console.log(`[PARALLEL-SEARCH] ⏱️ Early return check: ${completedResults.length}/${allStreamsPromises.length} providers complete, ${currentStreams.length} streams collected (need ${EARLY_RETURN_MIN_STREAMS})`);
      if (pendingBlockers.length > 0) {
        const pendingBlockerNames = pendingBlockers
          .map(index => streamTasks[index]?.provider)
          .filter(Boolean);
        if (pendingBlockerNames.length > 0) {
          console.log(`[PARALLEL-SEARCH] ⏳ Early return waiting for ${pendingBlockerNames.join(', ')}`);
        }
      }
      const canEarlyReturn = pendingBlockers.length === 0 && currentStreams.length >= EARLY_RETURN_MIN_STREAMS;
      if (!canEarlyReturn && pendingProviders > 0) {
        console.log(`[PARALLEL-SEARCH] ⏳ ${pendingProviders} provider(s) still running after early return timeout`);
      }
      maybeTriggerEarlyReturn();
    }, earlyReturnTimeoutMs);

    // Wrap each promise to track completion
    const trackedPromises = allStreamsPromises.map((promise, index) =>
      promise.then(result => {
        completedResults.push({ index, result, status: 'fulfilled' });
        completedIndexes.add(index);
        maybeTriggerEarlyReturn();
        return result;
      }).catch(err => {
        completedResults.push({ index, result: [], status: 'rejected', error: err });
        completedIndexes.add(index);
        maybeTriggerEarlyReturn();
        return [];
      })
    );

    const allCompletePromise = Promise.all(trackedPromises).then(() => {
      allComplete = true;
      return 'all-complete';
    });

    const raceResult = await Promise.race([allCompletePromise, earlyReturnGate]);

    clearTimeout(timerId);

    if (raceResult === 'early-return') {
      // Early return triggered - use results collected so far
      const currentStreams = completedResults.flatMap(r => r.result || []);
      flatStreams = currentStreams;
      const elapsed = Date.now() - totalStartTime;
      console.log(`[PARALLEL-SEARCH] ⚡ EARLY RETURN after ${elapsed}ms with ${flatStreams.length} streams (${completedResults.length}/${allStreamsPromises.length} providers complete)`);

      // Let remaining promises complete in background (for cache warming)
      Promise.all(trackedPromises).then(() => {
        const bgDuration = Date.now() - totalStartTime;
        console.log(`[PARALLEL-SEARCH] 🔄 Background providers completed in ${(bgDuration/1000).toFixed(2)}s total`);
      }).catch(() => {});
    }

    // If early return wasn't triggered, wait for all results
    if (!earlyReturnTriggered) {
      await Promise.all(trackedPromises);
      flatStreams = completedResults.flatMap(r => r.result || []);
      const totalDuration = Date.now() - totalStartTime;
      console.log(`[PARALLEL-SEARCH] 🏁 All ${allStreamsPromises.length} searches completed in ${(totalDuration/1000).toFixed(2)}s (parallel execution)`);
    }
  } else {
    // Original behavior when early return is disabled or single provider
    const allStreamsSettled = await Promise.allSettled(allStreamsPromises);
    const totalDuration = Date.now() - totalStartTime;
    console.log(`[PARALLEL-SEARCH] 🏁 All ${allStreamsPromises.length} searches completed in ${(totalDuration/1000).toFixed(2)}s (parallel execution)`);

    // Extract successful results and log failures
    const allStreams = allStreamsSettled
      .filter((result, index) => {
        if (result.status === 'rejected') {
          console.warn(`[STREAM-PROVIDER] Movie provider ${index} failed: ${result.reason?.message || result.reason}`);
          return false;
        }
        return true;
      })
      .map(result => result.value);

    flatStreams = allStreams.flat();
  }

  // Apply size filter if configured
  const minSize = config.minSize !== undefined ? config.minSize : 0;
  const maxSize = config.maxSize !== undefined ? config.maxSize : 200;
  flatStreams = filterBySize(flatStreams, minSize, maxSize);

  // Apply language filter if configured
  if (config.Languages && config.Languages.length > 0) {
    flatStreams = filterStreamsByLanguage(flatStreams, config.Languages);
  }

  // Apply resolution filter if configured
  if (config.Resolutions && config.Resolutions.length > 0) {
    flatStreams = filterByResolution(flatStreams, config.Resolutions);
  }

  // Apply proxy to HTTP streaming and Easynews streams if configured
  flatStreams = applyProxyToStreams(flatStreams, config);

  // Cross-provider deduplication: if a torrent exists in personal cloud AND as external cached,
  // keep only the personal version to avoid showing duplicate entries
  flatStreams = deduplicatePersonalStreams(flatStreams);

  // Sort streams: personal files first, then by resolution (highest to lowest), then by size (largest to smallest)
  // This applies to ALL sources (4KHDHub, HDHub4u, UHDMovies, MoviesDrive, torrents, etc.)
  flatStreams.sort((a, b) => {
    // Personal files always come first
    if (a.isPersonal && !b.isPersonal) return -1;
    if (!a.isPersonal && b.isPersonal) return 1;

    // Sort by resolution
    // HTTP streams have a dedicated 'resolution' field, use it first
    // Otherwise extract from name/title (for torrents)
    const resA = a.resolution || getResolutionFromName(a.name || a.title || '');
    const resB = b.resolution || getResolutionFromName(b.name || b.title || '');
    const rankA = resolutionOrder[resA] || 0;
    const rankB = resolutionOrder[resB] || 0;
    if (rankA !== rankB) return rankB - rankA;

    // Sort by size within same resolution (largest to smallest)
    // HTTP streams may have size as string, torrents have _size as number
    const sizeA = a._size || (a.size ? sizeToBytes(a.size) : 0);
    const sizeB = b._size || (b.size ? sizeToBytes(b.size) : 0);
    return sizeB - sizeA;
  });

  return flatStreams;
}

// Helper to fetch series streams from a single debrid service
async function getSeriesStreamsFromProvider(debridProvider, apiKey, type, id, config, cinemetaDetails, searchKey, season, episode) {
  // Create a config copy with the correct API key for this specific provider
  const providerConfig = { ...config, DebridApiKey: apiKey };
  if (debridProvider == "DebridLink") {
    const torrents = await getCachedTorrents(debridProvider, type, id, config, () => DebridLink.searchTorrents(apiKey, searchKey, 0.1));
    if (torrents && torrents.length) {
      const torrentIds = torrents.filter(t => filterSeason(t, season, cinemetaDetails)).map(t => t.id);
      if (torrentIds && torrentIds.length) {
        return DebridLink.getTorrentDetails(apiKey, torrentIds.join())
          .then(list => list
            .sort(sortTorrents)
            .filter(td => filterEpisode(td, season, episode, cinemetaDetails))
            .map(td => toStream(td, type, providerConfig))
            .filter(Boolean)
          );
      }
    }
  } else if (debridProvider == "RealDebrid") {
    const allResults = await getCachedTorrents(
      debridProvider,
      type,
      id,
      config,
      (isBackgroundRefresh = false) => RealDebrid.searchRealDebridTorrents(apiKey, type, id, config, config.clientIp, isBackgroundRefresh),
      () => RealDebrid.searchPersonalFiles(apiKey, searchKey, 0.3, config.clientIp)
    );
    if (!allResults || allResults.length === 0) return [];

    const s = Number(season), e = Number(episode);
    const looksCorrectEp = t => t?.info && Number(t.info.season) === s && Number(t.info.episode) === e;

    const filtered = allResults.filter(t =>
      looksCorrectEp(t) ||
      (filterSeason(t, season, cinemetaDetails) && filterEpisode(t, season, episode, cinemetaDetails))
    );

    const wrapped = filtered.map(item => {
      // Skip cached items with invalid URLs containing 'undefined'
      if (item && typeof item.url === 'string' && item.url.includes('/resolve/')) {
        if (item.url.includes('/undefined') || item.url.endsWith('undefined')) {
          console.log(`[CACHE] Skipping cached item with invalid URL: ${item.title || item.name}`);
          return null;
        }
        return item;
      }
      return toStream(item, type, providerConfig);
    });

    return wrapped.filter(Boolean);
  } else if (debridProvider == "AllDebrid") {
    const allResults = await getCachedTorrents(debridProvider, type, id, config, (isBackgroundRefresh = false) => AllDebrid.searchAllDebridTorrents(apiKey, type, id, config, config.clientIp, isBackgroundRefresh));
    if (!allResults || allResults.length === 0) return [];

    const s = Number(season), e = Number(episode);
    const looksCorrectEp = t => t?.info && Number(t.info.season) === s && Number(t.info.episode) === e;

    const filtered = allResults.filter(t =>
      looksCorrectEp(t) ||
      (filterSeason(t, season, cinemetaDetails) && filterEpisode(t, season, episode, cinemetaDetails))
    );

    const wrapped = filtered.map(item => {
      // Skip cached items with invalid URLs containing 'undefined'
      if (item && typeof item.url === 'string' && item.url.includes('/resolve/')) {
        if (item.url.includes('/undefined') || item.url.endsWith('undefined')) {
          console.log(`[CACHE] Skipping cached item with invalid URL: ${item.title || item.name}`);
          return null;
        }
        return item;
      }
      return toStream(item, type, providerConfig);
    });

    return wrapped.filter(Boolean);
  } else if (debridProvider == "Premiumize") {
    const torrents = await getCachedTorrents(
      debridProvider,
      type,
      id,
      config,
      () => Premiumize.search(apiKey, type, id, config),
      () => Premiumize.searchPersonalFiles(apiKey, searchKey, 0.3)
    );
    if (torrents && torrents.length) {
      return torrents
        .sort(sortTorrents)
        .map(td => toStream(td, type, providerConfig, { season, episode }))
        .filter(Boolean);
    }
  } else if (debridProvider.toLowerCase() == "offcloud") {
    const torrents = await getCachedTorrents(
      debridProvider,
      type,
      id,
      config,
      () => OffCloud.searchOffcloudTorrents(apiKey, type, id, config),
      () => OffCloud.searchPersonalFiles(apiKey, [searchKey], searchKey, type, season, episode)
    );
    if (torrents && torrents.length) {
      const bypass = torrents.filter(t => t.bypassFiltering === true);
//      if (bypass.length > 0) {
//        return bypass.sort(sortTorrents).map(td => toStream(td, type, providerConfig)).filter(Boolean);
//      }
      const fullTitle = String(cinemetaDetails?.name || '').trim();
      const shortTitle = fullTitle.includes(':') ? fullTitle.split(':')[0].trim() : '';
      const matchesTitle = (t) => {
        if (matchesSeriesTitle(t, fullTitle)) return true;
        if (shortTitle && matchesSeriesTitle(t, shortTitle)) return true;
        return false;
      };
      const episodeRegex = new RegExp(`s${String(season).padStart(2, '0')}e${String(episode).padStart(2, '0')}`, 'i');
      const realEpisodes = torrents
        .filter(t => matchesTitle(t))
        .filter(t => episodeRegex.test(t.name || t.title || ''));
      return realEpisodes.sort(sortTorrents).map(td => toStream(td, type, providerConfig)).filter(Boolean);
    }
  } else if (debridProvider == "TorBox") {
    const torrents = await getCachedTorrents(debridProvider, type, id, config, () => TorBox.searchTorboxTorrents(apiKey, type, id, config));
    if (torrents && torrents.length) {
      // Results are already pre-filtered at the scraping layer for series/episode.
      return torrents
        .sort(sortTorrents)
        .map(td => toStream(td, type, providerConfig))
        .filter(Boolean);
    }
  } else if (debridProvider == "DebriderApp") {
    // Check if this service has Newznab configured for Personal Cloud NZB support
    let serviceConfig = config;
    if (Array.isArray(config.DebridServices)) {
      const service = config.DebridServices.find(s => s.provider === 'DebriderApp');
      if (service && (service.newznabUrl || service.newznabApiKey)) {
        // Use searchWithPersonalCloud to include NZB results
        serviceConfig = {
          ...config,
          newznabUrl: service.newznabUrl,
          newznabApiKey: service.newznabApiKey
        };
        console.log(`[DBA] Newznab configured, using searchWithPersonalCloud`);
        const baseUrl = 'https://debrider.app/api/v1';
        const torrents = await getCachedTorrents(debridProvider, type, id, config, () => DebriderApp.searchWithPersonalCloud(apiKey, type, id, serviceConfig, baseUrl));
        if (torrents && torrents.length) {
          return torrents.sort(sortTorrents)
            .map(td => toDebriderStream(td, type, providerConfig))
            .filter(Boolean);
        }
      } else {
        // Regular search without Newznab
        const torrents = await getCachedTorrents(debridProvider, type, id, config, () => DebriderApp.search(apiKey, type, id, config));
        if (torrents && torrents.length) {
          return torrents.sort(sortTorrents)
            .map(td => toDebriderStream(td, type, providerConfig))
            .filter(Boolean);
        }
      }
    } else {
      // Fallback to regular search
      const torrents = await getCachedTorrents(debridProvider, type, id, config, () => DebriderApp.search(apiKey, type, id, config));
      if (torrents && torrents.length) {
        return torrents.sort(sortTorrents)
          .map(td => toDebriderStream(td, type, providerConfig))
          .filter(Boolean);
      }
    }
  } else if (debridProvider == "PersonalCloud") {
    const personalCloudConfig = {
      newznabUrl: config.PersonalCloudNewznabUrl,
      newznabApiKey: config.PersonalCloudNewznabApiKey,
      ...config
    };
    const baseUrl = config.PersonalCloudUrl || 'https://debrider.app/api/v1';
    const torrents = await getCachedTorrents(debridProvider, type, id, config, () => DebriderApp.searchWithPersonalCloud(apiKey, type, id, personalCloudConfig, baseUrl));
    if (torrents && torrents.length) {
      return torrents.sort(sortTorrents)
        .map(td => toDebriderStream(td, type, providerConfig))
        .filter(Boolean);
    }
  }
  return [];
}

async function getSeriesStreams(config, type, id) {
  const [imdbId, season, episode] = id.split(":");
  const cinemetaDetails = await Cinemeta.getMeta(type, imdbId);

  const cinemetaFailed = !cinemetaDetails || !cinemetaDetails.name;

  // Handle Cinemeta failure gracefully — skip debrid/torrent providers but still
  // try HTTP streaming providers that do their own metadata lookup.
  if (cinemetaFailed) {
    console.warn(`[STREAM-PROVIDER] Cinemeta returned no metadata for ${type}:${imdbId} - skipping debrid providers, trying HTTP streaming only`);
  }

  const searchKey = cinemetaDetails?.name || '';
  const tmdbIdFromMeta = cinemetaFailed ? null : resolveTmdbId(cinemetaDetails);

  const allStreamsPromises = [];
  const streamTasks = [];
  const addStreamTask = (promise, meta = {}) => {
    allStreamsPromises.push(promise);
    streamTasks.push({
      promise,
      provider: meta.provider || 'unknown',
      earlyReturnDisabled: meta.earlyReturnDisabled === true,
      earlyReturnTimeoutMs: meta.earlyReturnTimeoutMs
    });
  };

  // Support multiple debrid services (skip when Cinemeta failed — they need metadata for search)
  if (!cinemetaFailed && config.DebridServices && Array.isArray(config.DebridServices) && config.DebridServices.length > 0) {
    config.DebridServices.forEach(service => {
      const { disableEarlyReturn, earlyReturnTimeoutMs } = getServiceEarlyReturnConfig(service);
      const earlyReturnMeta = { earlyReturnDisabled: disableEarlyReturn, earlyReturnTimeoutMs };
      if (service.provider === 'Usenet') {
        // Handle Usenet service
        const usenetConfig = {
          NewznabUrl: service.newznabUrl,
          NewznabApiKey: service.apiKey,
          NntpAddress: service.nntpAddress,
          NntpPort: service.nntpPort,
          NntpUsername: service.nntpUsername,
          NntpPassword: service.nntpPassword,
          NntpConnections: service.nntpConnections || 4,
          NntpSsl: service.nntpSsl !== false,
          FileServerUrl: service.fileServerUrl || ''
        };
        const serviceName = 'Usenet';
        addStreamTask(
          (async () => {
            const startTime = Date.now();
            console.log(`[PARALLEL-SEARCH] 🚀 Starting ${serviceName} search at ${new Date(startTime).toISOString()}`);
            try {
              const results = await withTimeout(
                getUsenetStreams(usenetConfig, type, id),
                USENET_TIMEOUT_MS,
                'Usenet'
              );
              const duration = Date.now() - startTime;
              console.log(`[PARALLEL-SEARCH] ✅ ${serviceName} completed in ${(duration/1000).toFixed(2)}s with ${results?.length || 0} results`);
              return results;
            } catch (error) {
              const duration = Date.now() - startTime;
              console.error(`[PARALLEL-SEARCH] ❌ ${serviceName} failed after ${(duration/1000).toFixed(2)}s: ${error.message}`);
              throw error;
            }
          })(),
          { provider: serviceName, ...earlyReturnMeta }
        );
      } else if (service.provider === 'Easynews') {
        // Handle Easynews service with caching
        const easynewsConfig = {
          EasynewsUsername: service.username,
          EasynewsPassword: service.password,
          ...config
        };
        const serviceName = 'Easynews';
        addStreamTask(
          (async () => {
            const startTime = Date.now();
            console.log(`[PARALLEL-SEARCH] 🚀 Starting ${serviceName} search at ${new Date(startTime).toISOString()}`);
            try {
              const results = await withTimeout(
                getEasynewsStreams(easynewsConfig, type, id),
                SERVICE_TIMEOUT_MS,
                'Easynews'
              );
              const duration = Date.now() - startTime;
              console.log(`[PARALLEL-SEARCH] ✅ ${serviceName} completed in ${(duration/1000).toFixed(2)}s with ${results?.length || 0} results`);
              return results;
            } catch (error) {
              const duration = Date.now() - startTime;
              console.error(`[PARALLEL-SEARCH] ❌ ${serviceName} failed after ${(duration/1000).toFixed(2)}s: ${error.message}`);
              throw error;
            }
          })(),
          { provider: serviceName, ...earlyReturnMeta }
        );
      } else if (service.provider === 'HomeMedia') {
        // Handle Home Media Server
        const homeMediaConfig = {
          HomeMediaUrl: service.homeMediaUrl,
          HomeMediaApiKey: service.apiKey,
          Languages: config.Languages
        };
        const serviceName = 'HomeMedia';
        addStreamTask(
          (async () => {
            const startTime = Date.now();
            console.log(`[PARALLEL-SEARCH] 🚀 Starting ${serviceName} search at ${new Date(startTime).toISOString()}`);
            try {
              const results = await withTimeout(
                getHomeMediaStreams(homeMediaConfig, type, id),
                SERVICE_TIMEOUT_MS,
                'HomeMedia'
              );
              const duration = Date.now() - startTime;
              console.log(`[PARALLEL-SEARCH] ✅ ${serviceName} completed in ${(duration/1000).toFixed(2)}s with ${results?.length || 0} results`);
              return results;
            } catch (error) {
              const duration = Date.now() - startTime;
              console.error(`[PARALLEL-SEARCH] ❌ ${serviceName} failed after ${(duration/1000).toFixed(2)}s: ${error.message}`);
              throw error;
            }
          })(),
          { provider: serviceName, ...earlyReturnMeta }
        );
      } else if (service.provider === 'PersonalCloud') {
        // Handle Personal Cloud
        const personalCloudConfig = {
          PersonalCloudUrl: service.baseUrl,
          PersonalCloudNewznabUrl: service.newznabUrl,
          PersonalCloudNewznabApiKey: service.newznabApiKey,
          Languages: config.Languages,
          ...config
        };
        const serviceName = 'PersonalCloud';
        addStreamTask(
          (async () => {
            const startTime = Date.now();
            console.log(`[PARALLEL-SEARCH] 🚀 Starting ${serviceName} search at ${new Date(startTime).toISOString()}`);
            try {
              const results = await withTimeout(
                getMovieStreamsFromProvider('PersonalCloud', service.apiKey, type, id, personalCloudConfig, cinemetaDetails, searchKey),
                SERVICE_TIMEOUT_MS,
                'PersonalCloud'
              );
              const duration = Date.now() - startTime;
              console.log(`[PARALLEL-SEARCH] ✅ ${serviceName} completed in ${(duration/1000).toFixed(2)}s with ${results?.length || 0} results`);
              return results;
            } catch (error) {
              const duration = Date.now() - startTime;
              console.error(`[PARALLEL-SEARCH] ❌ ${serviceName} failed after ${(duration/1000).toFixed(2)}s: ${error.message}`);
              throw error;
            }
          })(),
          { provider: serviceName, ...earlyReturnMeta }
        );
      } else if (service.provider === 'httpstreaming') {
        // Fetch streams based on user's selected HTTP streaming sources with caching
        // Only enable providers explicitly set to true (not default-on)
        const use4KHDHub = service.http4khdhub === true;
        const useHDHub4u = service.httpHDHub4u === true;
        const useUHDMovies = service.httpUHDMovies === true;
        const useMoviesDrive = service.httpMoviesDrive === true;
        const useMKVCinemas = service.httpMKVCinemas === true;
        const useMkvDrama = service.httpMkvDrama === true;
        const useMalluMv = service.httpMalluMv === true;
        const useCineDoze = service.httpCineDoze === true;
        const useXDMovies = service.httpXDMovies === true;
        const useVixSrc = service.httpVixSrc === true;
        const useNetflixMirror = service.httpNetflixMirror === true;
        const useMoviesMod = service.httpMoviesMod === true;
        const useMoviesLeech = service.httpMoviesLeech === true;
        const useAnimeFlix = service.httpAnimeFlix === true;
        const allowMkvDramaForTitle = shouldUseMkvDramaForTitle(cinemetaDetails);
        const vixSrcId = tmdbIdFromMeta || imdbId;

        // HTTP streaming providers should NOT block early return — they are independent
        // fast providers that complete within their own timeouts. Blocking early return
        // forces the response to wait for all HTTP providers before returning any results.
        if (use4KHDHub) {
          addStreamTask(
            withTimeout(
              getCachedTorrents('httpstreaming', type, `${imdbId}-4khdhub-${season}:${episode}`, config, () =>
                get4KHDHubStreams(imdbId, type, season, episode, config)
              ).then(streams => wrapHttpStreamsWithResolver(streams, config.host)),
              getHttpStreamingTimeout('4KHDHub'),
              '4KHDHub'
            ),
            { provider: '4KHDHub', earlyReturnDisabled: false, earlyReturnTimeoutMs: earlyReturnMeta.earlyReturnTimeoutMs }
          );
        }

        if (useHDHub4u) {
          addStreamTask(
            withTimeout(
              getCachedTorrents('httpstreaming', type, `${imdbId}-hdhub4u-${season}:${episode}`, config, () =>
                getHDHub4uStreams(imdbId, type, season, episode, config)
              ).then(streams => wrapHttpStreamsWithResolver(streams, config.host)),
              getHttpStreamingTimeout('HDHub4u'),
              'HDHub4u'
            ),
            { provider: 'HDHub4u', earlyReturnDisabled: false, earlyReturnTimeoutMs: earlyReturnMeta.earlyReturnTimeoutMs }
          );
        }

        if (useMKVCinemas) {
          addStreamTask(
            withTimeout(
              getCachedTorrents('httpstreaming', type, `${imdbId}-mkvcinemas2-${season}:${episode}`, config, () =>
                getMKVCinemasStreams(imdbId, type, season, episode, config)
              ).then(streams => {
                const wrapped = wrapHttpStreamsWithResolver(streams, config.host);
                backgroundPreResolve(wrapped, 'MKVCinemas');
                return wrapped;
              }),
              getHttpStreamingTimeout('MKVCinemas'),
              'MKVCinemas'
            ),
            { provider: 'MKVCinemas', earlyReturnDisabled: false, earlyReturnTimeoutMs: earlyReturnMeta.earlyReturnTimeoutMs }
          );
        }

        if (useMkvDrama && allowMkvDramaForTitle) {
          addStreamTask(
            withTimeout(
              getMkvDramaStreams(imdbId, type, season, episode, config)
                .then(streams => wrapHttpStreamsWithResolver(streams, config.host)),
              getHttpStreamingTimeout('MkvDrama'),
              'MkvDrama'
            ),
            { provider: 'MkvDrama', earlyReturnDisabled: true, earlyReturnTimeoutMs: earlyReturnMeta.earlyReturnTimeoutMs }
          );
        } else if (useMkvDrama) {
          console.log('[MKVDrama] Skipping MKVDrama for non-Asian title due to MKVDRAMA_ASIAN_ONLY=true');
        }

        if (useCineDoze) {
          addStreamTask(
            withTimeout(
              getCachedTorrents('httpstreaming', type, `${imdbId}-cinedoze-${season}:${episode}`, config, () =>
                getCineDozeStreams(imdbId, type, season, episode, config)
              ).then(streams => wrapHttpStreamsWithResolver(streams, config.host)),
              getHttpStreamingTimeout('CineDoze'),
              'CineDoze'
            ),
            { provider: 'CineDoze', earlyReturnDisabled: false, earlyReturnTimeoutMs: earlyReturnMeta.earlyReturnTimeoutMs }
          );
        }

        if (useMalluMv) {
          addStreamTask(
            withTimeout(
              getCachedTorrents('httpstreaming', type, `${imdbId}-mallumv-${season}:${episode}`, config, () =>
                getMalluMvStreams(imdbId, type, season, episode, config)
              ).then(streams => wrapHttpStreamsWithResolver(streams, config.host)),
              getHttpStreamingTimeout('MalluMv'),
              'MalluMv'
            ),
            { provider: 'MalluMv', earlyReturnDisabled: false, earlyReturnTimeoutMs: earlyReturnMeta.earlyReturnTimeoutMs }
          );
        }

        if (useUHDMovies) {
          addStreamTask(
            withTimeout(
              getCachedTorrents('httpstreaming', type, `${imdbId}-uhdmovies-${season}:${episode}`, config, () =>
                getUHDMoviesStreams(imdbId, imdbId, type, season, episode, config)
              ).then(streams => wrapHttpStreamsWithResolver(streams, config.host)),
              getHttpStreamingTimeout('UHDMovies'),
              'UHDMovies'
            ),
            { provider: 'UHDMovies', earlyReturnDisabled: false, earlyReturnTimeoutMs: earlyReturnMeta.earlyReturnTimeoutMs }
          );
        }


        if (useMoviesDrive) {
          addStreamTask(
            withTimeout(
              getCachedTorrents('httpstreaming', type, `${imdbId}-moviesdrive-${season}:${episode}`, config, () =>
                getMoviesDriveStreams(imdbId, imdbId, type, season, episode, config)
              ).then(streams => wrapHttpStreamsWithResolver(streams, config.host)),
              getHttpStreamingTimeout('MoviesDrive'),
              'MoviesDrive'
            ),
            { provider: 'MoviesDrive', earlyReturnDisabled: false, earlyReturnTimeoutMs: earlyReturnMeta.earlyReturnTimeoutMs }
          );
        }

        if (useXDMovies) {
          addStreamTask(
            withTimeout(
              getCachedTorrents('httpstreaming', type, `${imdbId}-xdmovies-${season}:${episode}`, config, () =>
                getXDMoviesStreams(imdbId, type, season, episode, config, cinemetaDetails)
              ).then(streams => wrapHttpStreamsWithResolver(streams, config.host)),
              getHttpStreamingTimeout('XDMovies'),
              'XDMovies'
            ),
            { provider: 'XDMovies', earlyReturnDisabled: false, earlyReturnTimeoutMs: earlyReturnMeta.earlyReturnTimeoutMs }
          );
        }

        if (useVixSrc) {
          // VixSrc uses session-based URLs that expire quickly - don't cache
          addStreamTask(
            withTimeout(
              getVixSrcStreams(vixSrcId, type, season, episode)
                .then(streams => wrapHttpStreamsWithResolver(streams, config.host)),
              getHttpStreamingTimeout('VixSrc'),
              'VixSrc'
            ),
            { provider: 'VixSrc', earlyReturnDisabled: false, earlyReturnTimeoutMs: earlyReturnMeta.earlyReturnTimeoutMs }
          );
        }

        if (useNetflixMirror) {
          // NetflixMirror uses session-based URLs that expire quickly - don't cache
          addStreamTask(
            withTimeout(
              getNetflixMirrorStreams(imdbId, type, season, episode, config, cinemetaDetails)
                .then(streams => wrapHttpStreamsWithResolver(streams, config.host)),
              getHttpStreamingTimeout('NetflixMirror'),
              'NetflixMirror'
            ),
            { provider: 'NetflixMirror', earlyReturnDisabled: false, earlyReturnTimeoutMs: earlyReturnMeta.earlyReturnTimeoutMs }
          );
        }

        if (useMoviesMod) {
          addStreamTask(
            withTimeout(
              getCachedTorrents('httpstreaming', type, `${imdbId}-moviesmod-${season}:${episode}`, config, () =>
                getMoviesModStreams(imdbId, type, season, episode, config, cinemetaDetails)
              ).then(streams => wrapHttpStreamsWithResolver(streams, config.host)),
              getHttpStreamingTimeout('MoviesMod'),
              'MoviesMod'
            ),
            { provider: 'MoviesMod', earlyReturnDisabled: false, earlyReturnTimeoutMs: earlyReturnMeta.earlyReturnTimeoutMs }
          );
        }

        if (useMoviesLeech) {
          addStreamTask(
            withTimeout(
              getCachedTorrents('httpstreaming', type, `${imdbId}-moviesleech-${season}:${episode}`, config, () =>
                getMoviesLeechStreams(imdbId, type, season, episode, config, cinemetaDetails)
              ).then(streams => wrapHttpStreamsWithResolver(streams, config.host)),
              getHttpStreamingTimeout('MoviesLeech'),
              'MoviesLeech'
            ),
            { provider: 'MoviesLeech', earlyReturnDisabled: false, earlyReturnTimeoutMs: earlyReturnMeta.earlyReturnTimeoutMs }
          );
        }

        if (useAnimeFlix) {
          addStreamTask(
            withTimeout(
              getCachedTorrents('httpstreaming', type, `${imdbId}-animeflix-${season}:${episode}`, config, () =>
                getAnimeFlixStreams(imdbId, type, season, episode, config, cinemetaDetails)
              ).then(streams => wrapHttpStreamsWithResolver(streams, config.host)),
              getHttpStreamingTimeout('AnimeFlix'),
              'AnimeFlix'
            ),
            { provider: 'AnimeFlix', earlyReturnDisabled: false, earlyReturnTimeoutMs: earlyReturnMeta.earlyReturnTimeoutMs }
          );
        }

      } else {
        // Handle regular debrid service
        const serviceName = service.provider;
        addStreamTask(
          (async () => {
            const startTime = Date.now();
            console.log(`[PARALLEL-SEARCH] 🚀 Starting ${serviceName} search at ${new Date(startTime).toISOString()}`);
            try {
              const results = await getSeriesStreamsFromProvider(service.provider, service.apiKey, type, id, config, cinemetaDetails, searchKey, season, episode);
              const duration = Date.now() - startTime;
              console.log(`[PARALLEL-SEARCH] ✅ ${serviceName} completed in ${(duration/1000).toFixed(2)}s with ${results?.length || 0} results`);
              return results;
            } catch (error) {
              const duration = Date.now() - startTime;
              console.error(`[PARALLEL-SEARCH] ❌ ${serviceName} failed after ${(duration/1000).toFixed(2)}s: ${error.message}`);
              throw error;
            }
          })(),
          { provider: serviceName, ...earlyReturnMeta }
        );
      }
    });
  } else if (!cinemetaFailed) {
    // Backward compatibility: single service (skip when Cinemeta failed)
    let apiKey = config.DebridLinkApiKey ? config.DebridLinkApiKey : config.DebridApiKey;
    const debridProvider = config.DebridProvider || (config.DebridLinkApiKey ? "DebridLink" : null);

    if (debridProvider) {
      addStreamTask(
        getSeriesStreamsFromProvider(debridProvider, apiKey, type, id, config, cinemetaDetails, searchKey, season, episode),
        { provider: debridProvider }
      );
    }
  }

  if (allStreamsPromises.length === 0) {
    if (cinemetaFailed) {
      console.warn(`[STREAM-PROVIDER] No HTTP streaming providers configured — returning empty for ${type}:${imdbId}`);
      return [];
    }
    return Promise.reject(BadRequestError);
  }

  const totalStartTime = Date.now();
  console.log(`[PARALLEL-SEARCH] 🔥 Executing ${allStreamsPromises.length} service searches IN PARALLEL...`);

  // EARLY RETURN OPTIMIZATION: Return results as soon as we have enough quality streams
  let flatStreams = [];

  if (EARLY_RETURN_ENABLED && allStreamsPromises.length > 1) {
    const completedResults = [];
    const completedIndexes = new Set();
    const blockedIndexes = streamTasks
      .map((task, index) => task.earlyReturnDisabled ? index : null)
      .filter(index => index !== null);
    const timeoutOverrides = streamTasks
      .filter(task => !task.earlyReturnDisabled)
      .map(task => task.earlyReturnTimeoutMs)
      .filter(value => Number.isFinite(value));
    const earlyReturnTimeoutMs = Math.max(EARLY_RETURN_TIMEOUT_MS, ...timeoutOverrides);

    let earlyReturnTriggered = false;
    let timerFired = false;
    let allComplete = false;
    let earlyReturnResolve;
    const earlyReturnGate = new Promise(resolve => {
      earlyReturnResolve = resolve;
    });

    const maybeTriggerEarlyReturn = () => {
      if (earlyReturnTriggered || allComplete || !timerFired) return;

      const currentStreams = completedResults.flatMap(r => r.result || []);
      const pendingBlockers = blockedIndexes.filter(index => !completedIndexes.has(index));
      if (pendingBlockers.length > 0) return;

      if (currentStreams.length >= EARLY_RETURN_MIN_STREAMS) {
        earlyReturnTriggered = true;
        earlyReturnResolve('early-return');
      }
    };

    const timerId = setTimeout(() => {
      timerFired = true;
      const currentStreams = completedResults.flatMap(r => r.result || []);
      const pendingProviders = allStreamsPromises.length - completedResults.length;
      const pendingBlockers = blockedIndexes.filter(index => !completedIndexes.has(index));
      console.log(`[PARALLEL-SEARCH] ⏱️ Early return check: ${completedResults.length}/${allStreamsPromises.length} providers complete, ${currentStreams.length} streams collected (need ${EARLY_RETURN_MIN_STREAMS})`);
      if (pendingBlockers.length > 0) {
        const pendingBlockerNames = pendingBlockers
          .map(index => streamTasks[index]?.provider)
          .filter(Boolean);
        if (pendingBlockerNames.length > 0) {
          console.log(`[PARALLEL-SEARCH] ⏳ Early return waiting for ${pendingBlockerNames.join(', ')}`);
        }
      }
      const canEarlyReturn = pendingBlockers.length === 0 && currentStreams.length >= EARLY_RETURN_MIN_STREAMS;
      if (!canEarlyReturn && pendingProviders > 0) {
        console.log(`[PARALLEL-SEARCH] ⏳ ${pendingProviders} provider(s) still running after early return timeout`);
      }
      maybeTriggerEarlyReturn();
    }, earlyReturnTimeoutMs);

    const trackedPromises = allStreamsPromises.map((promise, index) =>
      promise.then(result => {
        completedResults.push({ index, result, status: 'fulfilled' });
        completedIndexes.add(index);
        maybeTriggerEarlyReturn();
        return result;
      }).catch(err => {
        completedResults.push({ index, result: [], status: 'rejected', error: err });
        completedIndexes.add(index);
        maybeTriggerEarlyReturn();
        return [];
      })
    );

    const allCompletePromise = Promise.all(trackedPromises).then(() => {
      allComplete = true;
      return 'all-complete';
    });

    const raceResult = await Promise.race([allCompletePromise, earlyReturnGate]);

    clearTimeout(timerId);

    if (raceResult === 'early-return') {
      const currentStreams = completedResults.flatMap(r => r.result || []);
      flatStreams = currentStreams;
      const elapsed = Date.now() - totalStartTime;
      console.log(`[PARALLEL-SEARCH] ⚡ EARLY RETURN after ${elapsed}ms with ${flatStreams.length} streams (${completedResults.length}/${allStreamsPromises.length} providers complete)`);

      Promise.all(trackedPromises).then(() => {
        const bgDuration = Date.now() - totalStartTime;
        console.log(`[PARALLEL-SEARCH] 🔄 Background providers completed in ${(bgDuration/1000).toFixed(2)}s total`);
      }).catch(() => {});
    }

    if (!earlyReturnTriggered) {
      await Promise.all(trackedPromises);
      flatStreams = completedResults.flatMap(r => r.result || []);
      const totalDuration = Date.now() - totalStartTime;
      console.log(`[PARALLEL-SEARCH] 🏁 All ${allStreamsPromises.length} searches completed in ${(totalDuration/1000).toFixed(2)}s (parallel execution)`);
    }
  } else {
    const allStreams = await Promise.all(allStreamsPromises);
    const totalDuration = Date.now() - totalStartTime;
    console.log(`[PARALLEL-SEARCH] 🏁 All ${allStreamsPromises.length} searches completed in ${(totalDuration/1000).toFixed(2)}s (parallel execution)`);
    flatStreams = allStreams.flat();
  }

  // Apply size filter if configured
  const minSize = config.minSize !== undefined ? config.minSize : 0;
  const maxSize = config.maxSize !== undefined ? config.maxSize : 200;
  flatStreams = filterBySize(flatStreams, minSize, maxSize);

  // Apply language filter if configured
  if (config.Languages && config.Languages.length > 0) {
    flatStreams = filterStreamsByLanguage(flatStreams, config.Languages);
  }

  // Apply resolution filter if configured
  if (config.Resolutions && config.Resolutions.length > 0) {
    flatStreams = filterByResolution(flatStreams, config.Resolutions);
  }

  // Apply episode filter to remove wrong episodes from all services
  // Pass showTitle to also filter out results from different shows (e.g., "Crime Story" when searching for "Fallout")
  flatStreams = filterByEpisode(flatStreams, season, episode, cinemetaDetails?.name);

  // Apply proxy to HTTP streaming and Easynews streams if configured
  flatStreams = applyProxyToStreams(flatStreams, config);

  // Cross-provider deduplication: if a torrent exists in personal cloud AND as external cached,
  // keep only the personal version to avoid showing duplicate entries
  flatStreams = deduplicatePersonalStreams(flatStreams);

  // Sort streams: personal files first, then by resolution (highest to lowest), then by size (largest to smallest)
  flatStreams.sort((a, b) => {
    if (a.isPersonal && !b.isPersonal) return -1;
    if (!a.isPersonal && b.isPersonal) return 1;

    const resA = a.resolution || getResolutionFromName(a.name || a.title || '');
    const resB = b.resolution || getResolutionFromName(b.name || b.title || '');
    const rankA = resolutionOrder[resA] || 0;
    const rankB = resolutionOrder[resB] || 0;
    if (rankA !== rankB) return rankB - rankA;

    const sizeA = a._size || (a.size ? sizeToBytes(a.size) : 0);
    const sizeB = b._size || (b.size ? sizeToBytes(b.size) : 0);
    return sizeB - sizeA;
  });

  return flatStreams;
}

async function resolveUrl(debridProvider, debridApiKey, itemId, hostUrl, clientIp, config = {}) {
  const provider = debridProvider.toLowerCase();
  const useResolveCache = provider !== 'realdebrid';
  const sanitizedConfig = sanitizeConfig(config, 'RESOLVER');
  config = sanitizedConfig;
  const sanitizedKey = sanitizeToken(debridApiKey, 'debridApiKey', 'RESOLVER');
  const apiKey = sanitizedKey || debridApiKey;

  // Validate hostUrl before attempting to use it
  if (!hostUrl || hostUrl === 'undefined') {
    console.error(`[RESOLVER] Invalid or missing hostUrl: ${hostUrl}`);
    return null;
  }

  const cacheKey = buildResolveCacheKey(provider, apiKey, hostUrl, clientIp);
  if (useResolveCache) {
    const cacheState = getResolveCache(cacheKey);
    if (cacheState.status === 'success') {
      console.log(`[RESOLVER] Cache hit for ${provider} resolve (${cacheKey})`);
      return cacheState.value;
    }
    if (cacheState.status === 'fail') {
      console.warn(`[RESOLVER] Recent failed resolve for ${provider}, short-circuiting retry (${cacheKey})`);
      return null;
    }

    if (resolveInFlight.has(cacheKey)) {
      console.log(`[RESOLVER] Joining in-flight resolve for ${provider}: ${cacheKey}`);
      return resolveInFlight.get(cacheKey);
    }
  } else if (resolveInFlight.has(cacheKey)) {
    console.log(`[RESOLVER] Joining in-flight resolve for ${provider}: ${cacheKey} (no-cache mode)`);
    return resolveInFlight.get(cacheKey);
  }

  console.log(`[RESOLVER] resolveUrl called with provider: ${provider}, hostUrl: ${hostUrl.substring(0, 100)}${hostUrl.length > 100 ? '...' : ''}`);

  // Handle NZB URLs for DebriderApp/PersonalCloud
  if (hostUrl.startsWith('nzb:') && (provider === 'debriderapp' || provider === 'personalcloud')) {
    const nzbUrl = hostUrl.substring(4); // Remove 'nzb:' prefix
    const newznabApiKey = sanitizedConfig.PersonalCloudNewznabApiKey || sanitizedConfig.newznabApiKey || '';
    const baseUrl = sanitizedConfig.PersonalCloudUrl || 'https://debrider.app/api/v1';

    console.log(`[RESOLVER] Processing NZB download for ${provider}...`);

    try {
      // Submit NZB to Personal Cloud
      const taskInfo = await DebriderApp.submitNzb(apiKey, nzbUrl, newznabApiKey, baseUrl);
      console.log(`[RESOLVER] NZB task created: ${taskInfo.taskId}`);

      // Wait for task to complete and get video file
      const completedTask = await DebriderApp.waitForTaskCompletion(apiKey, taskInfo.taskId, baseUrl, 300000);

      if (completedTask.videoFiles && completedTask.videoFiles.length > 0) {
        // Return the largest video file
        const largestVideo = completedTask.videoFiles.reduce((a, b) => (a.size > b.size ? a : b));
        const videoUrl = largestVideo.download_link || largestVideo.url;
        console.log(`[RESOLVER] NZB download complete, returning video URL`);
        if (useResolveCache) storeResolveCache(cacheKey, videoUrl);
        return videoUrl;
      } else {
        throw new Error('No video files found in completed task');
      }
    } catch (error) {
      console.error(`[RESOLVER] NZB processing error: ${error.message}`);
      if (useResolveCache) storeResolveCache(cacheKey, null);
      return null;
    }
  }

  if (!isValidUrl(hostUrl)) {
    console.error(`[RESOLVER] Invalid URL provided: ${hostUrl}`);
    return null;
  }
  const performResolve = async () => {
    try {
      if (provider === "realdebrid") {
        if (hostUrl.startsWith('magnet:') || hostUrl.includes('||HINT||')) {
          const maxRetries = 20; // Increase retries to allow more time for links to become available
          const retryInterval = 3000; // Reduce delay to allow more attempts
          let episodeHint = null;
          if (hostUrl.includes('||HINT||')) {
            try {
              const parts = hostUrl.split('||HINT||');
              hostUrl = parts[0];
              episodeHint = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf-8'));
            } catch (_) { episodeHint = null; }
          }

        // Import rate limiter dynamically to avoid circular dependencies
        const RdLimiter = (await import('./util/rd-rate-limit.js')).default;
        const rdCall = (fn) => RdLimiter.schedule(fn, 'rd-call', apiKey);

        const normalizedClientIp = normalizeClientIp(clientIp);
        const rdClientOptions = normalizedClientIp
          ? {
            ip: normalizedClientIp,
            headers: {
              'X-Forwarded-For': normalizedClientIp,
              'X-Real-IP': normalizedClientIp
            }
          }
          : {};
        const RD = new RealDebridClient(apiKey, rdClientOptions);
        let torrentId = null;
        let createdTorrent = false;
        try {
          const magnetHash = extractMagnetHash(hostUrl);
          const blockedStatuses = new Set(['magnet_error', 'error', 'virus', 'dead']);

          if (magnetHash) {
            await withRealDebridMagnetLock(apiKey, magnetHash, async () => {
              torrentId = await findExistingRdTorrentIdByHash(RD, rdCall, magnetHash, blockedStatuses);
              if (torrentId) {
                console.log(`[RESOLVER] Reusing existing RD torrent ${torrentId} for hash ${magnetHash.substring(0, 12)}...`);
                return;
              }

              const addResponse = await rdCall(() => RD.torrents.addMagnet(hostUrl));
              if (!addResponse?.data?.id) throw new Error("Failed to add magnet.");
              torrentId = addResponse.data.id;
              createdTorrent = true;
              console.log(`[RESOLVER] Added new RD magnet as torrent ${torrentId}`);
            });
          } else {
            const addResponse = await rdCall(() => RD.torrents.addMagnet(hostUrl));
            if (!addResponse?.data?.id) throw new Error("Failed to add magnet.");
            torrentId = addResponse.data.id;
            createdTorrent = true;
            console.log(`[RESOLVER] Added new RD magnet as torrent ${torrentId} (no hash lock)`);
          }

          let torrentInfo = await rdCall(() => RD.torrents.info(torrentId));
          const hasSelectedFiles = Array.isArray(torrentInfo?.data?.files)
            ? torrentInfo.data.files.some(file => file?.selected)
            : false;
          if (!hasSelectedFiles || torrentInfo?.data?.status === 'waiting_files_selection') {
            await rdCall(() => RD.torrents.selectFiles(torrentId, 'all'));
            torrentInfo = await rdCall(() => RD.torrents.info(torrentId));
          }

          // First wait for the torrent to be processed and ready
          const uncachedStatuses = new Set(['downloading', 'queued']);
          for (let i = 0; i < maxRetries; i++) {
              torrentInfo = await rdCall(() => RD.torrents.info(torrentId));
              const status = String(torrentInfo?.data?.status || '').toLowerCase();
              if (status === 'downloaded' || status === 'finished') break;
              if (blockedStatuses.has(status)) throw new Error(`Torrent failed: ${status}`);
              if (i === 0 && config?.cacheKey && uncachedStatuses.has(status)) {
                const cacheHash = config.cacheHash || extractMagnetHash(hostUrl);
                if (cacheHash) {
                  await removeCachedSearchResult(config.cacheKey, cacheHash);
                  await SqliteCache.deleteCachedHash(provider, cacheHash);
                }
                throw new Error(`Torrent not cached (status: ${status})`);
              }
              if (i === maxRetries - 1) throw new Error(`Torrent not ready after ${Math.ceil((maxRetries*retryInterval)/1000)}s`);
              await new Promise(r => setTimeout(r, retryInterval));
            }
            
            // Now wait for links to become available (separate from download status)
            let links = torrentInfo?.data?.links || [];
            if (links.length === 0) {
              console.log(`[RESOLVER] Links not available yet, waiting for them to be generated...`);
              for (let i = 0; i < maxRetries; i++) {
                torrentInfo = await rdCall(() => RD.torrents.info(torrentId));
                links = torrentInfo?.data?.links || [];
                if (links.length > 0) {
                  console.log(`[RESOLVER] Links are now available: ${links.length} links found`);
                  break;
                }
                if (i === maxRetries - 1) throw new Error("No streamable links found after waiting");
                await new Promise(r => setTimeout(r, retryInterval));
              }
            }
            
            if (!links.length) throw new Error("No streamable links found.");
            
            const files = torrentInfo.data.files || [];
            const videoFiles = files.filter(f => f.selected);
            if (videoFiles.length === 0) throw new Error("No valid video files.");
            
            let chosen = null;
            if (episodeHint) {
              if (episodeHint.fileId != null) chosen = videoFiles.find(f => f.id === episodeHint.fileId) || null;
              if (!chosen && episodeHint.filePath) chosen = videoFiles.find(f => f.path === episodeHint.filePath) || null;
              if (!chosen && episodeHint.season && episodeHint.episode) {
                const s = String(episodeHint.season).padStart(2, '0');
                const e = String(episodeHint.episode).padStart(2, '0');
                const patterns = [
                  new RegExp('[sS][\\W_]*' + s + '[\\W_]*[eE][\\W_]*' + e, 'i'),
                  new RegExp('\\b' + Number(episodeHint.season) + '[\\W_]*x[\\W_]*' + e + '\\b', 'i'),
                  new RegExp('\\b[eE]p?\\.?\\s*' + Number(episodeHint.episode) + '\\b', 'i'),
                  new RegExp('episode\\s*' + Number(episodeHint.episode), 'i')
                ];
                chosen = videoFiles.find(f => patterns.some(p => p.test(f.path))) || null;
              }
            }
            if (!chosen) chosen = videoFiles.reduce((a, b) => (a.bytes > b.bytes ? a : b));
            
            // Find the correct link for the chosen file
            // RD API behavior: links[] array maps to files[] array (links[i] is for files[i])
            let directUrl = null;
            const chosenFileId = String(chosen.id);

            // Method 1: Check if file has its own links property (newer API format)
            if (chosen.links && Array.isArray(chosen.links) && chosen.links.length > 0) {
              directUrl = chosen.links[0];
              console.log(`[RESOLVER] Found direct URL using file.links property for file ${chosenFileId}`);
            }

            // Method 2: Find the file's index in ALL files, then use that to index into links array
            // This is the standard RD API mapping: links[i] corresponds to files[i]
            if (!directUrl) {
              const fileIndexInAll = files.findIndex(f => String(f.id) === chosenFileId);
              if (fileIndexInAll !== -1 && fileIndexInAll < links.length) {
                const potentialUrl = links[fileIndexInAll];
                if (potentialUrl && potentialUrl !== 'undefined') {
                  directUrl = potentialUrl;
                  console.log(`[RESOLVER] Found direct URL at index ${fileIndexInAll} for file ${chosenFileId}`);
                }
              } else {
                console.log(`[RESOLVER] Method 2 failed: File index: ${fileIndexInAll}, links length: ${links.length}, files length: ${files.length}`);
              }
            }

            // Method 3: Try finding among selected files only (fallback for edge cases)
            // Some RD API versions may only return links for selected files
            if (!directUrl) {
              const selectedFiles = files.filter(f => f.selected);
              const indexInSelected = selectedFiles.findIndex(f => String(f.id) === chosenFileId);
              if (indexInSelected !== -1 && indexInSelected < links.length) {
                const potentialUrl = links[indexInSelected];
                if (potentialUrl && potentialUrl !== 'undefined') {
                  directUrl = potentialUrl;
                  console.log(`[RESOLVER] Found direct URL at selected-index ${indexInSelected} for file ${chosenFileId}`);
                }
              } else {
                console.log(`[RESOLVER] Method 3 failed: Selected index: ${indexInSelected}, selected files: ${selectedFiles.length}`);
              }
            }

            if (!directUrl || directUrl === 'undefined') {
              // Enhanced debugging: show all files and their selection status
              console.error(`[RESOLVER] RD magnet error: Direct URL not found for torrent ${torrentId}, file ${chosenFileId}`);
              console.error(`[RESOLVER] Files info: ${files.length} total files, ${videoFiles.length} selected video files, ${links.length} links`);
              files.forEach((f, idx) => {
                console.error(`[RESOLVER]   File[${idx}]: id=${f.id}, selected=${f.selected}, path=${f.path}`);
              });
              links.forEach((link, idx) => {
                console.error(`[RESOLVER]   Link[${idx}]: ${link ? 'present' : 'missing'}`);
              });
              throw new Error("Direct URL not found.");
            }
            
            const unrestrictedUrl = await RealDebrid.unrestrictUrl(apiKey, directUrl, clientIp);
            if (!unrestrictedUrl) throw new Error("Unrestrict failed.");
            return unrestrictedUrl;
        } catch (error) {
          const status = error?.response?.status || error?.status;
          console.error(`[RESOLVER] RD magnet error: ${error.message}${status ? ` (HTTP ${status})` : ''}`);
          if (createdTorrent && torrentId) {
            try { await rdCall(() => RD.torrents.delete(torrentId)); } catch (_) {}
          }
          return null;
        }
      } else {
        return RealDebrid.unrestrictUrl(apiKey, hostUrl, clientIp);
      }
    } else if (provider === "offcloud") {
      let inferredType = null;
      if (itemId && typeof itemId === 'string') {
        const parts = itemId.split(':');
        inferredType = parts.length > 1 ? 'series' : 'movie';
      }
      const resolvedUrl = await OffCloud.resolveStream(apiKey, hostUrl, inferredType, itemId);
      if (!resolvedUrl) {
        console.error("[RESOLVER] OffCloud returned empty for resolve, giving up.");
        return null;
      }
      return resolvedUrl;
      } else if (provider === "debridlink") {
        return hostUrl;
      } else if (provider === "premiumize") {
        if (hostUrl.startsWith('magnet:')) {
            let episodeHint = null;
            if (hostUrl.includes('||HINT||')) {
                try {
                    const parts = hostUrl.split('||HINT||');
                    hostUrl = parts[0];
                    episodeHint = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf-8'));
                } catch (_) { episodeHint = null; }
            }

            const directDownload = await Premiumize.getDirectDownloadLink(apiKey, hostUrl);
            if (!directDownload) {
                throw new Error("Failed to get direct download link from Premiumize.");
            }

            let videos = [];
            if (directDownload.content && Array.isArray(directDownload.content) && directDownload.content.length > 0) {
                // Multi-file torrent
                videos = directDownload.content
                    .filter(f => isVideo(f.path))
                    .map(f => ({ ...f, name: f.path })); // Normalize name for PTT
            } else if (directDownload.location && isVideo(directDownload.filename)) {
                // Single file torrent
                videos.push({
                    name: directDownload.filename,
                    size: directDownload.filesize,
                    stream_link: directDownload.stream_link || directDownload.location,
                    link: directDownload.location,
                });
            }

            if (videos.length === 0) {
                throw new Error("No video files found in direct download response.");
            }

            let chosenVideo = null;
            if (videos.length > 1 && episodeHint && episodeHint.season && episodeHint.episode) {
                const s = Number(episodeHint.season);
                const e = Number(episodeHint.episode);

                chosenVideo = videos.find(f => {
                    const pttInfo = PTT.parse(f.name);
                    return pttInfo.season === s && pttInfo.episode === e;
                });
            }

            if (!chosenVideo) {
                if (videos.length > 1) {
                    chosenVideo = videos.reduce((a, b) => (a.size > b.size ? a : b));
                } else {
                    chosenVideo = videos[0];
                }
            }

            const streamLink = chosenVideo.stream_link || chosenVideo.link;
            if (!streamLink) {
                throw new Error("No streamable link found for the chosen video file.");
            }

            return streamLink;
        }
        return hostUrl; // for non-magnet links
      } else if (provider === "alldebrid") {
        return AllDebrid.resolveStreamUrl(apiKey, hostUrl, clientIp);
      } else if (provider === "torbox") {
        return TorBox.unrestrictUrl(apiKey, itemId, hostUrl, clientIp);
      } else {
        throw new Error(`Unsupported debrid provider: ${debridProvider}`);
      }
    } catch (error) {
      console.error(`[RESOLVER] Critical error for ${debridProvider}: ${error.message}`);
      if (error.stack) console.error(error.stack);
      return null;
    }
  };

  const inflightPromise = performResolve().finally(() => {
    resolveInFlight.delete(cacheKey);
  });
  resolveInFlight.set(cacheKey, inflightPromise);

  const resolved = await inflightPromise;
  if (useResolveCache) storeResolveCache(cacheKey, resolved);
  return resolved;
}

function toStream(details, type, config, streamHint = {}) {
  let video = details;
  let icon = details.isPersonal ? '☁️' : '💾';
  let personalTag = details.isPersonal ? '[Cloud] ' : '';
  // Defer URL validity check until after we build the final streamUrl

  function shouldUseArchiveName(videoFileName, archiveName) {
    if (!videoFileName || !archiveName) return false;
    const meaningfulPatterns = [
      /s\d{2}e\d{2}/i,
      /1080p|720p|480p|2160p|4k/i,
      /bluray|web|hdtv|dvd|brrip/i,
      /x264|x265|h264|h265/i,
      /remaster|director|extended/i,
      /\d{4}/
    ];
    return !meaningfulPatterns.some(p => p.test(videoFileName));
  }

  let displayName = video.name || video.title || 'Unknown';
  // Detect languages from the display name and render flags
  const detectedLanguages = detectLanguagesFromTitle(displayName);
  const flagsSuffix = renderLanguageFlags(detectedLanguages);
  if (video.searchableName && shouldUseArchiveName(video.name, video.searchableName)) {
    const archiveName = video.searchableName.split(' ')[0] || video.name;
    displayName = archiveName;
  }

  let title = personalTag + displayName + flagsSuffix;
  if (type == 'series' && video.name && video.name !== displayName) title = title + '\n' + video.name;
  
  const pttInfo = PTT.parse(displayName);
  if (type === 'series' && streamHint.season && streamHint.episode && pttInfo.season && !pttInfo.episode) {
    const episodeInfo = `S${String(streamHint.season).padStart(2, '0')}E${String(streamHint.episode).padStart(2, '0')}`;
    title = `${personalTag}${displayName}\n${episodeInfo}${flagsSuffix}`;
  }

  const trackerLabel = [details.tracker, details.Tracker, details.originalSource]
    .find(value => typeof value === 'string' && value.trim())?.trim()
    || (!details.isPersonal ? 'Cached' : '');
  const trackerInfo = trackerLabel ? ` | ${trackerLabel}` : '';
  title = title + '\n' + icon + ' ' + formatSize(video.size) + trackerInfo;

  const inferredFromUrl = (details.url && details.url.includes('real-debrid.com')) ? 'realdebrid' : null;
  const normalizedSource = (details.source || inferredFromUrl || (config?.DebridProvider ? String(config.DebridProvider).toLowerCase() : '') || 'debrid');
  const sourceLabel = STREAM_NAME_MAP[normalizedSource] || `[${(normalizedSource || 'debrid').toUpperCase()}]`;
  let name = sourceLabel; // always just provider tag
  name = name + '\n'; // resolution appended below
  const resolution = getResolutionFromName(video.name || video.title || '');
  // Set resolution label properly - 2160p shows as "4k", 1080p shows as "1080p", etc.
  let resolutionLabel;
  if (resolution === '2160p') {
      resolutionLabel = '4k';
  } else if (resolution === '1080p') {
      resolutionLabel = '1080p';
  } else if (resolution === '720p') {
      resolutionLabel = '720p';
  } else if (resolution === '480p') {
      resolutionLabel = '480p';
  } else {
      resolutionLabel = resolution; // fallback for other values
  }
  name = name + '\n' + (resolutionLabel || 'N/A');

  const base = ADDON_HOST || config?.host || '';
  let streamUrl;
  let urlToEncode = video.url;

  // If url is missing, construct magnet URL from hash (common for Torz API results)
  if (!urlToEncode && (video.hash || video.infoHash)) {
    const hash = (video.hash || video.infoHash).toLowerCase();
    const torrentName = encodeURIComponent(video.name || video.title || 'torrent');
    urlToEncode = `magnet:?xt=urn:btih:${hash}&dn=${torrentName}`;
    console.log(`[STREAM] Constructed magnet URL from hash for torrent: ${video.name || 'Unknown'}`);
  }

  // Force debrid to resolve via magnet/resolve endpoint instead of cached direct links
  if (normalizedSource === 'realdebrid' && urlToEncode && urlToEncode.startsWith('http') && (video.hash || video.infoHash)) {
    const hash = (video.hash || video.infoHash).toLowerCase();
    const torrentName = encodeURIComponent(video.name || video.title || 'torrent');
    urlToEncode = `magnet:?xt=urn:btih:${hash}&dn=${torrentName}`;
  }

  // If still no URL available, return null (cannot create stream)
  if (!urlToEncode) {
    console.error(`[STREAM] Cannot create stream - no URL or hash available for: ${video.name || 'Unknown'}`);
    return null;
  }

  if (normalizedSource === 'premiumize' && type === 'series' && streamHint.season && streamHint.episode) {
    const hint = Buffer.from(JSON.stringify({ season: streamHint.season, episode: streamHint.episode })).toString('base64');
    urlToEncode += '||HINT||' + hint;
  }

  if (normalizedSource === 'realdebrid') {
    const encodedApiKey = encodeURIComponent(config.DebridApiKey || '');
    const encodedUrl = encodeURIComponent(urlToEncode);
    streamUrl = (base && base.startsWith('http'))
      ? `${base}/resolve/realdebrid/${encodedApiKey}/${encodedUrl}`
      : urlToEncode;
  } else if (normalizedSource === 'offcloud' && urlToEncode.includes('offcloud.com/cloud/download/')) {
    streamUrl = urlToEncode;
  } else {
    const encodedApiKey = encodeURIComponent(config.DebridApiKey || config.DebridLinkApiKey || '');
    const encodedUrl = encodeURIComponent(urlToEncode);
    streamUrl = (base && base.startsWith('http'))
      ? `${base}/resolve/${normalizedSource}/${encodedApiKey}/${encodedUrl}`
      : urlToEncode;
  }

  if (details.isCached && streamUrl && streamUrl.includes('/resolve/')) {
    const cacheKey = details._cacheKey || details.cacheKey;
    const cacheHash = details.hash || details.infoHash || details.InfoHash;
    if (cacheKey && cacheHash) {
      const separator = streamUrl.includes('?') ? '&' : '?';
      streamUrl = `${streamUrl}${separator}cacheKey=${encodeURIComponent(cacheKey)}&cacheHash=${encodeURIComponent(cacheHash)}`;
    }
  }

  if (!isValidUrl(streamUrl)) return null;

  // Check if this service has proxy enabled
  let proxyEnabled = false;
  let proxyUrl = '';
  let proxyPassword = '';
  if (config.DebridServices && Array.isArray(config.DebridServices)) {
    // Map normalized source back to provider name
    const providerNameMap = {
      'realdebrid': 'RealDebrid',
      'alldebrid': 'AllDebrid',
      'torbox': 'TorBox',
      'offcloud': 'OffCloud',
      'premiumize': 'Premiumize',
      'debridlink': 'DebridLink',
      'debriderapp': 'DebriderApp'
    };
    const providerName = providerNameMap[normalizedSource] || normalizedSource;
    const serviceConfig = config.DebridServices.find(s => s.provider === providerName);
    if (serviceConfig && serviceConfig.enableProxy && serviceConfig.proxyUrl) {
      proxyEnabled = true;
      proxyUrl = serviceConfig.proxyUrl.replace(/\/+$/, ''); // Remove trailing slash
      proxyPassword = serviceConfig.proxyPassword || '';
    }
  }

  // Route through MediaFlow proxy if enabled
  if (proxyEnabled && proxyUrl) {
    const proxyParams = new URLSearchParams();
    proxyParams.set('d', streamUrl);
    if (proxyPassword) {
      proxyParams.set('api_password', proxyPassword);
    }
    streamUrl = `${proxyUrl}/proxy/stream?${proxyParams.toString()}`;

    // Add proxy badge to title
    title = title + '\n🔒 Proxy';
  }

  const fileName = extractFileName(video.name || video.title || '');
  const behaviorHints = {
    bingeGroup: `sootio-${normalizedSource}`
  };
  if (fileName) {
    behaviorHints.fileName = fileName;
  }

  const streamObj = {
    name,
    title,
    url: streamUrl,
    isPersonal: details.isPersonal, // Keep track of personal files for sorting
    _size: video.size || 0,  // Preserve size for filtering
    _hash: (details.hash || details.infoHash || details.InfoHash || '').toLowerCase() || undefined, // Preserve hash for cross-provider dedup
    behaviorHints
  };
  if (details.bypassFiltering) streamObj.bypassFiltering = true;
  return streamObj;
}

function toDebriderStream(details, type, config) {
    const resolution = getResolutionFromName(details.fileName || details.name);
    // Set resolution label properly - 2160p shows as "4k", 1080p shows as "1080p", etc.
    let resolutionLabel;
    if (resolution === '2160p') {
        resolutionLabel = '4k';
    } else if (resolution === '1080p') {
        resolutionLabel = '1080p';
    } else if (resolution === '720p') {
        resolutionLabel = '720p';
    } else if (resolution === '480p') {
        resolutionLabel = '480p';
    } else {
        resolutionLabel = resolution; // fallback for other values
    }

    // Personal files get cloud icon, NZBs get download icon
    const icon = details.isPersonal ? '☁️' : (details.source === 'newznab' ? '📡' : '💾');
    const trackerLabel = [details.tracker, details.Tracker, details.originalSource]
        .find(value => typeof value === 'string' && value.trim())?.trim()
        || (!details.isPersonal ? 'Cached' : '');
    const trackerInfo = trackerLabel ? ` | ${trackerLabel}` : '';
    // Detect languages from the title and render flags
    const detectedLanguages = detectLanguagesFromTitle(details.name || details.fileName || '');
    const flagsSuffix = renderLanguageFlags(detectedLanguages);

    let title = details.name;
    if (details.fileName) {
        title = `${details.name}/${details.fileName}`;
    }
    title = `${title}\n${icon} ${formatSize(details.size)}${trackerInfo}${flagsSuffix}`;

    // Use appropriate stream name map
    const sourceName = details.source === 'personalcloud' ? STREAM_NAME_MAP.personalcloud : STREAM_NAME_MAP.debriderapp;
    const name = `${sourceName}\n${resolutionLabel}`;

    // For NZB URLs, route through resolver endpoint with config
    let streamUrl = details.url;
    if (details.url.startsWith('nzb:')) {
        const base = ADDON_HOST || config?.host || '';
        const provider = details.source === 'personalcloud' ? 'personalcloud' : 'debriderapp';
        const encodedApiKey = encodeURIComponent(config.DebridApiKey || '');
        const encodedUrl = encodeURIComponent(details.url);

        // Find the service config for this provider
        let serviceConfig = {};
        if (Array.isArray(config.DebridServices)) {
            const service = config.DebridServices.find(s =>
                (s.provider === 'DebriderApp' || s.provider === 'PersonalCloud')
            );
            if (service) {
                serviceConfig = {
                    PersonalCloudUrl: service.baseUrl || 'https://debrider.app/api/v1',
                    PersonalCloudNewznabApiKey: service.newznabApiKey || '',
                    newznabApiKey: service.newznabApiKey || ''
                };
            }
        }

        const configParam = encodeURIComponent(JSON.stringify(serviceConfig));
        streamUrl = (base && base.startsWith('http'))
            ? `${base}/resolve/${provider}/${encodedApiKey}/${encodedUrl}?config=${configParam}`
            : details.url;
    }

    // Check if proxy is enabled for DebriderApp or PersonalCloud
    let proxyEnabled = false;
    let proxyUrl = '';
    let proxyPassword = '';
    if (config.DebridServices && Array.isArray(config.DebridServices)) {
        const serviceConfig = config.DebridServices.find(s =>
            s.provider === 'DebriderApp' || s.provider === 'PersonalCloud'
        );
        if (serviceConfig && serviceConfig.enableProxy && serviceConfig.proxyUrl) {
            proxyEnabled = true;
            proxyUrl = serviceConfig.proxyUrl.replace(/\/+$/, '');
            proxyPassword = serviceConfig.proxyPassword || '';
        }
    }

    // Route through MediaFlow proxy if enabled (only for non-NZB direct URLs)
    let finalTitle = title;
    if (proxyEnabled && proxyUrl && !details.url.startsWith('nzb:')) {
        const proxyParams = new URLSearchParams();
        proxyParams.set('d', streamUrl);
        if (proxyPassword) {
            proxyParams.set('api_password', proxyPassword);
        }
        streamUrl = `${proxyUrl}/proxy/stream?${proxyParams.toString()}`;
        finalTitle = title + '\n🔒 Proxy';
    }

    return {
        name: name,
        title: finalTitle,
        url: streamUrl,
        isPersonal: details.isPersonal, // Keep track of personal files for sorting
        _size: details.size || 0,  // Preserve size for filtering
        behaviorHints: (() => {
            const fileName = extractFileName(details.fileName || details.name || '');
            const hints = {
                directLink: !details.url.startsWith('nzb:'), // NZB links need processing
                bingeGroup: `sootio-${details.source || 'debriderapp'}`
            };
            if (fileName) {
                hints.fileName = fileName;
            }
            return hints;
        })()
    };
}

/**
 * Get streams from Usenet
 */
async function getEasynewsStreams(config, type, id) {
  try {
    console.log('[EN+] getEasynewsStreams called');
    console.log('[EN+] Username:', config.EasynewsUsername ? '***' : 'not set');

    const results = await Easynews.searchEasynewsStreams(
      config.EasynewsUsername,
      config.EasynewsPassword,
      type,
      id,
      config
    );

    if (!results || results.length === 0) {
      console.log('[EN+] No results found');
      return [];
    }

    console.log(`[EN+] Got ${results.length} results from Easynews`);

    // Format results for Stremio
    const formattedStreams = results.map(result => {
      const resolution = getResolutionFromName(result.name);
      // Set resolution label properly - 2160p shows as "4k", 1080p shows as "1080p", etc.
      let resolutionLabel;
      if (resolution === '2160p') {
        resolutionLabel = '4k';
      } else if (resolution === '1080p') {
        resolutionLabel = '1080p';
      } else if (resolution === '720p') {
        resolutionLabel = '720p';
      } else if (resolution === '480p') {
        resolutionLabel = '480p';
      } else {
        resolutionLabel = resolution || 'N/A';
      }

      return {
        name: `${STREAM_NAME_MAP.easynews}\n${resolutionLabel}`,
        title: `${result.name}\n📡 ${formatSize(result.size)}`,
        url: result.url,
        _size: result.size || 0,
        provider: 'easynews',
        behaviorHints: {
          bingeGroup: 'sootio-easynews'
        }
      };
    });

    return formattedStreams;

  } catch (error) {
    console.error('[EN+] Error getting Easynews streams:', error);
    return [];
  }
}

async function getUsenetStreams(config, type, id) {
  try {
    console.log('[USENET] getUsenetStreams called - Personal file check will ALWAYS run (never cached)');
    console.log('[USENET] Config FileServerUrl:', config.FileServerUrl);

    const results = await Usenet.searchUsenet(
      config.NewznabUrl,
      config.NewznabApiKey,
      type,
      id,
      config
    );

    if (!results || results.length === 0) {
      console.log('[USENET] No search results from Newznab');
      return [];
    }

    console.log(`[USENET] Got ${results.length} search results from Newznab (may be cached)`);

    // ALWAYS check file server for existing files (never cached)
    // Match personal files against the SEARCH QUERY, not individual Newznab results
    const personalFiles = []; // Array of file objects from server
    const personalFileNames = new Set(); // Set of file names for quick lookup
    console.log('[USENET] Running personal file check (UNCACHED)...');

    if (config.FileServerUrl) {
      try {
        const axios = (await import('axios')).default;
        const fileServerUrl = config.FileServerUrl.replace(/\/$/, '');
        console.log(`[USENET] Querying file server: ${fileServerUrl}/api/list`);

        // Simple GET without cache-busting that might cause issues
        const response = await axios.get(`${fileServerUrl}/api/list`, {
          timeout: 10000,
          validateStatus: (status) => status === 200
        });

        if (response.data?.files && Array.isArray(response.data.files)) {
          // Only use completed files for personal streams (isComplete: true)
          // Files in incomplete/ are for streaming via download+extraction
          const completedFiles = response.data.files.filter(f => f.isComplete === true);
          personalFiles.push(...completedFiles);
          completedFiles.forEach(file => {
            personalFileNames.add(file.name);
          });
          console.log(`[USENET] ✓ Found ${completedFiles.length} completed files on server (${response.data.files.length} total)`);
          if (completedFiles.length > 0) {
            console.log(`[USENET] Sample completed files:`, completedFiles.slice(0, 2).map(f => f.path).join(', '));
          }
        } else {
          console.log(`[USENET] ✓ No files on server`);
        }
      } catch (error) {
        console.error('[USENET] ✗ Personal file check FAILED:', error.code, error.message);
        if (error.response) {
          console.error('[USENET] Response status:', error.response.status);
        }
        // Continue without personal files if file server is unavailable
      }
    } else {
      console.log('[USENET] ⚠ FileServerUrl not configured');
    }

    // Get metadata for title matching
    let metadata = null;
    try {
      // For series, extract just the imdbId (before the colon)
      const imdbId = type === 'series' ? id.split(':')[0] : id;
      metadata = await Cinemeta.getMeta(type, imdbId);
    } catch (err) {
      console.log('[USENET] Could not fetch metadata for title matching:', err.message);
    }

    // Helper function to match file against search query
    const matchesSearch = (fileName, searchType, searchId, meta) => {
      if (searchType === 'series') {
        // Extract S01E05 from search ID (format: tt123:1:5)
        const [, season, episode] = searchId.split(':');
        const seasonEpPattern = new RegExp(`s0*${season}e0*${episode}`, 'i');

        // Check if episode pattern matches
        if (!seasonEpPattern.test(fileName)) {
          return false;
        }

        // If we have metadata, also verify the title matches
        if (meta && meta.name) {
          // Normalize both strings for comparison
          const normalizeStr = (str) => str.toLowerCase()
            .replace(/[^\w\s]/g, '') // Remove special chars
            .replace(/\s+/g, ''); // Remove spaces

          const normalizedTitle = normalizeStr(meta.name);
          const normalizedFileName = normalizeStr(fileName);

          // Check if the file name contains the show title
          if (!normalizedFileName.includes(normalizedTitle)) {
            console.log(`[USENET] ✗ File "${fileName}" has correct episode but wrong title (expected: "${meta.name}")`);
            return false;
          }
        }

        console.log(`[USENET] ✓ Personal file matches search: "${fileName}"`);
        return true;
      } else {
        // For movies, match by title and optionally year
        if (!meta || !meta.name) {
          return false;
        }

        const normalizeStr = (str) => str.toLowerCase()
          .replace(/[^\w\s]/g, '')
          .replace(/\s+/g, '');

        const normalizedTitle = normalizeStr(meta.name);
        const normalizedFileName = normalizeStr(fileName);

        // Check if filename contains the movie title
        if (!normalizedFileName.includes(normalizedTitle)) {
          return false;
        }

        // If we have a year, check if it matches too
        if (meta.year) {
          const yearPattern = new RegExp(`\\b${meta.year}\\b`);
          if (!yearPattern.test(fileName)) {
            console.log(`[USENET] ✗ File "${fileName}" has correct title but wrong year (expected: ${meta.year})`);
            return false;
          }
        }

        console.log(`[USENET] ✓ Personal file matches search: "${fileName}"`);
        return true;
      }
    };

    // Find personal files that match the search
    // Try matching against file.path first, then fall back to folderName if filename is a hash
    const matchedPersonalFiles = personalFiles.filter(file => {
      // First try the full path (includes folder name)
      if (matchesSearch(file.path, type, id, metadata)) {
        return true;
      }
      // If path doesn't match and we have a folderName, try that
      // This handles cases where the video file has a random hash name
      if (file.folderName && matchesSearch(file.folderName, type, id, metadata)) {
        console.log(`[USENET] ✓ Matched by folder name: "${file.folderName}" (file: ${file.name})`);
        return true;
      }
      return false;
    });

    console.log(`[USENET] Found ${matchedPersonalFiles.length} personal files matching search`);

    // Build NNTP server connection string for Stremio SDK
    // Format: nntp(s)://{user}:{pass}@{domain}:{port}/{connections}
    const protocol = config.NntpSsl !== false ? 'nntps' : 'nntp';
    const nntpServer = `${protocol}://${encodeURIComponent(config.NntpUsername)}:${encodeURIComponent(config.NntpPassword)}@${config.NntpAddress}:${config.NntpPort}/${config.NntpConnections || 4}`;

    const base = ADDON_HOST || config?.host || '';

    // Helper to match Newznab result with personal file
    const findMatchingPersonalFile = (nzbTitle) => {
      const normalizeForMatch = (str) => {
        const withoutExt = str.replace(/\.(mkv|mp4|avi|mov|wmv|flv|webm|m4v|mpg|mpeg)$/i, '');
        return withoutExt.toLowerCase().replace(/[.\s_-]+/g, '');
      };
      const normalized = normalizeForMatch(nzbTitle);

      return matchedPersonalFiles.find(file => {
        const fileNorm = normalizeForMatch(file.name);
        return fileNorm === normalized || fileNorm.includes(normalized) || normalized.includes(fileNorm);
      });
    };

    // Apply filters to Newznab results (same as debrid services)
    let filteredResults = results;

    // For movies, filter by year
    if (type === 'movie' && metadata) {
      filteredResults = filteredResults.filter(result => filterYear(result, metadata));
      console.log(`[USENET] Filtered ${results.length} -> ${filteredResults.length} results by year`);
    }

    // For series, filter out results that don't have episode markers
    if (type === 'series') {
      const [, season, episode] = id.split(':');
      const initialCount = filteredResults.length;
      filteredResults = filteredResults.filter(result => {
        const name = result?.name || result?.title || '';
        // Check if name has ANY episode pattern (S##E##, 1x05, etc)
        const hasAnyEpisode = /[sS]\d+[eE]\d+|\b\d+x\d+\b|[eE]pisode\s*\d+/i.test(name);
        return hasAnyEpisode;
      });
      if (filteredResults.length < initialCount) {
        console.log(`[USENET] Filtered ${initialCount} -> ${filteredResults.length} results (removed non-series)`);
      }
    }

    // Convert Newznab results to stream objects
    const newznabStreams = filteredResults.slice(0, 50).map(result => {
      const resolution = getResolutionFromName(result.title);
      // Set resolution label properly - 2160p shows as "4k", 1080p shows as "1080p", etc.
      let resolutionLabel;
      if (resolution === '2160p') {
          resolutionLabel = '4k';
      } else if (resolution === '1080p') {
          resolutionLabel = '1080p';
      } else if (resolution === '720p') {
          resolutionLabel = '720p';
      } else if (resolution === '480p') {
          resolutionLabel = '480p';
      } else {
          resolutionLabel = resolution; // fallback for other values
      }

      // Check if this Newznab result matches a personal file
      const matchingFile = findMatchingPersonalFile(result.title);
      const isInCloud = !!matchingFile;

      // Build stream object based on whether file is in cloud or needs downloading
      let streamObj;
      if (isInCloud) {
        // Stream from personal file (already on server) - use custom URL
        const configData = {
          newznabUrl: config.NewznabUrl,
          newznabApiKey: config.NewznabApiKey,
          nntpAddress: config.NntpAddress,
          nntpPort: config.NntpPort,
          nntpUsername: config.NntpUsername,
          nntpPassword: config.NntpPassword,
          nntpConnections: config.NntpConnections,
          nntpSsl: config.NntpSsl
        };
        const configParam = encodeURIComponent(JSON.stringify(configData));
        const encodedPath = matchingFile.path.split('/').map(encodeURIComponent).join('/');
        const streamUrl = `${base}/usenet/personal/${encodedPath}?config=${configParam}`;
        console.log(`[USENET] ✓ Newznab result "${result.title}" matches personal file, using direct URL`);

        streamObj = {
          url: streamUrl,
          behaviorHints: {
            bingeGroup: `usenet-personal|${matchingFile.name}`
          }
        };
      } else {
        // Use SDK's built-in NZB support
        console.log(`[USENET] Using SDK NZB streaming for: "${result.title}"`);
        streamObj = {
          nzbUrl: result.nzbUrl,
          servers: [nntpServer],
          behaviorHints: {
            bingeGroup: `usenet|${result.id}`,
            notWebReady: true
          }
        };
      }

      return {
        name: isInCloud ? `☁️ Personal\n${resolutionLabel || 'N/A'}` : `${STREAM_NAME_MAP.usenet}\n${resolutionLabel || 'N/A'}`,
        title: `${result.title}\n${isInCloud ? '☁️' : '📡'} ${formatSize(result.size)}`,
        ...streamObj,
        isPersonal: isInCloud,
        _size: result.size || 0  // Preserve size for filtering
      };
    });

    // Create streams for personal files that DON'T match any Newznab result
    const personalOnlyStreams = matchedPersonalFiles
      .filter(file => {
        // Check if this file matches ANY Newznab result
        const normalizeForMatch = (str) => {
          const withoutExt = str.replace(/\.(mkv|mp4|avi|mov|wmv|flv|webm|m4v|mpg|mpeg)$/i, '');
          return withoutExt.toLowerCase().replace(/[.\s_-]+/g, '');
        };
        const fileNorm = normalizeForMatch(file.name);

        const hasMatch = results.some(result => {
          const resultNorm = normalizeForMatch(result.title);
          return fileNorm === resultNorm || fileNorm.includes(resultNorm) || resultNorm.includes(fileNorm);
        });
        return !hasMatch;
      })
      .map(file => {
        const resolution = getResolutionFromName(file.name);
        // Set resolution label properly - 2160p shows as "4k", 1080p shows as "1080p", etc.
        let resolutionLabel;
        if (resolution === '2160p') {
            resolutionLabel = '4k';
        } else if (resolution === '1080p') {
            resolutionLabel = '1080p';
        } else if (resolution === '720p') {
            resolutionLabel = '720p';
        } else if (resolution === '480p') {
            resolutionLabel = '480p';
        } else {
            resolutionLabel = resolution; // fallback for other values
        }

        // Use the file name as the release name, but if it's a hash (no recognizable info),
        // use the parent directory name (folderName) instead
        let releaseName = file.name.replace(/\.(mkv|mp4|avi|mov|wmv|flv|webm|m4v|mpg|mpeg)$/i, '');

        // Check if filename looks like a hash (mostly alphanumeric, no spaces, < 20 chars)
        const looksLikeHash = /^[a-zA-Z0-9]{8,32}$/.test(releaseName);
        if (looksLikeHash && file.folderName) {
          console.log(`[USENET] Using folder name instead of hash filename: "${file.folderName}" (was: "${releaseName}")`);
          releaseName = file.folderName;
        }

        // Create a stream URL that goes through Node.js for tracking
        // Use a special "personal" marker in the URL
        const configData = {
          newznabUrl: config.NewznabUrl,
          newznabApiKey: config.NewznabApiKey,
          nntpAddress: config.NntpAddress,
          nntpPort: config.NntpPort,
          nntpUsername: config.NntpUsername,
          nntpPassword: config.NntpPassword,
          nntpConnections: config.NntpConnections,
          nntpSsl: config.NntpSsl
        };
        const encodedPath = file.path.split('/').map(encodeURIComponent).join('/');
        const configParam = encodeURIComponent(JSON.stringify(configData));
        const personalStreamUrl = `${base}/usenet/personal/${encodedPath}?config=${configParam}`;

        console.log(`[USENET] ✓ Creating personal-only stream for: "${file.name}"`);

        return {
          name: `☁️ Personal\n${resolutionLabel || 'N/A'}`,
          title: `${releaseName}\n☁️ ${formatSize(file.size)} (On Server)`,
          url: personalStreamUrl,
          isPersonal: true,
          _size: file.size || 0,  // Preserve size for filtering
          behaviorHints: {
            bingeGroup: 'sootio-usenet-personal'
          }
        };
      });

    console.log(`[USENET] Created ${personalOnlyStreams.length} personal-only streams`);

    // Combine: personal files at top, then regular Newznab results
    const allStreams = [...personalOnlyStreams, ...newznabStreams];

    return allStreams;

  } catch (error) {
    console.error('[USENET] Error getting streams:', error.message);
    return [];
  }
}

/**
 * Get streams from Home Media Server
 */
async function getHomeMediaStreams(config, type, id) {
  try {
    console.log('[HM+] getHomeMediaStreams called');
    console.log('[HM+] Config HomeMediaUrl:', config.HomeMediaUrl);

    const results = await HomeMedia.searchHomeMedia(
      config.HomeMediaUrl,
      config.HomeMediaApiKey,
      type,
      id,
      config
    );

    if (!results || results.length === 0) {
      console.log('[HM+] No files found on home media server');
      return [];
    }

    console.log(`[HM+] Got ${results.length} results from home media server`);

    const base = ADDON_HOST || config?.host || '';

    // Convert Home Media results to stream objects
    const streams = results.map(result => {
      const resolution = result.resolution || getResolutionFromName(result.title);
      // Set resolution label properly - 2160p shows as "4k", 1080p shows as "1080p", etc.
      let resolutionLabel;
      if (resolution === '2160p') {
          resolutionLabel = '4k';
      } else if (resolution === '1080p') {
          resolutionLabel = '1080p';
      } else if (resolution === '720p') {
          resolutionLabel = '720p';
      } else if (resolution === '480p') {
          resolutionLabel = '480p';
      } else {
          resolutionLabel = resolution; // fallback for other values
      }

      // Generate stream URL
      const streamUrl = HomeMedia.getStreamUrl(
        config.HomeMediaUrl,
        config.HomeMediaApiKey,
        result.flatPath || result.fileName
      );

      console.log(`[HM+] ✓ Creating stream for: "${result.title}"`);

      return {
        name: `☁️ Personal\n${resolutionLabel || 'N/A'}`,
        title: `${result.title}\n☁️ ${formatSize(result.size)} (Home Media)`,
        url: streamUrl,
        _size: result.size || 0,  // Preserve size for filtering
        behaviorHints: {
          bingeGroup: 'sootio-homemedia'
        }
      };
    });

    return streams;

  } catch (error) {
    console.error('[HM+] Error getting streams:', error.message);
    return [];
  }
}

// ---------------------------------------------------------------------------------
// Deduplicated wrappers for exported functions
// ---------------------------------------------------------------------------------

/**
 * Deduplicated movie streams function
 * Prevents duplicate concurrent requests for the same movie
 */
async function getMovieStreamsDeduped(config, type, id) {
  const sanitizedConfig = sanitizeConfig(config, 'STREAM-PROVIDER');
  // Create deduplication key based on provider, type, id, and languages
  const provider = sanitizedConfig.DebridProvider || 'unknown';
  const langs = (sanitizedConfig.Languages || []).sort().join(',');
  const userKey = buildDedupUserKey(sanitizedConfig);
  const key = `${provider}:${type}:${id}:${langs}:${userKey}`;

  return dedupedRequest(key, () => getMovieStreams(sanitizedConfig, type, id));
}

/**
 * Deduplicated series streams function
 * Prevents duplicate concurrent requests for the same episode
 */
async function getSeriesStreamsDeduped(config, type, id) {
  const sanitizedConfig = sanitizeConfig(config, 'STREAM-PROVIDER');
  // Create deduplication key based on provider, type, id, and languages
  const provider = sanitizedConfig.DebridProvider || 'unknown';
  const langs = (sanitizedConfig.Languages || []).sort().join(',');
  const userKey = buildDedupUserKey(sanitizedConfig);
  const key = `${provider}:${type}:${id}:${langs}:${userKey}`;

  return dedupedRequest(key, () => getSeriesStreams(sanitizedConfig, type, id));
}

// Verification functions for cached torrents and HTTP streams
async function verifyCachedTorrents(apiKey, provider, cachedResults) {
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

async function refreshHttpStreamLinks(cachedResults) {
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

export {
  shouldUseMkvDramaForTitle,
  hasLikelyAsianCredits,
  hasAsianScriptSignals,
  looksLikeAsianCreditName
};

export default {
  getMovieStreams: getMovieStreamsDeduped,
  getSeriesStreams: getSeriesStreamsDeduped,
  resolveUrl,
  STREAM_NAME_MAP,
  getCacheStats,
  clearInternalCaches
};
function resolveTmdbId(meta) {
  if (!meta) return null;

  const candidates = [];

  // Cinemeta provides TMDB id as moviedb_id
  if (meta.moviedb_id || meta.moviedbId || meta.movieDbId) {
    candidates.push(meta.moviedb_id || meta.moviedbId || meta.movieDbId);
  }

  if (meta.tmdb_id || meta.tmdbId) {
    candidates.push(meta.tmdb_id || meta.tmdbId);
  }

  if (meta.ids) {
    if (Array.isArray(meta.ids)) {
      candidates.push(...meta.ids);
    } else if (typeof meta.ids === 'object') {
      Object.values(meta.ids).forEach(val => candidates.push(val));
    }
  }

  if (meta.externalIds) {
    Object.values(meta.externalIds).forEach(val => candidates.push(val));
  }

  if (meta.behaviorHints?.defaultVideoId) {
    candidates.push(meta.behaviorHints.defaultVideoId);
  }

  if (meta.links && Array.isArray(meta.links)) {
    meta.links.forEach(link => {
      if (link?.url) candidates.push(link.url);
      if (link?.name) candidates.push(link.name);
    });
  }

  for (const value of candidates) {
    if (!value) continue;
    const str = String(value);
    // Direct numeric TMDB id
    if (/^\d+$/.test(str.trim())) {
      return str.trim();
    }

    // Patterns like tmdb:123456 or movie/123456
    const match = str.match(/tmdb[^0-9]*([0-9]{3,})/i) || str.match(/\/movie\/([0-9]{3,})/i);
    if (match && match[1]) {
      return match[1];
    }
  }

  return null;
}
