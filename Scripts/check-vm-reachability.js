#!/usr/bin/env node
/**
 * Scripts/check-vm-reachability.js
 * Checks if the deployment VM is running and reachable on port 22.
 */

const { execSync } = require('child_process');
const net = require('net');

const PROJECT_ID = 'project-39c0ea08-238b-47b5-915';
const ZONE = 'us-west1-b';
const INSTANCE_NAME = 'gocd-deploy-target';

function run(cmd, options = {}) {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: options.silent ? 'pipe' : 'inherit', ...options }).trim();
  } catch { return null; }
}

// Get VM status and external IP
const desc = run(`gcloud compute instances describe ${INSTANCE_NAME} --zone=${ZONE} --project=${PROJECT_ID} --format="value(status,networkInterfaces[0].accessConfigs[0].natIP)"`, { silent: true });

if (!desc) {
  console.log('\x1b[31mVM not found or gcloud error.\x1b[0m');
  process.exit(1);
}

const [status, ip] = desc.split(/\s+/);
console.log(`\x1b[36mVM Status: ${status}\x1b[0m`);
if (ip) console.log(`\x1b[36mExternal IP: ${ip}\x1b[0m`);
else {
  console.log('\x1b[31mNo external IP found.\x1b[0m');
  process.exit(1);
}

// Check TCP port 22
console.log(`\x1b[33mChecking SSH port 22 on ${ip}...\x1b[0m`);
const socket = new net.Socket();
socket.setTimeout(5000);
socket.on('connect', () => {
  console.log('\x1b[32m✓ Port 22 is open and reachable.\x1b[0m');
  socket.destroy();
  process.exit(0);
});
socket.on('timeout', () => {
  console.log('\x1b[31m✗ Connection timed out. VM may be stopped or firewall blocking port 22.\x1b[0m');
  socket.destroy();
  process.exit(1);
});
socket.on('error', (err) => {
  console.log(`\x1b[31m✗ Connection refused or error: ${err.message}\x1b[0m`);
  process.exit(1);
});
socket.connect(22, ip);