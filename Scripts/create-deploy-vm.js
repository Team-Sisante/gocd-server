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
const STATIC_IP_NAME = 'gocd-deploy-target-ip';

// ---------- Validate required environment variables ----------
const SSH_USER = process.env.VM_SSH_USER;
if (!SSH_USER) {
    console.error('\x1b[31mERROR: VM_SSH_USER is not set.\x1b[0m');
    console.error('Please define VM_SSH_USER in your .env.docker file (e.g., VM_SSH_USER=xmnione).');
    process.exit(1);
}

const DESIRED_IP = process.env.GCP_VM_IP;
if (!DESIRED_IP) {
    console.error('\x1b[31mERROR: GCP_VM_IP is not set in your .env.docker file.\x1b[0m');
    console.error('Please define GCP_VM_IP with the desired static IP.');
    process.exit(1);
}

// Region derived from zone (e.g., us-west1-b → us-west1)
const REGION = ZONE.substring(0, ZONE.lastIndexOf('-'));

// Default compute service account (this email is standard for GCP projects)
const COMPUTE_SA = `575810712323-compute@developer.gserviceaccount.com`;

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

# Wait up to 5 minutes for any apt process to finish (GCP guest agent, auto-updates, etc.)
echo "Waiting for apt lock to be released..."
for i in $(seq 1 30); do
  if fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1; then
    echo "  apt is busy (attempt $i/30), waiting 10s..."
    sleep 10
  else
    echo "  apt lock is free."
    break
  fi
done

# Now safe to run apt
export DEBIAN_FRONTEND=noninteractive

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

# Verify critical tools
for tool in git docker node npm gcloud; do
  if command -v $tool &>/dev/null; then
    echo "  ✓ $tool is installed"
  else
    echo "  ✗ WARNING: $tool is MISSING"
  fi
done

echo "=== Startup script finished at $(date) ==="
`;

// ---------- Main flow ----------
async function main() {
  log('VM Provisioning Script for badminton_court deployment', '\x1b[32m');

  // ----------------------------------------------------------------
  // Ensure the VM's service account can read Secret Manager (one-time)
  // ----------------------------------------------------------------
  log('Ensuring Secret Manager permissions for the VM service account...', '\x1b[33m');
  run(
    `gcloud projects add-iam-policy-binding ${PROJECT_ID} \
        --member="serviceAccount:${COMPUTE_SA}" \
        --role="roles/secretmanager.secretAccessor"`,
    { silent: true, ignoreError: true }  // safe to run every time, idempotent
  );

  // -----------------------------------------------
  // Manage static IP reservation (with retry, avoids misleading messages)
  // -----------------------------------------------
  log('Ensuring static IP reservation...', '\x1b[33m');
  let finalIp = DESIRED_IP;

  // Check if reservation already exists and matches
  const existingIP = run(
    `gcloud compute addresses describe ${STATIC_IP_NAME} --region=${REGION} --format="value(address)"`,
    { silent: true, ignoreError: true }
  );

  if (existingIP && existingIP.trim() === finalIp) {
    log(`Static IP ${finalIp} already reserved.`);
  } else {
    if (existingIP) {
      log(`Static IP changed: ${existingIP.trim()} → ${finalIp}. Deleting old reservation...`, '\x1b[33m');
      run(`gcloud compute addresses delete ${STATIC_IP_NAME} --region=${REGION} --quiet`, { silent: true });
    }

    // Try twice to reserve the exact desired IP (transient GCP errors can happen)
    let reservationCreated = false;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const createResult = run(
        `gcloud compute addresses create ${STATIC_IP_NAME} --region=${REGION} --addresses=${finalIp}`,
        { silent: true, ignoreError: true }
      );
      if (createResult !== null) {
        log(`Static IP ${finalIp} reserved successfully.`);
        reservationCreated = true;
        break;
      }
      if (attempt === 1) {
        log(`First reservation attempt failed – retrying once after a short pause...`, '\x1b[33m');
        execSync(`ping -n 6 127.0.0.1 >nul`, { stdio: 'pipe' }); // ~5 seconds
      }
    }

    if (!reservationCreated) {
      // True fallback: desired IP really not available
      log(`Could not reserve ${finalIp}. Falling back to a random static IP.`, '\x1b[33m');
      run(`gcloud compute addresses create ${STATIC_IP_NAME} --region=${REGION}`, { silent: true });
      const assignedIp = run(
        `gcloud compute addresses describe ${STATIC_IP_NAME} --region=${REGION} --format="value(address)"`,
        { silent: true }
      );
      finalIp = assignedIp.trim();
      log(`Assigned static IP: ${finalIp}`, '\x1b[32m');

      // Update .env.docker with the new IP
      const envFilePath = path.join(__dirname, '..', '.env.docker');
      if (fs.existsSync(envFilePath)) {
        let envContent = fs.readFileSync(envFilePath, 'utf8');
        envContent = envContent.replace(/^GCP_VM_IP=.*/m, `GCP_VM_IP=${finalIp}`);
        fs.writeFileSync(envFilePath, envContent);
        log(`Updated .env.docker with new GCP_VM_IP=${finalIp}`, '\x1b[32m');
      }
    }
  }

  // Check if VM already exists
  const existing = run(
    `gcloud compute instances describe ${INSTANCE_NAME} --zone=${ZONE} --project=${PROJECT_ID} --format="value(name)"`,
    { silent: true, ignoreError: true }
  );

  if (existing && existing.trim()) {
    const answer = await ask(`VM ${INSTANCE_NAME} already exists. Delete and recreate? (y/N): `);
    if (answer !== 'y') {
      log('Aborting. Existing VM will be kept.', '\x1b[33m');
      process.exit(1);   // non‑zero exit code signals an abort
    }
    log('Deleting existing VM...', '\x1b[33m');
    run(`gcloud compute instances delete ${INSTANCE_NAME} --zone=${ZONE} --project=${PROJECT_ID} --quiet`, { silent: true });
    log('Existing VM deleted.', '\x1b[32m');
  }

  // Write startup script to temp file (replace SSH_USER placeholder)
  const finalScript = startupScript.replace(/__SSH_USER__/g, SSH_USER);
  fs.writeFileSync(STARTUP_SCRIPT_PATH, finalScript);
  log('Startup script written.', '\x1b[33m');

  // Create the VM with the static IP AND the cloud-platform scope
  log(`Creating VM ${INSTANCE_NAME} with cloud-platform scope...`, '\x1b[33m');
  const tagsArg = TAGS.join(',');
  const createCmd = `gcloud compute instances create ${INSTANCE_NAME} \
      --project=${PROJECT_ID} \
      --zone=${ZONE} \
      --machine-type=${MACHINE_TYPE} \
      --image-project=${IMAGE_PROJECT} \
      --image-family=${IMAGE_FAMILY} \
      --tags=${tagsArg} \
      --address=${STATIC_IP_NAME} \
      --scopes=https://www.googleapis.com/auth/cloud-platform \
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

  // Get the assigned IP (should be the same as finalIp)
  const vmIP = run(
    `gcloud compute instances describe ${INSTANCE_NAME} --zone=${ZONE} --project=${PROJECT_ID} --format="value(networkInterfaces[0].accessConfigs[0].natIP)"`,
    { silent: true }
  );
  
  log(`\n✅ Deployment VM ${INSTANCE_NAME} is ready.`, '\x1b[32m');
  log(`   Static IP: ${vmIP}`, '\x1b[36m');
  log(`   This IP is permanently reserved and will not change.`, '\x1b[36m');
  log(`   The VM has full access to GCP Secret Manager.`, '\x1b[36m');
  log(`   You may now run option 2.4 (Convert pipelines to SSH) and then trigger the pipeline.`, '\x1b[36m');
}

main().catch(err => {
  console.error('\x1b[31mError:', err.message, '\x1b[0m');
  process.exit(1);
});