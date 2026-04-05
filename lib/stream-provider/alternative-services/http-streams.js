/**
 * HTTP streaming services orchestration (no caching)
 * Wraps 4KHDHub, HDHub4u, MKVCinemas, MKVDrama, MalluMv, CineDoze, UHDMovies, MoviesDrive, XDMovies, MoviesMod, MoviesLeech, and AnimeFlix
 */

import { get4KHDHubStreams, getHDHub4uStreams, getMKVCinemasStreams, getMalluMvStreams, getCineDozeStreams, getVixSrcStreams, getMkvDramaStreams, getXDMoviesStreams, getMoviesModStreams, getMoviesLeechStreams, getAnimeFlixStreams } from '../../http-streams.js';
import { getUHDMoviesStreams } from '../../uhdmovies.js';
import { getMoviesDriveStreams } from '../../moviesdrive.js';
import { wrapHttpStreamsWithResolver } from '../utils/url-validation.js';
import { withTimeout, getHttpStreamingTimeoutMs } from '../config/timeouts.js';
import { preCalculateTimeouts } from '../../util/adaptive-timeout.js';
import Cinemeta from '../../util/cinemeta.js';

/**
 * Fetch HTTP streaming results (no caching - always live).
 * Supports both movies and series (season/episode provided via options).
 *
 * PERFORMANCE FIX: Cinemeta metadata is fetched ONCE before the timeout wrappers,
 * then passed to each provider. This prevents the metadata fetch time from eating
 * into the per-provider timeout budget.
 */
export async function getHttpStreamingStreams(config, type, id, options = {}) {
  const { season = null, episode = null } = options;

  const use4KHDHub = config.http4khdhub !== false;
  const useHDHub4u = config.httpHDHub4u !== false;
  const useUHDMovies = config.httpUHDMovies !== false;
  const useMoviesDrive = config.httpMoviesDrive !== false;
  const useMKVCinemas = config.httpMKVCinemas !== false;
  const useMkvDrama = config.httpMkvDrama !== false;
  const useMalluMv = config.httpMalluMv !== false;
  const useCineDoze = config.httpCineDoze !== false;
  const useVixSrc = config.httpVixSrc !== false;
  const useXDMovies = config.httpXDMovies !== false;
  const useMoviesMod = config.httpMoviesMod !== false;
  const useMoviesLeech = config.httpMoviesLeech !== false;
  const useAnimeFlix = config.httpAnimeFlix !== false;
  // Webstreamr removed: keep legacy flags no-op

  // Pre-fetch Cinemeta metadata BEFORE starting the timeout-wrapped tasks.
  // This ensures slow Cinemeta responses don't eat into each provider's timeout budget.
  // For series, extract just the IMDB ID (before the colon if present)
  const imdbId = type === 'series' ? id.split(':')[0] : id;
  let cinemetaDetails = null;

  try {
    const startTime = Date.now();
    cinemetaDetails = await Cinemeta.getMeta(type, imdbId);
    const duration = Date.now() - startTime;
    if (cinemetaDetails) {
      console.log(`[HTTP-STREAMS] Pre-fetched Cinemeta metadata for ${imdbId}: "${cinemetaDetails.name}" (${duration}ms)`);
    } else {
      console.log(`[HTTP-STREAMS] Cinemeta returned no metadata for ${imdbId} (${duration}ms)`);
    }
  } catch (err) {
    console.error(`[HTTP-STREAMS] Failed to pre-fetch Cinemeta metadata for ${imdbId}:`, err.message);
  }

  // If Cinemeta failed, we can't search effectively - return empty
  if (!cinemetaDetails || !cinemetaDetails.name) {
    console.log(`[HTTP-STREAMS] Skipping HTTP streaming providers - no metadata available for ${imdbId}`);
    return [];
  }

  // Pre-calculate adaptive timeouts for all enabled providers
  // This warms the cache so getHttpStreamingTimeoutMs() can return sync values
  const enabledProviders = [];
  if (use4KHDHub) enabledProviders.push('4KHDHub');
  if (useHDHub4u) enabledProviders.push('HDHub4u');
  if (useMKVCinemas) enabledProviders.push('MKVCinemas');
  if (useMkvDrama) enabledProviders.push('MkvDrama');
  if (useMalluMv) enabledProviders.push('MalluMv');
  if (useCineDoze) enabledProviders.push('CineDoze');
  if (useUHDMovies) enabledProviders.push('UHDMovies');
  if (useMoviesDrive) enabledProviders.push('MoviesDrive');
  if (useVixSrc) enabledProviders.push('VixSrc');
  if (useXDMovies) enabledProviders.push('XDMovies');
  if (useMoviesMod) enabledProviders.push('MoviesMod');
  if (useMoviesLeech) enabledProviders.push('MoviesLeech');
  if (useAnimeFlix) enabledProviders.push('AnimeFlix');

  // Pre-warm timeout cache (non-blocking, best effort)
  preCalculateTimeouts(enabledProviders).catch(() => {});

  const resolverWrapper = streams => {
    const tagged = (streams || []).map(stream => ({ provider: 'httpstreaming', ...stream }));
    return wrapHttpStreamsWithResolver(tagged, config.host);
  };
  const tasks = [];

  const addTask = (label, searchFn) => {
    tasks.push(
      withTimeout(
        Promise.resolve(searchFn()).then(resolverWrapper),
        getHttpStreamingTimeoutMs(label),
        label
      )
    );
  };

  if (use4KHDHub) {
    addTask('4KHDHub', () => get4KHDHubStreams(id, type, season, episode, config, cinemetaDetails));
  }

  if (useHDHub4u) {
    addTask('HDHub4u', () => getHDHub4uStreams(id, type, season, episode, cinemetaDetails));
  }

  if (useMKVCinemas) {
    addTask('MKVCinemas', () => getMKVCinemasStreams(id, type, season, episode, config, cinemetaDetails));
  }

  if (useMkvDrama) {
    addTask('MkvDrama', () => getMkvDramaStreams(id, type, season, episode, config, cinemetaDetails));
  }

  if (useMalluMv) {
    addTask('MalluMv', () => getMalluMvStreams(id, type, season, episode, config, cinemetaDetails));
  }

  if (useCineDoze) {
    addTask('CineDoze', () => getCineDozeStreams(id, type, season, episode, config, cinemetaDetails));
  }

  if (useUHDMovies) {
    addTask('UHDMovies', () => getUHDMoviesStreams(id, id, type, season, episode, config));
  }

  if (useMoviesDrive) {
    addTask('MoviesDrive', () => getMoviesDriveStreams(id, id, type, season, episode, config, cinemetaDetails));
  }

  if (useVixSrc) {
    addTask('VixSrc', () => getVixSrcStreams(id, type, season, episode));
  }

  if (useXDMovies) {
    addTask('XDMovies', () => getXDMoviesStreams(id, type, season, episode, config, cinemetaDetails));
  }

  if (useMoviesMod) {
    addTask('MoviesMod', () => getMoviesModStreams(id, type, season, episode, config, cinemetaDetails));
  }

  if (useMoviesLeech) {
    addTask('MoviesLeech', () => getMoviesLeechStreams(id, type, season, episode, config, cinemetaDetails));
  }

  if (useAnimeFlix) {
    addTask('AnimeFlix', () => getAnimeFlixStreams(id, type, season, episode, config, cinemetaDetails));
  }

  if (tasks.length === 0) {
    return [];
  }

  const settled = await Promise.allSettled(tasks);

  return settled
    .filter(result => result.status === 'fulfilled')
    .flatMap(result => (Array.isArray(result.value) ? result.value : []))
    .filter(Boolean);
}
