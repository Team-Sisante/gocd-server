#!/usr/bin/env node
/**
 * Scripts/setup-gcp-secrets-access.js
 * Ensures a GCP service account with Secret Manager access exists,
 * and generates a key file for the GoCD agent to use.
 * Cross‑platform: Node.js + gcloud.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// ---------- Configuration ----------
const PROJECT_ID = 'project-39c0ea08-238b-47b5-915';
const SA_NAME = 'gocd-agent-secrets';
const SA_EMAIL = `${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com`;
const KEY_FILE = path.join(__dirname, '..', 'secrets', 'gcp-key.json');
const ROLE = 'roles/secretmanager.secretAccessor';

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

// ---------- Step 1: Ensure service account exists ----------
const existingSA = run(`gcloud iam service-accounts list --project=${PROJECT_ID} --format="value(email)" --filter="email:${SA_EMAIL}"`, { silent: true, ignoreError: true });
if (!existingSA || !existingSA.trim()) {
  log(`Creating service account ${SA_EMAIL}...`, '\x1b[33m');
  run(`gcloud iam service-accounts create ${SA_NAME} --display-name="GoCD Agent Secret Manager Access" --project=${PROJECT_ID}`);
  log('Service account created.', '\x1b[32m');
} else {
  log('Service account already exists.', '\x1b[32m');
}

// ---------- Step 2: Grant Secret Manager access ----------
log('Granting Secret Manager access...', '\x1b[33m');
// idempotent: won't fail if already bound
run(`gcloud projects add-iam-policy-binding ${PROJECT_ID} --member="serviceAccount:${SA_EMAIL}" --role="${ROLE}" --condition=None 2>nul || true`, { silent: true, ignoreError: true });
// The above may show a warning if already present, but won't stop the script.
log('Access granted.', '\x1b[32m');

// ---------- Step 3: Generate key if missing ----------
if (!fs.existsSync(KEY_FILE)) {
  log('Generating service account key...', '\x1b[33m');
  // Ensure secrets directory exists
  fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true });
  run(`gcloud iam service-accounts keys create "${KEY_FILE}" --iam-account="${SA_EMAIL}" --project=${PROJECT_ID}`, { silent: true });
  log(`Key written to ${KEY_FILE}.`, '\x1b[32m');
} else {
  log('Key file already exists. Skipping generation.', '\x1b[32m');
}

log('Done. GoCD agent can now access GCP secrets.\n', '\x1b[32m');