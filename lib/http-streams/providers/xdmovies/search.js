/**
 * XDMovies Search Helpers
 * Handles search API and page parsing for XDMovies
 */

import * as cheerio from 'cheerio';
import { makeRequest } from '../../utils/http.js';
import { cleanTitle, getResolutionFromName } from '../../utils/parsing.js';
import { detectLanguagesFromTitle } from '../../../util/language-mapping.js';
import { fetchWithFlaresolverr } from '../../../util/flaresolverr-manager.js';

const BASE_URL = process.env.XDMOVIES_BASE_URL || 'https://top.xdmovies.wtf';
const SEARCH_CACHE_TTL = parseInt(process.env.XDMOVIES_SEARCH_CACHE_TTL, 10) || 30 * 60 * 1000; // 30 minutes
const PAGE_CACHE_TTL = parseInt(process.env.XDMOVIES_PAGE_CACHE_TTL, 10) || 10 * 60 * 1000; // 10 minutes

// In-memory caches
const searchCache = new Map(); // query -> { fetchedAt, data }
const pageCache = new Map(); // url -> { fetchedAt, data }

// Auth token fetched from /php/get_token.php (cached for 1 hour)
let cachedToken = null;
let tokenTimestamp = 0;
const TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Get auth token from the XDMovies API (cached for 1 hour)
 */
async function getAuthToken() {
    const now = Date.now();
    if (cachedToken && now - tokenTimestamp < TOKEN_TTL_MS) {
        return cachedToken;
    }
    try {
        const response = await makeRequest(`${BASE_URL}/php/get_token.php`, { timeout: 5000 });
        const data = JSON.parse(response.body);
        if (data.token) {
            cachedToken = data.token;
            tokenTimestamp = now;
            console.log(`[XDMovies] Got fresh auth token`);
            return cachedToken;
        }
    } catch (e) {
        console.log(`[XDMovies] Failed to get token, using fallback: ${e.message}`);
    }
    return cachedToken || '7297skkihkajwnsgaklakshuwd'; // fallback
}

function getSearchHeaders(token) {
    return {
        'x-auth-token': token,
        'x-requested-with': 'XMLHttpRequest',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    };
}

/**
 * Search XDMovies using their API
 * @param {string} query - Search query
 * @param {number} limit - Maximum results to return
 * @returns {Promise<Array>} Search results
 */
export async function searchXDMovies(query, limit = 15) {
    if (!query) return [];

    const cacheKey = `search:${query.toLowerCase().trim()}`;
    const now = Date.now();

    // Check in-memory cache
    const cached = searchCache.get(cacheKey);
    if (cached && now - cached.fetchedAt < SEARCH_CACHE_TTL) {
        console.log(`[XDMovies] Using cached search results for "${query}"`);
        return cached.data.slice(0, limit);
    }

    try {
        const token = await getAuthToken();
        const searchUrl = `${BASE_URL}/php/search_api.php?query=${encodeURIComponent(query)}&fuzzy=true`;
        console.log(`[XDMovies] Searching: ${searchUrl}`);

        const response = await makeRequest(searchUrl, {
            headers: getSearchHeaders(token),
            timeout: 10000
        });

        let data = [];
        try {
            data = JSON.parse(response.body);
        } catch (e) {
            console.error('[XDMovies] Failed to parse search response:', e.message);
            return [];
        }

        if (!Array.isArray(data)) {
            console.log('[XDMovies] Search returned non-array response');
            return [];
        }

        const results = data.map(item => ({
            id: item.id,
            tmdbId: item.tmdb_id,
            title: item.title,
            path: item.path,
            url: `${BASE_URL}${item.path}`,
            poster: item.poster ? `https://image.tmdb.org/t/p/original${item.poster}` : null,
            type: item.type?.toLowerCase() === 'tv' || item.type?.toLowerCase() === 'series' ? 'series' : 'movie',
            year: item.release_year ? parseInt(item.release_year) : null,
            qualities: item.qualities || [],
            audioLanguages: item.audio_languages,
            exactMatch: item.exact_match === 1
        }));

        // Cache results in memory
        searchCache.set(cacheKey, { fetchedAt: now, data: results });

        console.log(`[XDMovies] Found ${results.length} results for "${query}"`);
        return results.slice(0, limit);
    } catch (error) {
        console.error(`[XDMovies] Search error for "${query}":`, error.message);
        return [];
    }
}

/**
 * Extract season and episode from text
 */
function extractSeasonEpisode(text) {
    if (!text) return {};

    const seasonMatch = text.match(/S(?:eason)?\s*0*(\d+)/i);
    const episodeMatch = text.match(/E(?:pisode)?\s*0*(\d+)/i) || text.match(/\bEp?\s*0*(\d+)/i);

    return {
        season: seasonMatch ? parseInt(seasonMatch[1]) : null,
        episode: episodeMatch ? parseInt(episodeMatch[1]) : null
    };
}

/**
 * Extract size from text
 */
function extractSize(text) {
    if (!text) return null;
    const match = text.match(/([0-9]+(?:\.[0-9]+)?)\s*(TB|GB|MB)/i);
    return match ? `${match[1]} ${match[2].toUpperCase()}` : null;
}

/**
 * Load content page and extract download links
 * @param {string} url - Page URL
 * @returns {Promise<Object|null>} Parsed content with download links
 */
export async function loadXDMoviesContent(url) {
    if (!url) return null;

    const now = Date.now();

    // Check in-memory cache
    const cached = pageCache.get(url);
    if (cached && now - cached.fetchedAt < PAGE_CACHE_TTL) {
        console.log(`[XDMovies] Using cached content for ${url}`);
        return cached.data;
    }

    try {
        console.log(`[XDMovies] Loading content page: ${url}`);

        let html = null;

        // Try direct request first
        try {
            const response = await makeRequest(url, {
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
                timeout: 10000
            });
            // Check if we got a CF challenge instead of real content
            if (response.body && !response.body.includes('Just a moment') && !response.body.includes('cf_chl_opt')) {
                html = response.body;
            } else {
                console.log(`[XDMovies] Cloudflare challenge detected, using FlareSolverr`);
            }
        } catch (e) {
            console.log(`[XDMovies] Direct request failed: ${e.message}, trying FlareSolverr`);
        }

        // Fallback to FlareSolverr for Cloudflare-protected pages
        if (!html) {
            const flareResult = await fetchWithFlaresolverr(url, { timeout: 30000 });
            if (!flareResult?.body) {
                console.error(`[XDMovies] FlareSolverr also failed for ${url}`);
                return null;
            }
            html = flareResult.body;
        }

        const $ = cheerio.load(html);

        // Extract basic info
        const infoDiv = $('div.info').first();
        const title = infoDiv.find('h2').text().trim() || $('h1').first().text().trim() || $('title').text().replace(/\s*[—|].*/,'').trim();
        const description = $('p.overview').text().trim();

        // Extract year from URL or page
        const urlTmdbId = url.match(/-(\d+)$/)?.[1];
        const releaseDateText = $('p:contains("Release Date:")').text() || $('p:contains("First Air Date:")').text();
        const yearMatch = releaseDateText.match(/(\d{4})/);
        const year = yearMatch ? parseInt(yearMatch[1]) : null;

        // Determine content type from URL path
        const pathType = url.split('/')[3]; // e.g., 'movie', 'tv', 'anime'
        const type = ['tv', 'series', 'anime'].includes(pathType?.toLowerCase()) ? 'series' : 'movie';

        // Extract audio languages from page
        const audioText = $('span.neon-audio').text().trim() || '';

        const downloadLinks = [];

        // For movies: div.download-item contains div.custom-title + a.movie-download-btn
        $('div.download-item').each((_, el) => {
            const $item = $(el);
            const $link = $item.find('a.movie-download-btn, a.download-button, a[href*="xdmovies"]').first();
            const href = $link.attr('href')?.trim();
            if (!href) return;

            const customTitle = $item.find('.custom-title, .episode-title').text().trim();
            const linkText = $link.text().trim();
            const size = extractSize(linkText) || extractSize(customTitle);
            const label = customTitle || linkText || '';

            downloadLinks.push({
                url: href,
                label,
                quality: getResolutionFromName(label),
                size,
                languages: detectLanguagesFromTitle(label) || detectLanguagesFromTitle(audioText),
                ...extractSeasonEpisode(label)
            });
        });

        // For series: #season-episodes-{N} .episode-card
        const episodeData = [];
        // Find all season-episodes containers
        $('[id^="season-episodes-"]').each((_, section) => {
            const sectionId = $(section).attr('id') || '';
            const seasonMatch = sectionId.match(/season-episodes-(\d+)/);
            const seasonNum = seasonMatch ? parseInt(seasonMatch[1]) : 1;

            $(section).find('.episode-card').each((idx, card) => {
                const $card = $(card);
                const cardTitle = $card.find('.episode-title, .custom-title').text().trim();
                const epMatch = cardTitle.match(/S(\d+)\s*E(\d+)/i) || cardTitle.match(/Episode\s*(\d+)/i);
                const epNum = epMatch ? parseInt(epMatch[2] || epMatch[1]) : (idx + 1);

                const links = [];
                $card.find('a.movie-download-btn, a.download-button, a[href*="xdmovies"]').each((_, a) => {
                    const href = $(a).attr('href')?.trim();
                    if (href) {
                        const linkText = $(a).text().trim();
                        const label = cardTitle || linkText || `S${seasonNum}E${epNum}`;
                        const size = extractSize(linkText) || extractSize(cardTitle);
                        links.push({
                            url: href,
                            label,
                            quality: getResolutionFromName(cardTitle) || getResolutionFromName(linkText),
                            size,
                            languages: detectLanguagesFromTitle(cardTitle) || detectLanguagesFromTitle(audioText),
                            season: seasonNum,
                            episode: epNum
                        });
                    }
                });

                if (links.length > 0) {
                    episodeData.push({ season: seasonNum, episode: epNum, title: cardTitle, links });
                }
            });

            // Pack cards
            $(section).find('.packs-grid .pack-card').each((_, pack) => {
                const href = $(pack).find('a.download-button, a.movie-download-btn').attr('href')?.trim();
                if (href) {
                    const packLabel = $(pack).text().trim() || `Season ${seasonNum} Pack`;
                    downloadLinks.push({
                        url: href,
                        label: packLabel,
                        quality: getResolutionFromName(packLabel),
                        size: extractSize(packLabel),
                        languages: detectLanguagesFromTitle(packLabel),
                        season: seasonNum,
                        episode: null,
                        isPack: true
                    });
                }
            });
        });

        // Also check old-style div.season-section as fallback
        if (episodeData.length === 0) {
            $('div.season-section').each((_, section) => {
                const sectionHtml = $(section).html() || '';
                const sm = sectionHtml.match(/season-(?:packs|episodes)-(\d+)/i) ||
                    $(section).find('button.toggle-season-btn').text().match(/Season\s*(\d+)/i);
                const seasonNum = sm ? parseInt(sm[1]) : 1;

                $(section).find('.episode-card').each((idx, card) => {
                    const cardTitle = $(card).find('.episode-title').text().trim();
                    const epMatch = cardTitle.match(/S(\d+)E(\d+)/i) || cardTitle.match(/Episode\s*(\d+)/i);
                    const epNum = epMatch ? parseInt(epMatch[2] || epMatch[1]) : (idx + 1);
                    const links = [];
                    $(card).find('a.movie-download-btn, a.download-button, a[href*="xdmovies"]').each((_, a) => {
                        const href = $(a).attr('href')?.trim();
                        if (href) {
                            const linkText = $(a).text().trim();
                            const label = cardTitle || linkText || `S${seasonNum}E${epNum}`;
                            links.push({ url: href, label, quality: getResolutionFromName(label), size: extractSize(linkText), languages: detectLanguagesFromTitle(label), season: seasonNum, episode: epNum });
                        }
                    });
                    if (links.length > 0) episodeData.push({ season: seasonNum, episode: epNum, title: cardTitle, links });
                });
            });
        }

        // Flatten episode data to download links
        if (episodeData.length > 0) {
            episodeData.forEach(ep => downloadLinks.push(...ep.links));
        }

        const titleLanguages = detectLanguagesFromTitle(title) || detectLanguagesFromTitle(audioText);

        const data = {
            url, title, year, type,
            tmdbId: urlTmdbId ? parseInt(urlTmdbId) : null,
            description, titleLanguages, downloadLinks, episodeData
        };

        pageCache.set(url, { fetchedAt: now, data });
        console.log(`[XDMovies] Loaded content: "${title}" with ${downloadLinks.length} download links`);
        return data;
    } catch (error) {
        console.error(`[XDMovies] Failed to load content ${url}:`, error.message);
        return null;
    }
}

export { BASE_URL };
