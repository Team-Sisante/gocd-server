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
  let errorMsg = 'ERROR: The following required infrastructure variables are missing:\n';
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
  'INACTIVE_ADMIN_PASSWORD', 'NGR_AUTHTOKEN'
];
// --- Ensure gcloud can find the CA bundle (same logic as generate-env.js) ---
const certFile = process.env.CLOUDSDK_CA_CERTS_FILE;
const childEnv = { ...process.env };
if (certFile) {
  childEnv.CLOUDSDK_CA_CERTS_FILE = certFile;
  childEnv.REQUESTS_CA_BUNDLE = certFile;
}

for (const secret of SECRETS_TO_FETCH) {
  try {
    const value = execSync(
      `gcloud secrets versions access latest --secret="${secret}" --project ${GCP_PROJECT_ID} 2>/dev/null`,
      { encoding: 'utf8', stdio: 'pipe', env: childEnv }   // <-- env added
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

// ---------------------------------------------------------------
// Diagnostic dump of required variables (masked for safety)
// ---------------------------------------------------------------
console.log('\x1b[36m--- Required variables after fetch (masked) ---\x1b[0m');
const REQUIRED_VARS = [
  'SECRET_KEY', 'POSTGRES_PASSWORD', 'EMAIL_HOST_PASSWORD',
  'POSTE_API_PASSWORD', 'ADMIN_PASSWORD', 'POSTEIO_DB_PASSWORD',
  'POSTE_PROTOCOL', 'POSTE_HOSTNAME', 'POSTE_PORT', 'POSTE_API_USER',
  'POSTE_DOMAIN', 'POSTEIO_DB_HOST', 'POSTEIO_DB_PORT', 'POSTEIO_DB_NAME',
  'POSTEIO_DB_USER', 'WEB_HOST_PORT', 'WEB_HTTPS_PORT',
  'NGINX_STAGING_HOST_PORT', 'NGINX_PRODUCTION_HOST_PORT', 'POSTGRES_HOST_PORT',
  'REDIS_HOST_PORT', 'MAIL_SMTP_HOST_PORT', 'MAIL_SUBMISSION_HOST_PORT',
  'MAIL_SMTPS_HOST_PORT', 'MAIL_HTTPS_HOST_PORT', 'DEBUG', 'ALLOWED_HOSTS',
  'CSRF_TRUSTED_ORIGINS', 'ENVIRONMENT', 'APP_PROTOCOL', 'APP_DOMAIN',
  'APP_PORT', 'DOMAIN_PREFIX', 'POSTGRES_USER', 'POSTGRES_DB',
  'POSTGRES_HOST', 'POSTGRES_PORT', 'REDIS_URL', 'EMAIL_HOST',
  'EMAIL_PORT', 'EMAIL_HOST_USER', 'DEFAULT_FROM_EMAIL', 'PROFILE_EDIT_URL',
  'SITE_HEADER', 'SITE_TITLE', 'SITE_INDEX_TITLE', 'GCP_PROJECT_ID',
  'GCP_ZONE', 'GCP_VM_NAME', 'GCP_VM_IP', 'ADMIN_EMAIL', 'SUPPORT_EMAIL',
  'REGULARUSER_EMAIL'
];

REQUIRED_VARS.forEach(v => {
  const val = process.env[v];
  const status = val === undefined ? '\x1b[31mMISSING\x1b[0m' :
                 val === ''        ? '\x1b[33mEMPTY\x1b[0m' :
                 `\x1b[32m${val.substring(0,4)}...\x1b[0m`;
  console.log(`  ${v}: ${status}`);
});

// ---------------------------------------------------------------
// Pre‑deployment validation – ensure every required variable is set AND non‑empty
// ---------------------------------------------------------------
const missingVars = REQUIRED_VARS.filter(v => process.env[v] === undefined);
const emptyVars   = REQUIRED_VARS.filter(v => process.env[v] === '');

if (missingVars.length > 0 || emptyVars.length > 0) {
  if (missingVars.length > 0) {
    console.error(`\x1b[31mABORTING: The following required variables are missing:\x1b[0m`);
    missingVars.forEach(v => console.error(`  - ${v}`));
  }
  if (emptyVars.length > 0) {
    console.error(`\x1b[31mABORTING: The following required variables have empty values:\x1b[0m`);
    emptyVars.forEach(v => console.error(`  - ${v}`));
  }
  console.error(`\x1b[33mCheck the GitHub Environment and GCP Secret Manager for these keys and ensure they have real values.\x1b[0m`);
  waitAndExit('Deployment aborted due to missing or empty configuration.');
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

// ------------------------------------------------------------------
// 6. Ensure Docker daemon DNS & MTU are correctly configured (idempotent)
//    Also perform a pre‑deploy health check to avoid TLS timeouts
// ------------------------------------------------------------------
const DOCKER_CONF = '{"dns":["8.8.8.8"],"mtu":1460}';
try {
  const currentConf = execSync(
    `ssh -i /secret/agent-key ${SSH_OPTS} -o LogLevel=ERROR ${SSH_USER}@${vmIP} "cat /etc/docker/daemon.json 2>/dev/null || echo ''"`,
    { encoding: 'utf8', stdio: 'pipe' }
  ).trim();

  if (currentConf !== DOCKER_CONF) {
    console.log('Configuring Docker daemon DNS and MTU on VM...');
    execSync(
      `ssh -i /secret/agent-key ${SSH_OPTS} ${SSH_USER}@${vmIP} ` +
      `"sudo bash -c 'echo \\'${DOCKER_CONF}\\' > /etc/docker/daemon.json && systemctl restart docker'"`,
      { stdio: 'inherit' }
    );
  }
} catch (e) {
  console.log(`\x1b[33mWarning: Failed to verify/configure Docker daemon: ${e.message}\x1b[0m`);
}

// ------------------------------------------------------------------
// Pre‑deploy health check: verify system load
// ------------------------------------------------------------------
console.log('Running pre‑deploy health checks...');
const healthCheckResult = execSync(
  `ssh -i /secret/agent-key ${SSH_OPTS} -o LogLevel=ERROR ${SSH_USER}@${vmIP} ` +
  `"sudo bash -c '` +
    `load=$(awk \"{print \\\\$1}\" /proc/loadavg); ` +
    `echo \"LOAD=\\$load\"'` +
  `"`,
  { encoding: 'utf8', stdio: 'pipe' }
).trim();
console.log(`  VM health: ${healthCheckResult}`);

const loadMatch = healthCheckResult.match(/LOAD=([0-9.]+)/);
const systemLoad = loadMatch ? parseFloat(loadMatch[1]) : 0;

if (systemLoad > 2.0) {
  console.log(`\x1b[33mWarning: System load is ${systemLoad}, which may cause timeouts. Consider stopping heavy processes before deploying.\x1b[0m`);
}
console.log('\x1b[32mPre‑deploy health checks passed.\x1b[0m');

// ------------------------------------------------------------------
// Check ghcr.io connectivity before deployment
// ------------------------------------------------------------------
console.log('Checking ghcr.io connectivity...');
try {
  execSync(`ssh -i /secret/agent-key ${SSH_OPTS} ${SSH_USER}@${vmIP} "curl -v --connect-timeout 10 https://ghcr.io/v2/ 2>&1 | head -20"`, { stdio: 'inherit' });
  console.log('\x1b[32mghcr.io is reachable.\x1b[0m');
} catch (e) {
  console.error('\x1b[31mghcr.io is unreachable. Deployment aborted to prevent using stale cached images.\x1b[0m');
  console.error('\x1b[33mRetry the deployment when network connectivity is restored.\x1b[0m');
  process.exit(1);
}

// ------------------------------------------------------------------
// Prepare VM directory (fix ownership so SCP can create subdirs)
// ------------------------------------------------------------------
const deployDir = appConf.deployDir;
console.log('Preparing deployment directory on VM...');
execSync(`ssh -i /secret/agent-key ${SSH_OPTS} ${SSH_USER}@${vmIP} "sudo rm -rf ${deployDir}/certs && sudo mkdir -p ${deployDir}/certs ${deployDir}/Scripts && sudo chown -R ${SSH_USER}:${SSH_USER} ${deployDir}"`, { stdio: 'inherit' });

// 7. Copy files to VM
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

// 8. Deploy – write a temporary .env file on the VM, use it, then delete it
console.log('Logging into ghcr.io and deploying...');
const tokenFile = '/tmp/gh_token';
fs.writeFileSync(tokenFile, token, { mode: 0o600 });

// Build the content of a single temporary .env file containing all variables
const envLines = [];
for (const [key, value] of Object.entries(process.env)) {
  // Exclude internal Node.js / system variables to keep the file clean
  if (key.startsWith('npm_') || ['PATH', 'HOME', 'PWD', 'SHELL', 'HOSTNAME'].includes(key)) continue;
  const safeValue = value.replace(/"/g, '\\"');
  envLines.push(`${key}="${safeValue}"`);
}
const envContent = envLines.join('\n');

// Write the temp file locally, then copy it to the VM
const localTempEnvFile = `/tmp/deploy-env-${projectName}.env`;
fs.writeFileSync(localTempEnvFile, envContent);
const remoteTempEnvFile = `${deployDir}/.env.tmp`;
execSync(`${scpBase} ${localTempEnvFile} ${SSH_USER}@${vmIP}:${remoteTempEnvFile}`, { stdio: 'inherit' });
console.log('Temporary env file uploaded to VM');

// Verify the uploaded file contains POSTE_PROTOCOL (to catch any write/SCP issues)
const verifyEnvFileCmd = `ssh -i /secret/agent-key ${SSH_OPTS} ${SSH_USER}@${vmIP} "grep -q '^POSTE_PROTOCOL=' ${remoteTempEnvFile} && echo 'POSTE_PROTOCOL present' || echo 'POSTE_PROTOCOL MISSING'"`;
try {
  const verifyResult = execSync(verifyEnvFileCmd, { encoding: 'utf8', stdio: 'pipe' }).trim();
  if (!verifyResult.includes('present')) {
    console.error(`\x1b[31mERROR: POSTE_PROTOCOL is missing from ${remoteTempEnvFile} on the VM.\x1b[0m`);
    console.error(`\x1b[33mThe file may not have been written correctly. Aborting.\x1b[0m`);
    waitAndExit('Deployment aborted – temporary env file is incomplete.');
  }
  console.log(`\x1b[32mVerified POSTE_PROTOCOL in temp env file.\x1b[0m`);
} catch (e) {
  console.error(`\x1b[31mERROR: Could not verify temp env file on VM.\x1b[0m`);
  waitAndExit('Deployment aborted – cannot read temp env file.');
}

// Clean up the local temp file
fs.unlinkSync(localTempEnvFile);

// ---------------------------------------------------------------
// Pre‑deploy cleanup: stop & remove any container using required host ports
// ---------------------------------------------------------------
console.log('Checking for containers holding required host ports...');
const HOST_PORTS = [
  process.env.POSTGRES_HOST_PORT,
  process.env.REDIS_HOST_PORT,
  process.env.MAIL_SMTP_HOST_PORT,
  process.env.MAIL_SUBMISSION_HOST_PORT,
  process.env.MAIL_SMTPS_HOST_PORT,
  process.env.MAIL_HTTPS_HOST_PORT,
  process.env.WEB_HOST_PORT
].filter(Boolean).join(' ');

if (HOST_PORTS) {
  const checkPortsCmd = `for port in ${HOST_PORTS}; do sudo docker ps -q --filter "publish=\\$port" | xargs -r sudo docker stop; done`;
  execSync(`ssh -i /secret/agent-key ${SSH_OPTS} ${SSH_USER}@${vmIP} "${checkPortsCmd}"`, { stdio: 'inherit' });
}

// The remote commands: docker compose with the temp file, then delete the file
const deployCmd = [
  `cd ${deployDir}`,
  `sudo docker compose -p ${projectName} -f ${composeFile} --env-file ${remoteTempEnvFile} --profile ${cfg.profile} down --remove-orphans`,
  `sudo docker compose -p ${projectName} -f ${composeFile} --env-file ${remoteTempEnvFile} --profile ${cfg.profile} up -d --pull always --remove-orphans`,
  `sudo rm -f ${remoteTempEnvFile}`
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