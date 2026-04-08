import axios from 'axios';
import PTT from './util/parse-torrent-title.js';
import Cinemeta from './util/cinemeta.js';
import { orchestrateScrapers } from './util/scraper-selector.js';
import { getCachedScraperResults } from './util/cache-store.js';
import { filterEpisode, normalizeTitle } from './util/filter-torrents.js';
import * as torrentUtils from './common/torrent-utils.js';

const LOG_PREFIX = 'RG';
const DEFAULT_BASE_URL = process.env.RELAYGATE_API_URL || 'https://relaygate.xyz';
const DEFAULT_PROVIDER = process.env.RELAYGATE_PROVIDER || 'torbox';
const ADDON_ID = process.env.RELAYGATE_ADDON_ID || '';
const ADDON_SECRET = process.env.RELAYGATE_ADDON_SECRET || '';
const TIMEOUT_MS = parseInt(process.env.RELAYGATE_TIMEOUT_MS || '15000', 10);
const POLL_TIMEOUT_MS = parseInt(process.env.RELAYGATE_POLL_TIMEOUT_MS || '120000', 10);
const POLL_INTERVAL_MS = parseInt(process.env.RELAYGATE_POLL_INTERVAL_MS || '2500', 10);
const CACHE_CHECK_MAX_HASHES = Math.min(100, Math.max(1, parseInt(process.env.RELAYGATE_CACHE_CHECK_MAX_HASHES || '100', 10)));

function getBaseUrl(config = {}) {
    const configured = config.relaygateUrl || config.RelaygateUrl || DEFAULT_BASE_URL;
    return String(configured || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

function getProviderSlugs(config = {}) {
    const list = config.relaygateProviders;
    if (Array.isArray(list) && list.length > 0) {
        return list.map(s => String(s).trim()).filter(Boolean);
    }
    const one = config.relaygateProvider || config.RelaygateProvider || DEFAULT_PROVIDER;
    return [String(one || DEFAULT_PROVIDER).trim()].filter(Boolean);
}

function getProviderHeaderValue(config = {}) {
    const slugs = getProviderSlugs(config);
    return slugs.length ? slugs.join(', ') : DEFAULT_PROVIDER;
}

function buildHeaders(apiKey, config = {}) {
    const headers = {
        'Content-Type': 'application/json',
        'X-Relaygate-Provider': getProviderHeaderValue(config)
    };
    if (!ADDON_ID || !ADDON_SECRET) {
        throw new Error('Missing RELAYGATE_ADDON_ID or RELAYGATE_ADDON_SECRET');
    }
    headers['X-Relaygate-Addon-Id'] = ADDON_ID;
    headers['X-Relaygate-Addon-Secret'] = ADDON_SECRET;
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    return headers;
}

function providerPayload(envelope, provider) {
    return envelope?.data?.[provider]?.data || null;
}

function providerError(envelope, provider) {
    return envelope?.data?.[provider]?.error || null;
}

function parseCacheItems(payload) {
    if (Array.isArray(payload?.items)) return payload.items;
    if (Array.isArray(payload?.data?.items)) return payload.data.items;
    return [];
}

function parseFiles(payload) {
    if (Array.isArray(payload?.files)) return payload.files;
    if (Array.isArray(payload?.items)) return payload.items;
    if (Array.isArray(payload?.data?.files)) return payload.data.files;
    if (Array.isArray(payload?.data?.items)) return payload.data.items;
    return [];
}

function parseLocations(payload) {
    if (Array.isArray(payload?.locations)) return payload.locations;
    if (Array.isArray(payload?.data?.locations)) return payload.data.locations;
    return [];
}

function pickUrlFromLocations(locations = []) {
    for (const location of locations) {
        if (location?.url) return location.url;
    }
    return null;
}

function normalizeTorrentResult(torrent) {
    const name = torrent.Title || torrent.name || torrent.title || 'Unknown';
    const hash = torrent.info_hash;
    return {
        source: 'relaygate',
        name,
        info: PTT.parse(name),
        size: torrent.Size || torrent.size || 0,
        seeders: torrent.Seeders || torrent.seeders || 0,
        hash,
        tracker: torrent.Tracker || 'Relaygate',
        isCached: true,
        url: `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(name)}`
    };
}

function firstProviderError(responseData, slugs) {
    for (const slug of slugs) {
        const err = providerError(responseData, slug);
        if (err) return err;
    }
    return null;
}

function mergeProviderPayloads(responseData, slugs) {
    const merged = { items: [] };
    for (const slug of slugs) {
        const fragment = providerPayload(responseData, slug);
        if (!fragment) continue;
        const items = parseCacheItems(fragment);
        merged.items = merged.items.concat(items);
    }
    return merged;
}

/** Canonical job / playback paths expect a single upstream provider payload. */
function firstProviderJobConfig(config = {}) {
    const first = getProviderSlugs(config)[0] || DEFAULT_PROVIDER;
    return { ...config, relaygateProviders: [first] };
}

async function relaygateRequest(method, path, apiKey, config = {}, data = null, params = null) {
    const baseUrl = getBaseUrl(config);
    const slugs = getProviderSlugs(config);
    const response = await axios({
        method,
        url: `${baseUrl}${path}`,
        headers: buildHeaders(apiKey, config),
        timeout: TIMEOUT_MS,
        data,
        params
    });
    const err = firstProviderError(response.data, slugs);
    if (err) {
        const msg = err.detail || err.title || 'Relaygate provider error';
        throw new Error(msg);
    }
    if (slugs.length <= 1) {
        return providerPayload(response.data, slugs[0]);
    }
    return mergeProviderPayloads(response.data, slugs);
}

function chunkArray(arr, size) {
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
}

async function checkCachedHashes(apiKey, hashes, config = {}) {
    if (!hashes || hashes.length === 0) return new Set();
    const unique = [...new Set(hashes.map(h => String(h).toLowerCase()).filter(Boolean))];
    const cached = new Set();
    for (const batch of chunkArray(unique, CACHE_CHECK_MAX_HASHES)) {
        const payload = await relaygateRequest(
            'post',
            '/api/v0.6-beta/canonical/torrents/cache-check',
            apiKey,
            config,
            { hashes: batch, list_files: false }
        );
        const items = parseCacheItems(payload);
        for (const item of items) {
            const hash = item?.info_hash;
            const isCached = item?.cached === true;
            if (hash && isCached) cached.add(hash);
        }
    }
    return cached;
}

async function searchRelaygateTorrents(apiKey, type, id, userConfig = {}) {
    try {
        const imdbId = id.split(':')[0];
        const [season, episode] = id.split(':').slice(1);
        const cinemetaDetails = await Cinemeta.getMeta(type, imdbId);
        if (!cinemetaDetails) return [];

        const searchKey = cinemetaDetails.name;
        const selectedLanguages = Array.isArray(userConfig.Languages) ? userConfig.Languages : [];
        const baseSearchKey = type === 'series'
            ? `${searchKey} s${String(season).padStart(2, '0')}e${String(episode).padStart(2, '0')}`
            : `${searchKey} ${cinemetaDetails.year || ''}`.trim();

        const [scraperResults, cachedScraperResults] = await Promise.all([
            orchestrateScrapers({
                type,
                imdbId,
                searchKey,
                baseSearchKey,
                season,
                episode,
                logPrefix: LOG_PREFIX,
                userConfig,
                selectedLanguages
            }),
            getCachedScraperResults(type, imdbId, season, episode).catch(() => [])
        ]);

        let torrents = [].concat(...scraperResults, cachedScraperResults);
        if (type === 'series') {
            torrents = torrents.filter(t => filterEpisode(t, season, episode, cinemetaDetails));
        } else if (type === 'movie') {
            const beforeSeriesFilter = torrents.length;
            let filtered = torrents.filter(item => {
                try {
                    const title = item?.Title || item?.name || '';
                    if (torrentUtils.isSeriesLikeTitle(title)) return false;
                    const parsed = PTT.parse(title) || {};
                    if (parsed.season != null || parsed.seasons) return false;
                } catch {}
                return true;
            });
            if (beforeSeriesFilter !== filtered.length) {
                console.log(`[${LOG_PREFIX}] Removed ${beforeSeriesFilter - filtered.length} series-like results for movie request.`);
            }
            if (cinemetaDetails.year) {
                const beforeYear = filtered.length;
                filtered = filtered.filter(torrent => torrentUtils.filterByYear(torrent, cinemetaDetails, LOG_PREFIX));
                if (beforeYear !== filtered.length) {
                    console.log(`[${LOG_PREFIX}] Filtered by year (${cinemetaDetails.year}). Removed ${beforeYear - filtered.length} mismatched results.`);
                }
            }
            if (cinemetaDetails.name) {
                const beforeTitleFilter = filtered.length;
                const expectedTitle = normalizeTitle(cinemetaDetails.name);
                filtered = filtered.filter(torrent => {
                    try {
                        const title = torrent.Title || torrent.name || '';
                        const normalizedFullTitle = normalizeTitle(title);
                        const expectedWords = expectedTitle.split(/\s+/).filter(w => w.length > 2);
                        const wordsToMatch = expectedWords.length > 0 ? expectedWords : expectedTitle.split(/\s+/).filter(w => w.length > 0);
                        const matchingWords = wordsToMatch.filter(word => normalizedFullTitle.includes(word));
                        const requiredMatches = wordsToMatch.length <= 2 ? wordsToMatch.length : Math.ceil(wordsToMatch.length * 0.5);
                        return matchingWords.length >= requiredMatches;
                    } catch {
                        return true;
                    }
                });
                if (beforeTitleFilter !== filtered.length) {
                    console.log(`[${LOG_PREFIX}] Filtered by title matching "${cinemetaDetails.name}". Removed ${beforeTitleFilter - filtered.length} unrelated results.`);
                }
            }
            torrents = filtered;
        }

        const hashes = torrents
            .map(t => (t.InfoHash || t.infoHash || '').toLowerCase())
            .filter(Boolean);
        const cachedHashes = await checkCachedHashes(apiKey, hashes, userConfig);
        const cachedTorrents = torrents.filter(t => cachedHashes.has((t.InfoHash || t.infoHash || '').toLowerCase()));
        return cachedTorrents.map(normalizeTorrentResult);
    } catch (error) {
        console.error(`[${LOG_PREFIX}] search failed: ${error.message}`);
        return [];
    }
}

function parseHint(hostUrl) {
    if (!hostUrl.includes('||HINT||')) return { magnet: hostUrl, hint: null };
    try {
        const [magnet, encoded] = hostUrl.split('||HINT||');
        const hint = JSON.parse(Buffer.from(encoded, 'base64').toString('utf-8'));
        return { magnet, hint };
    } catch {
        return { magnet: hostUrl.split('||HINT||')[0], hint: null };
    }
}

async function createTorrentJob(apiKey, magnet, config = {}) {
    const jc = firstProviderJobConfig(config);
    const payload = await relaygateRequest(
        'post',
        '/api/v0.6-beta/canonical/jobs',
        apiKey,
        jc,
        { kind: 'torrent', magnet }
    );
    return payload?.job_id || payload?.id || payload?.jobId || null;
}

async function waitForJobReady(apiKey, jobId, config = {}) {
    const jc = firstProviderJobConfig(config);
    const started = Date.now();
    while (Date.now() - started < POLL_TIMEOUT_MS) {
        const payload = await relaygateRequest(
            'get',
            `/api/v0.6-beta/canonical/jobs/${encodeURIComponent(jobId)}`,
            apiKey,
            jc,
            null,
            { kind: 'torrent' }
        );
        const status = String(payload?.status || payload?.state || '').toLowerCase();
        if (['completed', 'downloaded', 'ready', 'finished'].includes(status)) return true;
        if (['error', 'failed', 'dead', 'canceled', 'cancelled'].includes(status)) return false;
        await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    return false;
}

function chooseFile(files, hint = null) {
    const videoFiles = files.filter(file => torrentUtils.isValidVideo(file?.name || file?.path || '', file?.size, undefined, LOG_PREFIX));
    if (videoFiles.length === 0) return null;

    if (hint?.fileId != null) {
        const matched = videoFiles.find(file => String(file.id) === String(hint.fileId));
        if (matched) return matched;
    }
    if (hint?.filePath) {
        const matched = videoFiles.find(file => String(file.path || file.name || '').endsWith(String(hint.filePath)));
        if (matched) return matched;
    }
    return videoFiles.sort((a, b) => (b.size || 0) - (a.size || 0))[0];
}

async function resolveMagnet(apiKey, hostUrl, config = {}) {
    const { magnet, hint } = parseHint(hostUrl);
    const jc = firstProviderJobConfig(config);
    const jobId = await createTorrentJob(apiKey, magnet, jc);
    if (!jobId) return null;

    const ready = await waitForJobReady(apiKey, jobId, jc);
    if (!ready) return null;

    const filesPayload = await relaygateRequest(
        'get',
        `/api/v0.6-beta/canonical/jobs/${encodeURIComponent(jobId)}/files`,
        apiKey,
        jc,
        null,
        { kind: 'torrent' }
    );
    const files = parseFiles(filesPayload);
    const file = chooseFile(files, hint);
    if (!file?.id) return null;

    const playbackPayload = await relaygateRequest(
        'post',
        `/api/v0.6-beta/canonical/jobs/${encodeURIComponent(jobId)}/files/${encodeURIComponent(file.id)}/playback`,
        apiKey,
        jc,
        {},
        { kind: 'torrent' }
    );
    return pickUrlFromLocations(parseLocations(playbackPayload));
}

async function unrestrictUrl(apiKey, itemId, hostUrl, clientIp, userConfig = {}) {
    try {
        if (!hostUrl) return null;
        if (hostUrl.startsWith('magnet:')) {
            return await resolveMagnet(apiKey, hostUrl, userConfig);
        }
        const payload = await relaygateRequest(
            'post',
            '/api/v0.6-beta/canonical/hoster/links/unlock',
            apiKey,
            firstProviderJobConfig(userConfig),
            { url: hostUrl, client_ip: clientIp || undefined }
        );
        return pickUrlFromLocations(parseLocations(payload));
    } catch (error) {
        console.error(`[${LOG_PREFIX}] resolve failed: ${error.message}`);
        return null;
    }
}

async function searchDownloads(apiKey, searchKey = null, threshold = 0.3, userConfig = {}) {
    try {
        const payload = await relaygateRequest(
            'get',
            '/api/v0.6-beta/canonical/jobs',
            apiKey,
            firstProviderJobConfig(userConfig),
            null,
            { kind: 'torrent' }
        );
        const items = Array.isArray(payload?.items) ? payload.items : [];
        const query = String(searchKey || '').toLowerCase().trim();

        return items
            .map(item => {
                const name = item?.name || item?.title || '';
                return {
                    source: 'relaygate',
                    id: item?.id || item?.job_id,
                    name,
                    info: PTT.parse(name),
                    size: item?.size || 0,
                    hash: (item?.hash || item?.infoHash || '').toLowerCase(),
                    isCached: true,
                    isPersonal: true,
                    url: item?.url || ''
                };
            })
            .filter(item => !query || item.name.toLowerCase().includes(query));
    } catch (error) {
        console.error(`[${LOG_PREFIX}] downloads failed: ${error.message}`);
        return [];
    }
}

async function searchPersonalFiles(apiKey, searchKey, threshold = 0.3, userConfig = {}) {
    return searchDownloads(apiKey, searchKey, threshold, userConfig);
}

export default { searchRelaygateTorrents, unrestrictUrl, searchDownloads, searchPersonalFiles };
