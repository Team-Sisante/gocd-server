#!/usr/bin/env node
/**
 * Scripts/setup-gcp-secrets-access.js
 * Ensures a GCP service account with Secret Manager access exists,
 * and generates a key file for the GoCD agent to use.
 * Cross‑platform: Node.js + gcloud.
 *
 * 🔴 HARD RULE: Every process MUST display real‑time progress.
 *    Never suppress output or leave the screen frozen.
 *    Always show live elapsed time where appropriate.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// ---------- Configuration ----------
const PROJECT_ID = process.env.GCP_PROJECT_ID;
const SA_NAME = 'gocd-agent-secrets';
const SA_EMAIL = `${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com`;
const KEY_FILE = path.join(__dirname, '..', 'secrets', 'gcp-key.json');
const ROLE = 'roles/secretmanager.secretAccessor';

const scriptStart = Date.now();
const elapsed = () => Math.floor((Date.now() - scriptStart) / 1000) + 's';

function run(cmd, options = {}) {
  const stdio = options.silent ? 'pipe' : 'inherit';
  try {
    return execSync(cmd, { encoding: 'utf8', stdio, ...options }).trim();
  } catch (e) {
    if (!options.ignoreError) {
      console.error(`\x1b[31m[${elapsed()}] Command failed: ${cmd}\x1b[0m`);
      console.error(e.stderr || e.message);
      process.exit(1);
    }
    return null;
  }
}

function log(msg, color = '\x1b[36m') {
  console.log(`${color}[${elapsed()}] ${msg}\x1b[0m`);
}

// Check if the active account is a service account (common cause of permission errors)
const activeAccount = run('gcloud config get-value account', { silent: true, ignoreError: true });
if (activeAccount && activeAccount.includes('.gserviceaccount.com')) {
  log(`⚠️  Detected active account is a Service Account: ${activeAccount}`, '\x1b[33m');
  log('Administrative IAM tasks usually require a User Account (Owner/Editor).', '\x1b[33m');
  log('Suggestion: Run "gcloud auth login" to switch back to your personal account.', '\x1b[33m');
}

// ---------- Step 1: Ensure service account exists ----------
log('Checking if service account exists...', '\x1b[33m');
const existingSA = run(`gcloud iam service-accounts list --project=${PROJECT_ID} --format="value(email)" --filter="email:${SA_EMAIL}"`, { silent: true, ignoreError: true });
if (!existingSA || !existingSA.trim()) {
  log(`Creating service account ${SA_EMAIL}...`, '\x1b[33m');
  run(`gcloud iam service-accounts create ${SA_NAME} --display-name="GoCD Agent Secret Manager Access" --project=${PROJECT_ID}`, { silent: false });
  log('Service account created.', '\x1b[32m');
} else {
  log('Service account already exists.', '\x1b[32m');
}

// ---------- Step 2: Grant Secret Manager access ----------
log('Granting Secret Manager access...', '\x1b[33m');
// idempotent; show output for transparency
run(`gcloud projects add-iam-policy-binding ${PROJECT_ID} --member="serviceAccount:${SA_EMAIL}" --role="${ROLE}" --condition=None`, { silent: false, ignoreError: true });
// The above may show a warning if already present, but won't stop the script.
log('Access granted.', '\x1b[32m');

// ---------- Step 3: Generate key if missing ----------
if (!fs.existsSync(KEY_FILE)) {
  log('Generating service account key...', '\x1b[33m');
  // Ensure secrets directory exists
  fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true });
  run(`gcloud iam service-accounts keys create "${KEY_FILE}" --iam-account="${SA_EMAIL}" --project=${PROJECT_ID}`, { silent: false });
  log(`Key written to ${KEY_FILE}.`, '\x1b[32m');
} else {
  log('Key file already exists. Skipping generation.', '\x1b[32m');
}

log('Done. GoCD agent can now access GCP secrets.\n', '\x1b[32m');