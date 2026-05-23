#!/usr/bin/env node
/**
 * Scripts/create‑fresh‑vm.js
 * Creates (or replaces) the deployment VM for badminton_court.
 * Provisions the VM from scratch with a startup script that installs all
 * necessary dependencies.
 * Does NOT inject the agent's SSH key – use option 6.3 for that.
 * Automatically falls back to an available free‑tier zone if the chosen one is full.
 * Updates all .env files with the final IP and zone.
 *
 * For a fully automatic fresh start, use option 6.22.
 *
 * Cross‑platform: Node.js + gcloud.
 * Usage:
 *   node Scripts/create‑fresh‑vm.js
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

// ---------- Validate required environment variables ----------
const PROJECT_ID = process.env.GCP_PROJECT_ID;
const ZONE       = process.env.GCP_ZONE;
const INSTANCE_NAME = process.env.GCP_VM_NAME;
const SSH_USER    = process.env.VM_SSH_USER;
const DESIRED_IP  = process.env.GCP_VM_IP;

const missing = [];
if (!PROJECT_ID) missing.push('GCP_PROJECT_ID');
if (!ZONE)       missing.push('GCP_ZONE');
if (!INSTANCE_NAME) missing.push('GCP_VM_NAME');
if (!SSH_USER)   missing.push('VM_SSH_USER');
if (!DESIRED_IP) missing.push('GCP_VM_IP');

if (missing.length > 0) {
    console.error('\x1b[31mERROR: The following required environment variables are missing:\x1b[0m');
    missing.forEach(v => console.error(`  - ${v}`));
    console.error('\nPlease define them in your .env.docker file.');
    process.exit(1);
}

// --- Pre-flight Check: Prevent Service Account usage for VM creation ---
const activeAccount = run('gcloud config get-value account', { silent: true, ignoreError: true });
if (activeAccount && activeAccount.includes('.gserviceaccount.com')) {
  log(`⚠️  ERROR: Active account is a Service Account: ${activeAccount}`, '\x1b[31m');
  log('VM creation requires a User Account (Owner/Editor permissions).', '\x1b[33m');
  log('Run "gcloud auth login" before continuing.', '\x1b[33m');
  process.exit(1);
}

// ---------- Configuration (no defaults) ----------
const MACHINE_TYPE = 'e2-micro';
const IMAGE_PROJECT = 'debian-cloud';
const IMAGE_FAMILY = 'debian-11';
const DISK_SIZE = '30GB'; // Max free tier limit for stability
const TAGS = ['http-server', 'https-server', 'gocd-deploy-target'];
const STARTUP_SCRIPT_PATH = path.join(__dirname, '..', 'tmp_startup_script.sh');
const STATIC_IP_NAME = 'gocd-deploy-target-ip';

// Region derived from the original desired zone (e.g., us-west1-b → us-west1)
const REGION = ZONE.substring(0, ZONE.lastIndexOf('-'));

/**
 * Dynamically identifies the best available zones in the region.
 * Prioritizes the zone from the environment files to achieve the best speed
 * by avoiding "resource unavailable" or "zone down" errors.
 */
function getOptimalZones(region, preferredZone) {
  log(`Searching for available zones in region ${region}...`, '\x1b[33m');
  try {
    // Query gcloud for zones that are currently UP in the region
    const result = execSync(
      `gcloud compute zones list --filter="region:(${region}) AND status:UP" --format="value(name)"`,
      { encoding: 'utf8', stdio: 'pipe' }
    );
    const zones = result.split(/\r?\n/).map(z => z.trim()).filter(z => z);
    
    // Prioritize the list of currently UP zones returned by GCP to ensure best speed/availability.
    // If the preferred zone is UP, it will be included in this list.
    if (zones.length > 0) return zones;
    return [preferredZone, `${region}-a`, `${region}-b`, `${region}-c`].filter((v, i, a) => a.indexOf(v) === i);
  } catch (e) {
    log('Note: Zone availability query failed. Falling back to regional defaults.', '\x1b[33m');
    return [preferredZone, `${region}-a`, `${region}-b`, `${region}-c`].filter((v, i, a) => a.indexOf(v) === i);
  }
}

const REGIONAL_ZONES = getOptimalZones(REGION, ZONE);

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

# Wait up for any apt process to finish (GCP guest agent, auto-updates, etc.)
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

# Force apt to use IPv4 – avoids network unreachable errors on some GCP zones
echo 'Acquire::ForceIPv4 "true";' | tee /etc/apt/apt.conf.d/99force-ipv4

# Update system
echo "Updating package lists..."
apt-get update
echo "Upgrading existing packages..."
apt-get upgrade -y
apt-get clean
apt-get autoremove -y

# Install required packages
echo "Installing essential packages..."
apt-get install -y ca-certificates curl git gnupg lsb-release cloud-guest-utils

# Install Docker
echo "Installing Docker..."
curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /usr/share/keyrings/docker-archive-keyring.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/docker-archive-keyring.gpg] https://download.docker.com/linux/debian $(lsb_release -cs) stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
systemctl enable docker --now
echo "Docker installed."

echo "Ensuring filesystem utilizes full 30GB disk..."
growpart /dev/sda 1 || echo "Partition already max size"
resize2fs /dev/sda1 || echo "Filesystem already max size"
df -h /

echo "Enabling 4GB swap space for stability..."
if [ ! -f /swapfile ]; then
  fallocate -l 4G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
echo "Swap space enabled."

echo "Configuring Docker DNS and MTU for reliable registry access on GCP..."
echo '{"dns":["8.8.8.8"], "mtu": 1460}' | sudo tee /etc/docker/daemon.json
sudo systemctl restart docker
echo "Docker DNS and MTU configured."

# Install Node.js 18.x
echo "Installing Node.js..."
curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
apt-get install -y nodejs
echo "Node.js installed."

# Install gcloud CLI (optional)
echo "Installing gcloud CLI..."
echo "deb [signed-by=/usr/share/keyrings/cloud.google.gpg] https://packages.cloud.google.com/apt cloud-sdk main" | tee -a /etc/apt/sources.list.d/google-cloud-sdk.list
curl -fsSL https://packages.cloud.google.com/apt/doc/apt-key.gpg | gpg --dearmor -o /usr/share/keyrings/cloud.google.gpg
apt-get update
apt-get install -y google-cloud-cli
echo "gcloud CLI installed."

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
echo ""
echo "=== Verifying installed tools ==="
for tool in git docker node npm gcloud; do
  if command -v $tool &>/dev/null; then
    echo "  ✓ $tool is installed"
  else
    echo "  ✗ WARNING: $tool is MISSING"
  fi
done

echo "=== Startup script finished at $(date) ==="
`;

// ---------- Update all .env files with new IP and/or zone ----------
function updateEnvFiles(newIp, newZone, oldIp) {
    const badmintonDir = path.join(__dirname, '..', '..', 'badminton_court');
    const gocdServerEnv = path.join(__dirname, '..', '.env.docker');

    const files = [
        path.join(gocdServerEnv),
        path.join(badmintonDir, '.env.dev'),
        path.join(badmintonDir, '.env.docker'),
        path.join(badmintonDir, '.env.staging'),
        path.join(badmintonDir, '.env.production')
    ];

    for (const filePath of files) {
        if (!fs.existsSync(filePath)) continue;
        let content = fs.readFileSync(filePath, 'utf8');

        // Replace old IP everywhere (APP_DOMAIN, ALLOWED_HOSTS, GCP_VM_IP, STAGING_APP_URL, etc.)
        if (oldIp && newIp && oldIp !== newIp) {
            content = content.split(oldIp).join(newIp);
            content = content.replace(/^GCP_VM_IP=.*/m, `GCP_VM_IP=${newIp}`);
        }

        // Always sync the zone to the final value
        if (newZone) {
            content = content.replace(/^GCP_ZONE=.*/m, `GCP_ZONE=${newZone}`);
        }

        fs.writeFileSync(filePath, content);
        log(`Updated ${path.basename(filePath)}`);
    }
}

// ---------- Attempt to create VM in a specific zone ----------
function tryCreateVM(zone) {
    const tagsArg = TAGS.join(',');
    const createCmd = `gcloud compute instances create ${INSTANCE_NAME} \
        --project=${PROJECT_ID} \
        --zone=${zone} \
        --machine-type=${MACHINE_TYPE} \
        --image-project=${IMAGE_PROJECT} \
        --image-family=${IMAGE_FAMILY} \
        --boot-disk-size=${DISK_SIZE} \
        --tags=${tagsArg} \
        --address=${STATIC_IP_NAME} \
        --scopes=https://www.googleapis.com/auth/cloud-platform \
        --metadata-from-file startup-script=${STARTUP_SCRIPT_PATH}`;

    const result = run(createCmd, { silent: true, ignoreError: true });
    return result !== null; // null means error (zone full, etc.)
}

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

      // Update .env.docker – replace the old IP with the new one everywhere
      const envFilePath = path.join(__dirname, '..', '.env.docker');
      if (fs.existsSync(envFilePath)) {
        let envContent = fs.readFileSync(envFilePath, 'utf8');
        // Replace all occurrences of the old (desired) IP with the new final IP
        envContent = envContent.split(DESIRED_IP).join(finalIp);
        // Also explicitly update the GCP_VM_IP line (belt‑and‑suspenders, the split/join already caught it)
        envContent = envContent.replace(/^GCP_VM_IP=.*/m, `GCP_VM_IP=${finalIp}`);
        fs.writeFileSync(envFilePath, envContent);
        log(`Updated .env.docker: all references to ${DESIRED_IP} changed to ${finalIp}`, '\x1b[32m');
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

  // Try to create VM in the desired zone, fallback to other free-tier zones
  // (only within the same region to keep the static IP valid)
  let createdZone = null;
  for (const zone of REGIONAL_ZONES) {
    // Create the VM with the static IP AND the cloud-platform scope
    log(`Creating VM ${INSTANCE_NAME} with cloud-platform scope in zone ${zone}...`, '\x1b[33m');
    if (tryCreateVM(zone)) {
      createdZone = zone;
      break;
    }
    log(`Zone ${zone} is unavailable or full, trying next...`, '\x1b[33m');
  }

  if (!createdZone) {
    log('All free-tier zones in the region failed. Unable to create VM.', '\x1b[31m');
    process.exit(1);
  }

  // Always update all .env files with the final zone and IP
  updateEnvFiles(finalIp, createdZone, DESIRED_IP);

  // Wait until VM is RUNNING
  log('VM created. Waiting for it to be ready...', '\x1b[33m');
  let status = '';
  for (let i = 0; i < 30; i++) {
    status = run(
      `gcloud compute instances describe ${INSTANCE_NAME} --zone=${createdZone} --project=${PROJECT_ID} --format="value(status)"`,
      { silent: true, ignoreError: true }
    );
    if (status && status.trim() === 'RUNNING') {
      log('VM status: RUNNING', '\x1b[32m');
      break;
    }
    log(`Waiting for VM... (status: ${status ? status.trim() : 'unknown'})`);
    await new Promise(resolve => setTimeout(resolve, 10000));
  }

  if (!status || status.trim() !== 'RUNNING') {
    log('VM failed to reach RUNNING state. Check console.', '\x1b[31m');
    process.exit(1);
  }
  log('VM is running.', '\x1b[32m');

  // Automatically configure firewall rules
  log('Automatically configuring firewall rules...', '\x1b[33m');
  run('node Scripts/setup-firewall-rules.js', { stdio: 'inherit' });

  // Clean up temp file
  fs.unlinkSync(STARTUP_SCRIPT_PATH);

  // Get the assigned IP (should be the same as finalIp)
  const vmIP = run(
    `gcloud compute instances describe ${INSTANCE_NAME} --zone=${createdZone} --project=${PROJECT_ID} --format="value(networkInterfaces[0].accessConfigs[0].natIP)"`,
    { silent: true }
  );
  
  log(`\n✅ Deployment VM ${INSTANCE_NAME} is ready.`, '\x1b[32m');
  log(`   Static IP: ${vmIP}`, '\x1b[36m');
  log(`   This IP is permanently reserved and will not change.`, '\x1b[36m');
  log(`   The VM has full access to GCP Secret Manager.`, '\x1b[36m');
  log(`   Next steps:`, '\x1b[36m');
  log(`   • Run 6.2‑6.7 to complete the setup (firewall, SSH, tools, secrets, reachability, pipeline config).`, '\x1b[36m');
  log(`   • Or use option 6.15 to run firewall, SSH, secrets, reachability, then run 6.7 for pipeline config.`, '\x1b[36m');
  log(`   • For a fully automatic fresh start, use option 6.22 next time.`, '\x1b[36m');
}

main().catch(err => {
  console.error('\x1b[31mError:', err.message, '\x1b[0m');
  process.exit(1);
});