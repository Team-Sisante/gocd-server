#!/usr/bin/env node
/**
 * Scripts/setup-agent-ssh.js
 * Automates provisioning of the GoCD agent's SSH key to the deployment VM.
 * Cross‑platform: runs wherever Node.js and gcloud are available.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ---------- Configuration ----------
const PROJECT_ID = 'project-39c0ea08-238b-47b5-915';
const ZONE = 'us-west1-b';
const INSTANCE_NAME = 'gocd-deploy-target';
const REMOTE_USER = 'sol-i';
const AGENT_KEY_PATH = path.join(__dirname, '..', 'secrets', 'agent-key');
const AGENT_KEY_COMMENT = 'gocd-agent';

// ---------- Helpers ----------
function run(cmd, options = {}) {
    try {
        return execSync(cmd, { encoding: 'utf8', stdio: options.silent ? 'pipe' : 'inherit', ...options });
    } catch (e) {
        if (!options.ignoreError) {
            console.error(`\x1b[31mCommand failed: ${cmd}\x1b[0m`);
            console.error(e.message);
            process.exit(1);
        }
        return null;
    }
}

function log(msg, color = '\x1b[36m') {
    console.log(`${color}%s\x1b[0m`, msg);
}

// ---------- Step 1: Ensure agent key pair exists ----------
if (!fs.existsSync(AGENT_KEY_PATH)) {
    log('Generating new agent SSH key pair...', '\x1b[33m');
    const keyDir = path.dirname(AGENT_KEY_PATH);
    if (!fs.existsSync(keyDir)) fs.mkdirSync(keyDir, { recursive: true });
    // ssh-keygen -t rsa -b 4096 -f <path> -C <comment> -N ""
    run(`ssh-keygen -t rsa -b 4096 -f "${AGENT_KEY_PATH}" -C "${AGENT_KEY_COMMENT}" -N ""`, { silent: true });
    log('Key pair generated.', '\x1b[32m');
} else {
    log('Agent key pair already exists.', '\x1b[32m');
}

// ---------- Step 2: Read current instance metadata SSH keys ----------
log('Fetching current SSH keys from instance...', '\x1b[33m');
const describeCmd = `gcloud compute instances describe ${INSTANCE_NAME} --zone=${ZONE} --project=${PROJECT_ID} --format="value(metadata.items.ssh-keys)"`;
const rawKeys = run(describeCmd, { silent: true, ignoreError: true });
if (!rawKeys) {
    log('Could not retrieve existing keys. Proceeding with only the agent key.', '\x1b[33m');
}

// ---------- Step 3: Filter out ephemeral/expired keys ----------
// Ephemeral keys contain 'expireOn' in the comment (e.g., google-ssh {...})
const lines = rawKeys ? rawKeys.split('\n').filter(line => line.trim() !== '') : [];
const permanentKeys = lines.filter(line => !line.includes('expireOn'));

if (lines.length !== permanentKeys.length) {
    log(`Removed ${lines.length - permanentKeys.length} ephemeral key(s).`, '\x1b[33m');
}

// ---------- Step 4: Add agent public key ----------
const agentPubKey = fs.readFileSync(`${AGENT_KEY_PATH}.pub`, 'utf8').trim();
const agentLine = `${REMOTE_USER}:${agentPubKey}`;
permanentKeys.push(agentLine);

// ---------- Step 5: Write temporary ssh-keys.txt ----------
const tmpFile = path.join(os.tmpdir(), 'ssh-keys.txt');
fs.writeFileSync(tmpFile, permanentKeys.join('\n') + '\n');
log(`Temporary file created: ${tmpFile}`, '\x1b[33m');

// ---------- Step 6: Apply metadata ----------
log('Applying new SSH keys to instance...', '\x1b[33m');
run(`gcloud compute instances add-metadata ${INSTANCE_NAME} \
    --zone=${ZONE} \
    --project=${PROJECT_ID} \
    --metadata-from-file ssh-keys="${tmpFile}"`, { silent: true });
log('SSH keys successfully applied to the VM.', '\x1b[32m');

// ---------- Step 7: Cleanup ----------
fs.unlinkSync(tmpFile);
log('Temporary file cleaned up.\nDone!', '\x1b[32m');