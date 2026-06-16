#!/usr/bin/env node
// Scripts/entrypoint.js
'use strict';

const fs = require('fs');
const crypto = require('crypto');
const { execSync, spawnSync } = require('child_process');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(msg) {
  process.stdout.write(`[entrypoint.js] ${msg}\n`);
}

function sh(cmd) {
  return execSync(cmd, { encoding: 'utf8' }).trim();
}

function uuidv4() {
  return crypto.randomUUID ? crypto.randomUUID() : sh('uuidgen');
}

function replaceInFile(filePath, search, replace) {
  const content = fs.readFileSync(filePath, 'utf8');
  fs.writeFileSync(filePath, content.replaceAll(search, replace));
}

// ---------------------------------------------------------------------------
log('======================================');
log('entrypoint.js is running!');
log(`Node.js version: ${process.version}`);
log(`Working directory: ${process.cwd()}`);
log('======================================');

// ---------------------------------------------------------------------------
// PERSISTENT SERVER ID LOGIC
// ---------------------------------------------------------------------------

log('STEP 1: Checking server ID...');
const SERVER_ID_FILE     = '/godata/.server-id';
const BUILD_TIME_ID_FILE = '/etc/server-id';

fs.mkdirSync('/godata/config', { recursive: true });

if (!fs.existsSync(SERVER_ID_FILE)) {
  log('No server ID found in persistent storage. Generating a new one...');
  if (fs.existsSync(BUILD_TIME_ID_FILE)) {
    fs.writeFileSync(SERVER_ID_FILE, fs.readFileSync(BUILD_TIME_ID_FILE, 'utf8'));
    log('Using build-time server ID and saving to persistent storage.');
  } else {
    fs.writeFileSync(SERVER_ID_FILE, uuidv4());
    log('Generated a new runtime server ID and saved to persistent storage.');
  }
} else {
  log('Using existing server ID from persistent storage.');
}

const SERVER_ID = fs.readFileSync(SERVER_ID_FILE, 'utf8').trim();
log(`Server ID: ${SERVER_ID}`);

// ---------------------------------------------------------------------------
// CONFIG FILE CUSTOMIZATION
// Always recreate cruise-config.xml from the template to ensure
// placeholders are always replaced, even if a stale file exists.
// ---------------------------------------------------------------------------

log('STEP 2: Recreating cruise-config.xml from template...');
const CRUISE_CONFIG   = '/godata/config/cruise-config.xml';
const CRUISE_TEMPLATE = '/tmp/cruise-config.xml.template';

log(`Template exists: ${fs.existsSync(CRUISE_TEMPLATE)}`);

if (!fs.existsSync(CRUISE_TEMPLATE)) {
  log('ERROR: Template file not found at /tmp/cruise-config.xml.template. Exiting.');
  process.exit(1);
}

// Always delete and recreate to avoid stale placeholder issues
if (fs.existsSync(CRUISE_CONFIG)) {
  fs.unlinkSync(CRUISE_CONFIG);
  log('Deleted existing cruise-config.xml.');
}

fs.copyFileSync(CRUISE_TEMPLATE, CRUISE_CONFIG);
log('Template copied successfully.');

replaceInFile(CRUISE_CONFIG, '__SERVER_ID__', SERVER_ID);
log('Injected server ID.');

// ---------------------------------------------------------------------------
// TOKEN GENERATION KEY
// GoCD requires a stable tokenGenerationKey. If the operator provides one
// via env var we use it; otherwise we generate a stable random one and
// persist it so agents keep working across restarts.
// ---------------------------------------------------------------------------

const TOKEN_GEN_KEY_FILE = '/godata/.token-generation-key';
let TOKEN_GEN_KEY = process.env.TOKEN_GENERATION_KEY;

if (!TOKEN_GEN_KEY) {
  if (fs.existsSync(TOKEN_GEN_KEY_FILE)) {
    TOKEN_GEN_KEY = fs.readFileSync(TOKEN_GEN_KEY_FILE, 'utf8').trim();
    log('Reusing existing token generation key from persistent storage.');
  } else {
    TOKEN_GEN_KEY = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(TOKEN_GEN_KEY_FILE, TOKEN_GEN_KEY);
    log('Generated a new token generation key and saved to persistent storage.');
  }
} else {
  log('Using token generation key from TOKEN_GENERATION_KEY env var.');
}

replaceInFile(CRUISE_CONFIG, '__TOKEN_GENERATION_KEY__', TOKEN_GEN_KEY);
log('Injected token generation key.');

// ---------------------------------------------------------------------------
// Read env vars, defensively trimming whitespace.
// Trailing whitespace in .env.docker lines is a common cause of malformed
// git URLs (e.g. "https://TOKEN @github.com/..."), which GoCD rejects with
// the cryptic "URL does not seem to be valid" error.
// ---------------------------------------------------------------------------

const clean = (v) => (v == null ? '' : String(v).trim());

const env = (name) => clean(process.env[name]);

const GITHUB_TOKEN                   = env('GITHUB_TOKEN');
const SITE_URL                       = env('SITE_URL');
const GIT_REPO_PROTOCOL              = env('GIT_REPO_PROTOCOL');
const GIT_REPO_DOMAIN                = env('GIT_REPO_DOMAIN');
const GIT_REPO_USERNAME              = env('GIT_REPO_USERNAME');
const GIT_REPO_BADMINTON_REPONAME    = env('GIT_REPO_BADMINTON_REPONAME');
const GIT_REPO_HUMRINE_REPONAME      = env('GIT_REPO_HUMRINE_REPONAME');
const GIT_PEARL_HELLO_WORLD_REPONAME = env('GIT_PEARL_HELLO_WORLD_REPONAME');
const GIT_SOLVPN_REPONAME            = env('GIT_SOLVPN_REPONAME');
const GCP_PROJECT_ID                 = env('GCP_PROJECT_ID');
const GCP_ZONE                       = env('GCP_ZONE');
const GCP_VM_NAME                    = env('GCP_VM_NAME');

log('STEP 3: Checking env vars...');
log(`  SITE_URL                      : ${SITE_URL || 'MISSING'}`);
log(`  GIT_REPO_PROTOCOL             : ${GIT_REPO_PROTOCOL || 'MISSING'}`);
log(`  GIT_REPO_DOMAIN               : ${GIT_REPO_DOMAIN || 'MISSING'}`);
log(`  GIT_REPO_USERNAME             : ${GIT_REPO_USERNAME || 'MISSING'}`);
log(`  GITHUB_TOKEN                  : ${GITHUB_TOKEN ? 'SET' : 'MISSING'}`);
log(`  GIT_REPO_BADMINTON_REPONAME   : ${GIT_REPO_BADMINTON_REPONAME || 'MISSING'}`);
log(`  GIT_REPO_HUMRINE_REPONAME     : ${GIT_REPO_HUMRINE_REPONAME || 'MISSING'}`);
log(`  GIT_PEARL_HELLO_WORLD_REPONAME: ${GIT_PEARL_HELLO_WORLD_REPONAME || 'MISSING'}`);
log(`  GIT_SOLVPN_REPONAME           : ${GIT_SOLVPN_REPONAME || 'MISSING'}`);
log(`  GCP_PROJECT_ID                : ${GCP_PROJECT_ID || 'MISSING'}`);
log(`  GCP_ZONE                      : ${GCP_ZONE || 'MISSING'}`);
log(`  GCP_VM_NAME                   : ${GCP_VM_NAME || 'MISSING'}`);

if (!GITHUB_TOKEN || !GIT_REPO_PROTOCOL || !GIT_REPO_DOMAIN || !GIT_REPO_USERNAME || !GCP_PROJECT_ID) {
  log('ERROR: Required Git or GCP environment variables are missing. Exiting.');
  process.exit(1);
}

// Build URL with trimmed components so trailing whitespace can never produce
// an "https://TOKEN @host/..." pattern.
const makeUrl = (repo) => {
  const safeRepo = clean(repo);
  return `${GIT_REPO_PROTOCOL}://${GITHUB_TOKEN}@${GIT_REPO_DOMAIN}/${GIT_REPO_USERNAME}/${safeRepo}.git`;
};

// Inject Site URL for 415 fix
if (SITE_URL) {
  log('Injecting Site URL...');
  replaceInFile(CRUISE_CONFIG, '__SITE_URL__', SITE_URL);
} else {
  log('WARNING: SITE_URL is empty. The __SITE_URL__ placeholder will remain.');
}

// Inject standalone GitHub Token (for SSH tasks)
log('Injecting standalone GitHub Token...');
replaceInFile(CRUISE_CONFIG, '__GITHUB_TOKEN__', GITHUB_TOKEN);

// Inject GCP details
log('Injecting GCP deployment metadata...');
replaceInFile(CRUISE_CONFIG, '__GCP_PROJECT_ID__', GCP_PROJECT_ID);
replaceInFile(CRUISE_CONFIG, '__GCP_ZONE__', GCP_ZONE || 'us-west1-b');
replaceInFile(CRUISE_CONFIG, '__GCP_VM_NAME__', GCP_VM_NAME || 'gocd-deploy-target');

log('STEP 4: Processing dynamic app injections from apps.json...');
const APPS_JSON = '/tmp/apps.json';

if (fs.existsSync(APPS_JSON)) {
  try {
    const appsData = JSON.parse(fs.readFileSync(APPS_JSON, 'utf8'));
    if (appsData.apps && Array.isArray(appsData.apps)) {
      appsData.apps.forEach(app => {
        const repoName = process.env[app.env_var];
        if (repoName && app.placeholder) {
          const before = fs.readFileSync(CRUISE_CONFIG, 'utf8');
          replaceInFile(CRUISE_CONFIG, app.placeholder, makeUrl(repoName));
          const after = fs.readFileSync(CRUISE_CONFIG, 'utf8');
          if (before === after) {
            log(`  WARNING: placeholder ${app.placeholder} not found in cruise-config.xml (env_var=${app.env_var})`);
          } else {
            log(`  Successfully injected URL for: ${app.name} (${app.placeholder})`);
          }
        } else {
          log(`  Skipping ${app.name}: env var ${app.env_var} is empty or placeholder missing.`);
        }
      });
    }
  } catch (err) {
    log(`ERROR parsing apps.json: ${err.message}`);
    process.exit(1);
  }
} else {
  log('WARNING: apps.json not found at /tmp/apps.json. Skipping dynamic injections.');
}

log('Credential injection complete.');

// ---------------------------------------------------------------------------
// POST-REPLACEMENT VERIFICATION
// Fail fast if any placeholder of the form __UPPER_SNAKE_CASE__ remains.
// This converts the silent "URL does not seem to be valid" failure into a
// loud, actionable error at container startup.
// ---------------------------------------------------------------------------

log('STEP 4.5: Verifying no placeholders remain in cruise-config.xml...');
const finalConfigContent = fs.readFileSync(CRUISE_CONFIG, 'utf8');
const leftoverPlaceholders = finalConfigContent.match(/__[A-Z][A-Z0-9_]*__/g);
if (leftoverPlaceholders) {
  const unique = [...new Set(leftoverPlaceholders)];
  log(`ERROR: ${unique.length} unreplaced placeholder(s) remain in cruise-config.xml:`);
  unique.forEach(p => log(`  - ${p}`));
  log('These must be either:');
  log('  (a) defined in apps.json with a matching `placeholder` field,');
  log('  (b) replaced explicitly in entrypoint.js, or');
  log('  (c) removed from cruise-config.xml if no longer needed.');
  process.exit(1);
}
log('All placeholders successfully replaced.');

// ---------------------------------------------------------------------------
// PASSWORD CONFIGURATION
// ---------------------------------------------------------------------------

log('STEP 5: Configuring admin password...');
const GOCD_ADMIN_PASSWORD = process.env.GOCD_ADMIN_PASSWORD ? clean(process.env.GOCD_ADMIN_PASSWORD) : '';

if (GOCD_ADMIN_PASSWORD) {
  log('Hashing and writing admin password...');
  const htpasswd = sh(`htpasswd -nbB admin "${GOCD_ADMIN_PASSWORD}"`);
  const hashed   = htpasswd.replace(/^admin:/, '');
  fs.writeFileSync('/godata/config/password.properties', `admin=${hashed}\n`);
  log('Admin password file created/updated.');
} else {
  log('WARNING: GOCD_ADMIN_PASSWORD not set. Using default password.');
}

// ---------------------------------------------------------------------------
// FIX PERMISSIONS
// ---------------------------------------------------------------------------

log('STEP 6: Fixing permissions on /godata volume...');
sh('chown -R 1000:1000 /godata');
log('Permissions set.');

// ---------------------------------------------------------------------------
// HAND OFF TO GOCD
// ---------------------------------------------------------------------------

log('STEP 7: Handing off to GoCD via gosu...');
const args   = process.argv.slice(2);
const result = spawnSync('gosu', ['go', '/docker-entrypoint.sh', ...args], { stdio: 'inherit' });

log(`gosu exited with code: ${result.status}`);
process.exit(result.status ?? 0);