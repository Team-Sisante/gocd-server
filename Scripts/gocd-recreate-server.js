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
    // ---------------------------------------------------------------
    log('STEP 3: Waiting for GoCD server to become healthy...', '\x1b[33m');
    let ready = false;
    for (let attempt = 1; attempt <= 30; attempt++) {
        try {
            execSync('curl -s -o /dev/null -f http://localhost:8153/go/api/v1/health', { stdio: 'pipe' });
            ready = true;
            log(`Server is healthy (attempt ${attempt}/30).`, '\x1b[32m');
            break;
        } catch (_) {
            process.stdout.write('.');
            await sleep(5000);
        }
    }
    process.stdout.write('\n');

    if (!ready) {
        log('Server did not become healthy within 150 seconds. Check logs:', '\x1b[31m');
        log('  docker logs gocd-server --tail=50', '\x1b[33m');
        rl.close();
        process.exit(1);
    }

    // ---------------------------------------------------------------
    // STEP 4: Verify entrypoint.js ran successfully (no leftover placeholders)
    // ---------------------------------------------------------------
    log('STEP 4: Verifying entrypoint.js output...', '\x1b[33m');

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
    // STEP 5: Show recent entrypoint log lines for confirmation
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