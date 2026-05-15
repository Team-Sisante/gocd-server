#!/usr/bin/env node
/**
 * Scripts/update-pipelines-ssh.js
 * Updates the local cruise-config.xml to use the deploy.js task
 * (instead of the SSH one‑liner that clones the repo on the VM).
 * Deploy.js copies only the necessary files via SCP, keeping source
 * code off the deployment VM.
 *
 * Usage:
 *   node Scripts/update-pipelines-ssh.js          (apply changes)
 *   node Scripts/update-pipelines-ssh.js --dry-run (show what would change)
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const os = require('os');

const CONFIG_PATH = path.join(__dirname, '..', 'config', 'cruise-config.xml');
const DRY_RUN = process.argv.includes('--dry-run');

// ----- New deploy.js tasks (no hardcoded values) -----
const stagingNewTask = `              <exec command="bash">
                <arg>-c</arg>
                <arg>node /badminton_court/Scripts/deploy.js staging __GITHUB_TOKEN__</arg>
              </exec>`;

const productionNewTask = `              <exec command="bash">
                <arg>-c</arg>
                <arg>node /badminton_court/Scripts/deploy.js production __GITHUB_TOKEN__</arg>
              </exec>`;

// ---------- Old task blocks to replace ----------

// Old gcloud compute ssh tasks (no longer used)
const stagingOldGcloudTask = `              <exec command="bash">
                <arg>-c</arg>
                <arg><![CDATA[gcloud compute ssh "__GCP_VM_NAME__" --project "__GCP_PROJECT_ID__" --zone "__GCP_ZONE__" --quiet --command "export GITHUB_TOKEN='__GITHUB_TOKEN__' && sudo chown -R \\$USER /app/badminton_court && git config --global --add safe.directory /app/badminton_court && cd /app/badminton_court && git pull origin master && node Scripts/generate-env.js development .env.staging && echo '__GITHUB_TOKEN__' | sudo docker login ghcr.io -u xmione --password-stdin && sudo docker compose -f docker-compose.vm.yml --env-file .env.staging --profile staging pull && sudo docker compose -f docker-compose.vm.yml --env-file .env.staging --profile staging up -d --build"]]></arg>
              </exec>`;

const productionOldGcloudTask = `              <exec command="bash">
                <arg>-c</arg>
                <arg><![CDATA[gcloud compute ssh "__GCP_VM_NAME__" --project "__GCP_PROJECT_ID__" --zone "__GCP_ZONE__" --quiet --command "export GITHUB_TOKEN='__GITHUB_TOKEN__' && sudo chown -R \\$USER /app/badminton_court && git config --global --add safe.directory /app/badminton_court && cd /app/badminton_court && git pull origin master && node Scripts/generate-env.js docker-production .env.production && echo '__GITHUB_TOKEN__' | sudo docker login ghcr.io -u xmione --password-stdin && sudo docker compose -f docker-compose.vm.yml --env-file .env.production --profile production pull && sudo docker compose -f docker-compose.vm.yml --env-file .env.production --profile production up -d --build"]]></arg>
              </exec>`;

// Old deploy.js tasks (already in this format, but included for completeness)
const stagingOldDeployTask = `              <exec command="bash">
                <arg>-c</arg>
                <arg>node /badminton_court/Scripts/deploy.js staging __GITHUB_TOKEN__</arg>
              </exec>`;

const productionOldDeployTask = `              <exec command="bash">
                <arg>-c</arg>
                <arg>node /badminton_court/Scripts/deploy.js production __GITHUB_TOKEN__</arg>
              </exec>`;

// Current SSH tasks (the ones that clone the repo on the VM)
const stagingOldSSHTask = `              <exec command="bash">
                <arg>-c</arg>
                <arg><![CDATA[
    ssh -i /secret/agent-key \\
        -o StrictHostKeyChecking=no \\
        -o UserKnownHostsFile=/dev/null \\
        xmione@136.109.209.69 \\
        "mkdir -p /opt/badminton_court &&
         sudo chown -R \\$USER /opt/badminton_court &&
         git config --global --add safe.directory /opt/badminton_court &&
         cd /