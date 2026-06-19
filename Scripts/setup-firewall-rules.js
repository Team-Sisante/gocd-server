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
const readline = require('readline');

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
  // Mail service ports (SMTP/IMAP/POP3/Sieve) — needed for Poste.io setup wizard
  // connectivity tests and for actual mail delivery. These are standard ports
  // that Poste.io listens on.
  MAIL_SMTP: '25',
  MAIL_SMTPS: '465',
  MAIL_SUBMISSION: '587',
  MAIL_IMAP: '143',
  MAIL_IMAPS: '993',
  MAIL_POP3: '110',
  MAIL_POP3S: '995',
  MAIL_SIEVE: '4190',
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
      try {
        const verify = execSync(`gcloud compute firewall-rules describe ${ruleName} --project=${PROJECT_ID} --format="value(name)"`, { encoding: 'utf8', stdio: 'pipe' }).trim();
        if (verify === ruleName) {
          log(`Rule ${ruleName} created (despite gcloud warning).`, '\x1b[32m');
          return ruleName;
        }
      } catch (verifyErr) {
        // Verification failed, fall through to error handling
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

// --- Main Execution ---
async function main() {
  console.log('\x1b[33m========================================\x1b[0m');
  console.log('\x1b[33m⚠️  FIREWALL RULE MANAGEMENT WARNING ⚠️\x1b[0m');
  console.log('\x1b[33m========================================\x1b[0m');
  console.log('This script will create the following firewall rules if they do not exist:');
  console.log('  - default-allow-ssh (port 22)');
  console.log('  - default-allow-http (port 80)');
  console.log('  - default-allow-https (port 443)');
  console.log('  - allow-gocd-web (port 8153)');
  console.log(`  - allow-staging-http (port ${PORTS.STAGING_HTTP})`);
  console.log(`  - allow-staging-https (port ${PORTS.STAGING_HTTPS})`);
  console.log(`  - allow-production-http (port ${PORTS.PRODUCTION_HTTP})`);
  console.log(`  - allow-production-https (port ${PORTS.PRODUCTION_HTTPS})`);
  console.log(`  - allow-mail-https-staging (port ${PORTS.MAIL_HTTPS_STAGING})`);
  console.log(`  - allow-mail-https-production (port ${PORTS.MAIL_HTTPS_PRODUCTION})`);
  console.log(`  - allow-mail-smtp (port ${PORTS.MAIL_SMTP})`);
  console.log(`  - allow-mail-smtps (port ${PORTS.MAIL_SMTPS})`);
  console.log(`  - allow-mail-submission (port ${PORTS.MAIL_SUBMISSION})`);
  console.log(`  - allow-mail-imap (port ${PORTS.MAIL_IMAP})`);
  console.log(`  - allow-mail-imaps (port ${PORTS.MAIL_IMAPS})`);
  console.log(`  - allow-mail-pop3 (port ${PORTS.MAIL_POP3})`);
  console.log(`  - allow-mail-pop3s (port ${PORTS.MAIL_POP3S})`);
  console.log(`  - allow-mail-sieve (port ${PORTS.MAIL_SIEVE})`);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  
  const answer = await new Promise(resolve => {
    rl.question('\x1b[33mType "yes" to continue, or anything else to abort: \x1b[0m', resolve);
  });
  rl.close();

  if (answer.trim().toLowerCase() !== 'yes') {
    console.log('\x1b[36m[0s] Aborted by user. No changes made.\x1b[0m');
    process.exit(0);
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
    // Mail service ports (SMTP/IMAP/POP3/Sieve) — needed for Poste.io setup
    // wizard connectivity tests and for actual mail delivery.
    ['allow-mail-smtp', PORTS.MAIL_SMTP],
    ['allow-mail-smtps', PORTS.MAIL_SMTPS],
    ['allow-mail-submission', PORTS.MAIL_SUBMISSION],
    ['allow-mail-imap', PORTS.MAIL_IMAP],
    ['allow-mail-imaps', PORTS.MAIL_IMAPS],
    ['allow-mail-pop3', PORTS.MAIL_POP3],
    ['allow-mail-pop3s', PORTS.MAIL_POP3S],
    ['allow-mail-sieve', PORTS.MAIL_SIEVE],
  ];

  // Combine and process all rules
  [...standardRules, ...appRules].forEach(([name, port]) => {
    ensureRule(name, port, existingRules);
  });

  console.log(`\x1b[32m[${elapsed()}] Firewall rules verification complete.\x1b[0m`);
}

main();