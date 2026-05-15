#!/usr/bin/env node
/**
 * Scripts/create-deploy-vm.js
 * Master orchestrator for a full fresh deployment VM.
 * 1. Creates a new VM (calls create-fresh-vm.js  → menu option 6.1)
 * 2. Runs all post‑creation setup steps by calling the same
 *    granular scripts that are also available as individual menu options:
 *    - setup-firewall-rules.js      (6.2)
 *    - setup-agent-ssh.js           (6.3)
 *    - install-tools-on-vm.js       (6.4)
 *    - setup-gcp-secrets-access.js  (6.5)
 *    - check-vm-reachability.js     (6.6)
 *    - apply-pipeline-config.js     (6.7)   ← pipeline config is part of the setup
 *
 * Usage:
 *   node Scripts/create-deploy-vm.js
 */

const { execSync } = require('child_process');
const path = require('path');

// ---------- Helpers ----------
function run(cmd, options = {}) {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: options.silent ? 'pipe' : 'inherit', ...options });
  } catch (e) {
    if (!options.ignoreError) {
      console.error(`\x1b[31mCommand failed: ${cmd}\x1b[0m`);
      console.error(e.stderr || e.message);
      process.exit(1);
    }
    return null;
  }
}

function log(msg, color = '\x1b[36m') {
  console.log(`${color}%s\x1b[0m`, msg);
}

// ---------- Main flow ----------
async function main() {
  const startTime = Date.now();
  const elapsed = () => Math.floor((Date.now() - startTime) / 1000) + 's';

  log(`[${elapsed()}] Starting full deployment VM creation…`, '\x1b[32m');

  // 1. Create the VM (menu option 6.1)
  log(`[${elapsed()}] Step 1: Creating fresh VM (menu option 6.1)…`, '\x1b[33m');
  run('node Scripts/create-fresh-vm.js');
  log(`[${elapsed()}] VM created.`);

  // 2. Post‑creation setup (same as individual menu options)
  const steps = [
    ['setup-firewall-rules.js',      'Configure firewall rules (6.2)'],
    ['setup-agent-ssh.js',           'Setup agent SSH keys (6.3)'],
    ['install-tools-on-vm.js',       'Install / Verify tools on VM (6.4)'],
    ['setup-gcp-secrets-access.js',  'Setup GCP Secret Manager access (6.5)'],
    ['check-vm-reachability.js',     'Check VM running & reachable (6.6)'],
    ['apply-pipeline-config.js',     'Apply pipeline configuration (6.7)']
  ];

  for (const [script, label] of steps) {
    log(`[${elapsed()}] Step: ${label}…`, '\x1b[33m');
    run(`node "${path.join(__dirname, script)}"`, { silent: true });
    log(`[${elapsed()}] ${label} done.`, '\x1b[36m');
  }

  log(`\n✅ Full deployment VM is ready.`, '\x1b[32m');
  log(`   All post‑creation steps completed and pipeline configuration applied.`, '\x1b[36m');
  log(`   You can now use option 2.1 to trigger the badminton_court‑artifacts pipeline.`, '\x1b[36m');
}

main().catch(err => {
  console.error('\x1b[31mError:', err.message, '\x1b[0m');
  process.exit(1);
});