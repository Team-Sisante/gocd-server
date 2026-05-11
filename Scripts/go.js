#!/usr/bin/env node
/**
 * Scripts/go.js
 * 
 * Cross-platform "Master Reset" for GoCD environment.
 * Replicates the aggressive cleanup of go.ps1 and the startup logic of go.sh.
 */

const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');

const PROJECT_ROOT = path.join(__dirname, '..');
const CERTS_DIR = path.join(PROJECT_ROOT, 'certs');
const KEYSTORE_PATH = path.join(CERTS_DIR, 'keystore.p12');
const ENV_FILE = path.join(PROJECT_ROOT, '.env.docker');

function log(msg, color = '\x1b[36m') {
    console.log(`${color}%s\x1b[0m`, `[go.js] ${msg}`);
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

async function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// 1. Validation & Registry Auth
// ---------------------------------------------------------------------------
function validateAndAuth() {
    log('STEP 1: Validation & Registry Authentication');
    
    if (!fs.existsSync(ENV_FILE)) {
        console.error('\x1b[31m%s\x1b[0m', `❌ ERROR: .env.docker not found at ${ENV_FILE}`);
        process.exit(1);
    }

    const envContent = fs.readFileSync(ENV_FILE, 'utf8');
    const getVar = (key) => {
        const match = envContent.match(new RegExp(`^${key}=(.*)`, 'm'));
        return match ? match[1].trim().replace(/^["']|["']$/g, '') : null;
    };

    const token = getVar('GITHUB_TOKEN');
    const user = getVar('GIT_REPO_USERNAME');

    if (token && user) {
        log(`Authenticating with GitHub Registry as ${user}...`);
        try {
            sh(`echo "${token}" | docker login ghcr.io -u "${user}" --password-stdin`, { silent: true });
            log('✓ Registry authentication successful.', '\x1b[32m');
        } catch (e) {
            log('⚠️  Registry authentication failed. Pulling images might fail.', '\x1b[33m');
        }
    }
}

// ---------------------------------------------------------------------------
// 2. Keystore Generation
// ---------------------------------------------------------------------------
function generateKeystore() {
    log('STEP 2: Generating PKCS12 keystore...');
    
    if (!fs.existsSync(path.join(CERTS_DIR, 'server.crt'))) {
        console.error('\x1b[31m%s\x1b[0m', '❌ ERROR: Certificates not found. Please run generate-certs script first.');
        process.exit(1);
    }

    try {
        const cmd = `openssl pkcs12 -export -in certs/server.crt -inkey certs/server.key -out certs/keystore.p12 -name gocd-server -password pass:changeit`;
        sh(cmd, { silent: true });
        log(`✓ Keystore generated at ${KEYSTORE_PATH}`, '\x1b[32m');
    } catch (e) {
        console.error('\x1b[31m%s\x1b[0m', `❌ ERROR: Failed to generate keystore: ${e.message}`);
        process.exit(1);
    }
}

// ---------------------------------------------------------------------------
// 3. Aggressive Cleanup (The Nuclear Option)
// ---------------------------------------------------------------------------
function nuclearCleanup() {
    log('STEP 3: Performing Nuclear Cleanup (Wiping Everything)...', '\x1b[31m');

    log('Stopping containers and removing project volumes...');
    sh('docker compose down -v --remove-orphans', { ignoreError: true });

    log('Force removing ALL containers...');
    const containers = sh('docker ps -aq', { silent: true, ignoreError: true }).trim();
    if (containers) sh(`docker rm -f ${containers.split('\n').join(' ')}`, { ignoreError: true });

    log('Force removing ALL volumes...');
    const volumes = sh('docker volume ls -q', { silent: true, ignoreError: true }).trim();
    if (volumes) sh(`docker volume rm -f ${volumes.split('\n').join(' ')}`, { ignoreError: true });

    log('Performing system prune...');
    sh('docker system prune -a --volumes -f', { ignoreError: true });
    
    log('✓ Cleanup complete. System is factory-fresh.', '\x1b[32m');
}

// ---------------------------------------------------------------------------
// 4. Startup & Health Checks
// ---------------------------------------------------------------------------
async function startup() {
    log('STEP 4: Rebuilding and Starting GoCD...');
    
    sh('docker compose build --no-cache');
    sh('docker compose up -d');

    log('Waiting for GoCD server to be ready (this may take a minute)...');
    const healthUrl = 'http://localhost:8153/go/api/v1/health';
    let ready = false;
    let attempts = 0;

    while (!ready && attempts < 30) {
        attempts++;
        try {
            // Using a simple command line curl for the health check to avoid complex Node https logic
            sh('curl -s -o /dev/null -f http://localhost:8153/go/api/v1/health', { silent: true });
            ready = true;
            log('\n✓ GoCD server is ready!', '\x1b[32m');
        } catch (e) {
            process.stdout.write('.');
            await wait(5000);
        }
    }

    if (!ready) {
        log('⚠️  Server health check timed out, but it might still be starting.', '\x1b[33m');
    }
}

// ---------------------------------------------------------------------------
// Main Execution
// ---------------------------------------------------------------------------
async function main() {
    log('======================================');
    log('  GoCD Master Reset Engine (.js)     ');
    log('======================================');

    validateAndAuth();
    generateKeystore();
    nuclearCleanup();
    await startup();

    log('======================================');
    log('✅ SUCCESS: GoCD environment is up!', '\x1b[32m');
    log('Refresh your browser to access the UI.');
    log('======================================');
}

main().catch(err => {
    console.error('\x1b[31m%s\x1b[0m', `FATAL ERROR: ${err.message}`);
    process.exit(1);
});
