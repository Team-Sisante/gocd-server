#!/usr/bin/env node
/**
 * Scripts/update-pipelines-ssh.js
 * Rewrites the staging and production pipeline tasks to use SSH instead of gcloud compute ssh.
 * Cross‑platform: Node.js only.
 * Usage:
 *   node Scripts/update-pipelines-ssh.js          (applies changes)
 *   node Scripts/update-pipelines-ssh.js --dry-run (shows what would change)
 */

const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'config', 'cruise-config.xml');
const DRY_RUN = process.argv.includes('--dry-run');

// ---------- New SSH task blocks ----------
const stagingNewTask = `              <exec command="bash">
                <arg>-c</arg>
                <arg><![CDATA[
    ssh -i /secret/agent-key \\
        -o StrictHostKeyChecking=no \\
        -o UserKnownHostsFile=/dev/null \\
        sol-i@35.230.13.215 \\
        "export GITHUB_TOKEN='__GITHUB_TOKEN__' &&
         sudo chown -R \\$USER /app/badminton_court &&
         git config --global --add safe.directory /app/badminton_court &&
         cd /app/badminton_court &&
         git pull &&
         node Scripts/generate-env.js development .env.staging &&
         echo '__GITHUB_TOKEN__' | sudo docker login ghcr.io -u xmione --password-stdin &&
         sudo docker compose -f docker-compose.vm.yml --env-file .env.staging --profile staging pull &&
         sudo docker compose -f docker-compose.vm.yml --env-file .env.staging --profile staging up -d --build"
  ]]></arg>
              </exec>`;

const productionNewTask = `              <exec command="bash">
                <arg>-c</arg>
                <arg><![CDATA[
    ssh -i /secret/agent-key \\
        -o StrictHostKeyChecking=no \\
        -o UserKnownHostsFile=/dev/null \\
        sol-i@35.230.13.215 \\
        "export GITHUB_TOKEN='__GITHUB_TOKEN__' &&
         sudo chown -R \\$USER /app/badminton_court &&
         git config --global --add safe.directory /app/badminton_court &&
         cd /app/badminton_court &&
         git pull &&
         node Scripts/generate-env.js docker-production .env.production &&
         echo '__GITHUB_TOKEN__' | sudo docker login ghcr.io -u xmione --password-stdin &&
         sudo docker compose -f docker-compose.vm.yml --env-file .env.production --profile production pull &&
         sudo docker compose -f docker-compose.vm.yml --env-file .env.production --profile production up -d --build"
  ]]></arg>
              </exec>`;

// ---------- Old task blocks (exact match from original) ----------
const stagingOldTask = `              <exec command="bash">
                <arg>-c</arg>
                <arg><![CDATA[gcloud compute ssh "__GCP_VM_NAME__" --project "__GCP_PROJECT_ID__" --zone "__GCP_ZONE__" --quiet --command "export GITHUB_TOKEN='__GITHUB_TOKEN__' && sudo chown -R \\$USER /app/badminton_court && git config --global --add safe.directory /app/badminton_court && cd /app/badminton_court && git pull && node Scripts/generate-env.js development .env.staging && echo '__GITHUB_TOKEN__' | sudo docker login ghcr.io -u xmione --password-stdin && sudo docker compose -f docker-compose.vm.yml --env-file .env.staging --profile staging pull && sudo docker compose -f docker-compose.vm.yml --env-file .env.staging --profile staging up -d --build"]]></arg>
              </exec>`;

const productionOldTask = `              <exec command="bash">
                <arg>-c</arg>
                <arg><![CDATA[gcloud compute ssh "__GCP_VM_NAME__" --project "__GCP_PROJECT_ID__" --zone "__GCP_ZONE__" --quiet --command "export GITHUB_TOKEN='__GITHUB_TOKEN__' && sudo chown -R \\$USER /app/badminton_court && git config --global --add safe.directory /app/badminton_court && cd /app/badminton_court && git pull && node Scripts/generate-env.js docker-production .env.production && echo '__GITHUB_TOKEN__' | sudo docker login ghcr.io -u xmione --password-stdin && sudo docker compose -f docker-compose.vm.yml --env-file .env.production --profile production pull && sudo docker compose -f docker-compose.vm.yml --env-file .env.production --profile production up -d --build"]]></arg>
              </exec>`;

// ---------- Main ----------
let content = fs.readFileSync(CONFIG_PATH, 'utf8');
let changes = 0;

if (content.includes(stagingOldTask)) {
    console.log('▶ Updating staging pipeline task...');
    content = content.replace(stagingOldTask, stagingNewTask);
    changes++;
} else {
    console.log('⚠ Staging task not found or already modified.');
}

if (content.includes(productionOldTask)) {
    console.log('▶ Updating production pipeline task...');
    content = content.replace(productionOldTask, productionNewTask);
    changes++;
} else {
    console.log('⚠ Production task not found or already modified.');
}

if (changes === 0) {
    console.log('No changes were necessary.');
    process.exit(0);
}

if (DRY_RUN) {
    console.log('\n--- DRY RUN (no file written) ---');
    console.log('Changes would be written to', CONFIG_PATH);
} else {
    const backupPath = CONFIG_PATH + '.bak';
    fs.writeFileSync(backupPath, fs.readFileSync(CONFIG_PATH)); // backup
    fs.writeFileSync(CONFIG_PATH, content);
    console.log('✅ cruise-config.xml updated. Backup saved to', backupPath);
}