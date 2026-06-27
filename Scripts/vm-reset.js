#!/usr/bin/env node

/**
 * vm-reset.js – Reset the GCP VM, validate state, update .env files AND GitHub Environments
 *
 * Usage: node vm-reset.js
 *
 * Safety: User confirmation is required before any destructive action.
 * All operations are logged with timestamps and color-coded output.
 *
 * Prerequisites:
 * - gcloud CLI installed and authenticated
 * - GITHUB_TOKEN set in environment (with repo and env write permissions)
 * - GitHub repository owner/name set below
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const readline = require('readline');

// ----- Configuration (read from environment or hardcoded) -----
const VM_NAME = process.env.VM_NAME || 'gocd-deploy-target';
const ZONE = process.env.GCP_ZONE || 'asia-southeast1-b';
const PROJECT = process.env.GCP_PROJECT_ID || 'project-39c0ea08-238b-47b5-915';

const GITHUB_OWNER = process.env.GITHUB_OWNER || 'Team-Sisante';
const GITHUB_REPO = process.env.GITHUB_REPO || 'git-temp';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

const ENVIRONMENTS = ['staging', 'production'];

// ----- Paths -----
const SCRIPT_DIR = __dirname;                     // .../gocd-server/Scripts
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, '..', '..');  // .../repo

const ENV_FILES = [
  'gocd-server/.env.docker',
  'badminton_court/.env.common',
  'badminton_court/.env.common.safe',
  'humrine_site/.env.common',
  'humrine_site/.env.common.safe',
];

// ----- Utility: sleep -----
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ----- Utility: colored logging with timestamps -----
function logInfo(msg) {
  console.log(`\x1b[36m[${new Date().toISOString()}] ℹ️ ${msg}\x1b[0m`);
}
function logSuccess(msg) {
  console.log(`\x1b[32m[${new Date().toISOString()}] ✅ ${msg}\x1b[0m`);
}
function logWarn(msg) {
  console.log(`\x1b[33m[${new Date().toISOString()}] ⚠️ ${msg}\x1b[0m`);
}
function logError(msg) {
  console.log(`\x1b[31m[${new Date().toISOString()}] ❌ ${msg}\x1b[0m`);
}

// ----- Helper: ask for confirmation -----
function askConfirmation(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  return new Promise(resolve => {
    rl.question(`\x1b[33m${question} (yes/no): \x1b[0m`, answer => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'yes');
    });
  });
}

// ----- Helper: run gcloud command with error handling -----
function runGcloud(cmd, options = {}) {
  try {
    const fullCmd = `gcloud ${cmd}`;
    const result = execSync(fullCmd, {
      encoding: 'utf8',
      stdio: options.silent ? 'pipe' : 'inherit',
      ...options
    });
    return { success: true, output: result ? result.trim() : '' };
  } catch (error) {
    return { success: false, error: error.message, output: error.stdout || '' };
  }
}

// ----- Helper: get VM status -----
function getVMStatus() {
  const cmd = `compute instances describe ${VM_NAME} --zone=${ZONE} --project=${PROJECT} --format="value(status)"`;
  const result = runGcloud(cmd, { silent: true });
  if (result.success) {
    return result.output;
  }
  return null;
}

// ----- Helper: get VM external IP -----
function getVMIP() {
  const cmd = `compute instances describe ${VM_NAME} --zone=${ZONE} --project=${PROJECT} --format="value(networkInterfaces[0].accessConfigs[0].natIP)"`;
  const result = runGcloud(cmd, { silent: true });
  if (result.success && result.output) {
    return result.output;
  }
  return null;
}

// ----- Helper: reset VM -----
function resetVM() {
  const cmd = `compute instances reset ${VM_NAME} --zone=${ZONE} --project=${PROJECT}`;
  const result = runGcloud(cmd);
  if (result.success) {
    return true;
  }
  logError(`Failed to reset VM: ${result.error}`);
  return false;
}

// ----- Helper: update a single .env file (with backup) -----
function updateEnvFile(filePath, newIP) {
  const fullPath = path.join(PROJECT_ROOT, filePath);
  if (!fs.existsSync(fullPath)) {
    logWarn(`File ${filePath} not found, skipping.`);
    return { updated: false, reason: 'File not found' };
  }

  // Read file
  let content;
  try {
    content = fs.readFileSync(fullPath, 'utf8');
  } catch (err) {
    logError(`Failed to read ${filePath}: ${err.message}`);
    return { updated: false, reason: err.message };
  }

  // Check if GCP_VM_IP already has the correct value
  const currentMatch = content.match(/^GCP_VM_IP=(.*)$/m);
  if (currentMatch && currentMatch[1] === newIP) {
    logInfo(`GCP_VM_IP already set to ${newIP} in ${filePath}, skipping.`);
    return { updated: false, reason: 'Already correct' };
  }

  // Create backup
  const backupPath = fullPath + '.bak';
  try {
    fs.writeFileSync(backupPath, content, 'utf8');
  } catch (err) {
    logError(`Failed to create backup for ${filePath}: ${err.message}`);
    return { updated: false, reason: err.message };
  }

  // Update content
  const regex = /^GCP_VM_IP=.*$/m;
  const newLine = `GCP_VM_IP=${newIP}`;
  let newContent;
  if (regex.test(content)) {
    newContent = content.replace(regex, newLine);
  } else {
    newContent = content + `\n${newLine}`;
  }

  // Write file
  try {
    fs.writeFileSync(fullPath, newContent, 'utf8');
    logSuccess(`Updated ${filePath} (backup saved as ${filePath}.bak)`);
    return { updated: true, reason: 'Updated' };
  } catch (err) {
    logError(`Failed to write ${filePath}: ${err.message}`);
    // Restore backup? Not necessary, but we could.
    return { updated: false, reason: err.message };
  }
}

// ----- Helper: update GitHub Environment variable (create if missing) -----
async function updateGitHubEnv(environment, ip) {
  if (!GITHUB_TOKEN) {
    logError('GITHUB_TOKEN not set. Skipping GitHub updates.');
    return false;
  }

  const baseUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/environments/${environment}/variables`;
  
  // Check if variable exists
  const checkUrl = `${baseUrl}/GCP_VM_IP`;
  const checkOptions = {
    hostname: 'api.github.com',
    path: checkUrl,
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'node-script',
    },
  };

  let exists = false;
  try {
    const checkResult = await new Promise((resolve) => {
      const req = https.request(checkOptions, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode === 200) {
            resolve({ success: true, exists: true });
          } else {
            resolve({ success: true, exists: false });
          }
        });
      });
      req.on('error', () => resolve({ success: false }));
      req.end();
    });
    if (checkResult.success) {
      exists = checkResult.exists;
    } else {
      logError(`Failed to check existence of GCP_VM_IP in ${environment} environment.`);
      return false;
    }
  } catch (err) {
    logError(`GitHub API error: ${err.message}`);
    return false;
  }

  const method = exists ? 'PATCH' : 'POST';
  const url = exists ? `${baseUrl}/GCP_VM_IP` : baseUrl;
  const data = exists
    ? JSON.stringify({ value: ip })
    : JSON.stringify({ name: 'GCP_VM_IP', value: ip });

  const options = {
    hostname: 'api.github.com',
    path: url,
    method: method,
    headers: {
      'Authorization': `Bearer ${GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'Content-Length': data.length,
      'User-Agent': 'node-script',
    },
  };

  try {
    const result = await new Promise((resolve) => {
      const req = https.request(options, (res) => {
        let responseBody = '';
        res.on('data', (chunk) => { responseBody += chunk; });
        res.on('end', () => {
          if (res.statusCode === 204 || res.statusCode === 200 || res.statusCode === 201) {
            resolve({ success: true });
          } else {
            resolve({ success: false, status: res.statusCode, body: responseBody });
          }
        });
      });
      req.on('error', (error) => resolve({ success: false, error: error.message }));
      req.write(data);
      req.end();
    });

    if (result.success) {
      logSuccess(`GitHub Environment '${environment}' updated to ${ip}`);
      return true;
    } else {
      logError(`Failed to update GitHub Environment '${environment}'. Status: ${result.status || 'unknown'}`);
      if (result.body) logError(result.body);
      return false;
    }
  } catch (err) {
    logError(`GitHub API error for ${environment}: ${err.message}`);
    return false;
  }
}

// ----- Main logic -----
async function main() {
  logInfo('Starting VM reset process...');

  // 1. Validate gcloud is available
  const gcloudCheck = runGcloud('--version', { silent: true });
  if (!gcloudCheck.success) {
    logError('gcloud CLI not found or not working. Please install and authenticate.');
    process.exit(1);
  }

  // 2. Check current VM status
  const currentStatus = getVMStatus();
  if (!currentStatus) {
    logError('Could not retrieve VM status. Check project, zone, and VM name.');
    process.exit(1);
  }
  logInfo(`Current VM status: ${currentStatus}`);

  // 3. Check current IP
  const currentIP = getVMIP();
  if (currentIP) {
    logInfo(`Current VM IP: ${currentIP}`);
  } else {
    logWarn('Could not retrieve current VM IP. It may be unavailable.');
  }

  // 4. Ask for confirmation (destructive action)
  const confirmed = await askConfirmation(`\n⚠️  You are about to RESET the VM "${VM_NAME}" in zone "${ZONE}". This will force a hard reboot. Are you sure you want to continue?`);
  if (!confirmed) {
    logInfo('Aborted by user.');
    process.exit(0);
  }

  // 5. Reset the VM
  logInfo(`Resetting VM ${VM_NAME}...`);
  if (!resetVM()) {
    logError('VM reset failed. Exiting.');
    process.exit(1);
  }
  logSuccess('VM reset command sent.');

  // 6. Wait for VM to start (with retries)
  logInfo('Waiting for VM to come back online...');
  let status = null;
  let attempts = 0;
  const maxAttempts = 12; // 12 * 10s = 2 minutes
  while (attempts < maxAttempts) {
    await sleep(10000);
    status = getVMStatus();
    attempts++;
    if (status === 'RUNNING') {
      break;
    }
    logInfo(`Waiting... VM status: ${status || 'unknown'} (attempt ${attempts}/${maxAttempts})`);
  }

  if (status !== 'RUNNING') {
    logError(`VM did not become RUNNING after ${maxAttempts * 10} seconds. Current status: ${status}. Please check manually.`);
    process.exit(1);
  }
  logSuccess('VM is RUNNING.');

  // 7. Get new IP address
  await sleep(5000); // extra delay for network interfaces
  const newIP = getVMIP();
  if (!newIP) {
    logError('Could not retrieve new VM IP address. Exiting.');
    process.exit(1);
  }
  logSuccess(`New VM IP: ${newIP}`);

  // 8. Compare IP with current IP and decide if updates are needed
  if (currentIP === newIP) {
    logInfo('IP address unchanged. No updates needed.');
    process.exit(0);
  }

  // 9. Update .env files
  logInfo('Updating local .env files...');
  let updatedCount = 0;
  for (const file of ENV_FILES) {
    const result = updateEnvFile(file, newIP);
    if (result.updated) {
      updatedCount++;
    }
  }
  logInfo(`Updated ${updatedCount} .env files.`);

  // 10. Update GitHub Environments
  if (GITHUB_TOKEN) {
    logInfo('Updating GitHub Environments...');
    for (const env of ENVIRONMENTS) {
      await updateGitHubEnv(env, newIP);
    }
  } else {
    logWarn('GITHUB_TOKEN not set. Skipping GitHub Environment updates.');
  }

  logSuccess('VM reset and configuration update completed successfully.');
  logInfo(`New IP: ${newIP}. Please update any DNS or firewall rules if necessary.`);
}

// ----- Run -----
main().catch(err => {
  logError(`Unexpected error: ${err.message}`);
  console.error(err);
  process.exit(1);
});