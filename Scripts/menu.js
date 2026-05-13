#!/usr/bin/env node
/**
 * Scripts/menu.js
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
// Ensure the GoCD server's password file matches GOCD_ADMIN_PASSWORD (fire‑and‑forget)
try {
  require('child_process').spawn('docker', [
    'exec', 'gocd-server', 'sh', '-c',
    `echo 'admin:${GOCD_PASS}' > /godata/config/password.properties`
  ], { stdio: 'ignore', detached: true }).unref();
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
      `docker exec gocd-server curl -s -u "${GOCD_USER}:${GOCD_PASS}" -H "Accept: application/vnd.go.cd.v3+json" "${pipelineListUrl}"`,
      { encoding: 'utf8', stdio: 'pipe' }
    );
    const data = JSON.parse(raw);
    // Log raw response for debugging (you can remove this later)
    // console.log('DEBUG pipelines response:', JSON.stringify(data, null, 2));

    // Try both possible locations of the pipeline list
    let pipelineList = data._embedded?.pipelines || data.pipelines || [];
    if (pipelineList.length === 0) {
      log('No pipelines found in response. Are pipelines configured in GoCD?', '\x1b[31m');
      return;
    }

    // Filter for badminton_court_group (fallback to all if none match)
    pipelines = pipelineList
      .filter(p => p.group === 'badminton_court_group')
      .map(p => p.name);

    if (pipelines.length === 0) {
      log('No pipelines in badminton_court_group. Showing all available:', '\x1b[33m');
      pipelines = pipelineList.map(p => p.name);
      if (pipelines.length === 0) {
        log('No pipelines exist at all.', '\x1b[31m');
        return;
      }
    }
  } catch (e) {
    log('Could not fetch pipelines. Check the GoCD server and credentials.', '\x1b[31m');
    console.error(e);  // show the real error while debugging
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
        process.stdout.write('\x1Bc');

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
        console.log('   6.9. Install Tools on VM (one‑time setup)');
        console.log('   6.10. Export VM settings to YAML');
        console.log('   6.11. Delete VM');
        console.log('   6.12. Create VM from saved YAML');
        console.log('   6.13. Recreate fresh VM (export → delete → create)');
        console.log('   6.14. Run full post‑creation setup (firewall, SSH, secrets, tools, check)'); 
        console.log('   6.15. Show Docker containers on VM (staging/production)');
        console.log('   6.16. View logs of a service on VM');
        console.log('   6.17. Restart a service on VM');
        console.log('   6.18. Open staging app in browser');
        console.log('   6.19. Health check staging app');
        console.log('   6.20. Clear SSH host key for VM');
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
                sh(`gcloud projects add-iam-policy-binding ${GCP_PROJECT_ID} --member="serviceAccount:${sa}" --role="roles/compute.securityAdmin"`);
                sh(`gcloud iam service-accounts add-iam-policy-binding 575810712323-compute@developer.gserviceaccount.com --member="serviceAccount:${sa}" --role="roles/iam.serviceAccountUser"`);
                log('Agent granted all required permissions (including project‑level SSH metadata).', '\x1b[32m');
                await pause();
                break;
            case '6.9':
                // Install tools on VM (one-time setup)
                sh('node Scripts/install-tools-on-vm.js');
                await pause();
                break;
                log('Agent granted all required permissions.', '\x1b[32m');
                await pause();
                break;
            case '6.10':
                const exportPath = await ask('Output filename (default: gocd-deploy-target-config.yaml): ') || 'gocd-deploy-target-config.yaml';
                sh(`gcloud compute instances export ${GCP_VM_NAME} --project=${GCP_PROJECT_ID} --zone=${GCP_ZONE} --destination=${exportPath}`);
                log(`VM settings saved to ${exportPath}`, '\x1b[32m');
                await pause();
                break;
            case '6.11':
                log('WARNING: This will delete the VM and all its data!', '\x1b[31m');
                const confirmDelete = await ask('Are you sure? (y/N): ');
                if (confirmDelete.toLowerCase() === 'y') {
                    sh(`gcloud compute instances delete ${GCP_VM_NAME} --project=${GCP_PROJECT_ID} --zone=${GCP_ZONE} --quiet`);
                    log('VM deleted.', '\x1b[32m');
                }
                await pause();
                break;
            case '6.12': {
                const yamlFile = await ask('YAML config file (default: gocd-deploy-target-config.yaml): ') || 'gocd-deploy-target-config.yaml';
                if (!fs.existsSync(yamlFile)) {
                    log(`File not found: ${yamlFile}`, '\x1b[31m');
                } else {
                    // Check if the VM already exists
                    let vmExists = false;
                    try {
                        execSync(`gcloud compute instances describe ${GCP_VM_NAME} --project=${GCP_PROJECT_ID} --zone=${GCP_ZONE}`, { stdio: 'pipe' });
                        vmExists = true;
                    } catch (_) { /* VM does not exist */ }

                    if (vmExists) {
                        log(`ℹ️  VM "${GCP_VM_NAME}" already exists.`, '\x1b[33m');
                        log('    If it needs configuration, proceed with the setup steps below.', '\x1b[33m');
                        log('    To recreate a fresh VM, delete it first (option 6.11) or use 6.13.', '\x1b[33m');
                    } else {
                        // Read the YAML and build a standard creation command
                        const yaml = fs.readFileSync(yamlFile, 'utf8');

                        // Extract short resource names (last part of the URL after the final slash)
                        const machineType = (yaml.match(/machineType:\s*.*\/([^/\s]+)/) || [])[1] || 'e2-medium';
                        const image       = (yaml.match(/sourceImage:\s*(.+)/) || [])[1]?.trim() || 'projects/debian-cloud/global/images/family/debian-11';
                        const bootDiskSize = (yaml.match(/diskSizeGb:\s*(\d+)/) || [])[1] || '20';
                        const network     = (yaml.match(/network:\s*.*\/([^/\s]+)/) || [])[1] || 'default';
                        const subnetwork  = (yaml.match(/subnetwork:\s*.*\/([^/\s]+)/) || [])[1] || '';
                        const hasExternalIp = yaml.includes('natIP:');
                        const externalIPFlag = hasExternalIp ? '' : '--no-address';

                        let createCmd = `gcloud compute instances create ${GCP_VM_NAME}`;
                        createCmd += ` --project=${GCP_PROJECT_ID}`;
                        createCmd += ` --zone=${GCP_ZONE}`;
                        createCmd += ` --machine-type=${machineType}`;
                        createCmd += ` --image=${image}`;
                        createCmd += ` --boot-disk-size=${bootDiskSize}GB`;
                        createCmd += ` --network=${network}`;
                        if (subnetwork) createCmd += ` --subnet=${subnetwork}`;
                        if (externalIPFlag) createCmd += ` ${externalIPFlag}`;

                        const result = sh(createCmd);
                        if (result && result.success) {
                            log('VM created from saved settings.', '\x1b[32m');
                        } else {
                            // sh() already printed the error; we just add context
                            log('⚠️  VM creation failed. Check the error above.', '\x1b[31m');
                        }
                    }

                    // --- Next steps reminder (shown whether VM existed or was just created) ---
                    log('', '\x1b[36m');
                    log('📋 Recommended next steps for this VM:', '\x1b[33m');
                    log('   6.2  – Configure firewall rules', '\x1b[33m');
                    log('   6.3  – Setup agent SSH keys', '\x1b[33m');
                    log('   6.4  – Setup GCP Secret Manager access', '\x1b[33m');
                    log('   6.9  – Install Tools on VM', '\x1b[33m');
                    log('   6.7  – Check VM reachability', '\x1b[33m');
                    log('', '\x1b[36m');
                    log('💡 Pro tip: Use option 6.14 to run all of them at once.', '\x1b[36m');
                    log('⚠️ Before using option 6.13: The YAML file "gocd-deploy-target-config.yaml" will be overwritten.', '\x1b[33m');
                    log('⚠️ All the existing settings of a fully setup VM will be lost.', '\x1b[33m');

                }
                await pause();
                break;
            }
            case '6.13':
                log('This will: 1) Export settings, 2) Delete VM, 3) Create fresh VM, 4) Run full setup', '\x1b[33m');
                log('⚠️  The YAML file "gocd-deploy-target-config.yaml" will be overwritten.', '\x1b[33m');
                const confirmRecreate = await ask('Proceed? (y/N): ');
                if (confirmRecreate.toLowerCase() === 'y') {
                    const recreateYaml = 'gocd-deploy-target-config.yaml';

                    // Backup the old YAML if it exists
                    if (fs.existsSync(recreateYaml)) {
                        const backupName = recreateYaml.replace('.yaml', `-backup-${Date.now()}.yaml`);
                        fs.copyFileSync(recreateYaml, backupName);
                        log(`📁 Previous config backed up to: ${backupName}`, '\x1b[36m');
                    }

                    // Step 1: Export (overwrites the original)
                    log('Step 1: Exporting VM settings...', '\x1b[33m');
                    sh(`gcloud compute instances export ${GCP_VM_NAME} --project=${GCP_PROJECT_ID} --zone=${GCP_ZONE} --destination=${recreateYaml}`);
                    
                    log('Step 2: Deleting VM...', '\x1b[33m');
                    sh(`gcloud compute instances delete ${GCP_VM_NAME} --project=${GCP_PROJECT_ID} --zone=${GCP_ZONE} --quiet`);

                    log('Step 3: Creating fresh VM...', '\x1b[33m');
                    {
                        const yaml = fs.readFileSync(recreateYaml, 'utf8');
                        const machineType   = (yaml.match(/machineType:\s*(\S+)/) || [])[1] || 'e2-medium';
                        const image         = (yaml.match(/sourceImage:\s*["']?([^"'\n\r]+)["']?/) || [])[1] || 'projects/debian-cloud/global/images/family/debian-11';
                        const bootDiskSize  = (yaml.match(/diskSizeGb:\s*(\d+)/) || [])[1] || '20';
                        const network       = (yaml.match(/network:\s*(\S+)/) || [])[1] || 'default';
                        const subnetwork    = (yaml.match(/subnetwork:\s*(\S+)/) || [])[1] || '';
                        const hasExternalIp = yaml.includes('natIP:');
                        const externalIPFlag = hasExternalIp ? '' : '--no-address';

                        let createCmd = `gcloud compute instances create ${GCP_VM_NAME}`;
                        createCmd += ` --project=${GCP_PROJECT_ID}`;
                        createCmd += ` --zone=${GCP_ZONE}`;
                        createCmd += ` --machine-type=${machineType}`;
                        createCmd += ` --image=${image}`;
                        createCmd += ` --boot-disk-size=${bootDiskSize}GB`;
                        createCmd += ` --network=${network}`;
                        if (subnetwork) createCmd += ` --subnet=${subnetwork}`;
                        if (externalIPFlag) createCmd += ` ${externalIPFlag}`;
                        sh(createCmd);
                    }
                    log('Fresh VM created from saved settings.', '\x1b[32m');

                    // Next steps reminder (same as 6.12)
                    log('', '\x1b[36m');
                    log('📋 Recommended next steps for this fresh VM:', '\x1b[33m');
                    log('   6.2  – Configure firewall rules', '\x1b[33m');
                    log('   6.3  – Setup agent SSH keys', '\x1b[33m');
                    log('   6.4  – Setup GCP Secret Manager access', '\x1b[33m');
                    log('   6.9  – Install Tools on VM', '\x1b[33m');
                    log('   6.7  – Check VM reachability', '\x1b[33m');
                    log('', '\x1b[36m');
                    log('💡 Pro tip: Use option 6.14 to run all of them at once.', '\x1b[36m');
                }
                await pause();
                break;
            case '6.14':
                log('Running full VM post‑creation setup...', '\x1b[33m');
                sh('node Scripts/setup-firewall-rules.js');
                sh('node Scripts/setup-agent-ssh.js');
                sh('node Scripts/setup-gcp-secrets-access.js');
                sh('node Scripts/install-tools-on-vm.js');
                sh('node Scripts/check-vm-reachability.js');
                log('✅ Setup completed.', '\x1b[32m');
                await pause();
                break;
            case '6.15': {
                const keyPath = path.join(__dirname, 'agent-key');
                const sshUser = process.env.VM_SSH_USER || 'xmnione';
                const vmIp = process.env.GCP_VM_IP || '136.109.209.69';
                const sshCmd = `ssh -i "${keyPath}" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null ${sshUser}@${vmIp} "docker ps --format 'table {{.Names}}\\t{{.Status}}\\t{{.Ports}}'"`;
                sh(sshCmd);
                await pause();
                break;
            }
            case '6.16': {
                const keyPath = path.join(__dirname, 'agent-key');
                const sshUser = process.env.VM_SSH_USER || 'xmnione';
                const vmIp = process.env.GCP_VM_IP || '136.109.209.69';
                const service = await ask('Service name (e.g., badminton_web_1): ');
                if (service) {
                    // Show logs interactively
                    sh(`ssh -i "${keyPath}" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null ${sshUser}@${vmIp} "docker logs -f --tail 50 ${service}"`);
                }
                await pause();
                break;
            }
            case '6.17': {
                const keyPath = path.join(__dirname, 'agent-key');
                const sshUser = process.env.VM_SSH_USER || 'xmnione';
                const vmIp = process.env.GCP_VM_IP || '136.109.209.69';
                const service = await ask('Service name to restart: ');
                if (service) {
                    sh(`ssh -i "${keyPath}" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null ${sshUser}@${vmIp} "docker restart ${service}"`);
                    log(`${service} restarted.`, '\x1b[32m');
                }
                await pause();
                break;
            }
            case '6.18': {
                // Open staging app – uses VM's external IP
                const stagingUrl = `http://${process.env.GCP_VM_IP || '136.109.209.69'}:8001`; // staging port
                openUrl(stagingUrl);
                log(`Opening staging app: ${stagingUrl}`, '\x1b[32m');
                await pause();
                break;
            }
            case '6.19': {
                // Health check – curl the app from inside the VM (avoids firewall issues)
                const keyPath = path.join(__dirname, 'agent-key');
                const sshUser = process.env.VM_SSH_USER || 'xmnione';
                const vmIp = process.env.GCP_VM_IP || '136.109.209.69';
                log('Performing health check on staging (port 8001)...', '\x1b[33m');
                sh(`ssh -i "${keyPath}" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null ${sshUser}@${vmIp} "curl -s -o /dev/null -w '%{http_code}' http://localhost:8001/ || echo 'Failed'"`);
                await pause();
                break;
            }
            case '6.20': {
                // Clear cached SSH host key for the VM IP
                const vmIp = process.env.GCP_VM_IP || '136.109.209.69';
                log(`Removing cached host key for ${vmIp}...`, '\x1b[33m');
                if (os.platform() === 'win32') {
                    // Use ssh-keygen from Git Bash or Windows OpenSSH
                    sh(`ssh-keygen -R ${vmIp}`);
                } else {
                    sh(`ssh-keygen -R ${vmIp}`);
                }
                log('Host key cleared. Next connection will accept the new key.', '\x1b[32m');
                await pause();
                break;
            }
            
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

(async () => {
    console.log('\x1b[36mGoCD Management Menu is starting...\x1b[0m');
    await new Promise(r => setTimeout(r, 2000));
    await showMenu();
})().catch(err => {
    console.error(err);
    rl.close();
    process.exit(1);
});