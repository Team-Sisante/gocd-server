#!/usr/bin/env node
/**
 * install-tools-on-vm.js – Installs Docker on the deployment VM using the official script.
 * Also creates /opt/badminton_court with correct ownership.
 * Uses GCP_PROJECT_ID & GCP_ZONE from the environment.
 */

const { execSync } = require('child_process');
const path = require('path');

const PROJECT_ID = process.env.GCP_PROJECT_ID;
const ZONE       = process.env.GCP_ZONE;
const KEY_FILE   = path.join(__dirname, '..', 'secrets', 'agent-key');

if (!PROJECT_ID || !ZONE) {
  console.error('Missing GCP_PROJECT_ID or GCP_ZONE in environment.');
  process.exit(1);
}

const ip = execSync(
  `gcloud compute instances describe gocd-deploy-target --project=${PROJECT_ID} --zone=${ZONE} --format="value(networkInterfaces[0].accessConfigs[0].natIP)"`,
  { encoding: 'utf8' }
).trim();

if (!ip) {
  console.error('Could not determine VM IP. Is it running?');
  process.exit(1);
}

// Install Docker
console.log('Installing Docker via official script...');
let cmd = `ssh -i "${KEY_FILE}" -o StrictHostKeyChecking=no sol-i@${ip} "curl -fsSL https://get.docker.com -o get-docker.sh && sudo sh get-docker.sh && sudo usermod -aG docker sol-i"`;
execSync(cmd, { stdio: 'inherit' });
console.log('Docker installed successfully. Use "sudo docker" if not in docker group yet.');

// Create /opt/badminton_court with proper ownership
console.log('Creating /opt/badminton_court directory...');
cmd = `ssh -i "${KEY_FILE}" -o StrictHostKeyChecking=no sol-i@${ip} "sudo mkdir -p /opt/badminton_court && sudo chown -R sol-i:sol-i /opt/badminton_court"`;
execSync(cmd, { stdio: 'inherit' });
console.log('Directory /opt/badminton_court ready.');