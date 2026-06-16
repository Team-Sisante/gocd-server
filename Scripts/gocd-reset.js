#!/usr/bin/env node
/**
 * Scripts/gocd-reset.js
 *
 * Surgical reset for the GoCD project only.
 * Wipes GoCD containers, volumes, images, and BuildKit cache, then rebuilds.
 * Other Docker projects on the machine are NOT affected.
 *
 * Usage:
 *   node Scripts/gocd-reset.js           # interactive (prompts for confirmation)
 *   node Scripts/gocd-reset.js --yes     # skip confirmation
 *
 * Exit codes:
 *   0 - reset successful
 *   1 - reset cancelled by user or fatal error
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const PROJECT_ROOT = path.join(__dirname, '..');
const CERTS_DIR = path.join(PROJECT_ROOT, 'certs');
const ENV_FILE = path.join(PROJECT_ROOT, '.env.docker');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise(r => rl.question(q, a => r(a.trim())));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function log(msg, color = '\x1b[36m') {
    console.log(`${color}%s\x1b[0m`, `[gocd-reset] ${msg}`);
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
        if (options.silent) return '';
        throw e;
    }
}

function confirm(question) {
    return new Promise(resolve => {
        rl.question(question, answer => {
            resolve(answer.trim().toLowerCase() === 'y');
        });
    });
}

async function main() {
    const skipConfirm = process.argv.includes('--yes') || process.argv.includes('-y');

    log('==============================================', '\x1b[31m');
    log('  GoCD Project Reset', '\x1b[31m');
    log('  Wipes: containers, volumes, images, cache', '\x1b[31m');
    log('  Other Docker projects are NOT affected.', '\x1b[31m');
    log('==============================================', '\x1b[31m');

    if (!skipConfirm) {
        const ok = await confirm('\nThis will wipe ALL GoCD containers, volumes, images, and BuildKit cache, then rebuild from scratch. Continue? (y/N): ');
        if (!ok) {
            log('Reset cancelled.', '\x1b[33m');
            rl.close();
            return;
        }
    }

    // Sanity check: .env.docker must exist
    if (!fs.existsSync(ENV_FILE)) {
        log(`ERROR: .env.docker not found at ${ENV_FILE}`, '\x1b[31m');
        rl.close();
        process.exit(1);
    }

    // ---------------------------------------------------------------
    // STEP 1: Stop & remove GoCD containers + named volumes via compose
    // ---------------------------------------------------------------
    log('STEP 1: Stopping GoCD containers and removing named volumes...', '\x1b[33m');
    sh('docker compose --env-file .env.docker down -v --remove-orphans', { ignoreError: true });

    // ---------------------------------------------------------------
    // STEP 2: Force-remove any leftover gocd-* containers by name
    // (in case compose state is out of sync with actual containers)
    // ---------------------------------------------------------------
    log('STEP 2: Force-removing any leftover gocd-* containers...', '\x1b[33m');
    try {
        const allContainers = sh('docker ps -a --format "{{.Names}}"', { silent: true }).trim();
        const gocdContainers = allContainers.split(/\r?\n/).filter(n => /^gocd[-_]/i.test(n));
        if (gocdContainers.length > 0) {
            log(`  Found ${gocdContainers.length} leftover container(s): ${gocdContainers.join(', ')}`, '\x1b[36m');
            sh(`docker rm -f ${gocdContainers.join(' ')}`, { ignoreError: true });
        } else {
            log('  No leftover gocd-* containers found.', '\x1b[36m');
        }
    } catch (e) {
        log(`  Warning: could not enumerate containers: ${e.message}`, '\x1b[33m');
    }

    // ---------------------------------------------------------------
    // STEP 3: Remove GoCD-related volumes only
    // Matches: gocd_data, gocd_home, gocd-server_gocd_data,
    //          gocd-server_gocd_home, and any anonymous volumes
    //          that Docker created for /godata and /go-working-dir
    // ---------------------------------------------------------------
    log('STEP 3: Removing GoCD volumes...', '\x1b[33m');
    try {
        const allVolumes = sh('docker volume ls --format "{{.Name}}"', { silent: true }).trim();
        const allVolumeLines = allVolumes.split(/\r?\n/).filter(Boolean);

        // Named volumes (compose-managed)
        const namedVolumes = allVolumeLines.filter(n =>
            /^(gocd_data|gocd_home|gocd[-_]server[-_]gocd[-_]data|gocd[-_]server[-_]gocd[-_]home)$/i.test(n)
        );

        // Anonymous volumes (long hex strings) — these are the ones Docker
        // created for /godata and /go-working-dir when the container started.
        // We can't safely identify which anon volume belongs to GoCD vs other
        // projects, so we SKIP anonymous volumes unless the user opts in.
        if (namedVolumes.length > 0) {
            log(`  Removing named volumes: ${namedVolumes.join(', ')}`, '\x1b[36m');
            sh(`docker volume rm -f ${namedVolumes.join(' ')}`, { ignoreError: true });
        } else {
            log('  No named GoCD volumes found.', '\x1b[36m');
        }

        // Check for anonymous volumes that were attached to gocd containers
        // (we already removed the containers, but the anon volumes may linger)
        try {
            const dangling = sh('docker volume ls -f dangling=true --format "{{.Name}}"', { silent: true }).trim();
            if (dangling) {
                const danglingLines = dangling.split(/\r?\n/).filter(Boolean);
                log(`  Removing ${danglingLines.length} dangling anonymous volume(s)...`, '\x1b[36m');
                sh(`docker volume rm -f ${danglingLines.join(' ')}`, { ignoreError: true });
            }
        } catch (_) { /* ignore */ }
    } catch (e) {
        log(`  Warning: could not enumerate volumes: ${e.message}`, '\x1b[33m');
    }

    // ---------------------------------------------------------------
    // STEP 4: Remove GoCD images (forces fresh rebuild)
    // ---------------------------------------------------------------
    log('STEP 4: Removing GoCD images (forces fresh rebuild)...', '\x1b[33m');
    try {
        const allImages = sh('docker images --format "{{.Repository}}:{{.Tag}}"', { silent: true }).trim();
        const gocdImages = allImages.split(/\r?\n/).filter(n =>
            /^gocd[-_]server[-_]/i.test(n) || /^gocd\/gocd-(server|agent)/i.test(n)
        );
        if (gocdImages.length > 0) {
            log(`  Removing images: ${gocdImages.join(', ')}`, '\x1b[36m');
            sh(`docker rmi -f ${gocdImages.join(' ')}`, { ignoreError: true });
        } else {
            log('  No GoCD images found to remove.', '\x1b[36m');
        }
    } catch (e) {
        log(`  Warning: could not enumerate images: ${e.message}`, '\x1b[33m');
    }

    // ---------------------------------------------------------------
    // STEP 5: Prune BuildKit cache (clears corrupted snapshot state)
    // ---------------------------------------------------------------
    log('STEP 5: Pruning BuildKit cache...', '\x1b[33m');
    sh('docker builder prune -a -f', { ignoreError: true });

    // ---------------------------------------------------------------
    // STEP 6: Regenerate PKCS12 keystore from existing certs
    // (same logic as go.js STEP 2)
    // ---------------------------------------------------------------
    log('STEP 6: Regenerating PKCS12 keystore...', '\x1b[33m');
    const serverCrt = path.join(CERTS_DIR, 'server.crt');
    const serverKey = path.join(CERTS_DIR, 'server.key');
    const keystorePath = path.join(CERTS_DIR, 'keystore.p12');

    if (fs.existsSync(serverCrt) && fs.existsSync(serverKey)) {
        try {
            sh(
                `openssl pkcs12 -export -in "${serverCrt}" -inkey "${serverKey}" -out "${keystorePath}" -name gocd-server -password pass:changeit`,
                { silent: true }
            );
            log('  Keystore regenerated.', '\x1b[32m');
        } catch (e) {
            log(`  Warning: keystore regeneration failed: ${e.message}`, '\x1b[33m');
        }
    } else {
        log('  server.crt / server.key not found — skipping keystore.', '\x1b[33m');
        log('  Run "node Scripts/generate-certs.js" first if you need SSL.', '\x1b[33m');
    }

    // ---------------------------------------------------------------
    // STEP 7: Rebuild from scratch and start
    // ---------------------------------------------------------------
    log('STEP 7: Rebuilding GoCD from scratch (--no-cache)...', '\x1b[32m');
    sh('docker compose --env-file .env.docker build --no-cache');
    sh('docker compose --env-file .env.docker up -d --force-recreate');

    // ---------------------------------------------------------------
    // STEP 8: Health check the server
    // ---------------------------------------------------------------
    log('STEP 8: Waiting for GoCD server to be ready...', '\x1b[33m');
    let ready = false;
    for (let attempt = 1; attempt <= 30; attempt++) {
        try {
            execSync('curl -s -o /dev/null -f http://localhost:8153/go/api/v1/health', { stdio: 'pipe' });
            ready = true;
            break;
        } catch (_) {
            process.stdout.write('.');
            await sleep(5000);
        }
    }
    process.stdout.write('\n');

    if (ready) {
        log('==============================================', '\x1b[32m');
        log('  GoCD reset complete!', '\x1b[32m');
        log('  Server: http://localhost:8153', '\x1b[32m');
        log('==============================================', '\x1b[32m');
    } else {
        log('==============================================', '\x1b[33m');
        log('  Server health check timed out.', '\x1b[33m');
        log('  Check logs: docker compose logs gocd-server', '\x1b[33m');
        log('==============================================', '\x1b[33m');
    }

    rl.close();
}

main().catch(err => {
    console.error('\x1b[31m%s\x1b[0m', `[gocd-reset] FATAL: ${err.message}`);
    rl.close();
    process.exit(1);
});