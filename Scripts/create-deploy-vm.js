#!/usr/bin/env node
/**
 * Scripts/create-deploy-vm.js
 * Creates (or replaces) the deployment VM for badminton_court.
 * Provisions the VM from scratch with a startup script that installs all
 * necessary dependencies and clones the repository.
 * After VM creation, automatically calls setup-agent-ssh.js to inject
 * the agent's SSH key.
 *
 * Cross‑platform: Node.js + gcloud.
 * Usage:
 *   node Scripts/create-deploy-vm.js
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

// ---------- Configuration ----------
const PROJECT_ID = process.env.GCP_PROJECT_ID || 'project-39c0ea08-238b-47b5-915';
const ZONE = process.env.GCP_ZONE || 'us-west1-b';
const INSTANCE_NAME = process.env.GCP_VM_NAME || 'gocd-deploy-target';
const MACHINE_TYPE = 'e2-micro';
const IMAGE_PROJECT = 'debian-cloud';
const IMAGE_FAMILY = 'debian-11';
const TAGS = ['http-server', 'https-server'];
const STARTUP_SCRIPT_PATH = path.join(__dirname, '..', 'tmp_startup_script.sh');
const SETUP_AGENT_SSH_SCRIPT = path.join(__dirname, 'setup-agent-ssh.js');

// ---------- Validate required environment variable ----------
const SSH_USER = process.env.VM_SSH_USER;
if (!SSH_USER) {
    console.error('\x1b[31mERROR: VM_SSH_USER is not set.\x1b[0m');
    console.error('Please define VM_SSH_USER in your .env.docker file (e.g., VM_SSH_USER=xmnione).');
    process.exit(1);
}

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

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(`\x1b[33m${question}\x1b[0m`, answer => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}

// ---------- Startup script content (inline) ----------
const startupScript = `#!/bin/bash
set -e
exec > /var/log/startup-script.log 2>&1

echo "=== Startup script starting at $(date) ==="

# Update system
apt-get update && apt-get upgrade -y

# Install required packages
apt-get install -y ca-certificates curl git gnupg lsb-release

# Install Docker
curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /usr/share/keyrings/docker-archive-keyring.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/docker-archive-keyring.gpg] https://download.docker.com/linux/debian $(lsb_release -cs) stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null
apt-get update && apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
systemctl enable docker --now

# Install Node.js 18.x
curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
apt-get install -y nodejs

# Install gcloud CLI (optional)
echo "deb [signed-by=/usr/share/keyrings/cloud.google.gpg] https://packages.cloud.google.com/apt cloud-sdk main" | tee -a /etc/apt/sources.list.d/google-cloud-sdk.list
curl -fsSL https://packages.cloud.google.com/apt/doc/apt-key.gpg | gpg --dearmor -o /usr/share/keyrings/cloud.google.gpg
apt-get update && apt-get install -y google-cloud-cli

# Create the SSH user (from VM_SSH_USER environment variable)
SSH_USER="${SSH_USER}"
if ! id -u "$SSH_USER" >/dev/null 2>&1; then
  useradd -m -s /bin/bash "$SSH_USER"
  echo "$SSH_USER ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/$SSH_USER
fi
usermod -aG docker "$SSH_USER"

# Set up the application directory
REPO_DIR="/opt/badminton_court"
mkdir -p "$REPO_DIR"
chown -R "$SSH_USER:$SSH_USER" "$REPO_DIR"

# Clone the repository (if possible)
cd "$REPO_DIR"
if [ ! -d ".git" ]; then
  sudo -u "$SSH_USER" git clone https://github.com/xmione/badminton_court.git . || {
    echo "Clone failed; creating empty directory for pipeline to populate."
    mkdir -p "$REPO_DIR"
    chown "$SSH_USER:$SSH_USER" "$REPO_DIR"
    cd "$REPO_DIR" && sudo -u "$SSH_USER" git init
  }
fi

echo "=== Startup script finished at $(date) ==="
`;

// ---------- Main flow ----------
async function main() {
  log('VM Provisioning Script for badminton_court deployment', '\x1b[32m');

  // Check if VM already exists
  const existing = run(
    `gcloud compute instances describe ${INSTANCE_NAME} --zone=${ZONE} --project=${PROJECT_ID} --format="value(name)"`,
    { silent: true, ignoreError: true }
  );

  if (existing && existing.trim()) {
    const answer = await ask(`VM ${INSTANCE_NAME} already exists. Delete and recreate? (y/N): `);
    if (answer !== 'y') {
      log('Aborting. Existing VM will be kept.', '\x1b[33m');
      process.exit(0);
    }
    log('Deleting existing VM...', '\x1b[33m');
    run(`gcloud compute instances delete ${INSTANCE_NAME} --zone=${ZONE} --project=${PROJECT_ID} --quiet`, { silent: true });
    log('Existing VM deleted.', '\x1b[32m');
  }

  // Write startup script to temp file (replace SSH_USER placeholder)
  const finalScript = startupScript.replace(/__SSH_USER__/g, SSH_USER);
  fs.writeFileSync(STARTUP_SCRIPT_PATH, finalScript);
  log('Startup script written.', '\x1b[33m');

  // Create the VM
  log(`Creating VM ${INSTANCE_NAME}...`, '\x1b[33m');
  const tagsArg = TAGS.join(',');
  const createCmd = `gcloud compute instances create ${INSTANCE_NAME} \
    --project=${PROJECT_ID} \
    --zone=${ZONE} \
    --machine-type=${MACHINE_TYPE} \
    --image-project=${IMAGE_PROJECT} \
    --image-family=${IMAGE_FAMILY} \
    --tags=${tagsArg} \
    --metadata-from-file startup-script=${STARTUP_SCRIPT_PATH}`;
  run(createCmd, { silent: true });
  log('VM created. Waiting for it to be ready...', '\x1b[33m');

  // Wait until VM is RUNNING
  let status = '';
  for (let i = 0; i < 30; i++) {
    status = run(
      `gcloud compute instances describe ${INSTANCE_NAME} --zone=${ZONE} --project=${PROJECT_ID} --format="value(status)"`,
      { silent: true, ignoreError: true }
    );
    if (status && status.trim() === 'RUNNING') break;
    await new Promise(resolve => setTimeout(resolve, 10000));
  }

  if (!status || status.trim() !== 'RUNNING') {
    log('VM failed to reach RUNNING state. Check console.', '\x1b[31m');
    process.exit(1);
  }
  log('VM is running.', '\x1b[32m');

  // Clean up temp file
  fs.unlinkSync(STARTUP_SCRIPT_PATH);

  // Run setup-agent-ssh.js to inject the agent's SSH key
  log('Injecting agent SSH key...', '\x1b[33m');
  run(`node "${SETUP_AGENT_SSH_SCRIPT}"`, { silent: true });
  log('Agent SSH key injected.', '\x1b[32m');

  log(`\nDeployment VM ${INSTANCE_NAME} is ready.\nYou can now trigger the pipeline.\n`, '\x1b[32m');

    // Show IP and reminder
  const vmIP = run(
    `gcloud compute instances describe ${INSTANCE_NAME} --zone=${ZONE} --project=${PROJECT_ID} --format="value(networkInterfaces[0].accessConfigs[0].natIP)"`,
    { silent: true }
  );
  log(`\n📌 The new VM IP is: ${vmIP}`, '\x1b[33m');
  log('⚠️  Update GCP_VM_IP in your .env.docker file with this IP!', '\x1b[33m');
  log('   Then run option 4.1 to encrypt the .env.docker file.\n', '\x1b[33m');
  log('   Then run option 2.4 to update the pipelines.\n', '\x1b[33m');
  log('   Then run option 2.1 to trigger the badminton_court-artifacts pipeline.\n', '\x1b[33m');
}

main().catch(err => {
  console.error('\x1b[31mError:', err.message, '\x1b[0m');
  process.exit(1);
});