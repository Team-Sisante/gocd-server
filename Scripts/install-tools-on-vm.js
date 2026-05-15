#!/usr/bin/env node
/**
 * install-tools-on-vm.js – Waits for the VM's startup script to finish,
 * then installs any missing tools (Docker, Node, git, etc.) and ensures
 * /opt/badminton_court has correct ownership.
 *
 * Uses GCP_PROJECT_ID, GCP_ZONE, GCP_VM_IP, VM_SSH_USER from the environment.
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

// ------------------------------------------------------------------
// Stream the startup log and wait until the startup script is finished
// AND apt is idle.
// ------------------------------------------------------------------
console.log('Waiting for VM startup script to complete…');
console.log('  (Live log from the VM – every new line will appear below)');

let lastOffset = 0;
let scriptFinished = false;
let statusPrinted = false;

for (let i = 0; i < 90; i++) {
    // 1. Print new log lines
    try {
        const newContent = execSync(
            `ssh -i "${KEY_FILE}" -o StrictHostKeyChecking=no ${SSH_USER}@${VM_IP} "tail -c +${lastOffset + 1} /var/log/startup-script.log 2>/dev/null || true"`,
            { encoding: 'utf8', stdio: 'pipe' }
        );
        if (newContent.trim()) {
            process.stdout.write(newContent);
            lastOffset += Buffer.byteLength(newContent, 'utf8');
            if (newContent.includes('=== Startup script finished at')) {
                scriptFinished = true;
            }
        }
    } catch (_) {}

    // 2. If the script has finished, check if apt is free
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
            console.log('✅ VM startup script finished and package manager is idle.');
            break;
        }
        if (!statusPrinted) {
            console.log('  (apt is still finishing – waiting)');
            statusPrinted = true;
        }
    }

    if (i < 89) {
        execSync(`ping -n 11 127.0.0.1 >nul`, { stdio: 'pipe' }); // wait 10 seconds
    }
}

if (!scriptFinished) {
    console.log('Startup script did not finish in time – proceeding anyway.');
}

// ------------------------------------------------------------------
// Install / fix missing tools
// ------------------------------------------------------------------
console.log('Checking and installing essential tools…');
const installCmd = `ssh -i "${KEY_FILE}" -o StrictHostKeyChecking=no ${SSH_USER}@${VM_IP} "
for tool in docker-ce docker-ce-cli containerd.io docker-compose-plugin nodejs git; do
    pkg=\$tool
    # Map tool names to the correct package if needed
    case \$tool in
        docker-ce) pkg=docker-ce;;
        docker-ce-cli) pkg=docker-ce-cli;;
        containerd.io) pkg=containerd.io;;
        docker-compose-plugin) pkg=docker-compose-plugin;;
        nodejs) pkg=nodejs;;
        git) pkg=git;;
    esac
    if dpkg -s \$pkg &>/dev/null; then
        echo \\"  ✓ \$pkg already installed\\"
    else
        echo \\"  Installing \$pkg…\\"
        sudo apt-get update -qq && sudo apt-get install -y \$pkg 2>/dev/null || echo \\"  ⚠ Failed to install \$pkg\\"
    fi
done
sudo usermod -aG docker ${SSH_USER} 2>/dev/null
"`;
try {
    execSync(installCmd, { stdio: 'inherit' });
} catch (e) {
    console.error('Some tools may have failed to install – continuing.');
}

// ------------------------------------------------------------------
// Ensure /opt/badminton_court exists and is owned by the correct user
// ------------------------------------------------------------------
console.log('Setting up /opt/badminton_court directory…');
const dirCmd = `ssh -i "${KEY_FILE}" -o StrictHostKeyChecking=no ${SSH_USER}@${VM_IP} "sudo mkdir -p /opt/badminton_court && sudo chown -R ${SSH_USER}:${SSH_USER} /opt/badminton_court"`;
execSync(dirCmd, { stdio: 'inherit' });
console.log('Directory /opt/badminton_court ready and owned by', SSH_USER);