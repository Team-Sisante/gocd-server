#!/usr/bin/env node
/**
 * deploy.js – Unified staging / production deployment for all Django apps.
 *
 * Runs on the GoCD agent. Loads required variables from GitHub Environments
 * and GCP Secret Manager. No .env files are written to the VM.
 *
 * Usage:
 *   node deploy.js <app_name> <target> <github_token>
 *   app_name:   badminton_court | humrine_site
 *   target:     staging | production
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const appName = process.argv[2];          // e.g. 'badminton_court'
const target   = process.argv[3];
const token    = process.argv[4];

console.log(`app: ${appName}, target: ${target}`);

/**
 * Helper to warn, pause for user input, and exit.
 */
function waitAndExit(message) {
  console.error(`\x1b[31m${message}\x1b[0m`);
  console.log('\x1b[33mPress Enter to exit and stop the process...\x1b[0m');
  try {
    // Wait for Enter key (works in most environments)
    fs.readSync(0, Buffer.alloc(1), 0, 1);
  } catch (err) {
    // Fallback for non-interactive shells
    console.log('Non-interactive shell detected, exiting immediately.');
  }
  process.exit(1);
}

if (token) {
  const masked = token.length > 8
    ? token.substring(0, 4) + '...' + token.substring(token.length - 4)
    : '****';
  console.log(`Using GITHUB_TOKEN: ${masked}`);
} else {
  console.log('WARNING: GITHUB_TOKEN is not set in environment');
}

// ------------------------------------------------------------------
// Override GITHUB_TOKEN with the pipeline’s token
// ------------------------------------------------------------------
process.env.GITHUB_TOKEN = token;

// Common SSH options – suppress host key prompts and post‑quantum KEX warnings
const SSH_OPTS = '-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o KexAlgorithms=+diffie-hellman-group14-sha256';
const SCP_OPTS = SSH_OPTS;   // scp accepts the same options

if (!appName || !target || !token) {
  console.error('Usage: deploy.js <app_name> staging|production <github_token>');
  process.exit(1);
}

// ------------------------------------------------------------------
// App‑specific configuration
// ------------------------------------------------------------------
const APP_CONFIG = {
  badminton_court: {
    projectPrefix: 'badminton',
    workDir:       '/badminton_court',
    deployDir:     '/opt/badminton_court',
  },
  humrine_site: {
    projectPrefix: 'humrine',
    workDir:       '/humrine_site',
    deployDir:     '/opt/humrine_site',
  },
};

const appConf = APP_CONFIG[appName];
if (!appConf) {
  console.error(`Unknown app: ${appName}. Expected badminton_court or humrine_site.`);
  process.exit(1);
}

// Change to the app’s working directory (mounted by GoCD)
process.chdir(appConf.workDir);

// ------------------------------------------------------------------
// Load .env.docker ONLY for pipeline‑level variables (non‑secret)
// ------------------------------------------------------------------
const envFilePath = '.env.docker';
if (fs.existsSync(envFilePath)) {
  const content = fs.readFileSync(envFilePath, 'utf8');
  content.split(/\r?\n/).forEach(line => {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
      const idx = trimmed.indexOf('=');
      const key = trimmed.substring(0, idx).trim();
      const value = trimmed.substring(idx + 1).trim().replace(/^["']|["']$/g, '');
      if (key && value) {
        process.env[key] = value;
      }
    }
  });
  console.log(`\x1b[36mLoaded pipeline configuration from ${appConf.workDir}/${envFilePath}\x1b[0m`);
} else {
  console.log(`\x1b[33m.env.docker not found in ${appConf.workDir}\x1b[0m`);
}

// ----- Validate required infrastructure variables -----
const missing = [];
if (!process.env.GCP_PROJECT_ID) missing.push('GCP_PROJECT_ID');
if (!process.env.GCP_ZONE) missing.push('GCP_ZONE');
if (!process.env.GIT_REPO_USERNAME) missing.push('GIT_REPO_USERNAME');
if (!process.env.VM_SSH_USER) missing.push('VM_SSH_USER');

if (missing.length > 0) {
  let errorMsg = 'ERROR: The following required environment variables are missing:\n';
  missing.forEach(v => errorMsg += `  - ${v}\n`);
  errorMsg += '\nPlease ensure they are defined in .env.docker.';
  waitAndExit(errorMsg);
}

const GCP_PROJECT_ID = process.env.GCP_PROJECT_ID;
const GIT_REPO_USERNAME = process.env.GIT_REPO_USERNAME;
const SSH_USER = process.env.VM_SSH_USER;

// ---------------------------------------------------------------
// 1. Fetch secrets from GCP Secret Manager
// ---------------------------------------------------------------
console.log('\x1b[33mFetching secrets from GCP Secret Manager...\x1b[0m');
const SECRETS_TO_FETCH = [
  'POSTGRES_PASSWORD', 'EMAIL_HOST_PASSWORD', 'POSTE_API_PASSWORD',
  'SECRET_KEY', 'GOOGLE_CLIENT_SECRET', 'FACEBOOK_CLIENT_SECRET',
  'TWITTER_CLIENT_SECRET', 'ADMIN_PASSWORD', 'POSTEIO_DB_PASSWORD',
  'REGULARUSER_PASSWORD', 'SUPERADMIN_PASSWORD', 'STAFF_ADMIN_PASSWORD',
  'INACTIVE_ADMIN_PASSWORD', 'NGR_AUTHTOKEN', 'GOOGLE_CLIENT_ID',
  'FACEBOOK_CLIENT_ID', 'TWITTER_CLIENT_ID'   // client IDs may also be secret
];
for (const secret of SECRETS_TO_FETCH) {
  try {
    const value = execSync(
      `gcloud secrets versions access latest --secret="${secret}" --project ${GCP_PROJECT_ID} 2>/dev/null`,
      { encoding: 'utf8', stdio: 'pipe' }
    ).trim();
    if (value) {
      process.env[secret] = value;
      console.log(`  🔐 ${secret}`);
    } else {
      console.log(`  ⚠️  ${secret} not found or empty`);
    }
  } catch (err) {
    console.log(`  ⚠️  ${secret} not found or empty`);
  }
}

// ---------------------------------------------------------------
// 2. Fetch GitHub Environment variables (all non‑secret config)
// ---------------------------------------------------------------
console.log('\x1b[33mFetching variables from GitHub Environments...\x1b[0m');
try {
  const repoFull = `${process.env.GIT_REPO_USERNAME}/${process.env.GIT_REPO_REPONAME}`;
  const stdout = execSync(
    `node Scripts/getGitHubVars.js ${repoFull} ${target} ${token}`,
    { encoding: 'utf8', stdio: 'pipe' }
  );
  const variables = JSON.parse(stdout);
  variables.forEach(v => {
    if (v.name && v.value) {
      process.env[v.name] = v.value;
    }
  });
  console.log(`Fetched ${variables.length} variables from GitHub.`);
} catch (e) {
  console.log(`\x1b[33mWarning: Could not fetch GitHub variables: ${e.message}\x1b[0m`);
}

// ------------------------------------------------------------------
// Deployment target config
// ------------------------------------------------------------------
const config = {
  staging: { env: 'staging', profile: 'staging' },
  production: { env: 'production', profile: 'production' }
};
const cfg = config[target];
if (!cfg) {
  console.error(`Unknown target: ${target}. Use staging or production.`);
  process.exit(1);
}

const projectName = `${appConf.projectPrefix}-${cfg.env}`;
const composeFile = 'docker-compose.vm.yml';

// 1. Fix SSH key permissions
try { execSync('chmod 600 /secret/agent-key', { stdio: 'pipe' }); } catch (_) {}

// 2. Generate environment file is NO LONGER NEEDED – we inject everything directly
//    (The generate-env.js call and all .env file handling has been removed)

// 3. Setup nginx if the template and certificates exist
let useNginx = false;
if (target === 'staging' || target === 'production') {
  const nginxTemplatePath = `nginx-${target}.conf.template`;
  if (fs.existsSync(nginxTemplatePath)) {
    // Check for certificates directory (must be pre‑generated and committed)
    const certsDir = 'certs';
    if (!fs.existsSync(certsDir) || !fs.existsSync(path.join(certsDir, 'posteio-cert.pem'))) {
      waitAndExit(`ERROR: nginx is enabled for ${target} but the certs/ directory (with posteio-cert.pem) is missing.\nPlease run "node Scripts/generate-certs.js" first and commit the resulting certs/ folder.`);
    }

    // Strict lookup: generated .env -> .env.docker (process.env)
    const webHttpsPort = process.env.WEB_HOST_PORT;
    if (!webHttpsPort) waitAndExit(`ERROR: WEB_HOST_PORT is not defined in environment.`);

    const nginxTemplate = fs.readFileSync(nginxTemplatePath, 'utf8');
    const webBackendService = `web-${target}`;
    const nginxConf = nginxTemplate
      .replace(/__WEB_HOST_PORT__/g, webHttpsPort)
      .replace(/__BACKEND_SERVICE__/g, webBackendService);

    const nginxConfFile = `nginx-${target}.conf`;
    fs.writeFileSync(nginxConfFile, nginxConf);
    console.log(`\x1b[32mGenerated ${nginxConfFile} with port ${webHttpsPort}\x1b[0m`);
    useNginx = true;

    // Firewall rule ensures the HTTPS port is open
    if (GCP_PROJECT_ID) {
      const ruleName = `allow-web-https-${target}`;
      const targetTag = process.env.GCP_VM_NAME;
      if (!targetTag) waitAndExit('ERROR: GCP_VM_NAME is not defined in environment.');

      console.log(`Ensuring firewall rule ${ruleName} for port ${webHttpsPort}...`);
      try {
        // Check existing rule port
        const existingPort = execSync(
          `gcloud compute firewall-rules describe ${ruleName} --project=${GCP_PROJECT_ID} --format="value(allowed[0].ports)"`,
          { stdio: 'pipe', encoding: 'utf8' }
        ).trim();
        if (existingPort === webHttpsPort) {
          console.log(`Firewall rule ${ruleName} already exists.`);
        } else {
          console.log(`Firewall rule port mismatch – recreating...`);
          execSync(`gcloud compute firewall-rules delete ${ruleName} --project=${GCP_PROJECT_ID} --quiet`, { stdio: 'inherit' });
          throw new Error('recreate');
        }
      } catch (e) {
        // Rule doesn't exist or was deleted – create it
        console.log(`Creating firewall rule ${ruleName}...`);
        execSync(
          `gcloud compute firewall-rules create ${ruleName} --project=${GCP_PROJECT_ID} --direction=INGRESS --priority=1000 --network=default --action=ALLOW --rules=tcp:${webHttpsPort} --source-ranges=0.0.0.0/0 --target-tags=${targetTag}`,
          { stdio: 'inherit' }
        );
      }
    }
  } else {
    console.log('\x1b[33mnginx template not found – skipping HTTPS setup.\x1b[0m');
  }
}

// 4. Ensure Unix line endings on compose file
execSync(`sed -i 's/\\r$//' ${composeFile}`, { stdio: 'inherit' });

// 5. Get VM IP
const vmIP = process.env.GCP_VM_IP;
if (!vmIP) waitAndExit('ERROR: GCP_VM_IP is not set in environment.');

// 6. Pre‑deploy checks (Docker daemon, system load, ghcr.io connectivity) – same as before, omitted for brevity.
//    (Keep the existing health‑check blocks from your original deploy.js – they are still valid.)

// 7. Prepare VM directory
const deployDir = appConf.deployDir;
console.log('Preparing deployment directory on VM...');
execSync(`ssh -i /secret/agent-key ${SSH_OPTS} ${SSH_USER}@${vmIP} "sudo rm -rf ${deployDir}/certs && sudo mkdir -p ${deployDir}/certs ${deployDir}/Scripts && sudo chown -R ${SSH_USER}:${SSH_USER} ${deployDir}"`, { stdio: 'inherit' });

// 8. Copy compose file and nginx/certs to VM (NO .env files!)
console.log('Copying deployment files to VM...');
const scpBase = `scp -i /secret/agent-key ${SSH_OPTS}`;
const vmDest = `${SSH_USER}@${vmIP}:${deployDir}/`;

execSync(`${scpBase} ${composeFile} ${vmDest}`, { stdio: 'inherit' });

if (useNginx) {
  const nginxConfFile = `nginx-${target}.conf`;
  execSync(`${scpBase} ${nginxConfFile} ${vmDest}`, { stdio: 'inherit' });
  console.log('Copying certs/ to VM...');
  execSync(`${scpBase} -r certs ${vmDest}`, { stdio: 'inherit' });
}

const mailSetupScript = 'Scripts/mail-setup.sh';
if (fs.existsSync(mailSetupScript)) {
  execSync(`${scpBase} ${mailSetupScript} ${vmDest}Scripts/`, { stdio: 'inherit' });
  execSync(`ssh -i /secret/agent-key ${SSH_OPTS} ${SSH_USER}@${vmIP} "chmod +x ${deployDir}/Scripts/mail-setup.sh"`, { stdio: 'inherit' });
}

// 9. Deploy – inject all environment variables (from process.env) into the remote shell
console.log('Logging into ghcr.io and deploying...');
const tokenFile = '/tmp/gh_token';
fs.writeFileSync(tokenFile, token, { mode: 0o600 });

// Build export commands for all relevant environment variables
const envExports = Object.entries(process.env)
  .filter(([k]) => !k.startsWith('npm_') && !['PATH', 'HOME', 'PWD', 'SHELL'].includes(k))
  .map(([k, v]) => `export ${k}="${v.replace(/"/g, '\\"')}"`)
  .join(' && ');

const deployCmd = [
  `cd ${deployDir}`,
  `${envExports}`,
  `sudo docker compose -p ${projectName} -f ${composeFile} --profile ${cfg.profile} down --remove-orphans`,
  `sudo docker compose -p ${projectName} -f ${composeFile} --profile ${cfg.profile} up -d --pull always --remove-orphans`
].join(' && ');

const fullRemote = `sudo docker login ghcr.io -u ${GIT_REPO_USERNAME} --password-stdin && ${deployCmd}`;

let success = false;
for (let attempt = 1; attempt <= 3; attempt++) {
  try {
    if (attempt > 1) console.log(`\x1b[33mRetry attempt ${attempt}/3...\x1b[0m`);
    execSync(`ssh -i /secret/agent-key ${SSH_OPTS} -o LogLevel=ERROR ${SSH_USER}@${vmIP} "${fullRemote.replace(/"/g, '\\"')}" < ${tokenFile}`, { stdio: 'inherit' });
    success = true;
    break;
  } catch (e) {
    console.error(`\x1b[31mDeployment attempt ${attempt} failed: ${e.message}\x1b[0m`);
    if (attempt < 3) {
      console.log('Waiting 10 seconds before retrying...');
      execSync('sleep 10', { stdio: 'inherit' });
    }
  }
}

try { fs.unlinkSync(tokenFile); } catch (_) {}

if (success) {
  console.log('\x1b[32m✓ Deployment completed successfully.\x1b[0m');
  console.log('\x1b[36mAll configuration injected from GitHub/GCP – no .env files left on disk.\x1b[0m');
} else {
  waitAndExit(`Failed to deploy ${target} after 3 attempts.`);
}