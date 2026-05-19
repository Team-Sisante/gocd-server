#!/usr/bin/env node
/**
 * Scripts/check-vm-reachability.js
 * Checks if the deployment VM is running and reachable on port 22.
 *
 * 🔴 HARD RULE: Every process MUST display real‑time progress.
 *    Never suppress output or leave the screen frozen.
 *    Always show live elapsed time where appropriate.
 */

const { execSync } = require('child_process');
const net = require('net');

const PROJECT_ID = process.env.GCP_PROJECT_ID;
const ZONE = process.env.GCP_ZONE;
const INSTANCE_NAME = process.env.GCP_VM_NAME;

const scriptStart = Date.now();
const elapsed = () => Math.floor((Date.now() - scriptStart) / 1000) + 's';

function run(cmd, options = {}) {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: options.silent ? 'pipe' : 'inherit', ...options }).trim();
  } catch { return null; }
}

console.log(`\x1b[36m[${elapsed()}] Fetching VM status…\x1b[0m`);
const desc = run(`gcloud compute instances describe ${INSTANCE_NAME} --zone=${ZONE} --project=${PROJECT_ID} --format="value(status,networkInterfaces[0].accessConfigs[0].natIP)"`, { silent: true });

if (!desc) {
  console.log(`\x1b[31m[${elapsed()}] VM not found or gcloud error.\x1b[0m`);
  process.exit(1);
}

const [status, ip] = desc.split(/\s+/);
console.log(`\x1b[36m[${elapsed()}] VM Status: ${status}\x1b[0m`);
if (ip) console.log(`\x1b[36m[${elapsed()}] External IP: ${ip}\x1b[0m`);
else {
  console.log(`\x1b[31m[${elapsed()}] No external IP found.\x1b[0m`);
  process.exit(1);
}

// Check TCP port 22
console.log(`\x1b[33m[${elapsed()}] Checking SSH port 22 on ${ip}…\x1b[0m`);
const socket = new net.Socket();
socket.setTimeout(5000);
socket.on('connect', () => {
  console.log(`\x1b[32m[${elapsed()}] ✓ Port 22 is open and reachable.\x1b[0m`);
  socket.destroy();
  process.exit(0);
});
socket.on('timeout', () => {
  console.log(`\x1b[31m[${elapsed()}] ✗ Connection timed out. VM may be stopped or firewall blocking port 22.\x1b[0m`);
  socket.destroy();
  process.exit(1);
});
socket.on('error', (err) => {
  console.log(`\x1b[31m[${elapsed()}] ✗ Connection refused or error: ${err.message}\x1b[0m`);
  process.exit(1);
});
socket.connect(22, ip);