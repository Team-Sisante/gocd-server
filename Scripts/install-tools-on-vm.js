#!/usr/bin/env node
/**
 * install-tools-on-vm.js – Waits for the VM's startup script to finish
 * (which already installs Docker, Node, etc.) and then ensures
 * /opt/badminton_court has correct ownership.
 *
 * Uses GCP_PROJECT_ID, GCP_ZONE, VM_SSH_USER from the environment.
 */

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const PROJECT_ID = process.env.GCP_PROJECT_ID;
const ZONE       = process.env.GCP_ZONE;
const SSH_USER   = process.env.VM_SSH_USER || 'xmnione';
const KEY_FILE   = path.join(__dirname, '..', 'secrets', 'agent-key');

if (!PROJECT_ID || !ZONE) {
  console.error('Missing GCP_PROJECT_ID or GCP_ZONE in environment.');
  process.exit(1);
}
if (!fs.existsSync(KEY_FILE)) {
  console.error('SSH key not found at', KEY_FILE);
  process.exit(1);
}

// Get VM IP
const ip = execSync(
  `gcloud compute instances describe gocd-deploy-target --project=${PROJECT_ID} --zone=${ZONE} --format="value(networkInterfaces[0].accessConfigs[0].natIP)"`,
  { encoding: 'utf8' }
).trim();

if (!ip) {
  console.error('Could not determine VM IP.');
  process.exit(1);
}

// Clear old host key
try { execSync(`ssh-keygen -R ${ip}`, { stdio: 'ignore' }); } catch (_) {}

// ------------------------------------------------------------------
// Wait until the startup script is completely done
// ------------------------------------------------------------------
console.log('Waiting for VM startup script to complete…');
console.log('  (New log lines from the VM will appear below)');

let lastLogLine = '';
let startupDone = false;

for (let i = 0; i < 90; i++) {   // up to 15 minutes
  // Show progress from the startup log
  try {
    const logLine = execSync(
      `ssh -i "${KEY_FILE}" -o StrictHostKeyChecking=no ${SSH_USER}@${ip} "tail -n 1 /var/log/startup-script.log 2>/dev/null || echo ''"`,
      { encoding: 'utf8', stdio: 'pipe' }
    ).trim();
    if (logLine && logLine !== lastLogLine) {
      console.log(`  VM: ${logLine}`);
      lastLogLine = logLine;
    }
  } catch (_) {}

  // Check if the startup script service has stopped
  let serviceInactive = false;
  try {
    const status = execSync(
      `ssh -i "${KEY_FILE}" -o StrictHostKeyChecking=no ${SSH_USER}@${ip} "systemctl is-active google-startup-scripts.service 2>/dev/null || echo inactive"`,
      { encoding: 'utf8', stdio: 'pipe' }
    ).trim();
    if (status === 'inactive' || status === 'failed' || status === '') {
      serviceInactive = true;
    }
  } catch (_) { serviceInactive = true; }

  // Check if any apt-get or dpkg process is still running
  let aptRunning = false;
  try {
    const aptProcs = execSync(
      `ssh -i "${KEY_FILE}" -o StrictHostKeyChecking=no ${SSH_USER}@${ip} "pgrep -x apt-get || true"`,
      { encoding: 'utf8', stdio: 'pipe' }
    ).trim();
    if (aptProcs) aptRunning = true;
  } catch (_) { /* pgrep might not be installed, assume not running */ }

  if (serviceInactive && !aptRunning) {
    startupDone = true;
    console.log('✅ VM startup script finished successfully.');
    break;
  }

  if (i < 89) {
    execSync(`ping -n 11 127.0.0.1 >nul`, { stdio: 'pipe' }); // wait 10 seconds
  }
}

if (!startupDone) {
  console.log('Startup script did not finish in time – proceeding anyway.');
}

// ------------------------------------------------------------------
// Ensure /opt/badminton_court exists and is owned by the correct user
// ------------------------------------------------------------------
console.log('Setting up /opt/badminton_court directory…');
const cmd = `ssh -i "${KEY_FILE}" -o StrictHostKeyChecking=no ${SSH_USER}@${ip} "sudo mkdir -p /opt/badminton_court && sudo chown -R ${SSH_USER}:${SSH_USER} /opt/badminton_court"`;
execSync(cmd, { stdio: 'inherit' });
console.log('Directory /opt/badminton_court ready and owned by', SSH_USER);