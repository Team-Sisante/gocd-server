#!/usr/bin/env node
/**
 * Scripts/gocd-menu.js
 *
 * Cross-platform GoCD Management Menu.
 * Requires all necessary variables in .env.docker – no defaults.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const os = require('os');
const dotenv = require('dotenv');

// Load environment variables from .env.docker
const envPath = path.join(__dirname, '..', '.env.docker');
dotenv.config({ path: envPath });

// ----- Validate required environment variables -----
const requiredVars = [
  'GOCD_ADMIN_USERNAME',
  'GOCD_ADMIN_PASSWORD',
  'GOCD_SERVER_URL_PROTOCOL',
  'GOCD_SERVER_URL_HOST',
  'GOCD_SERVER_PORT',
  'GCP_PROJECT_ID',
  'GCP_ZONE',
  'GCP_VM_NAME'
];

const missingVars = requiredVars.filter(v => !process.env[v]);

if (missingVars.length > 0) {
  console.error(
    '\x1b[31mERROR: The following required environment variables are missing in .env.docker:\x1b[0m\n' +
    missingVars.map(v => `  - ${v}`).join('\n') +
    '\n\nPlease define them before running this script.'
  );

  process.exit(1);
}

// ----- Configuration from environment -----
const GOCD_USER = process.env.GOCD_ADMIN_USERNAME;
const GOCD_PASS = process.env.GOCD_ADMIN_PASSWORD;

// GoCD base URL
const GOCD_PROTO = process.env.GOCD_SERVER_URL_PROTOCOL;
const GOCD_HOST  = process.env.GOCD_SERVER_URL_HOST;
const GOCD_PORT  = process.env.GOCD_SERVER_PORT;
const GOCD_BASE  = `${GOCD_PROTO}://${GOCD_HOST}:${GOCD_PORT}`;
// Ensure the GoCD server's password file matches GOCD_ADMIN_PASSWORD
try {
  execSync(`docker exec gocd-server sh -c "echo 'admin:${GOCD_PASS}' > /godata/config/password.properties"`, { stdio: 'pipe' });
} catch {}
// GCP VM settings
const GCP_PROJECT_ID = process.env.GCP_PROJECT_ID;
const GCP_ZONE       = process.env.GCP_ZONE;
const GCP_VM_NAME    = process.env.GCP_VM_NAME;

// Optional – not required for menu operation
const SITE_URL = process.env.SITE_URL || '';

const PROJECT_ROOT = path.join(__dirname, '..');
const isWindows = os.platform() === 'win32';

function log(msg, color = '\x1b[36m') {
    console.log(`${color}%s\x1b[0m`, msg);
}

function sh(cmd, options = {}) {
    try {
        return execSync(cmd, {
            cwd: PROJECT_ROOT,
            encoding: 'utf8',
            stdio: options.stdio || 'inherit',
            ...options
        });
    } catch (error) {
        if (!options.silent) {
            console.error('\x1b[31m%s\x1b[0m', `Command failed: ${cmd}`);
        }
        return { success: false, error: error.message };
    }
}

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

function ask(question) {
    return new Promise(resolve => {
        rl.question(`\x1b[33m${question}\x1b[0m`, answer => {
            resolve(answer.trim());
        });
    });
}

async function pause() {
    await ask('Press Enter to continue...');
}

function openUrl(url) {
    let cmd = '';
    if (isWindows) cmd = `start ${url}`;
    else if (os.platform() === 'darwin') cmd = `open ${url}`;
    else cmd = `xdg-open ${url}`;

    try {
        sh(cmd, { stdio: 'ignore' });
    } catch (e) {
        log(`Could not open browser. Manually visit: ${url}`, '\x1b[33m');
    }
}

async function triggerPipelineInteractively() {
  const inquirer = (await import('inquirer')).default;
  const pipelineListUrl = `${GOCD_BASE}/go/api/pipelines`;

  let pipelines;
  try {
    const raw = execSync(
      `docker exec gocd-server curl -s -u "${GOCD_USER}:${GOCD_PASS}" "${pipelineListUrl}"`,
      { encoding: 'utf8', stdio: 'pipe' }
    );
    const data = JSON.parse(raw);
    if (!data._embedded || !data._embedded.pipelines) {
      log('No pipelines found in response.', '\x1b[31m');
      return;
    }
    // Filter for badminton_court_group
    pipelines = data._embedded.pipelines
      .filter(p => p.group === 'badminton_court_group')
      .map(p => p.name);
  } catch (e) {
    log('Could not fetch pipelines. Check the GoCD server and credentials.', '\x1b[31m');
    return;
  }

  if (pipelines.length === 0) {
    log('No pipelines in badminton_court_group.', '\x1b[31m');
    return;
  }

  const { selectedPipeline } = await inquirer.prompt({
    type: 'list',
    name: 'selectedPipeline',
    message: 'Select a pipeline to trigger:',
    choices: pipelines
  });

  sh(`docker exec gocd-server curl -s -u "${GOCD_USER}:${GOCD_PASS}" -H "Confirm: true" -X POST ${GOCD_BASE}/go/api/pipelines/${selectedPipeline}/schedule`);
  log(`Pipeline ${selectedPipeline} triggered.`, '\x1b[32m');
}

async function showMenu() {
    while (true) {
        if (isWindows) { sh('cls'); } else { sh('clear'); }

        console.log('\x1b[32mGoCD Management Menu (.js)\x1b[0m');
        console.log('\x1b[32m===========================\x1b[0m');
        console.log('');
        console.log('\x1b[36m1. CONTAINER MANAGEMENT\x1b[0m');
        console.log('   1.1. Update/Restart GoCD (Fast Build)');
        console.log('   1.2. Get Docker container errors');
        console.log('   1.3. Validate GoCD environment');
        console.log('   1.4. View container logs');
        console.log('   1.5. Stop all containers');
        console.log('   1.6. SYSTEM HARD RESET (Full Wipe via go.js)');
        console.log('');
        console.log('\x1b[36m2. PIPELINE MANAGEMENT\x1b[0m');
        console.log('   2.1. Trigger badminton_court pipeline');
        console.log('   2.2. View pipeline history');
        console.log('   2.3. Unlock pipeline');
        console.log('   2.4. Convert pipelines to SSH');
        console.log('');
        console.log('\x1b[36m3. AGENT MANAGEMENT\x1b[0m');
        console.log('   3.1. View agent status');
        console.log('   3.2. Enable agent');
        console.log('   3.3. Disable agent');
        console.log('');
        console.log('\x1b[36m4. SYSTEM UTILITIES\x1b[0m');
        console.log('   4.1. Encrypt .env files');
        console.log('   4.2. Decrypt .env files');
        console.log('   4.3. Open GoCD web interface');
        console.log('   4.4. View system resources');
        console.log('   4.5. Clean up Docker resources');
        console.log('   4.6. Print Project Folder Structure');
        console.log('   4.7. Sync Master with Feature Branch');
        console.log('   4.8. Fix NODE_OPTIONS error');
        console.log('');
        console.log('\x1b[36m5. TROUBLE-SHOOT CONTAINERS\x1b[0m');
        console.log('   5.1. Rebuild and Re-start gocd-server container');
        console.log('   5.2. Rebuild and Re-start gocd-agent-1 container');
        console.log('   5.3. Rebuild and Re-start gocd-agent-2 container');
        console.log('   5.4. Rebuild and Re-start gocd-agent-3 container');
        console.log('   5.5. View container logs');
        console.log('');
        console.log('\x1b[36m6. GCP VM SETUP\x1b[0m');
        console.log('   6.1. Create deployment VM');
        console.log('   6.2. Configure firewall rules');
        console.log('   6.3. Setup agent SSH keys');
        console.log('   6.4. Setup GCP Secret Manager access for agent');
        console.log('   6.5. Deploy application');
        console.log('   6.6. Monitor VM status');
        console.log('   6.7. Check VM running & reachable');
        console.log('   6.8. Grant agent VM read access (one‑time setup)');
        console.log('');
        console.log('\x1b[36m0. Exit\x1b[0m');
        console.log('');

        const choice = await ask('Select an option: ');

        switch (choice) {
            case '1.1':
                sh('docker compose build && docker compose up -d');
                await pause();
                break;
            case '1.2':
                sh('docker ps -a --filter "status=exited"');
                await pause();
                break;
            case '1.3':
                sh('node Scripts/validate.js');
                await pause();
                break;
            case '1.4':
            case '5.5':
                const containerName = await ask('Enter container name (default: gocd-server): ') || 'gocd-server';
                sh(`docker logs -f --tail 100 ${containerName}`);
                await pause();
                break;
            case '1.5':
                sh('docker compose down');
                await pause();
                break;
            case '1.6':
                const confirmReset = await ask('WARNING: This will wipe ALL Docker data. Are you sure? (y/N): ');
                if (confirmReset.toLowerCase() === 'y') { sh('node Scripts/go.js'); }
                await pause();
                break;

            case '2.1':
                await triggerPipelineInteractively();
                await pause();
                break;

            case '2.2':
                const pipelineToView = await ask('Enter pipeline name (default: badminton_court-artifacts): ') || 'badminton_court-artifacts';
                openUrl(`${GOCD_BASE}/go/pipelines/${pipelineToView}`);
                await pause();
                break;
            case '2.3':
                const pipelineToUnlock = await ask('Enter pipeline name (default: badminton_court-artifacts): ') || 'badminton_court-artifacts';
                sh(`docker exec gocd-server curl -s -u "${GOCD_USER}:${GOCD_PASS}" -H "Confirm: true" -X POST ${GOCD_BASE}/go/api/pipelines/${pipelineToUnlock}/unlock`);
                log(`Pipeline ${pipelineToUnlock} unlock requested.`, '\x1b[32m');
                await pause();
                break;
            case '2.4':
                sh('node Scripts/update-pipelines-ssh.js');
                await pause();
                break;

            case '3.1':
                sh(`docker exec gocd-server curl -s -u "${GOCD_USER}:${GOCD_PASS}" ${GOCD_BASE}/go/api/agents | jq ".[] | {hostname, status, resources}"`);
                await pause();
                break;
            case '3.2':
                const agentToEnable = await ask('Enter agent UUID: ');
                if (agentToEnable) {
                    sh(`docker exec gocd-server curl -s -u "${GOCD_USER}:${GOCD_PASS}" -X PATCH -H "Accept: application/vnd.go.cd.v1+json" -H "Content-Type: application/json" -d "{\\"agent_config_state\\": \\"Enabled\\"}" ${GOCD_BASE}/go/api/agents/${agentToEnable}`);
                    log(`Agent ${agentToEnable} enabled.`, '\x1b[32m');
                }
                await pause();
                break;
            case '3.3':
                const agentToDisable = await ask('Enter agent UUID: ');
                if (agentToDisable) {
                    sh(`docker exec gocd-server curl -s -u "${GOCD_USER}:${GOCD_PASS}" -X PATCH -H "Accept: application/vnd.go.cd.v1+json" -H "Content-Type: application/json" -d "{\\"agent_config_state\\": \\"Disabled\\"}" ${GOCD_BASE}/go/api/agents/${agentToDisable}`);
                    log(`Agent ${agentToDisable} disabled.`, '\x1b[32m');
                }
                await pause();
                break;

            case '4.1':
                sh('node Scripts/encryptenvfiles.js');
                await pause();
                break;
            case '4.2':
                sh('node Scripts/decryptenvfiles.js');
                await pause();
                break;
            case '4.3':
                openUrl(`${GOCD_BASE}/go`);
                await pause();
                break;
            case '4.4':
                sh('docker stats --no-stream');
                await pause();
                break;
            case '4.5':
                sh('docker system prune -f');
                await pause();
                break;
            case '4.6':
                sh('node Scripts/pfs.js');
                await pause();
                break;
            case '4.7':
                const featureBranch = await ask('Enter feature branch name: ');
                if (featureBranch) { sh(`node Scripts/master-feature-git-sync.js ${featureBranch}`); }
                await pause();
                break;
            case '4.8':
                sh('node Scripts/fix-node-options.js');
                await pause();
                break;

            case '5.1':
                sh('docker compose build gocd-server && docker compose up -d gocd-server');
                await pause();
                break;
            case '5.2':
                sh('docker compose build --no-cache gocd-agent-1 && docker compose up -d gocd-agent-1');
                await pause();
                break;
            case '5.3':
                sh('docker compose build --no-cache gocd-agent-2 && docker compose up -d gocd-agent-2');
                await pause();
                break;
            case '5.4':
                sh('docker compose build --no-cache gocd-agent-3 && docker compose up -d gocd-agent-3');
                await pause();
                break;

            // ---- 6. GCP VM SETUP ----
            case '6.1':
                sh('node Scripts/create-deploy-vm.js');
                await pause();
                break;
            case '6.2':
                sh('node Scripts/setup-firewall-rules.js');
                await pause();
                break;
            case '6.3':
                sh('node Scripts/setup-agent-ssh.js');
                await pause();
                break;
            case '6.4':
                sh('node Scripts/setup-gcp-secrets-access.js');
                await pause();
                break;
            case '6.5':
                sh(`docker exec gocd-server curl -s -u "${GOCD_USER}:${GOCD_PASS}" -H "Confirm: true" -X POST ${GOCD_BASE}/go/api/pipelines/badminton_court-artifacts/schedule`);
                log('Pipeline triggered. Staging will start automatically after artifacts succeed.', '\x1b[32m');
                await pause();
                break;
            case '6.6':
                sh(`gcloud compute instances describe ${GCP_VM_NAME} --zone=${GCP_ZONE} --project=${GCP_PROJECT_ID} --format="table[box](name, status, machineType, networkInterfaces[0].accessConfigs[0].natIP)"`);
                await pause();
                break;
            case '6.7':
                sh('node Scripts/check-vm-reachability.js');
                await pause();
                break;
            case '6.8':
                // Grant all required roles for gcloud compute ssh
                const sa = `gocd-agent-secrets@${GCP_PROJECT_ID}.iam.gserviceaccount.com`;
                sh(`gcloud projects add-iam-policy-binding ${GCP_PROJECT_ID} --member="serviceAccount:${sa}" --role="roles/compute.viewer"`);
                sh(`gcloud projects add-iam-policy-binding ${GCP_PROJECT_ID} --member="serviceAccount:${sa}" --role="roles/compute.instanceAdmin.v1"`);
                sh(`gcloud iam service-accounts add-iam-policy-binding 575810712323-compute@developer.gserviceaccount.com --member="serviceAccount:${sa}" --role="roles/iam.serviceAccountUser"`);
                log('Agent granted all required permissions.', '\x1b[32m');
                await pause();
                break;

            case '0':
                rl.close();
                process.exit(0);
            default:
                log('Invalid option.', '\x1b[31m');
                await pause();
                break;
        }
    }
}

showMenu().catch(err => {
    console.error(err);
    rl.close();
    process.exit(1);
});