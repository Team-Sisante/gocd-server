#!/usr/bin/env node
/**
 * Scripts/setup-firewall-rules.js
 * Ensures the required firewall rules exist for the deployment VM.
 * Creates default-allow-ssh, default-allow-http, default-allow-https if missing.
 *
 * 🔴 HARD RULE: Every process MUST display real‑time progress.
 *    Never suppress output or leave the screen frozen.
 *    Always show live elapsed time where appropriate.
 */

const { execSync } = require('child_process');

const PROJECT_ID = process.env.GCP_PROJECT_ID;
if (!PROJECT_ID) {
  console.error('\x1b[31mERROR: GCP_PROJECT_ID environment variable is missing.\x1b[0m');
  console.error('Ensure you are running this through the management menu or have .env.docker loaded.');
  process.exit(1);
}

const scriptStart = Date.now();
const elapsed = () => Math.floor((Date.now() - scriptStart) / 1000) + 's';

function run(cmd, options = {}) {
  const stdio = options.silent ? 'pipe' : 'inherit';
  try {
    return execSync(cmd, { encoding: 'utf8', stdio, ...options }).trim();
  } catch {
    if (!options.ignoreError) {
      console.error(`\x1b[31m[${elapsed()}] Command failed: ${cmd}\x1b[0m`);
    }
    return null;
  }
}

function log(msg, color = '\x1b[36m') {
  console.log(`${color}[${elapsed()}] ${msg}\x1b[0m`);
}

function ensureRule(name, port, existingRules, protocol = 'tcp') {
  if (!existingRules.has(name)) {
    log(`Creating firewall rule: ${name} (${protocol}:${port})`, '\x1b[33m');
    // Show the creation output – no suppression
    run(`gcloud compute firewall-rules create ${name} --project=${PROJECT_ID} --direction=INGRESS --priority=1000 --network=default --action=ALLOW --rules=${protocol}:${port} --source-ranges=0.0.0.0/0 --target-tags=gocd-deploy-target`);
    log(`Rule ${name} created.`, '\x1b[32m');
  } else {
    log(`Firewall rule ${name} already exists.`, '\x1b[32m');
  }
}

// Fetch all rules once to avoid expensive CLI calls in a loop
log('Fetching existing firewall rules list...', '\x1b[33m');
const rawRules = run(`gcloud compute firewall-rules list --project=${PROJECT_ID} --format="value(name)"`, { silent: true }) || "";
const existingRules = new Set(rawRules.split('\n').map(r => r.trim()));
log(`Found ${existingRules.size} existing rules.`, '\x1b[32m');

['default-allow-ssh:22', 'default-allow-http:80', 'default-allow-https:443', 
 'allow-staging-http:8001', 'allow-staging-https:8443', 
 'allow-production-http:8002', 'allow-production-https:9443',
 'allow-gocd-web:8153'].forEach(entry => {
  const [name, port] = entry.split(':');
  ensureRule(name, port, existingRules);
});

console.log(`\x1b[32m[${elapsed()}] Firewall rules verification complete.\x1b[0m`);