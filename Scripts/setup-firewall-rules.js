#!/usr/bin/env node
/**
 * Scripts/setup-firewall-rules.js
 * Ensures the required firewall rules exist for the deployment VM.
 * Creates default-allow-ssh, default-allow-http, default-allow-https if missing.
 */

const { execSync } = require('child_process');
const PROJECT_ID = 'project-39c0ea08-238b-47b5-915';

function run(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: 'pipe' }).trim();
  } catch { return null; }
}

function ensureRule(name, port, protocol = 'tcp') {
  const exists = run(`gcloud compute firewall-rules list --filter="name=${name}" --project=${PROJECT_ID} --format="value(name)"`);
  if (!exists) {
    console.log(`Creating firewall rule: ${name} (${protocol}:${port})`);
    run(`gcloud compute firewall-rules create ${name} --project=${PROJECT_ID} --direction=INGRESS --priority=1000 --network=default --action=ALLOW --rules=${protocol}:${port} --source-ranges=0.0.0.0/0`);
  } else {
    console.log(`Firewall rule ${name} already exists.`);
  }
}

['default-allow-ssh:22', 'default-allow-http:80', 'default-allow-https:443'].forEach(entry => {
  const [name, port] = entry.split(':');
  ensureRule(name, port);
});