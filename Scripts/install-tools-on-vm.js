#!/usr/bin/env node
/**
 * install-tools-on-vm.js – Waits for the VM's startup script to finish,
 * then installs any missing tools (Docker, Node, git, etc.) and ensures
 * /opt/badminton_court has correct ownership.
 * All output is shown in real time – no quiet flags.
 *
 * Uses GCP_PROJECT_ID, GCP_ZONE, GCP_VM_IP, VM_SSH_USER from the environment.
 * 
 * 🔴 HARD RULE: Every process MUST display real‑time progress.
 *    Never suppress output or leave the screen frozen.
 *    Always show live elapsed time where appropriate.
 */

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

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
try { execSync(`ssh-keygen -R ${VM_IP}`, { stdio: 'ignore' }); } catch (_) {}

const scriptStart = Date.now();
const elapsed = () => Math.floor((Date.now() - scriptStart) / 1000) + 's';

// ------------------------------------------------------------------
// Stream the startup log and wait until the startup script is finished
// ------------------------------------------------------------------
console.log(`\x1b[36m[${elapsed()}] Waiting for VM startup script to complete…\x1b[0m`);
console.log('  (Live log from the VM – every new line will appear below)');

let lastOffset = 0;
let scriptFinished = false;

for (let i = 0; i < 90; i++) {
    // Show a moving status line every attempt
    console.log(`\x1b[36m⏳ [${elapsed()}] Checking startup log (attempt ${i + 1}/90)…\x1b[0m`);

    try {
        const newContent = execSync(
            `ssh -i "${KEY_FILE}" -o StrictHostKeyChecking=no ${SSH_USER}@${VM_IP} "tail -c +${lastOffset + 1} /var/log/startup-script.log 2>/dev/null || true"`,
            { encoding: 'utf8', stdio: 'pipe' }
        );
        if (newContent.trim()) {
            process.stdout.write(newContent);   // real‑time log output
            lastOffset += Buffer.byteLength(newContent, 'utf8');
            if (newContent.includes('=== Startup script finished at')) {
                scriptFinished = true;
            }
        }
    } catch (_) {}

    if (scriptFinished) {
        let aptRunning = false;
        try {
            const aptProcs = execSync(
                `ssh -i "${KEY_FILE}" -o StrictHostKeyChecking=no ${SSH_USER}@${VM_IP} "pgrep -x apt-get || pgrep -x dpkg || true"`,
                { encoding: 'utf8', stdio: 'pipe' }
            ).trim();
            if (aptProcs) aptRunning = true;
        } catch (_) {}
        if (!aptRunning) {
            console.log(`\x1b[32m✅ [${elapsed()}] Startup script finished and package manager is idle.\x1b[0m`);
            break;
        }
    }

    if (i < 89) {
        execSync(`ping -n 11 127.0.0.1 >nul`, { stdio: 'pipe' }); // wait 10 seconds
    }
}

if (!scriptFinished) {
    console.log(`\x1b[33m⚠️ [${elapsed()}] Startup script did not finish in time – proceeding anyway.\x1b[0m`);
}

// ------------------------------------------------------------------
// Install missing tools (visible output, no quiet flags, no interactive prompts)
// ------------------------------------------------------------------
console.log(`\x1b[33m[${elapsed()}] Installing missing tools…\x1b[0m`);
const installRemoteCmd = (
    'sudo apt-get update && ' +
    'sudo DEBIAN_FRONTEND=noninteractive apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin nodejs git && ' +
    'sudo usermod -aG docker ' + SSH_USER
);

const installCmd = `ssh -T -i "${KEY_FILE}" -o StrictHostKeyChecking=no ${SSH_USER}@${VM_IP} "${installRemoteCmd}"`;
try {
    execSync(installCmd, { stdio: 'inherit' });   // FULL output visible
    console.log(`\x1b[32m✅ [${elapsed()}] Tools installed successfully.\x1b[0m`);
} catch (e) {
    console.error(`\x1b[31m❌ [${elapsed()}] Some tools may have failed to install – continuing.\x1b[0m`);
}

// ------------------------------------------------------------------
// Ensure /opt/badminton_court exists and is owned by the correct user
// ------------------------------------------------------------------
console.log(`\x1b[33m[${elapsed()}] Setting up /opt/badminton_court directory…\x1b[0m`);
const dirCmd = `ssh -T -i "${KEY_FILE}" -o StrictHostKeyChecking=no ${SSH_USER}@${VM_IP} "sudo mkdir -p /opt/badminton_court && sudo chown -R ${SSH_USER}:${SSH_USER} /opt/badminton_court"`;
execSync(dirCmd, { stdio: 'inherit' });
console.log(`\x1b[32m✅ [${elapsed()}] Directory /opt/badminton_court ready and owned by ${SSH_USER}.\x1b[0m`);