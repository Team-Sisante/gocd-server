#!/usr/bin/env node
/**
 * Scripts/update-pipelines-ssh.js
 * Updates the local cruise-config.xml to use SSH (instead of gcloud compute ssh),
 * then applies the changes to the running GoCD server inside Docker.
 *
 * Usage:
 *   node Scripts/update-pipelines-ssh.js          (apply changes)
 *   node Scripts/update-pipelines-ssh.js --dry-run (show what would change)
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

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

if (changes > 0) {
    // Write the updated file locally
    const backupPath = CONFIG_PATH + '.bak';
    fs.writeFileSync(backupPath, fs.readFileSync(CONFIG_PATH));
    fs.writeFileSync(CONFIG_PATH, content);
    console.log('✅ cruise-config.xml updated. Backup saved to', backupPath);
} else {
    console.log('No changes were necessary in the local XML.');
}

// ---------- Apply to running GoCD server ----------
if (DRY_RUN) {
    console.log('\n--- DRY RUN (no server update performed) ---');
    process.exit(0);
}

// Credentials are inherited from the gocd-server menu (.env.docker)
const GOCD_USER = process.env.GOCD_ADMIN_USERNAME;
const GOCD_PASS = process.env.GOCD_ADMIN_PASSWORD;

if (!GOCD_USER || !GOCD_PASS) {
    console.error('\x1b[31mError: GoCD credentials not found. Ensure this script is run from the GoCD Management Menu.\x1b[0m');
    process.exit(1);
}

// 1. Copy the local XML into the container
console.log('Copying updated XML into GoCD container...');
try {
    execSync(`docker cp "${CONFIG_PATH}" gocd-server:/godata/config/cruise-config.xml`, { stdio: 'inherit' });
    console.log('✅ Updated XML copied into GoCD container.');
} catch (e) {
    console.error('\x1b[31mFailed to copy XML into container:\x1b[0m', e.message);
    process.exit(1);
}

// 2. Restart GoCD and wait for it to be healthy
console.log('Restarting GoCD server...');
try {
    execSync('docker restart gocd-server', { stdio: 'inherit' });
} catch (e) {
    console.error('\x1b[31mFailed to restart GoCD:\x1b[0m', e.message);
    process.exit(1);
}

console.log('Waiting for GoCD server to become healthy...');
let retries = 12;  // up to ~60 seconds
while (retries > 0) {
    try {
        execSync(
            'docker exec gocd-server curl -sf http://localhost:8153/go/api/health',
            { stdio: 'pipe' }
        );
        console.log('✅ GoCD server is ready.');
        break;
    } catch (_) {
        retries--;
        if (retries === 0) {
            console.error('\x1b[31mGoCD server did not become healthy within the timeout.\x1b[0m');
            process.exit(1);
        }
        // Wait 5 seconds before retrying
        execSync(os.platform() === 'win32' ? 'timeout /t 5' : 'sleep 5', { stdio: 'pipe' });
    }
}

console.log('✅ Pipeline configuration applied successfully.');
process.exit(0);