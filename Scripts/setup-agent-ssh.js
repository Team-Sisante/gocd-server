#!/usr/bin/env node
/**
 * Scripts/setup-agent-ssh.js
 * Automates provisioning of the GoCD agent's SSH key to the deployment VM.
 * Cross‑platform: runs wherever Node.js and gcloud are available.
 *
 * 🔴 HARD RULE: Every process MUST display real‑time progress.
 *    Never suppress output or leave the screen frozen.
 *    Always show live elapsed time where appropriate.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ---------- Configuration ----------
const PROJECT_ID = process.env.GCP_PROJECT_ID || 'project-39c0ea08-238b-47b5-915';
const ZONE = process.env.GCP_ZONE || 'us-west1-b';
const INSTANCE_NAME = process.env.GCP_VM_NAME || 'gocd-deploy-target';
const REMOTE_USER = process.env.VM_SSH_USER || 'xmnione';
const AGENT_KEY_PATH = path.join(__dirname, '..', 'secrets', 'agent-key');
const AGENT_KEY_COMMENT = 'gocd-agent';

const scriptStart = Date.now();
const elapsed = () => Math.floor((Date.now() - scriptStart) / 1000) + 's';

// ---------- Helpers ----------
function run(cmd, options = {}) {
    const stdio = options.silent ? 'pipe' : 'inherit';
    try {
        return execSync(cmd, { encoding: 'utf8', stdio, ...options });
    } catch (e) {
        if (!options.ignoreError) {
            console.error(`\x1b[31m[${elapsed()}] Command failed: ${cmd}\x1b[0m`);
            console.error(e.message);
            process.exit(1);
        }
        return null;
    }
}

function log(msg, color = '\x1b[36m') {
    console.log(`${color}[${elapsed()}] ${msg}\x1b[0m`);
}

// ---------- Step 1: Ensure agent key pair exists ----------
if (!fs.existsSync(AGENT_KEY_PATH)) {
    log('Generating new agent SSH key pair...', '\x1b[33m');
    const keyDir = path.dirname(AGENT_KEY_PATH);
    if (!fs.existsSync(keyDir)) fs.mkdirSync(keyDir, { recursive: true });
    run(`ssh-keygen -t rsa -b 4096 -f "${AGENT_KEY_PATH}" -C "${AGENT_KEY_COMMENT}" -N ""`, { silent: false });
    log('Key pair generated.', '\x1b[32m');
} else {
    log('Agent key pair already exists.', '\x1b[32m');
}

// ---------- Get VM IP and clear old host key ----------
const ip = run(
  `gcloud compute instances describe ${INSTANCE_NAME} --zone=${ZONE} --project=${PROJECT_ID} --format="value(networkInterfaces[0].accessConfigs[0].natIP)"`,
  { silent: true, ignoreError: true }
);
if (ip) {
  try { execSync(`ssh-keygen -R ${ip}`, { stdio: 'ignore' }); } catch (_) {}
}

// ---------- Step 2: Read current instance metadata SSH keys ----------
log('Fetching current SSH keys from instance...', '\x1b[33m');
const describeCmd = `gcloud compute instances describe ${INSTANCE_NAME} --zone=${ZONE} --project=${PROJECT_ID} --format="value(metadata.items.ssh-keys)"`;
const rawKeys = run(describeCmd, { silent: true, ignoreError: true });
if (!rawKeys) {
    log('Could not retrieve existing keys. Proceeding with only the agent key.', '\x1b[33m');
}

// ---------- Step 3: Filter out ephemeral/expired keys ----------
const lines = rawKeys ? rawKeys.split('\n').filter(line => line.trim() !== '') : [];
const permanentKeys = lines.filter(line => !line.includes('expireOn'));

if (lines.length !== permanentKeys.length) {
    log(`Removed ${lines.length - permanentKeys.length} ephemeral key(s).`, '\x1b[33m');
}

// ---------- Step 4: Add agent public key (with username prefix) ----------
const agentPubKey = fs.readFileSync(`${AGENT_KEY_PATH}.pub`, 'utf8').trim();
const agentLine = `${REMOTE_USER}:${agentPubKey}`;
permanentKeys.push(agentLine);

// ---------- Step 5: Write temporary ssh-keys.txt ----------
const tmpFile = path.join(os.tmpdir(), 'ssh-keys.txt');
fs.writeFileSync(tmpFile, permanentKeys.join('\n') + '\n');
log(`Temporary file created: ${tmpFile}`, '\x1b[33m');

// ---------- Step 6: Apply metadata ----------
log('Applying new SSH keys to instance...', '\x1b[33m');
// No silent – let user see the gcloud output
run(`gcloud compute instances add-metadata ${INSTANCE_NAME} \
    --zone=${ZONE} \
    --project=${PROJECT_ID} \
    --metadata-from-file ssh-keys="${tmpFile}"`, { silent: false });

// ---------- Step 7: Verify the key was installed ----------
log('Verifying key installation...', '\x1b[33m');
const verifyCmd = `gcloud compute instances describe ${INSTANCE_NAME} --zone=${ZONE} --project=${PROJECT_ID} --format="value(metadata.items.ssh-keys)"`;
const updatedKeys = run(verifyCmd, { silent: true, ignoreError: true });
if (updatedKeys && updatedKeys.includes(agentLine)) {
    log('✅ Agent SSH key successfully installed on the VM.', '\x1b[32m');
} else {
    log('❌ Verification failed: the agent key was not found on the VM.', '\x1b[31m');
    try { fs.unlinkSync(tmpFile); } catch (_) {}
    process.exit(1);
}

// ---------- Step 8: Cleanup ----------
fs.unlinkSync(tmpFile);
log('Temporary file cleaned up.\nDone!', '\x1b[32m');