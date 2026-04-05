import { promises as fs } from 'fs'
import { randomUUID } from 'crypto'
import path from 'path'

export const MONTHLY_DONATION_GOAL_USD = 50
export const DEFAULT_DONATION_EMAIL = 'sooti@protonmail.ch'

const DONATION_DATA_FILE = process.env.DONATIONS_DATA_FILE || path.join(process.cwd(), 'data', 'donations.json')
const MAX_MONTH_DONATIONS = 500
const MAX_TRACKED_TXN_IDS = 5000
const MAX_PUBLIC_NAMES = 30
const MAX_NOTE_LENGTH = 160

let cachedState = null
let cachedStateMtimeMs = null
let stateMutationQueue = Promise.resolve()

const DEFAULT_SETTINGS = {
    showGoalBar: false,
    hideGoalBarWhenReached: false,
    goalAmountUsd: 50
}

function createDefaultState() {
    return {
        version: 1,
        months: {},
        processedTxnIds: {},
        settings: { ...DEFAULT_SETTINGS }
    }
}

function getSettings(state) {
    return { ...DEFAULT_SETTINGS, ...(state.settings || {}) }
}

function roundUsd(value) {
    return Math.round((Number(value) || 0) * 100) / 100
}

function getCurrentMonthKey(date = new Date()) {
    const year = date.getUTCFullYear()
    const month = String(date.getUTCMonth() + 1).padStart(2, '0')
    return `${year}-${month}`
}

function formatMonthLabel(monthKey) {
    const [year, month] = monthKey.split('-').map(Number)
    if (!year || !month) return monthKey
    return new Date(Date.UTC(year, month - 1, 1)).toLocaleString('en-US', {
        month: 'long',
        year: 'numeric',
        timeZone: 'UTC'
    })
}

function sanitizeFirstName(value) {
    const safe = String(value || '')
        .trim()
        .replace(/[^a-zA-Z0-9 .'-]/g, '')
        .split(/\s+/)
        .filter(Boolean)[0] || 'Anonymous'

    return safe.slice(0, 24)
}

function normalizeTxnId(value) {
    const txnId = String(value || '').trim()
    if (!txnId) return null
    return txnId.slice(0, 128)
}

function normalizeMonthKey(value) {
    const monthKey = String(value || '').trim()
    if (!/^\d{4}-\d{2}$/.test(monthKey)) return null
    const [, monthStr] = monthKey.split('-')
    const month = Number(monthStr)
    if (month < 1 || month > 12) return null
    return monthKey
}

function sanitizeNote(value) {
    if (value == null) return null
    const note = String(value)
        .replace(/[\r\n\t]+/g, ' ')
        .trim()
        .slice(0, MAX_NOTE_LENGTH)
    return note || null
}

function sanitizeSource(value) {
    return String(value || 'manual').trim().slice(0, 64) || 'manual'
}

function normalizeDonationId(value) {
    const id = String(value || '').trim()
    if (!id) return null
    return id.slice(0, 64)
}

function normalizeCreatedAt(value) {
    if (!value) return new Date().toISOString()
    const date = new Date(String(value))
    if (Number.isNaN(date.getTime())) return new Date().toISOString()
    return date.toISOString()
}

function nextDonationId() {
    if (typeof randomUUID === 'function') {
        return randomUUID().replace(/-/g, '')
    }
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`
}

function txnIdExists(state, txnId, excludeDonationId = null) {
    const safeTxnId = normalizeTxnId(txnId)
    if (!safeTxnId) return false

    for (const bucket of Object.values(state.months || {})) {
        if (!Array.isArray(bucket?.donations)) continue

        for (const donation of bucket.donations) {
            const rowTxnId = normalizeTxnId(donation?.txnId)
            if (rowTxnId !== safeTxnId) continue

            const rowDonationId = normalizeDonationId(donation?.id)
            if (excludeDonationId && rowDonationId === excludeDonationId) continue

            return true
        }
    }

    return false
}

function ensureUniqueDonationId(usedIds, preferredId = null) {
    const candidate = normalizeDonationId(preferredId)
    if (candidate && !usedIds.has(candidate)) {
        usedIds.add(candidate)
        return candidate
    }

    let generated = nextDonationId()
    while (usedIds.has(generated)) {
        generated = nextDonationId()
    }

    usedIds.add(generated)
    return generated
}

async function getDonationFileMtimeMs() {
    try {
        const stat = await fs.stat(DONATION_DATA_FILE)
        return Number(stat.mtimeMs) || 0
    } catch (error) {
        if (error.code === 'ENOENT') return null
        throw error
    }
}

function ensureMonthBucket(state, monthKey) {
    if (!state.months[monthKey]) {
        state.months[monthKey] = {
            totalUsd: 0,
            donations: []
        }
    }
    return state.months[monthKey]
}

async function loadState() {
    const fileMtimeMs = await getDonationFileMtimeMs().catch((error) => {
        console.error('[DONATIONS] Failed to stat donations file:', error.message)
        return cachedStateMtimeMs
    })

    if (cachedState && fileMtimeMs === cachedStateMtimeMs) {
        return cachedState
    }

    try {
        const raw = await fs.readFile(DONATION_DATA_FILE, 'utf8')
        const parsed = JSON.parse(raw)
        cachedState = {
            ...createDefaultState(),
            ...parsed,
            months: parsed?.months && typeof parsed.months === 'object' ? parsed.months : {},
            processedTxnIds: parsed?.processedTxnIds && typeof parsed.processedTxnIds === 'object' ? parsed.processedTxnIds : {}
        }
        cachedStateMtimeMs = fileMtimeMs
    } catch (error) {
        if (error.code !== 'ENOENT') {
            console.error('[DONATIONS] Failed to read donations file, using in-memory state:', error.message)
            if (cachedState) {
                return cachedState
            }
        }
        cachedState = createDefaultState()
        cachedStateMtimeMs = null
    }

    pruneState(cachedState)
    return cachedState
}

async function persistState(state) {
    cachedState = state

    try {
        await fs.mkdir(path.dirname(DONATION_DATA_FILE), { recursive: true })
        const tmpPath = `${DONATION_DATA_FILE}.tmp`
        await fs.writeFile(tmpPath, JSON.stringify(state, null, 2), 'utf8')
        await fs.rename(tmpPath, DONATION_DATA_FILE)
        cachedStateMtimeMs = await getDonationFileMtimeMs().catch(() => Date.now())
    } catch (error) {
        console.error('[DONATIONS] Failed to persist donations file (continuing in-memory):', error.message)
        cachedStateMtimeMs = null
    }
}

function pruneState(state) {
    const usedDonationIds = new Set()

    for (const monthKey of Object.keys(state.months)) {
        const bucket = ensureMonthBucket(state, monthKey)
        if (!Array.isArray(bucket.donations)) {
            bucket.donations = []
        }

        bucket.donations = bucket.donations.map((rawDonation) => {
            const normalized = {
                ...rawDonation,
                id: ensureUniqueDonationId(usedDonationIds, rawDonation?.id),
                firstName: sanitizeFirstName(rawDonation?.firstName),
                amountUsd: roundUsd(rawDonation?.amountUsd),
                source: sanitizeSource(rawDonation?.source),
                txnId: normalizeTxnId(rawDonation?.txnId),
                createdAt: normalizeCreatedAt(rawDonation?.createdAt),
                note: sanitizeNote(rawDonation?.note)
            }

            if (!Number.isFinite(normalized.amountUsd) || normalized.amountUsd < 0) {
                normalized.amountUsd = 0
            }

            return normalized
        })

        if (bucket.donations.length > MAX_MONTH_DONATIONS) {
            bucket.donations = bucket.donations.slice(-MAX_MONTH_DONATIONS)
        }

        bucket.totalUsd = roundUsd(
            bucket.donations.reduce((sum, donation) => sum + (Number(donation.amountUsd) || 0), 0)
        )
    }

    const entries = Object.entries(state.processedTxnIds || {})
    if (entries.length > MAX_TRACKED_TXN_IDS) {
        entries
            .sort((a, b) => (Number(a[1]) || 0) - (Number(b[1]) || 0))
            .slice(0, entries.length - MAX_TRACKED_TXN_IDS)
            .forEach(([txnId]) => {
                delete state.processedTxnIds[txnId]
            })
    }
}

async function mutateState(mutator) {
    let result

    stateMutationQueue = stateMutationQueue
        .catch(() => undefined)
        .then(async () => {
            const state = await loadState()
            result = await mutator(state)
            pruneState(state)
            await persistState(state)
        })

    await stateMutationQueue
    return result
}

function toPublicStatus(state, monthKey = getCurrentMonthKey()) {
    const settings = getSettings(state)
    const bucket = ensureMonthBucket(state, monthKey)
    const raisedUsd = roundUsd(bucket.totalUsd)
    const goalUsd = settings.goalAmountUsd
    const remainingUsd = Math.max(0, roundUsd(goalUsd - raisedUsd))
    const progressPercent = Math.min(100, Math.round((raisedUsd / goalUsd) * 100))
    const goalReached = raisedUsd >= goalUsd

    let showGoalBar = settings.showGoalBar
    if (showGoalBar && settings.hideGoalBarWhenReached && goalReached) {
        showGoalBar = false
    }

    const wallOfThanks = (bucket.donations || [])
        .slice()
        .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
        .map((donation) => ({
            name: sanitizeFirstName(donation.firstName),
            tier: (donation.amountUsd >= 25) ? 'gold' : (donation.amountUsd >= 10) ? 'silver' : 'base'
        }))
        .slice(0, MAX_PUBLIC_NAMES)

    return {
        recipientEmail: getDonationRecipientEmail(),
        currency: 'USD',
        goalUsd,
        raisedUsd,
        remainingUsd,
        progressPercent: Number.isFinite(progressPercent) ? progressPercent : 0,
        showGoalBar,
        monthKey,
        monthLabel: formatMonthLabel(monthKey),
        donationsCount: bucket.donations.length,
        wallOfThanks
    }
}

function toAdminStatus(state, requestedMonthKey = null) {
    const selectedMonthKey = normalizeMonthKey(requestedMonthKey) || getCurrentMonthKey()
    const selectedBucket = ensureMonthBucket(state, selectedMonthKey)
    const publicStatus = toPublicStatus(state, selectedMonthKey)

    const months = Object.keys(state.months || {})
        .sort((a, b) => b.localeCompare(a))
        .map((monthKey) => {
            const bucket = ensureMonthBucket(state, monthKey)
            return {
                monthKey,
                monthLabel: formatMonthLabel(monthKey),
                totalUsd: roundUsd(bucket.totalUsd),
                donationsCount: Array.isArray(bucket.donations) ? bucket.donations.length : 0
            }
        })

    if (!months.some((month) => month.monthKey === selectedMonthKey)) {
        months.unshift({
            monthKey: selectedMonthKey,
            monthLabel: formatMonthLabel(selectedMonthKey),
            totalUsd: roundUsd(selectedBucket.totalUsd),
            donationsCount: selectedBucket.donations.length
        })
    }

    const donations = (selectedBucket.donations || [])
        .slice()
        .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
        .map((donation) => ({
            id: normalizeDonationId(donation.id),
            firstName: sanitizeFirstName(donation.firstName),
            amountUsd: roundUsd(donation.amountUsd),
            source: String(donation.source || 'manual'),
            txnId: donation.txnId || null,
            createdAt: donation.createdAt || null,
            note: sanitizeNote(donation.note) || null
        }))

    return {
        ...publicStatus,
        settings: getSettings(state),
        selectedMonthKey,
        currentMonthKey: getCurrentMonthKey(),
        months,
        donations
    }
}

function getPayPalVerificationUrl() {
    if (process.env.PAYPAL_IPN_VERIFY_URL) return process.env.PAYPAL_IPN_VERIFY_URL
    if (process.env.PAYPAL_SANDBOX === 'true') {
        return 'https://ipnpb.sandbox.paypal.com/cgi-bin/webscr'
    }
    return 'https://ipnpb.paypal.com/cgi-bin/webscr'
}

async function verifyPayPalIpn(payload) {
    if (process.env.PAYPAL_IPN_VERIFY === 'false') {
        return { ok: true, mode: 'disabled' }
    }

    if (typeof fetch !== 'function') {
        throw new Error('Global fetch is not available for PayPal IPN verification')
    }

    const verifyBody = new URLSearchParams()
    verifyBody.append('cmd', '_notify-validate')

    for (const [key, value] of Object.entries(payload || {})) {
        if (Array.isArray(value)) {
            value.forEach((item) => verifyBody.append(key, String(item)))
            continue
        }

        if (value !== undefined && value !== null) {
            verifyBody.append(key, String(value))
        }
    }

    const response = await fetch(getPayPalVerificationUrl(), {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': 'Sootio-PayPal-IPN'
        },
        body: verifyBody.toString()
    })

    const text = (await response.text()).trim()
    if (!response.ok || text !== 'VERIFIED') {
        return { ok: false, reason: 'not_verified', details: text || response.statusText }
    }

    return { ok: true, mode: 'verified' }
}

function getIpnReceiverEmail(payload) {
    return String(payload?.receiver_email || payload?.business || '').trim().toLowerCase()
}

function parseUsdAmount(payload) {
    const amountRaw = payload?.mc_gross ?? payload?.payment_gross ?? payload?.amount
    const amount = roundUsd(Number.parseFloat(String(amountRaw || '0')))
    return amount > 0 ? amount : 0
}

function isCompletedPayment(payload) {
    return String(payload?.payment_status || '').toLowerCase() === 'completed'
}

function isUsd(payload) {
    const currency = String(payload?.mc_currency || 'USD').toUpperCase()
    return currency === 'USD'
}

function getDonationRecipientEmail() {
    return (process.env.PAYPAL_DONATION_EMAIL || DEFAULT_DONATION_EMAIL).trim()
}

export async function getDonationStatus() {
    const state = await loadState()
    return toPublicStatus(state)
}

export async function getDonationAdminStatus(monthKey = null) {
    const state = await loadState()
    return toAdminStatus(state, monthKey)
}

export async function getDonationSettings() {
    const state = await loadState()
    return getSettings(state)
}

export async function updateDonationSettings(newSettings) {
    return mutateState((state) => {
        if (!state.settings) state.settings = { ...DEFAULT_SETTINGS }
        if (newSettings.showGoalBar !== undefined) {
            state.settings.showGoalBar = !!newSettings.showGoalBar
        }
        if (newSettings.hideGoalBarWhenReached !== undefined) {
            state.settings.hideGoalBarWhenReached = !!newSettings.hideGoalBarWhenReached
        }
        if (newSettings.goalAmountUsd !== undefined) {
            const amount = Math.round(Number(newSettings.goalAmountUsd) || 0)
            if (amount > 0 && amount <= 10000) {
                state.settings.goalAmountUsd = amount
            }
        }
        return { updated: true, settings: getSettings(state) }
    })
}

export async function addDonationRecord({
    amountUsd,
    firstName,
    txnId = null,
    source = 'paypal-ipn',
    createdAt = new Date().toISOString(),
    monthKey = null,
    note = null
}) {
    const safeAmount = roundUsd(amountUsd)
    if (!Number.isFinite(safeAmount) || safeAmount <= 0) {
        return { updated: false, reason: 'invalid_amount' }
    }

    const safeTxnId = normalizeTxnId(txnId)
    const safeFirstName = sanitizeFirstName(firstName)
    const safeMonthKey = normalizeMonthKey(monthKey) || getCurrentMonthKey()
    const safeNote = sanitizeNote(note)
    const safeCreatedAt = normalizeCreatedAt(createdAt)
    const safeSource = sanitizeSource(source || 'paypal-ipn')

    return mutateState((state) => {
        if (safeTxnId && (state.processedTxnIds[safeTxnId] || txnIdExists(state, safeTxnId))) {
            return { updated: false, reason: 'duplicate_txn' }
        }

        const bucket = ensureMonthBucket(state, safeMonthKey)
        const usedIds = new Set()
        for (const existingBucket of Object.values(state.months || {})) {
            if (!Array.isArray(existingBucket?.donations)) continue
            existingBucket.donations.forEach((donation) => {
                const donationId = normalizeDonationId(donation?.id)
                if (donationId) usedIds.add(donationId)
            })
        }

        bucket.donations.push({
            id: ensureUniqueDonationId(usedIds),
            firstName: safeFirstName,
            amountUsd: safeAmount,
            source: safeSource,
            txnId: safeTxnId,
            createdAt: safeCreatedAt,
            note: safeNote
        })

        bucket.totalUsd = roundUsd((bucket.totalUsd || 0) + safeAmount)

        if (safeTxnId) {
            state.processedTxnIds[safeTxnId] = Date.now()
        }

        return {
            updated: true,
            status: toPublicStatus(state, safeMonthKey),
            adminStatus: toAdminStatus(state, safeMonthKey)
        }
    })
}

export async function updateDonationRecord({
    donationId,
    monthKey,
    amountUsd,
    firstName,
    txnId,
    source,
    createdAt,
    note
}) {
    const safeDonationId = normalizeDonationId(donationId)
    if (!safeDonationId) {
        return { updated: false, reason: 'invalid_donation_id' }
    }

    const safeMonthKey = normalizeMonthKey(monthKey) || getCurrentMonthKey()
    const safeFirstName = sanitizeFirstName(firstName)
    const safeAmount = roundUsd(amountUsd)
    if (!Number.isFinite(safeAmount) || safeAmount <= 0) {
        return { updated: false, reason: 'invalid_amount' }
    }

    const safeSource = sanitizeSource(source || 'manual-paypal-check')
    const safeTxnId = normalizeTxnId(txnId)
    const safeCreatedAt = createdAt == null || String(createdAt).trim() === ''
        ? null
        : normalizeCreatedAt(createdAt)
    const safeNote = sanitizeNote(note)

    return mutateState((state) => {
        const bucket = ensureMonthBucket(state, safeMonthKey)
        if (!Array.isArray(bucket.donations)) {
            bucket.donations = []
        }

        const donationIndex = bucket.donations.findIndex((donation) => normalizeDonationId(donation?.id) === safeDonationId)
        if (donationIndex < 0) {
            return { updated: false, reason: 'donation_not_found' }
        }

        const existingDonation = bucket.donations[donationIndex]
        const existingTxnId = normalizeTxnId(existingDonation?.txnId)
        if (
            safeTxnId &&
            safeTxnId !== existingTxnId &&
            (state.processedTxnIds[safeTxnId] || txnIdExists(state, safeTxnId, safeDonationId))
        ) {
            return { updated: false, reason: 'duplicate_txn' }
        }

        bucket.donations[donationIndex] = {
            ...existingDonation,
            id: safeDonationId,
            firstName: safeFirstName,
            amountUsd: safeAmount,
            source: safeSource,
            txnId: safeTxnId,
            createdAt: safeCreatedAt || normalizeCreatedAt(existingDonation?.createdAt),
            note: safeNote
        }

        if (safeTxnId) {
            state.processedTxnIds[safeTxnId] = Date.now()
        }

        return {
            updated: true,
            status: toPublicStatus(state, safeMonthKey),
            adminStatus: toAdminStatus(state, safeMonthKey)
        }
    })
}

export async function deleteDonationRecord({
    donationId,
    monthKey
}) {
    const safeDonationId = normalizeDonationId(donationId)
    if (!safeDonationId) {
        return { updated: false, reason: 'invalid_donation_id' }
    }

    const safeMonthKey = normalizeMonthKey(monthKey) || getCurrentMonthKey()

    return mutateState((state) => {
        const bucket = ensureMonthBucket(state, safeMonthKey)
        if (!Array.isArray(bucket.donations)) {
            bucket.donations = []
        }

        const donationIndex = bucket.donations.findIndex((donation) => normalizeDonationId(donation?.id) === safeDonationId)
        if (donationIndex < 0) {
            return { updated: false, reason: 'donation_not_found' }
        }

        bucket.donations.splice(donationIndex, 1)

        return {
            updated: true,
            status: toPublicStatus(state, safeMonthKey),
            adminStatus: toAdminStatus(state, safeMonthKey)
        }
    })
}

export async function processPayPalIpn(payload = {}) {
    const verification = await verifyPayPalIpn(payload)
    if (!verification.ok) {
        return { updated: false, ignored: true, reason: verification.reason || 'verification_failed' }
    }

    if (!isCompletedPayment(payload)) {
        return { updated: false, ignored: true, reason: 'payment_not_completed' }
    }

    if (!isUsd(payload)) {
        return { updated: false, ignored: true, reason: 'non_usd_payment' }
    }

    const receiverEmail = getIpnReceiverEmail(payload)
    const expectedReceiver = getDonationRecipientEmail().toLowerCase()
    if (!receiverEmail || receiverEmail !== expectedReceiver) {
        return { updated: false, ignored: true, reason: 'receiver_mismatch' }
    }

    const amountUsd = parseUsdAmount(payload)
    if (!amountUsd) {
        return { updated: false, ignored: true, reason: 'invalid_amount' }
    }

    const firstName = payload.first_name || payload.payer_first_name || payload.address_name || 'Anonymous'
    const txnId = normalizeTxnId(payload.txn_id)

    return addDonationRecord({
        amountUsd,
        firstName,
        txnId,
        source: 'paypal-ipn'
    })
}
