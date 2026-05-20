#!/usr/bin/env node
/**
 * Scripts/enable-swap-on-vm.js
 * Enables a 4GB swap file on the remote VM via SSH.
 * This script is idempotent – it will skip creation if /swapfile already exists.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

async function main() {
    console.log('\x1b[36m--- Enabling 4GB Swap Space on VM ---\x1b[0m');

    const IP = process.env.GCP_VM_IP;
    const USER = process.env.VM_SSH_USER;
    const KEY = '/secret/agent-key';

    if (!IP || !USER) {
        console.error('\x1b[31mERROR: GCP_VM_IP or VM_SSH_USER not found in environment.\x1b[0m');
        process.exit(1);
    }

    const SSH_OPTS = '-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null';
    const remoteCmd = [
        // Idempotent swap creation
        `if [ ! -f /swapfile ]; then`,
        `  echo "Creating 4GB swap file..."`,
        `  sudo fallocate -l 4G /swapfile`,
        `  sudo chmod 600 /swapfile`,
        `  sudo mkswap /swapfile`,
        `  sudo swapon /swapfile`,
        `  echo "/swapfile none swap sw 0 0" | sudo tee -a /etc/fstab`,
        `else`,
        `  echo "/swapfile already exists."`,
        `  if ! swapon --show | grep -q "/swapfile"; then`,
        `    echo "Activating existing swap..."`,
        `    sudo swapon /swapfile`,
        `  fi`,
        `fi`,
        // Re-expand filesystem just in case disk was recently resized
        `sudo resize2fs /dev/sda1 || (sudo growpart /dev/sda 1 && sudo resize2fs /dev/sda1)`,
        // Report status
        `free -h`,
        `df -h /`
    ].join(' && ');

    const fullCmd = `ssh -i ${KEY} ${SSH_OPTS} ${USER}@${IP} "${remoteCmd}"`;

    try {
        execSync(fullCmd, { stdio: 'inherit' });
        console.log('\n\x1b[32m✅ Swap configuration verified and active.\x1b[0m');
    } catch (err) {
        console.error('\n\x1b[31m❌ Failed to enable swap on VM.\x1b[0m');
        process.exit(1);
    }
}

main();