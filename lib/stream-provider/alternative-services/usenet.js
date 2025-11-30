/**
 * Usenet stream provider
 * Fetches and formats streams from Usenet/Newznab indexers
 * Includes personal file matching from file server
 */

import Usenet from '../../usenet.js';
import Cinemeta from '../../util/cinemeta.js';
import { getResolutionFromName, formatSize } from '../../common/torrent-utils.js';
import { filterYear } from '../../util/filter-torrents.js';
import { STREAM_NAME_MAP } from '../config/stream-names.js';

const ADDON_HOST = process.env.ADDON_URL;

/**
 * Get streams from Usenet
 * Combines Newznab search results with personal files from file server
 *
 * @param {Object} config - User configuration with Usenet/Newznab settings
 * @param {string} type - Content type ('movie' or 'series')
 * @param {string} id - Content ID (IMDB ID or IMDB:season:episode)
 * @returns {Promise<Array>} - Array of stream objects
 */
export async function getUsenetStreams(config, type, id) {
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
          timeout: 15000, // Increased to 15s for on-demand archive extraction
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

    const base = ADDON_HOST || '';

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
