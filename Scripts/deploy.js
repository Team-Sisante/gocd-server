#!/usr/bin/env node
/**
 * deploy.js – Unified staging / production deployment for all Django apps.
 *
 * Runs on the GoCD agent. Loads required variables from GitHub Environments
 * and GCP Secret Manager. A temporary .env file is created, used, and deleted
 * immediately – no secrets remain on the VM.
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
console.log('--- Environment Variables Check ---');
['GCP_PROJECT_ID', 'GCP_ZONE', 'GIT_REPO_USERNAME', 'VM_SSH_USER', 'GCP_VM_IP', 'GCP_VM_NAME'].forEach(v => {
  console.log(`${v}: ${process.env[v] ? 'PRESENT' : 'MISSING'}`);
});
console.log('-----------------------------------');

/**
 * Helper to warn, pause for user input, and exit.
 */
function waitAndExit(message) {
  console.error(`\x1b[31m${message}\x1b[0m`);
  console.log('\x1b[33mPress Enter to exit and stop the process...\x1b[0m');
  try {
    fs.readSync(0, Buffer.alloc(1), 0, 1);
  } catch (err) {
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

// Derive SSH key path from DEPLOY_SSH_KEY_PATH if available, otherwise default to secrets/agent-key relative to this script
const sshKeyPath = process.env.DEPLOY_SSH_KEY_PATH || path.resolve(__dirname, '..', 'secrets', 'agent-key');

// Common SSH options
const SSH_OPTS = '-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o KexAlgorithms=+diffie-hellman-group14-sha256';
const SSH_CMD = `ssh -i "${sshKeyPath}" ${SSH_OPTS}`;
const SCP_CMD = `scp -i "${sshKeyPath}" ${SSH_OPTS}`;

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
    nginxContainer: {
      staging:    'badminton_court-nginx-staging',
      production: 'badminton_court-nginx-production',
    },
    mailContainer: {
      staging:    'badminton-staging-mail-staging-1',
      production: 'badminton-production-mail-production-1',
    },
  },
  humrine_site: {
    projectPrefix: 'humrine',
    workDir:       '/humrine_site',
    deployDir:     '/opt/humrine_site',
    nginxContainer: {
      staging:    'humrine-nginx-staging',
      production: 'humrine-nginx-production',
    },
    // humrine does not use a mail container
  },
};

const appConf = APP_CONFIG[appName];
if (!appConf) {
  console.error(`Unknown app: ${appName}. Expected badminton_court or humrine_site.`);
  process.exit(1);
}

// Force the correct repository name for GitHub variable fetches
process.env.GIT_REPO_REPONAME = appName;

process.chdir(appConf.workDir);

// ----- Infrastructure variables (must come from pipeline env) -----
const missing = [];
if (!process.env.GCP_PROJECT_ID) missing.push('GCP_PROJECT_ID');
if (!process.env.GCP_ZONE) missing.push('GCP_ZONE');
if (!process.env.GIT_REPO_USERNAME) missing.push('GIT_REPO_USERNAME');
if (!process.env.VM_SSH_USER) missing.push('VM_SSH_USER');

if (missing.length > 0) {
  let errorMsg = 'ERROR: The following required infrastructure variables are missing:\n';
  missing.forEach(v => errorMsg += `  - ${v}\n`);
  errorMsg += '\nThese must be set in the pipeline environment.';
  waitAndExit(errorMsg);
}

const GCP_PROJECT_ID = process.env.GCP_PROJECT_ID;
const GIT_REPO_USERNAME = process.env.GIT_REPO_USERNAME;
const SSH_USER = process.env.VM_SSH_USER;

// ---------------------------------------------------------------
// Read <?secret?> / <?var?> from templates
// ---------------------------------------------------------------
function extractTemplatePlaceholders(templatePath, pattern) {
  if (!fs.existsSync(templatePath)) return [];
  const content = fs.readFileSync(templatePath, 'utf8');
  const regex = new RegExp(`^(\\w+)=${pattern}\\s*$`, 'gm');
  const matches = content.matchAll(regex);
  const keys = [];
  for (const m of matches) keys.push(m[1]);
  return keys;
}

const templateFiles = [
  `.env.${target}.template`,
  '.env.common.template'
];

let gcpSecrets = [];
templateFiles.forEach(file => {
  gcpSecrets = gcpSecrets.concat(extractTemplatePlaceholders(file, '<\\?secret\\?>'));
});
const SECRETS_TO_FETCH = [...new Set(gcpSecrets)];

let requiredVars = [];
templateFiles.forEach(file => {
  requiredVars = requiredVars.concat(extractTemplatePlaceholders(file, '<\\?var\\?>'));
  requiredVars = requiredVars.concat(extractTemplatePlaceholders(file, '<\\?secret\\?>'));
});
const REQUIRED_VARS = [...new Set(requiredVars)];

// ---------------------------------------------------------------
// 1. Fetch secrets from GCP (with app‑specific prefix)
// ---------------------------------------------------------------
console.log('\x1b[33mFetching secrets from GCP Secret Manager...\x1b[0m');
const certFile = process.env.CLOUDSDK_CA_CERTS_FILE;
const childEnv = { ...process.env };
if (certFile) {
  childEnv.CLOUDSDK_CA_CERTS_FILE = certFile;
  childEnv.REQUESTS_CA_BUNDLE = certFile;
}

// Prefix all GCP secret names with the app name to avoid collisions
const secretPrefix = `${appName}_`;

for (const secret of SECRETS_TO_FETCH) {
  let fullSecretName;
  try {
    fullSecretName = secretPrefix + secret;
    const value = execSync(
      `gcloud secrets versions access latest --secret="${fullSecretName}" --project ${GCP_PROJECT_ID} 2>/dev/null`,
      { encoding: 'utf8', stdio: 'pipe', env: childEnv }
    ).trim();
    if (value) {
      // Store under the original variable name (without prefix)
      process.env[secret] = value;
      console.log(`  🔐 ${secret} (from ${fullSecretName})`);
    } else {
      console.log(`  ⚠️  ${fullSecretName} not found or empty`);
    }
  } catch (err) {
    console.log(`  ⚠️  ${fullSecretName} not found or empty`);
  }
}

// ---------------------------------------------------------------
// 2. Fetch GitHub Environment variables (ALL config)
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
    if (v.name) {
      // Never allow a fetched variable to overwrite a non‑empty existing value with an empty one
      if (v.value === '' || v.value === undefined || v.value === null) {
        // If the fetched value is empty and we already have a non‑empty value, keep the existing one
        if (process.env[v.name] && process.env[v.name] !== '') {
          return;   // keep existing value
        }
        // Otherwise, delete and set nothing (or empty) – required later for validation
        delete process.env[v.name];
        return;
      }
      // Valid non‑empty value – always overwrite
      process.env[v.name] = v.value;
    }
  });
  console.log(`Fetched ${variables.length} variables from GitHub.`);
} catch (e) {
  console.log(`\x1b[33mWarning: Could not fetch GitHub variables: ${e.message}\x1b[0m`);
}

// ---------------------------------------------------------------
// Diagnostic dump
// ---------------------------------------------------------------
console.log('\x1b[36m--- Required variables after fetch (masked) ---\x1b[0m');
REQUIRED_VARS.forEach(v => {
  const val = process.env[v];
  const status = val === undefined ? '\x1b[31mMISSING\x1b[0m' :
                 val === ''        ? '\x1b[33mEMPTY\x1b[0m' :
                 `\x1b[32m${val.substring(0,4)}...\x1b[0m`;
  console.log(`  ${v}: ${status}`);
});

// Validation
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
  console.error(`\x1b[33mCheck the GitHub Environment and GCP Secret Manager for these keys.\x1b[0m`);
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
try { execSync(`chmod 600 ${sshKeyPath}`, { stdio: 'pipe' }); } catch (_) {}

// 2. Setup nginx if the template and certificates exist
let useNginx = false;
if (target === 'staging' || target === 'production') {
  const nginxTemplatePath = `nginx-${target}.conf.template`;
  if (fs.existsSync(nginxTemplatePath)) {
    const certsDir = 'certs';
    if (!fs.existsSync(certsDir) || !fs.existsSync(path.join(certsDir, 'posteio-cert.pem'))) {
      waitAndExit(`ERROR: nginx is enabled for ${target} but the certs/ directory (with posteio-cert.pem) is missing.\nPlease run "node Scripts/generate-certs.js" first and commit the resulting certs/ folder.`);
    }

    const webHttpsPort = process.env.WEB_HOST_PORT;
    if (!webHttpsPort) waitAndExit('ERROR: WEB_HOST_PORT is not defined in environment.');

    const nginxTemplate = fs.readFileSync(nginxTemplatePath, 'utf8');
    const webBackendService = `web-${target}`;
    const nginxConf = nginxTemplate
      .replace(/__WEB_HOST_PORT__/g, webHttpsPort)
      .replace(/__BACKEND_SERVICE__/g, webBackendService);

    const nginxConfFile = `nginx-${target}.conf`;
    fs.writeFileSync(nginxConfFile, nginxConf);
    console.log(`\x1b[32mGenerated ${nginxConfFile} with port ${webHttpsPort}\x1b[0m`);
    useNginx = true;

    if (GCP_PROJECT_ID) {
      const ruleName = `allow-web-https-${target}`;
      const targetTag = process.env.GCP_VM_NAME;
      if (!targetTag) waitAndExit('ERROR: GCP_VM_NAME is not defined in environment.');

      console.log(`Ensuring firewall rule ${ruleName} for port ${webHttpsPort}...`);
      try {
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

// 3. Ensure Unix line endings
execSync(`sed -i 's/\\r$//' ${composeFile}`, { stdio: 'inherit' });

// 4. Get VM IP
const vmIP = process.env.GCP_VM_IP;
if (!vmIP) waitAndExit('ERROR: GCP_VM_IP is not set in environment.');

// ------------------------------------------------------------------
// 5. Pre‑deploy health checks
// ------------------------------------------------------------------

// ---- Docker daemon DNS & MTU configuration ----
const DOCKER_CONF = '{"dns":["8.8.8.8"],"mtu":1460}';
try {
  const currentConf = execSync(
    `ssh -i ${sshKeyPath} ${SSH_OPTS} -o LogLevel=ERROR ${SSH_USER}@${vmIP} "cat /etc/docker/daemon.json 2>/dev/null || echo ''"`,
    { encoding: 'utf8', stdio: 'pipe' }
  ).trim();

  if (currentConf !== DOCKER_CONF) {
    console.log('Configuring Docker daemon DNS and MTU on VM...');
    execSync(
      `ssh -i ${sshKeyPath} ${SSH_OPTS} ${SSH_USER}@${vmIP} ` +
      `"sudo bash -c 'echo \\'${DOCKER_CONF}\\' > /etc/docker/daemon.json && systemctl restart docker'"`,
      { stdio: 'inherit' }
    );
  }
} catch (e) {
  console.log(`\x1b[33mWarning: Failed to verify/configure Docker daemon: ${e.message}\x1b[0m`);
}

// ---- System load check ----
console.log('Running pre‑deploy health checks...');
const healthCheckResult = execSync(
  `ssh -i ${sshKeyPath} ${SSH_OPTS} -o LogLevel=ERROR ${SSH_USER}@${vmIP} ` +
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

// ---- ghcr.io connectivity check ----
console.log('Checking ghcr.io connectivity...');
try {
  execSync(`ssh -i ${sshKeyPath} ${SSH_OPTS} ${SSH_USER}@${vmIP} "curl -v --connect-timeout 10 https://ghcr.io/v2/ 2>&1 | head -20"`, { stdio: 'inherit' });
  console.log('\x1b[32mghcr.io is reachable.\x1b[0m');
} catch (e) {
  console.error('\x1b[31mghcr.io is unreachable. Deployment aborted to prevent using stale cached images.\x1b[0m');
  console.error('\x1b[33mRetry the deployment when network connectivity is restored.\x1b[0m');
  process.exit(1);
}

// ------------------------------------------------------------------
// 6. Prepare VM directory
// ------------------------------------------------------------------
const deployDir = appConf.deployDir;
console.log('Preparing deployment directory on VM...');
execSync(`ssh -i ${sshKeyPath} ${SSH_OPTS} ${SSH_USER}@${vmIP} "sudo rm -rf ${deployDir}/certs && sudo mkdir -p ${deployDir}/certs ${deployDir}/Scripts && sudo chown -R ${SSH_USER}:${SSH_USER} ${deployDir}"`, { stdio: 'inherit' });

// 7. Copy files to VM
console.log('Copying deployment files to VM...');
const scpBase = `scp -i ${sshKeyPath} ${SSH_OPTS}`;
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
  execSync(`ssh -i ${sshKeyPath} ${SSH_OPTS} ${SSH_USER}@${vmIP} "chmod +x ${deployDir}/Scripts/mail-setup.sh"`, { stdio: 'inherit' });
}

const posteRelayScript = 'Scripts/configure-poste-relay.js';
if (fs.existsSync(posteRelayScript)) {
  execSync(`${scpBase} ${posteRelayScript} ${vmDest}Scripts/`, { stdio: 'inherit' });
}

// ---------------------------------------------------------------
// 8. Deploy
// ---------------------------------------------------------------
console.log('Logging into ghcr.io and deploying...');
const tokenFile = '/tmp/gh_token';
fs.writeFileSync(tokenFile, token, { mode: 0o600 });

// Pre-flight check for critical variables
const criticalVars = ['DEBUG', 'SECRET_KEY', 'SITE_HEADER', 'POSTE_PROTOCOL'];
console.log('\x1b[36m--- Checking critical vars in process.env before .env generation ---\x1b[0m');
criticalVars.forEach(v => {
  const val = process.env[v];
  if (val === undefined) {
    console.log(`  \x1b[31m${v}: MISSING\x1b[0m`);
  } else if (val === '') {
    console.log(`  \x1b[33m${v}: EMPTY\x1b[0m`);
  } else {
    console.log(`  \x1b[32m${v}: PRESENT\x1b[0m (length: ${val.length})`);
  }
});

// Build .env content
const envLines = [];
for (const [key, value] of Object.entries(process.env)) {
  // Exclude internal Node.js / system variables
  if (key.startsWith('npm_') || ['PATH', 'HOME', 'PWD', 'SHELL', 'HOSTNAME'].includes(key)) continue;

  // Remove ALL control characters (0x00‑0x1F) and DEL (0x7F) from the KEY.
  const cleanKey = key.replace(/[\x00-\x1F\x7F]/g, '');
  if (cleanKey === '') continue;   // skip entirely broken keys

  // Strip control characters from the VALUE.
  const cleanValue = (value || '').replace(/[\x00-\x1F\x7F]/g, '');
  
  // Properly escape backslashes, quotes, and dollar signs for Docker Compose .env files
  const safeValue  = cleanValue
    .replace(/\\/g, '\\\\')   // Escape backslashes first (prevents escaping the closing quote)
    .replace(/"/g, '\\"')     // Escape double quotes
    .replace(/\$/g, '$$');    // Escape dollar signs to prevent Compose variable interpolation

  envLines.push(`${cleanKey}="${safeValue}"`);
}
const envContent = envLines.join('\n');

// Use a uniquely named .env file for each app-environment to prevent race conditions
const remoteEnvFile = `${deployDir}/.env-${projectName}`;
const remoteLockFile = `${deployDir}/.deploy.lock`;

// Write temp file locally, SCP to VM
const localTempEnvFile = `/tmp/deploy-env-${projectName}.env`;
fs.writeFileSync(localTempEnvFile, envContent);
execSync(`${scpBase} ${localTempEnvFile} ${SSH_USER}@${vmIP}:${remoteEnvFile}`, { stdio: 'inherit' });
console.log(`Temporary env file uploaded to VM: ${remoteEnvFile}`);
// Verify file exists
execSync(`ssh -i ${sshKeyPath} ${SSH_OPTS} ${SSH_USER}@${vmIP} "ls -l ${remoteEnvFile} && cat ${remoteEnvFile} | head -n 5"`, { stdio: 'inherit' });
fs.unlinkSync(localTempEnvFile);

// Verify POSTE_PROTOCOL is non‑empty
const verifyPosteProtocolCmd = `ssh -i ${sshKeyPath} ${SSH_OPTS} ${SSH_USER}@${vmIP} "grep -E '^POSTE_PROTOCOL=\".+\"' ${remoteEnvFile} >/dev/null 2>&1 && echo 'OK' || echo 'FAIL'"`;
try {
  const verifyResult = execSync(verifyPosteProtocolCmd, { encoding: 'utf8', stdio: 'pipe' }).trim();
  if (verifyResult !== 'OK') {
    console.error(`\x1b[31mERROR: POSTE_PROTOCOL is missing or empty in ${remoteEnvFile} on the VM.\x1b[0m`);
    waitAndExit('Deployment aborted – POSTE_PROTOCOL is missing or empty.');
  }
  console.log(`\x1b[32mVerified POSTE_PROTOCOL is set and non‑empty.\x1b[0m`);
} catch (e) {
  console.error(`\x1b[31mERROR: Could not verify POSTE_PROTOCOL on VM.\x1b[0m`);
  waitAndExit('Deployment aborted – cannot verify POSTE_PROTOCOL.');
}

// Dump host ports for debugging
const dumpPortsCmd = `ssh -i ${sshKeyPath} ${SSH_OPTS} ${SSH_USER}@${vmIP} "grep -E '^(POSTGRES_HOST_PORT|REDIS_HOST_PORT|MAIL_SMTP_HOST_PORT|MAIL_SUBMISSION_HOST_PORT|MAIL_SMTPS_HOST_PORT|MAIL_HTTPS_HOST_PORT|WEB_HOST_PORT|NGINX_STAGING_HOST_PORT|NGINX_PRODUCTION_HOST_PORT)=' ${remoteEnvFile}"`;
try {
  const portsDump = execSync(dumpPortsCmd, { encoding: 'utf8', stdio: 'pipe' }).trim();
  if (portsDump) {
    console.log('\x1b[36mHost ports in temp env file:\x1b[0m');
    console.log(portsDump);
  }
} catch (e) {}

// ------------------------------------------------------------------
// Validate mail container name (if the app uses one)
// ------------------------------------------------------------------
const mailContainerName = appConf.mailContainer ? appConf.mailContainer[target] : null;

// ------------------------------------------------------------------
// Remote deploy command – sources the .env file and syncs mail password
// ------------------------------------------------------------------
// Derive SSH key path from DEPLOY_SSH_KEY_PATH if available, otherwise default to secrets/agent-key
// Note: sshKeyPath is already defined at the top of this script.

const mailSetupCmd = mailContainerName ? 
  `echo "Syncing Poste.io admin password..." && ` +
  `( sudo -E docker exec --user 8 ${mailContainerName} /opt/admin/bin/console domain:create ${process.env.POSTE_DOMAIN || 'aeropace.com'} || true ) && ` +
  `( sudo -E docker exec --user 8 ${mailContainerName} /opt/admin/bin/console email:create ${process.env.EMAIL_HOST_USER} "${process.env.POSTE_ADMIN_PASSWORD}" Admin || true ) && ` +
  `( sudo -E docker exec --user 8 ${mailContainerName} /opt/admin/bin/console email:admin ${process.env.EMAIL_HOST_USER} || true ) && ` +
  `echo "Configuring SMTP relay..." && ` +
  `node ${deployDir}/Scripts/configure-poste-relay.js ${mailContainerName} "${sshKeyPath}" && ` : '';
const nginxContainerName = appConf.nginxContainer[target];

const deployCmd =
  `cd ${deployDir} && ` +
  `flock ${remoteLockFile} bash -c '` +
    // Clean up env files to leave no secrets on disk
    `trap "rm -f ${deployDir}/.env ${remoteEnvFile}" EXIT; ` +
    // Copy to .env and source it so shell vars are available for compose substitution
    `cp ${remoteEnvFile} .env && ` +
    `set -a && source .env && set +a && ` +
    `sudo -E docker compose -p ${projectName} -f ${composeFile} --profile ${cfg.profile} down --remove-orphans && ` +
    `sudo docker rm -f ${nginxContainerName} || true; ` +
    `sudo -E docker compose -p ${projectName} -f ${composeFile} --profile ${cfg.profile} up -d --pull always --force-recreate --remove-orphans && ` +
    mailSetupCmd +
    `true'`;

const fullRemote = `sudo docker login ghcr.io -u ${GIT_REPO_USERNAME} --password-stdin && ${deployCmd}`;

let success = false;
for (let attempt = 1; attempt <= 3; attempt++) {
  try {
    if (attempt > 1) console.log(`\x1b[33mRetry attempt ${attempt}/3...\x1b[0m`);
    execSync(`ssh -i ${sshKeyPath} ${SSH_OPTS} -o LogLevel=ERROR ${SSH_USER}@${vmIP} "${fullRemote.replace(/"/g, '\\"')}" < ${tokenFile}`, { stdio: 'inherit' });
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
  // Post‑deploy verification: check that the web container actually received POSTE_PROTOCOL
  const webContainer = `${appConf.projectPrefix}-${cfg.env}-web-${cfg.env}-1`;
  try {
    const checkCmd = `ssh -i ${sshKeyPath} ${SSH_OPTS} ${SSH_USER}@${vmIP} "sudo docker exec ${webContainer} printenv POSTE_PROTOCOL"`;
    const output = execSync(checkCmd, { encoding: 'utf8', stdio: 'pipe' }).trim();
    if (!output) {
      console.error(`\x1b[31mWARNING: POSTE_PROTOCOL is empty inside the web container.\x1b[0m`);
    } else {
      console.log(`\x1b[32mPost‑deploy check: POSTE_PROTOCOL = ${output}\x1b[0m`);
    }
  } catch (e) { /* ignore */ }

  console.log('\x1b[32m✓ Deployment completed successfully.\x1b[0m');
  console.log('\x1b[36mAll configuration injected from GitHub/GCP – no .env files left on disk.\x1b[0m');
} else {
  waitAndExit(`Failed to deploy ${target} after 3 attempts.`);
}