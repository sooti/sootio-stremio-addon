import Router from 'router'
import cors from 'cors'
import rateLimit from "express-rate-limit";
import requestIp from 'request-ip'
import addonInterface from "./addon.js"
import landingTemplate from "./lib/util/landingTemplate.js"
import donationAdminTemplate from "./lib/util/donationAdminTemplate.js"
import StreamProvider from './lib/stream-provider.js'
import { decode } from 'urlencode'
import qs from 'querystring'
import { getManifest } from './lib/util/manifest.js'
import { parseConfiguration } from './lib/util/configuration.js'
import { BadTokenError, BadRequestError, AccessDeniedError } from './lib/util/error-codes.js'
import RealDebrid from './lib/real-debrid.js'
import { addDonationRecord, deleteDonationRecord, getDonationAdminStatus, getDonationStatus, processPayPalIpn, updateDonationRecord } from './lib/util/donationTracker.js'

const router = new Router();
const limiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 300, // limit each IP to 300 requests per windowMs
  headers: false,
  keyGenerator: (req) => requestIp.getClientIp(req)
})

router.use(cors())

function readRequestBody(req) {
    return new Promise((resolve, reject) => {
        let body = ''

        req.on('data', (chunk) => {
            body += chunk
            if (body.length > 1024 * 256) {
                reject(new Error('Request body too large'))
                req.destroy()
            }
        })

        req.on('end', () => resolve(body))
        req.on('error', reject)
    })
}

function parseServerlessRequestUrl(req) {
    try {
        const host = req.headers?.host || 'localhost'
        return new URL(req.url || '/', `http://${host}`)
    } catch (_) {
        return new URL('http://localhost/')
    }
}

function getDonationsAdminToken() {
    return String(process.env.DONATIONS_ADMIN_TOKEN || '').trim()
}

function getServerlessRequestAdminToken(req, parsedBody = null) {
    const authHeader = String(req.headers?.authorization || '')
    if (authHeader.toLowerCase().startsWith('bearer ')) {
        return authHeader.slice(7).trim()
    }

    const headerToken = String(req.headers?.['x-donations-admin-token'] || '').trim()
    if (headerToken) return headerToken

    const url = parseServerlessRequestUrl(req)
    const queryToken = (url.searchParams.get('token') || '').trim()
    if (queryToken) return queryToken

    const bodyToken = String(parsedBody?.token || '').trim()
    if (bodyToken) return bodyToken

    return ''
}

function sendJson(res, statusCode, payload) {
    res.statusCode = statusCode
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.end(JSON.stringify(payload))
}

function ensureServerlessDonationsAdminAuthorized(req, res, parsedBody = null) {
    const configuredToken = getDonationsAdminToken()
    if (!configuredToken) {
        sendJson(res, 503, { err: 'DONATIONS_ADMIN_TOKEN is not configured' })
        return false
    }

    const requestToken = getServerlessRequestAdminToken(req, parsedBody)
    if (!requestToken || requestToken !== configuredToken) {
        sendJson(res, 401, { err: 'Unauthorized' })
        return false
    }

    return true
}

async function parseServerlessBody(req) {
    const rawBody = await readRequestBody(req)
    const contentType = String(req.headers?.['content-type'] || '').toLowerCase()

    if (contentType.includes('application/json')) {
        try {
            return JSON.parse(rawBody || '{}')
        } catch (_) {
            return {}
        }
    }

    return qs.parse(rawBody)
}

router.get('/', (_, res) => {
    res.redirect('/configure')
    res.end();
})

router.get('/donations/admin', (req, res) => {
    const configuredToken = getDonationsAdminToken()
    if (!configuredToken) {
        res.statusCode = 503
        res.end('DONATIONS_ADMIN_TOKEN is not configured. Set it in .env and restart.')
        return
    }

    const requestToken = getServerlessRequestAdminToken(req)
    if (!requestToken || requestToken !== configuredToken) {
        res.statusCode = 401
        res.end('Unauthorized. Open /donations/admin?token=YOUR_TOKEN')
        return
    }

    res.setHeader('cache-control', 'no-store')
    res.setHeader('content-type', 'text/html; charset=utf-8')
    res.end(donationAdminTemplate())
})

router.get('/donations/status.json', async (_, res) => {
    try {
        const status = await getDonationStatus()
        sendJson(res, 200, status)
    } catch (error) {
        console.error('[DONATIONS] Failed to serve donation status:', error.message)
        sendJson(res, 500, { err: 'Donation status unavailable' })
    }
})

router.get('/donations/admin/status.json', async (req, res) => {
    if (!ensureServerlessDonationsAdminAuthorized(req, res)) {
        return
    }

    try {
        const url = parseServerlessRequestUrl(req)
        const month = url.searchParams.get('month') || null
        const status = await getDonationAdminStatus(month)
        res.setHeader('cache-control', 'no-store')
        sendJson(res, 200, status)
    } catch (error) {
        console.error('[DONATIONS] Failed to serve admin donation status:', error.message)
        sendJson(res, 500, { err: 'Admin donation status unavailable' })
    }
})

router.post('/donations/admin/add', async (req, res) => {
    try {
        const body = await parseServerlessBody(req)
        if (!ensureServerlessDonationsAdminAuthorized(req, res, body)) {
            return
        }

        const result = await addDonationRecord({
            amountUsd: body.amountUsd,
            firstName: body.firstName,
            txnId: body.txnId || null,
            source: body.source || 'manual-paypal-check',
            createdAt: body.createdAt || new Date().toISOString(),
            monthKey: body.monthKey || null,
            note: body.note || null
        })

        if (!result?.updated) {
            sendJson(res, 400, { ok: false, reason: result?.reason || 'not_updated' })
            return
        }

        sendJson(res, 200, { ok: true, status: result.status, adminStatus: result.adminStatus })
    } catch (error) {
        console.error('[DONATIONS] Failed to add manual donation:', error.message)
        sendJson(res, 500, { ok: false, err: 'Failed to add donation' })
    }
})

router.post('/donations/admin/edit', async (req, res) => {
    try {
        const body = await parseServerlessBody(req)
        if (!ensureServerlessDonationsAdminAuthorized(req, res, body)) {
            return
        }

        const result = await updateDonationRecord({
            donationId: body.donationId,
            monthKey: body.monthKey || null,
            amountUsd: body.amountUsd,
            firstName: body.firstName,
            txnId: body.txnId || null,
            source: body.source || 'manual-paypal-check',
            createdAt: body.createdAt ?? null,
            note: body.note || null
        })

        if (!result?.updated) {
            sendJson(res, 400, { ok: false, reason: result?.reason || 'not_updated' })
            return
        }

        sendJson(res, 200, { ok: true, status: result.status, adminStatus: result.adminStatus })
    } catch (error) {
        console.error('[DONATIONS] Failed to edit donation:', error.message)
        sendJson(res, 500, { ok: false, err: 'Failed to edit donation' })
    }
})

router.post('/donations/admin/delete', async (req, res) => {
    try {
        const body = await parseServerlessBody(req)
        if (!ensureServerlessDonationsAdminAuthorized(req, res, body)) {
            return
        }

        const result = await deleteDonationRecord({
            donationId: body.donationId,
            monthKey: body.monthKey || null
        })

        if (!result?.updated) {
            sendJson(res, 400, { ok: false, reason: result?.reason || 'not_updated' })
            return
        }

        sendJson(res, 200, { ok: true, status: result.status, adminStatus: result.adminStatus })
    } catch (error) {
        console.error('[DONATIONS] Failed to delete donation:', error.message)
        sendJson(res, 500, { ok: false, err: 'Failed to delete donation' })
    }
})

router.post('/paypal/ipn', async (req, res) => {
    try {
        const payload = await parseServerlessBody(req)
        const result = await processPayPalIpn(payload)
        if (result?.updated) {
            console.log(`[DONATIONS] PayPal IPN recorded (${payload?.txn_id || 'no-txn-id'})`)
        }
        res.statusCode = 200
        res.end('OK')
    } catch (error) {
        console.error('[DONATIONS] PayPal IPN processing failed:', error.message)
        res.statusCode = 500
        res.end('IPN processing failed')
    }
})

router.get('/:configuration?/configure', async (req, res) => {
    const config = parseConfiguration(req.params.configuration)
    const host = `${req.protocol}://${req.headers.host}`;
    const configValues = { ...config, host };
    const landingHTML = await landingTemplate(addonInterface.manifest, configValues)
    res.setHeader('content-type', 'text/html')
    res.end(landingHTML)
})

router.get('/:configuration?/manifest.json', (req, res) => {
    const config = parseConfiguration(req.params.configuration)
    const host = `${req.protocol}://${req.headers.host}`;
    const configValues = { ...config, host };
    // For initial install (no configuration) or when ShowCatalog is explicitly disabled, serve manifest without catalogs
    const noCatalogs = Object.keys(config).length === 0 || config.ShowCatalog === false;
    
    // Set proper headers for Stremio compatibility (keeps the CORS fix)
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    
    res.end(JSON.stringify(getManifest(configValues, noCatalogs)))
})

router.get(`/:configuration?/:resource/:type/:id/:extra?.json`, limiter, (req, res, next) => {
    console.log(`[DEBUG-ROUTE] Received request: resource=${req.params.resource}, type=${req.params.type}, id=${req.params.id}, config length=${req.params.configuration?.length || 0}`)
    const { resource, type, id } = req.params
    const config = parseConfiguration(req.params.configuration)
    console.log(`[DEBUG-ROUTE] Parsed config providers: ${config.DebridServices?.map(s => s.provider).join(', ') || 'none'}`)
    const extra = req.params.extra ? qs.parse(req.url.split('/').pop().slice(0, -5)) : {}
    const host = `${req.protocol}://${req.headers.host}`;
    const clientIp = requestIp.getClientIp(req);

    // Combine all configuration values properly, including clientIp
    const fullConfig = { ...config, host, clientIp };

    addonInterface.get(resource, type, id, extra, fullConfig)
        .then(async (resp) => {
            if (fullConfig.DebridProvider === 'RealDebrid' && resp && resp.streams) {
                resp.streams = await RealDebrid.validatePersonalStreams(fullConfig.DebridApiKey, resp.streams);
            }

            let cacheHeaders = {
                cacheMaxAge: 'max-age',
                staleRevalidate: 'stale-while-revalidate',
                staleError: 'stale-if-error'
            }

            const cacheControl = Object.keys(cacheHeaders)
                .map(prop => Number.isInteger(resp[prop]) && cacheHeaders[prop] + '=' + resp[prop])
                .filter(val => !!val).join(', ')

            res.setHeader('Cache-Control', `${cacheControl}, public`)
            res.setHeader('Content-Type', 'application/json; charset=utf-8')
            res.end(JSON.stringify(resp))
        })
        .catch(err => {
            console.error(err)
            handleError(err, res)
        })
})

router.get('/resolve/:debridProvider/:debridApiKey/:id/:hostUrl', limiter, (req, res) => {
    const clientIp = requestIp.getClientIp(req)
    const decodedHostUrl = decode(req.params.hostUrl)

    // Validate hostUrl parameter
    if (!decodedHostUrl || decodedHostUrl === 'undefined') {
        console.error('[RESOLVER] Missing or invalid hostUrl parameter')
        return res.status(400).send('Missing or invalid hostUrl parameter')
    }

    const cacheKey = typeof req.query.cacheKey === 'string' ? req.query.cacheKey : null;
    const cacheHash = typeof req.query.cacheHash === 'string' ? req.query.cacheHash : null;
    const resolveConfig = {};
    if (cacheKey && cacheKey.length < 512) resolveConfig.cacheKey = cacheKey;
    if (cacheHash && cacheHash.length < 128) resolveConfig.cacheHash = cacheHash;

    StreamProvider.resolveUrl(req.params.debridProvider, req.params.debridApiKey, req.params.id, decodedHostUrl, clientIp, resolveConfig)
        .then(url => {
            res.redirect(url)
        })
        .catch(err => {
            console.log(err)
            handleError(err, res)
        })
})

// Handle 3-parameter resolve URLs (compatibility with server.js format)
router.get('/resolve/:debridProvider/:debridApiKey/:url', limiter, (req, res) => {
    const { debridProvider, debridApiKey, url } = req.params;

    // Validate required parameters
    if (!url || url === 'undefined') {
        console.error('[RESOLVER] Missing or invalid URL parameter');
        return res.status(400).send('Missing or invalid URL parameter');
    }

    const decodedUrl = decodeURIComponent(url);
    const clientIp = requestIp.getClientIp(req);

    const cacheKey = typeof req.query.cacheKey === 'string' ? req.query.cacheKey : null;
    const cacheHash = typeof req.query.cacheHash === 'string' ? req.query.cacheHash : null;
    const resolveConfig = {};
    if (cacheKey && cacheKey.length < 512) resolveConfig.cacheKey = cacheKey;
    if (cacheHash && cacheHash.length < 128) resolveConfig.cacheHash = cacheHash;

    StreamProvider.resolveUrl(debridProvider, debridApiKey, null, decodedUrl, clientIp, resolveConfig)
        .then(url => {
            if (url) {
                res.redirect(url)
            } else {
                res.status(404).send('Could not resolve link');
            }
        })
        .catch(err => {
            console.log(err)
            handleError(err, res)
        })
})

router.get('/ping', (_, res) => {
    res.statusCode = 200
    res.end()
})

function handleError(err, res) {
    if (err == BadTokenError) {
        res.writeHead(401)
        res.end(JSON.stringify({ err: 'Bad token' }))
    } else if (err == AccessDeniedError) {
        res.writeHead(403)
        res.end(JSON.stringify({ err: 'Access denied' }))
    } else if (err == BadRequestError) {
        res.writeHead(400)
        res.end(JSON.stringify({ err: 'Bad request' }))
    } else {
        res.writeHead(500)
        res.end(JSON.stringify({ err: 'Server error' }))
    }
}

export default function (req, res) {
    router(req, res, function () {
        res.statusCode = 404;
        res.end();
    });
}
