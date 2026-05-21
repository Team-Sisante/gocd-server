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

function ensureRule(name, port, protocol = 'tcp') {
  console.log(`\x1b[33m[${elapsed()}] Checking firewall rule ${name}…\x1b[0m`);
  const exists = run(`gcloud compute firewall-rules list --filter="name=${name}" --project=${PROJECT_ID} --format="value(name)"`, { silent: true });
  if (!exists) {
    console.log(`\x1b[33m[${elapsed()}] Creating firewall rule: ${name} (${protocol}:${port})\x1b[0m`);
    // Show the creation output – no suppression
    run(`gcloud compute firewall-rules create ${name} --project=${PROJECT_ID} --direction=INGRESS --priority=1000 --network=default --action=ALLOW --rules=${protocol}:${port} --source-ranges=0.0.0.0/0 --target-tags=gocd-deploy-target`);
    console.log(`\x1b[32m[${elapsed()}] Rule ${name} created.\x1b[0m`);
  } else {
    console.log(`\x1b[32m[${elapsed()}] Firewall rule ${name} already exists.\x1b[0m`);
  }
}

['default-allow-ssh:22', 'default-allow-http:80', 'default-allow-https:443', 
 'allow-staging-http:8001', 'allow-staging-https:8443', 
 'allow-production-http:8002', 'allow-production-https:9443'].forEach(entry => {
  const [name, port] = entry.split(':');
  ensureRule(name, port);
});

console.log(`\x1b[32m[${elapsed()}] Firewall rules verification complete.\x1b[0m`);