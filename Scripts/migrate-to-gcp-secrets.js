#!/usr/bin/env node
/**
 * Scripts/migrate-to-gcp-secrets.js
 * 1. Decrypts .e.env.*.gpg files
 * 2. Extracts sensitive keys (Passwords, Tokens, Keys)
 * 3. Uploads them to GCP Secret Manager using gcloud CLI
 * 
 * Usage:
 *   node Scripts/migrate-to-gcp-secrets.js
 */

const { execSync } = require('child_process');
const fs = require('fs');

const PASSPHRASE = '9c9fdf41-a821-48c6-9f7d-40d3028f1580';
const FILES = ['.e.env.dev.gpg', '.e.env.docker.gpg'];
const PROJECT_ID = 'project-39c0ea08-238b-47b5-915';

function run(command, silent = false) {
    if (!silent) console.log(`\x1b[36mRunning: ${command}\x1b[0m`);
    try {
        return execSync(command, { encoding: 'utf8' }).trim();
    } catch (e) {
        if (!silent) console.error(`\x1b[31mCommand failed: ${command}\x1b[0m`);
        return null;
    }
}

function parseEnvContent(content) {
    const lines = content.split('\n');
    const env = {};
    lines.forEach(line => {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
            const index = trimmed.indexOf('=');
            const key = trimmed.substring(0, index).trim();
            const value = trimmed.substring(index + 1).trim().replace(/^["']|["']$/g, '');
            if (key) env[key] = value;
        }
    });
    return env;
}

async function migrate() {
    console.log('\x1b[32mStarting Migration to GCP Secret Manager...\x1b[0m');

    // 1. Enable API
    console.log('\x1b[34mEnabling Secret Manager API...\x1b[0m');
    run(`gcloud services enable secretmanager.googleapis.com --project ${PROJECT_ID}`);

    const allSecrets = {};

    // 2. Decrypt and collect secrets
    FILES.forEach(file => {
        if (!fs.existsSync(file)) return;
        console.log(`\x1b[34mProcessing ${file}...\x1b[0m`);
        const content = run(`gpg --batch --yes --pinentry-mode loopback --passphrase ${PASSPHRASE} -d ${file}`, true);
        const env = parseEnvContent(content);
        
        for (const [key, value] of Object.entries(env)) {
            const isSecret = key.includes('PASSWORD') || key.includes('SECRET') || key.includes('TOKEN') || key.includes('KEY');
            if (isSecret) {
                // For this migration, we store the most recent value found
                allSecrets[key] = value;
            }
        }
    });

    // Add the GPG passphrase itself
    allSecrets['GPG_PASSPHRASE'] = PASSPHRASE;

    // 3. Upload to GCP
    console.log(`\x1b[34mUploading ${Object.keys(allSecrets).length} secrets to GCP...\x1b[0m`);
    for (const [key, value] of Object.entries(allSecrets)) {
        console.log(`\x1b[36mProcessing secret: ${key}\x1b[0m`);
        
        // Check if secret exists
        const exists = run(`gcloud secrets describe ${key} --project ${PROJECT_ID}`, true);
        
        if (!exists) {
            run(`gcloud secrets create ${key} --replication-policy="automatic" --project ${PROJECT_ID}`);
        }
        
        // Add new version
        run(`echo -n "${value}" | gcloud secrets versions add ${key} --data-file=- --project ${PROJECT_ID}`);
    }

    console.log('\x1b[32m\nMigration to GCP Secret Manager Complete!\x1b[0m');
}

migrate();
