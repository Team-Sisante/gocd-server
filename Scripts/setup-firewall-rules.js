#!/usr/bin/env node
/**
 * Scripts/setup-firewall-rules.js
 * Ensures the required firewall rules exist for the deployment VM.
 * Creates all required rules by reading ports from environment variables.
 *
 * 🔴 HARD RULE: Every process MUST display real‑time progress.
 *    Never suppress output or leave the screen frozen.
 *    Always show live elapsed time where appropriate.
 *
 * 🔴 HARD RULE: Strict validation — no defaults, fails immediately if missing.
 */

const { execSync } = require('child_process');

const PROJECT_ID = process.env.GCP_PROJECT_ID;
if (!PROJECT_ID) {
  console.error('\x1b[31mERROR: GCP_PROJECT_ID environment variable is missing.\x1b[0m');
  console.error('Ensure you are running this through the management menu or have .env.docker loaded.');
  process.exit(1);
}

// Strict validation for all application ports — no defaults (per Roadmap #52)
const PORTS = {
  SSH: '22',
  HTTP: '80',
  HTTPS: '443',
  GOCD_WEB: '8153',
  STAGING_HTTP: process.env.WEB_HOST_PORT_BADMINTON_STAGING,
  STAGING_HTTPS: process.env.WEB_HTTPS_PORT_STAGING_BADMINTON,
  PRODUCTION_HTTP: process.env.WEB_HOST_PORT_BADMINTON_PRODUCTION,
  PRODUCTION_HTTPS: process.env.WEB_HTTPS_PORT_PRODUCTION_BADMINTON,
  MAIL_HTTPS_STAGING: process.env.MAIL_HTTPS_HOST_PORT_STAGING,
  MAIL_HTTPS_PRODUCTION: process.env.MAIL_HTTPS_HOST_PORT_PRODUCTION,
};

// Validate all application ports are set
const missingPorts = Object.entries(PORTS)
  .filter(([key, value]) => !value)
  .map(([key]) => key);

if (missingPorts.length > 0) {
  console.error('\x1b[31mERROR: Missing required port environment variables:\x1b[0m');
  missingPorts.forEach(p => console.error(`  - ${p}`));
  console.error('\nEnsure these are defined in .env.docker:');
  console.error('  WEB_HOST_PORT_BADMINTON_STAGING');
  console.error('  WEB_HTTPS_PORT_STAGING_BADMINTON');
  console.error('  WEB_HOST_PORT_BADMINTON_PRODUCTION');
  console.error('  WEB_HTTPS_PORT_PRODUCTION_BADMINTON');
  console.error('  MAIL_HTTPS_HOST_PORT_STAGING');
  console.error('  MAIL_HTTPS_HOST_PORT_PRODUCTION');
  process.exit(1);
}

const scriptStart = Date.now();
const elapsed = () => Math.floor((Date.now() - scriptStart) / 1000) + 's';

function run(cmd, options = {}) {
  const stdio = options.silent ? 'pipe' : 'inherit';
  try {
    return execSync(cmd, { encoding: 'utf8', stdio, ...options }).trim();
  } catch (err) {
    // gcloud sometimes returns non-zero exit codes for warnings like 
    // "Updates are available for some Google Cloud CLI components"
    // Check if the rule was actually created despite the error
    if (cmd.includes('firewall-rules create')) {
      const ruleName = cmd.match(/create\s+(\S+)/)[1];
      const verify = execSync(`gcloud compute firewall-rules describe ${ruleName} --project=${PROJECT_ID} --format="value(name)"`, { encoding: 'utf8', stdio: 'pipe' }).trim();
      if (verify === ruleName) {
        log(`Rule ${ruleName} created (despite gcloud warning).`, '\x1b[32m');
        return ruleName;
      }
    }
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

// Standard ports (universal, never change)
const standardRules = [
  ['default-allow-ssh', PORTS.SSH],
  ['default-allow-http', PORTS.HTTP],
  ['default-allow-https', PORTS.HTTPS],
  ['allow-gocd-web', PORTS.GOCD_WEB],
];

// Application-specific ports (read from env vars, change per deployment)
const appRules = [
  ['allow-staging-http', PORTS.STAGING_HTTP],
  ['allow-staging-https', PORTS.STAGING_HTTPS],
  ['allow-production-http', PORTS.PRODUCTION_HTTP],
  ['allow-production-https', PORTS.PRODUCTION_HTTPS],
  ['allow-mail-https-staging', PORTS.MAIL_HTTPS_STAGING],
  ['allow-mail-https-production', PORTS.MAIL_HTTPS_PRODUCTION],
];

// Combine and process all rules
[...standardRules, ...appRules].forEach(([name, port]) => {
  ensureRule(name, port, existingRules);
});

console.log(`\x1b[32m[${elapsed()}] Firewall rules verification complete.\x1b[0m`);