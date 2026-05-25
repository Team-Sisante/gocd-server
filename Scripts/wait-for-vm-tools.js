#!/usr/bin/env node
/**
 * wait-for-vm-tools.js – Streams the VM startup log and waits until
 * Docker, Node, and git are all installed.  Then sets up /opt/badminton_court.
 *
 * Uses GCP_PROJECT_ID, GCP_ZONE, GCP_VM_IP, VM_SSH_USER from the environment.
 *
 * ============================================================================
 * 🔴 HARD RULE: Every process MUST display real‑time progress.  Never suppress
 *    output or make the screen appear frozen.  Always show live elapsed time.
 *
 * 🔴 AI ASSISTANT NOTE – Active readiness, no deadlines.
 *    This script does NOT install anything.  The VM’s startup script already
 *    handles package installation.  We only wait until `docker`, `node`, and
 *    `git` are available on the VM, then we proceed.
 *
 *    All SSH checks are non‑blocking (spawn) with a short timeout so the loop
 *    never freezes, even when the VM is under heavy CPU/IO load.
 * ============================================================================
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// ------------------------------------------------------------------
// Configurable timings
// ------------------------------------------------------------------
const SLEEP_SECONDS       = 10;        // interval between readiness checks
const SSH_TIMEOUT_SECONDS  = 15;       // per‑SSH‑command timeout
const MAX_WAIT_SECONDS     = 1800;     // 30 minutes safety limit

const PROJECT_ID = process.env.GCP_PROJECT_ID;
const ZONE       = process.env.GCP_ZONE;
const VM_IP      = process.env.GCP_VM_IP;
const SSH_USER   = process.env.VM_SSH_USER;
const KEY_FILE   = path.join(__dirname, '..', 'secrets', 'agent-key');

// ----- Validate required environment variables -----
const missing = [];
if (!PROJECT_ID) missing.push('GCP_PROJECT_ID');
if (!ZONE)       missing.push('GCP_ZONE');
if (!VM_IP)      missing.push('GCP_VM_IP');
if (!SSH_USER)   missing.push('VM_SSH_USER');

if (missing.length > 0) {
    console.error('\x1b[31mERROR: The following required environment variables are missing:\x1b[0m');
    missing.forEach(v => console.error(`  - ${v}`));
    console.error('\nPlease define them in your .env.docker file.');
    process.exit(1);
}

if (!fs.existsSync(KEY_FILE)) {
    console.error('\x1b[31mSSH key not found at ' + KEY_FILE + '\x1b[0m');
    process.exit(1);
}

// Clear old host key
try {
    const { execSync } = require('child_process');
    execSync(`ssh-keygen -R ${VM_IP}`, { stdio: 'ignore' });
} catch (_) {}

// ------------------------------------------------------------------
// Non‑blocking helper: spawn an SSH command, capture stdout, reject on timeout or error
// ------------------------------------------------------------------
function sshAsync(args, timeoutSec = 10) {
    return new Promise((resolve, reject) => {
        const child = spawn('ssh', [
            '-i', KEY_FILE,
            '-o', 'StrictHostKeyChecking=no',
            '-o', `ConnectTimeout=${timeoutSec}`,
            `${SSH_USER}@${VM_IP}`,
            ...args
        ], { stdio: ['ignore', 'pipe', 'pipe'] });

        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d) => { stdout += d.toString(); });
        child.stderr.on('data', (d) => { stderr += d.toString(); });

        const timer = setTimeout(() => {
            child.kill();
            reject(new Error(`SSH command timed out after ${timeoutSec}s`));
        }, timeoutSec * 1000);

        child.on('close', (code) => {
            clearTimeout(timer);
            if (code === 0) resolve(stdout);
            else reject(new Error(stderr || `SSH exited with code ${code}`));
        });
        child.on('error', (err) => {
            clearTimeout(timer);
            reject(err);
        });
    });
}

// ------------------------------------------------------------------
// Main flow
// ------------------------------------------------------------------
async function main() {
    const scriptStart = Date.now();
    const elapsed = () => Math.floor((Date.now() - scriptStart) / 1000) + 's';

    console.log(`\x1b[36m[${elapsed()}] Waiting for VM tools (Docker, Node, git) to be ready…\x1b[0m`);
    console.log('  (Live log from the VM – every new line will appear below)');

    let lastOffset = 0;
    let toolsReady = false;
    const deadline = Date.now() + MAX_WAIT_SECONDS * 1000;

    while (!toolsReady && Date.now() < deadline) {
        console.log(`\x1b[36m⏳ [${elapsed()}] Checking tool readiness…\x1b[0m`);

        // 0. Check for startup script failure marker
        try {
            const failureCheck = await sshAsync(
                ['test -f /var/log/startup-script-failed && echo FAILED || true'],
                SSH_TIMEOUT_SECONDS
            );
            if (failureCheck.includes('FAILED')) {
                console.error(`\x1b[31m❌ [${elapsed()}] Startup script failed. Check /var/log/startup-script.log on VM for details.\x1b[0m`);
                process.exit(1);
            }
        } catch (_) { /* ignore */ }

        // 1. Stream new startup‑log lines (for visibility)
        try {
            const newContent = await sshAsync(
                [`tail -c +${lastOffset + 1} /var/log/startup-script.log 2>/dev/null || true`],
                SSH_TIMEOUT_SECONDS
            );
            if (newContent.trim()) {
                process.stdout.write(newContent);
                lastOffset += Buffer.byteLength(newContent, 'utf8');
            }
        } catch (_) { /* timeout or error – ignore */ }

        // 2. Check if Docker, Node, and git are all present
        try {
            const check = await sshAsync(
                ['command -v docker && command -v node && command -v git && echo ALL_READY'],
                SSH_TIMEOUT_SECONDS
            );
            if (check.includes('ALL_READY')) {
                toolsReady = true;
                console.log(`\x1b[32m✅ [${elapsed()}] All required tools are installed and ready.\x1b[0m`);
                break;
            }
        } catch (_) { /* tools not ready yet – will retry */ }

        if (!toolsReady && Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, SLEEP_SECONDS * 1000));
        }
    }

    if (!toolsReady) {
        console.error(`\x1b[31m❌ [${elapsed()}] Tools were not installed within ${MAX_WAIT_SECONDS}s. Aborting.\x1b[0m`);
        process.exit(1);
    }

    // ----- Set up /opt/badminton_court -----
    console.log(`\x1b[33m[${elapsed()}] Setting up /opt/badminton_court directory…\x1b[0m`);
    const dirCmd = `ssh -T -i "${KEY_FILE}" -o StrictHostKeyChecking=no ${SSH_USER}@${VM_IP} "sudo mkdir -p /opt/badminton_court && sudo chown -R ${SSH_USER}:${SSH_USER} /opt/badminton_court"`;
    try {
        const { execSync } = require('child_process');
        execSync(dirCmd, { stdio: 'inherit' });
        console.log(`\x1b[32m✅ [${elapsed()}] Directory /opt/badminton_court ready and owned by ${SSH_USER}.\x1b[0m`);
    } catch (e) {
        console.error(`\x1b[31m❌ [${elapsed()}] Failed to set up /opt/badminton_court.\x1b[0m`);
    }
}

main().catch(err => {
    console.error(`\x1b[31mFatal error: ${err.message}\x1b[0m`);
    process.exit(1);
});