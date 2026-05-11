#!/usr/bin/env node
/**
 * Scripts/migrate-environments.js
 * Automates the migration of local .env files to GitHub Environments.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO = 'xmione/badminton_court';

function run(command) {
    console.log(`\x1b[36mRunning: ${command}\x1b[0m`);
    try {
        return execSync(command, { stdio: 'inherit', encoding: 'utf8' });
    } catch (e) {
        console.error(`\x1b[31mCommand failed: ${command}\x1b[0m`);
        return null;
    }
}

function parseEnv(filePath) {
    if (!fs.existsSync(filePath)) {
        console.log(`\x1b[33mWarning: ${filePath} not found.\x1b[0m`);
        return {};
    }
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n');
    const env = {};
    lines.forEach(line => {
        // Simple parser: skip comments and empty lines, split on first '='
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
    console.log('\x1b[32mStarting Migration to GitHub Environments...\x1b[0m');

    // 1. Check gh auth
    try {
        execSync('gh auth status', { stdio: 'ignore' });
    } catch (e) {
        console.error('\x1b[31mError: GitHub CLI is not authenticated. Run "gh auth login" first.\x1b[0m');
        process.exit(1);
    }

    // 2. Create Environments
    console.log('\x1b[34mCreating GitHub Environments...\x1b[0m');
    run(`gh api -X PUT repos/${REPO}/environments/development`);
    run(`gh api -X PUT repos/${REPO}/environments/docker-production`);

    // 3. Migrate .env.dev to development environment
    console.log('\x1b[34mMigrating .env.dev to "development" environment...\x1b[0m');
    const devVars = parseEnv('.env.dev');
    for (const [key, value] of Object.entries(devVars)) {
        // GitHub Variables have size limits and rules. 
        // For simplicity, we upload all as variables unless they look like secrets.
        // Usually, passwords/keys should be secrets, but gh variable set is easier for this demo.
        const isSecret = key.includes('PASSWORD') || key.includes('SECRET') || key.includes('TOKEN') || key.includes('KEY');
        if (isSecret) {
            run(`gh secret set ${key} --env development --body "${value}" --repo ${REPO}`);
        } else {
            run(`gh variable set ${key} --env development --body "${value}" --repo ${REPO}`);
        }
    }

    // 4. Migrate .env.docker to docker-production environment
    console.log('\x1b[34mMigrating .env.docker to "docker-production" environment...\x1b[0m');
    const dockerVars = parseEnv('.env.docker');
    for (const [key, value] of Object.entries(dockerVars)) {
        const isSecret = key.includes('PASSWORD') || key.includes('SECRET') || key.includes('TOKEN') || key.includes('KEY');
        if (isSecret) {
            run(`gh secret set ${key} --env docker-production --body "${value}" --repo ${REPO}`);
        } else {
            run(`gh variable set ${key} --env docker-production --body "${value}" --repo ${REPO}`);
        }
    }

    // 5. Migrate GPG Passphrase
    if (fs.existsSync('env.passphrase.txt')) {
        console.log('\x1b[34mMigrating GPG passphrase to GitHub Secrets...\x1b[0m');
        const passphrase = fs.readFileSync('env.passphrase.txt', 'utf8').trim();
        run(`gh secret set GPG_PASSPHRASE --body "${passphrase}" --repo ${REPO}`);
    }

    console.log('\x1b[32m\nMigration Complete!\x1b[0m');
    console.log('\x1b[33mNext Steps: Update GoCD pipelines to use "gh variable list --env <env>" to generate .env files.\x1b[0m');
}

migrate();
