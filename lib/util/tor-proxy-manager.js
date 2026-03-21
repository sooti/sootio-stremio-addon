/**
 * Tor Proxy Manager
 * Manages multiple Tor instances with circuit rotation for bypassing
 * Cloudflare blocks on mkvdrama.net. Tor exits have ~10% chance of
 * being unblocked, so we aggressively rotate circuits and race requests.
 *
 * Flow:
 * 1. On init, starts N Tor instances on ports 9050..9050+N
 * 2. For each request, tests all instances in parallel
 * 3. If all blocked, rotates circuits via control ports and retries
 * 4. Caches known-good exits (short TTL since they get blocked quickly)
 */

import { execFile, exec } from 'child_process';
import { promisify } from 'util';
import { SocksProxyAgent } from 'socks-proxy-agent';
import net from 'net';
import axios from 'axios';
import fs from 'fs';

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);

const TOR_INSTANCE_COUNT = parseInt(process.env.TOR_INSTANCE_COUNT || '10', 10);
const TOR_BASE_SOCKS_PORT = parseInt(process.env.TOR_BASE_SOCKS_PORT || '9050', 10);
const TOR_BASE_CTRL_PORT = parseInt(process.env.TOR_BASE_CTRL_PORT || '9150', 10);
const TOR_CONTROL_PASSWORD = process.env.TOR_CONTROL_PASSWORD || 'mkvdrama_rotate';
const TOR_MAX_ROTATION_ROUNDS = parseInt(process.env.TOR_MAX_ROTATION_ROUNDS || '5', 10);
const TOR_CIRCUIT_SETTLE_MS = parseInt(process.env.TOR_CIRCUIT_SETTLE_MS || '8000', 10);
const TOR_REQUEST_TIMEOUT_MS = parseInt(process.env.TOR_REQUEST_TIMEOUT_MS || '10000', 10);
const TOR_KNOWN_GOOD_TTL_MS = 60_000; // Working exits expire in 60s (they get blocked fast)
const TOR_ENABLED = process.env.MKVDRAMA_TOR_ENABLED !== 'false';
const TOR_HOST = (process.env.TOR_HOST || '127.0.0.1').trim();

class TorProxyManager {
    constructor() {
        this.instances = []; // { socksPort, ctrlPort, agent }
        this.knownGood = new Map(); // port -> { ts, ip }
        this.initialized = false;
        this.initializing = null;
    }

    /**
     * Initialize Tor instances. Idempotent — only runs once.
     */
    async init() {
        if (!TOR_ENABLED) return;
        if (this.initialized) return;
        if (this.initializing) return this.initializing;

        this.initializing = this._doInit().finally(() => { this.initializing = null; });
        return this.initializing;
    }

    async _doInit() {
        // Check if Tor instances are already running (from previous process or systemd)
        for (let i = 0; i < TOR_INSTANCE_COUNT; i++) {
            const socksPort = TOR_BASE_SOCKS_PORT + i;
            const ctrlPort = TOR_BASE_CTRL_PORT + i;
            const isRunning = await this._isPortOpen(socksPort);
            if (isRunning) {
                this.instances.push({
                    socksPort,
                    ctrlPort,
                    agent: new SocksProxyAgent(`socks5h://${TOR_HOST}:${socksPort}`)
                });
            }
        }

        if (this.instances.length > 0) {
            console.log(`[TorProxy] Found ${this.instances.length} running Tor instances`);
            this.initialized = true;
            return;
        }

        // Start Tor instances
        console.log(`[TorProxy] Starting ${TOR_INSTANCE_COUNT} Tor instances...`);
        try {
            await this._startInstances();
            this.initialized = true;
            console.log(`[TorProxy] ${this.instances.length} instances ready`);
        } catch (error) {
            console.error(`[TorProxy] Failed to start Tor instances: ${error.message}`);
        }
    }

    async _isPortOpen(port) {
        return new Promise((resolve) => {
            const socket = net.createConnection({ port, host: TOR_HOST });
            socket.setTimeout(1000);
            socket.on('connect', () => { socket.destroy(); resolve(true); });
            socket.on('error', () => resolve(false));
            socket.on('timeout', () => { socket.destroy(); resolve(false); });
        });
    }

    async _startInstances() {
        // Generate hashed password once
        let hashedPassword;
        try {
            const { stdout } = await execFileAsync('tor', ['--hash-password', TOR_CONTROL_PASSWORD]);
            hashedPassword = stdout.trim();
        } catch {
            console.error('[TorProxy] Failed to hash Tor control password');
            return;
        }

        const startPromises = [];
        for (let i = 0; i < TOR_INSTANCE_COUNT; i++) {
            const socksPort = TOR_BASE_SOCKS_PORT + i;
            const ctrlPort = TOR_BASE_CTRL_PORT + i;
            const dataDir = `/var/lib/tor/instance_${i}`;

            const torrcContent = [
                `SocksPort ${socksPort}`,
                `ControlPort ${ctrlPort}`,
                `HashedControlPassword ${hashedPassword}`,
                `DataDirectory ${dataDir}`,
                'CircuitBuildTimeout 10',
                'LearnCircuitBuildTimeout 0',
                'MaxCircuitDirtiness 30',
                'NewCircuitPeriod 10',
                'NumEntryGuards 8'
            ].join('\n');

            const torrcPath = `/tmp/torrc_mkvdrama_${i}`;
            fs.writeFileSync(torrcPath, torrcContent);

            startPromises.push(
                execAsync(`sudo mkdir -p ${dataDir} && sudo chown debian-tor:debian-tor ${dataDir} && sudo chmod 700 ${dataDir} && sudo -u debian-tor tor -f ${torrcPath} --RunAsDaemon 1`)
                    .then(() => ({
                        socksPort,
                        ctrlPort,
                        agent: new SocksProxyAgent(`socks5h://${TOR_HOST}:${socksPort}`)
                    }))
                    .catch((err) => {
                        console.error(`[TorProxy] Failed to start instance ${i}: ${err.message}`);
                        return null;
                    })
            );
        }

        const results = await Promise.all(startPromises);
        this.instances = results.filter(Boolean);

        if (this.instances.length > 0) {
            // Wait for circuits to establish
            console.log(`[TorProxy] Waiting ${TOR_CIRCUIT_SETTLE_MS}ms for circuits...`);
            await new Promise(r => setTimeout(r, TOR_CIRCUIT_SETTLE_MS));
        }
    }

    /**
     * Send NEWNYM signal to all Tor instances to get fresh circuits
     */
    async rotateAllCircuits() {
        const rotatePromises = this.instances.map(async (instance) => {
            try {
                await this._sendControlCommand(instance.ctrlPort, 'SIGNAL NEWNYM');
            } catch { /* ignore rotation failures */ }
        });
        await Promise.all(rotatePromises);
        // Clear known-good cache since IPs changed
        this.knownGood.clear();
    }

    async _sendControlCommand(ctrlPort, command) {
        return new Promise((resolve, reject) => {
            const socket = net.createConnection({ port: ctrlPort, host: TOR_HOST });
            socket.setTimeout(3000);
            let response = '';

            socket.on('data', (data) => {
                response += data.toString();
                if (response.includes('250 OK') || response.includes('250 closing')) {
                    socket.destroy();
                    resolve(response);
                }
            });

            socket.on('connect', () => {
                socket.write(`AUTHENTICATE "${TOR_CONTROL_PASSWORD}"\r\n`);
                socket.write(`${command}\r\n`);
                socket.write('QUIT\r\n');
            });

            socket.on('error', reject);
            socket.on('timeout', () => { socket.destroy(); reject(new Error('timeout')); });
        });
    }

    /**
     * Find a working Tor exit for mkvdrama.net by testing all instances in parallel.
     * Returns { agent, port } or null.
     */
    async findWorkingExit() {
        if (!TOR_ENABLED || this.instances.length === 0) return null;

        // Check known-good exits first
        for (const [port, entry] of this.knownGood.entries()) {
            if (Date.now() - entry.ts < TOR_KNOWN_GOOD_TTL_MS) {
                const instance = this.instances.find(i => i.socksPort === port);
                if (instance) return { agent: instance.agent, port };
            } else {
                this.knownGood.delete(port);
            }
        }

        // Test all instances in parallel
        const testPromises = this.instances.map(async (instance) => {
            try {
                const response = await axios.get('https://mkvdrama.net/', {
                    httpAgent: instance.agent,
                    httpsAgent: instance.agent,
                    proxy: false,
                    timeout: TOR_REQUEST_TIMEOUT_MS,
                    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36' },
                    validateStatus: () => true
                });
                const body = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
                if (body.includes('Drama site API') || (response.status === 200 && !body.includes('Access denied') && !body.includes('Just a moment'))) {
                    return instance;
                }
            } catch { /* blocked or timeout */ }
            return null;
        });

        const results = await Promise.allSettled(testPromises);
        for (const result of results) {
            if (result.status === 'fulfilled' && result.value) {
                const instance = result.value;
                this.knownGood.set(instance.socksPort, { ts: Date.now() });
                console.log(`[TorProxy] Found working exit on port ${instance.socksPort}`);
                return { agent: instance.agent, port: instance.socksPort };
            }
        }

        return null;
    }

    /**
     * Make a request through a working Tor exit, with automatic rotation.
     * Tries up to TOR_MAX_ROTATION_ROUNDS rotation rounds.
     * @param {Object} axiosConfig - axios request config (url, headers, etc.)
     * @returns {{ response, port }} or throws if all attempts fail
     */
    async requestWithRotation(axiosConfig) {
        if (!TOR_ENABLED) throw new Error('Tor proxy disabled');
        await this.init();

        if (this.instances.length === 0) {
            throw new Error('No Tor instances available');
        }

        for (let round = 0; round < TOR_MAX_ROTATION_ROUNDS; round++) {
            if (round > 0) {
                console.log(`[TorProxy] Rotation round ${round + 1}/${TOR_MAX_ROTATION_ROUNDS}`);
                await this.rotateAllCircuits();
                await new Promise(r => setTimeout(r, TOR_CIRCUIT_SETTLE_MS));
            }

            const exit = await this.findWorkingExit();
            if (!exit) continue;

            try {
                const response = await axios.request({
                    ...axiosConfig,
                    httpAgent: exit.agent,
                    httpsAgent: exit.agent,
                    proxy: false,
                    timeout: axiosConfig.timeout || TOR_REQUEST_TIMEOUT_MS,
                    validateStatus: axiosConfig.validateStatus || (() => true)
                });

                const body = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
                const isBlocked = body.includes('Access denied') ||
                    body.includes('Just a moment') ||
                    body.includes('Sorry, you have been blocked') ||
                    response.status === 403;

                if (isBlocked) {
                    console.log(`[TorProxy] Request blocked on port ${exit.port} for ${axiosConfig.url}`);
                    this.knownGood.delete(exit.port);
                    continue;
                }

                return { response, port: exit.port };
            } catch (error) {
                console.log(`[TorProxy] Request failed on port ${exit.port}: ${error.message}`);
                this.knownGood.delete(exit.port);
            }
        }

        throw new Error(`[TorProxy] All ${TOR_MAX_ROTATION_ROUNDS} rotation rounds exhausted`);
    }

    /**
     * Get a working SOCKS5 agent, rotating as needed.
     * Returns { agent, port } or null.
     */
    async getWorkingAgent() {
        await this.init();
        for (let round = 0; round < TOR_MAX_ROTATION_ROUNDS; round++) {
            if (round > 0) {
                await this.rotateAllCircuits();
                await new Promise(r => setTimeout(r, TOR_CIRCUIT_SETTLE_MS));
            }
            const exit = await this.findWorkingExit();
            if (exit) return exit;
        }
        return null;
    }

    isEnabled() {
        return TOR_ENABLED && this.instances.length > 0;
    }

    getStats() {
        return {
            enabled: TOR_ENABLED,
            instances: this.instances.length,
            initialized: this.initialized,
            knownGood: this.knownGood.size
        };
    }
}

const torProxyManager = new TorProxyManager();
export default torProxyManager;
