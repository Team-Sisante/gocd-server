#!/usr/bin/env node
/**
 * Scripts/gocd-recreate-server.js
 *
 * Force-recreates ONLY the gocd-server container, preserving the /godata
 * volume (no data loss). Use this when you've changed config/cruise-config.xml
 * or Scripts/entrypoint.js and need the entrypoint to re-run.
 *
 * What it does:
 *   1. Rebuilds the gocd-server image (picks up Dockerfile / entrypoint changes)
 *   2. Force-recreates the gocd-server container
 *   3. Waits for the server to become healthy
 *   4. Verifies entrypoint.js ran successfully (no leftover placeholders)
 *
 * What it does NOT do:
 *   - Does NOT wipe the /godata volume (agent registrations & history preserved)
 *   - Does NOT touch agent containers
 *   - Does NOT prune Docker cache or images
 *
 * Usage:
 *   node Scripts/gocd-recreate-server.js           # interactive (prompts)
 *   node Scripts/gocd-recreate-server.js --yes     # skip confirmation
 */

const { execSync } = require('child_process');
const http = require('http');
const readline = require('readline');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..');
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise(r => rl.question(q, a => r(a.trim())));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function log(msg, color = '\x1b[36m') {
    console.log(`${color}%s\x1b[0m`, `[gocd-recreate-server] ${msg}`);
}

function sh(cmd, options = {}) {
    try {
        return execSync(cmd, {
            cwd: PROJECT_ROOT,
            encoding: 'utf8',
            stdio: options.silent ? 'pipe' : 'inherit',
            ...options
        });
    } catch (e) {
        if (options.ignoreError) return '';
        throw e;
    }
}

/**
 * Check if the GoCD server is responding. Uses Node's built-in http module
 * instead of curl to avoid Windows curl quirks (multiple curl binaries,
 * IPv4/IPv6 resolution issues, etc.).
 *
 * Tries two endpoints because the server boots in stages — the API health
 * endpoint may not be available until late in the boot process, but the
 * root URL usually responds earlier.
 *
 * Uses 127.0.0.1 explicitly (not localhost) to force IPv4 and avoid
 * Windows IPv6-first resolution delays.
 */
function isServerReady() {
    return new Promise((resolve) => {
        const tryEndpoint = (path, label) => {
            return new Promise((res) => {
                const req = http.get({
                    host: '127.0.0.1',
                    port: 8153,
                    path: path,
                    timeout: 3000,
                }, (response) => {
                    response.resume(); // drain the response so the socket closes
                    if (response.statusCode === 200 ||
                        response.statusCode === 302 ||
                        response.statusCode === 401) {
                        res(label);
                    } else {
                        res(null);
                    }
                });
                req.on('error', () => res(null));
                req.on('timeout', () => {
                    req.destroy();
                    res(null);
                });
            });
        };

        // Try the API health endpoint first (most reliable signal)
        tryEndpoint('/go/api/v1/health', 'health').then(result => {
            if (result) return resolve(result);
            // Fall back to the root UI URL (responds earlier in boot)
            return tryEndpoint('/go/', 'root');
        }).then(resolve);
    });
}

async function main() {
    const skipConfirm = process.argv.includes('--yes') || process.argv.includes('-y');

    log('==============================================', '\x1b[33m');
    log('  Force-recreate gocd-server container', '\x1b[33m');
    log('  Preserves /godata volume (no data loss)', '\x1b[33m');
    log('==============================================', '\x1b[33m');

    if (!skipConfirm) {
        const ok = await ask('\nThis will recreate the gocd-server container so entrypoint.js re-runs. Continue? (y/N): ');
        if (ok.toLowerCase() !== 'y') {
            log('Cancelled.', '\x1b[33m');
            rl.close();
            return;
        }
    }

    // ---------------------------------------------------------------
    // STEP 1: Rebuild the gocd-server image (picks up Dockerfile / entrypoint.js changes)
    // ---------------------------------------------------------------
    log('STEP 1: Rebuilding gocd-server image...', '\x1b[33m');
    sh('docker compose --env-file .env.docker build gocd-server');

    // ---------------------------------------------------------------
    // STEP 2: Force-recreate the gocd-server container
    // ---------------------------------------------------------------
    log('STEP 2: Force-recreating gocd-server container...', '\x1b[33m');
    sh('docker compose --env-file .env.docker up -d --force-recreate --no-deps gocd-server');

    // ---------------------------------------------------------------
    // STEP 3: Wait for the server to become healthy
    // GoCD is a Java app and can take 2-5 minutes to fully boot, especially
    // after a force-recreate. Poll patiently for up to 5 minutes.
    // ---------------------------------------------------------------
    log('STEP 3: Waiting for GoCD server to become healthy...', '\x1b[33m');
    log('  (GoCD can take 2-5 minutes to fully boot — be patient)', '\x1b[36m');

    const MAX_ATTEMPTS = 60;     // 60 attempts × 5s = 300s = 5 minutes
    const INTERVAL_MS = 5000;
    const startTime = Date.now();

    let ready = false;
    let readyEndpoint = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const elapsed = Math.floor((Date.now() - startTime) / 1000);
        const endpoint = await isServerReady();
        if (endpoint) {
            ready = true;
            readyEndpoint = endpoint;
            log(`Server is responding via /${endpoint} (attempt ${attempt}/${MAX_ATTEMPTS}, ${elapsed}s elapsed).`, '\x1b[32m');
            break;
        }
        if (attempt === 1 || attempt % 6 === 0) {
            log(`  Still waiting... attempt ${attempt}/${MAX_ATTEMPTS} (${elapsed}s elapsed)`, '\x1b[36m');
        }
        await sleep(INTERVAL_MS);
    }

    if (!ready) {
        log(`Server did not become healthy within ${MAX_ATTEMPTS * INTERVAL_MS / 1000} seconds.`, '\x1b[31m');
        log('', '\x1b[0m');
        log('Recent server logs:', '\x1b[33m');
        try {
            execSync('docker logs gocd-server --tail=30 2>&1', { stdio: 'inherit' });
        } catch (_) {}
        log('', '\x1b[0m');
        log('The container may still be booting. Check again in a minute with:', '\x1b[33m');
        log('  curl -s -o /dev/null -w "%{http_code}\\n" http://127.0.0.1:8153/go/api/v1/health', '\x1b[33m');
        log('  docker logs gocd-server --tail=50', '\x1b[33m');
        rl.close();
        process.exit(1);
    }

    // ---------------------------------------------------------------
    // STEP 4: Give it a few extra seconds to finish booting
    // (even after the endpoint responds, plugin loading may still be in progress)
    // ---------------------------------------------------------------
    log('STEP 4: Giving the server 10 extra seconds to finish booting...', '\x1b[33m');
    await sleep(10000);

    // ---------------------------------------------------------------
    // STEP 5: Verify entrypoint.js ran successfully (no leftover placeholders)
    // ---------------------------------------------------------------
    log('STEP 5: Verifying entrypoint.js output...', '\x1b[33m');

    try {
        const leftover = execSync(
            'docker exec gocd-server grep -oE "__[A-Z][A-Z0-9_]*__" /godata/config/cruise-config.xml 2>/dev/null || true',
            { encoding: 'utf8', stdio: 'pipe' }
        ).trim();

        if (leftover) {
            log(`⚠️  WARNING: Unreplaced placeholders remain in cruise-config.xml:`, '\x1b[33m');
            leftover.split('\n').forEach(p => log(`   - ${p}`, '\x1b[33m'));
            log('Check entrypoint.js logs: docker logs gocd-server 2>&1 | grep entrypoint', '\x1b[33m');
        } else {
            log('All placeholders successfully replaced.', '\x1b[32m');
        }
    } catch (e) {
        log(`Warning: could not verify placeholders: ${e.message}`, '\x1b[33m');
    }

    // ---------------------------------------------------------------
    // STEP 6: Show recent entrypoint log lines for confirmation
    // ---------------------------------------------------------------
    log('', '\x1b[0m');
    log('Recent entrypoint.js log lines:', '\x1b[36m');
    try {
        execSync('docker logs gocd-server 2>&1 | grep "\\[entrypoint.js\\]" | tail -15', { stdio: 'inherit' });
    } catch (_) {
        log('(no entrypoint.js log lines found)', '\x1b[33m');
    }

    log('', '\x1b[0m');
    log('==============================================', '\x1b[32m');
    log('  gocd-server recreated successfully!', '\x1b[32m');
    log('  Server: http://localhost:8153', '\x1b[32m');
    log('==============================================', '\x1b[32m');

    rl.close();
}

main().catch(err => {
    console.error('\x1b[31m%s\x1b[0m', `[gocd-recreate-server] FATAL: ${err.message}`);
    rl.close();
    process.exit(1);
});