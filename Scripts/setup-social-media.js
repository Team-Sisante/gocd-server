#!/usr/bin/env node
/**
 * Scripts/setup-social-media.js
 * Validates and manages social media application configurations
 * based on configuration in Scripts/social-media.json.
 *
 * Usage:
 *   node Scripts/setup-social-media.js <app_name> <environment>
 *   e.g., node Scripts/setup-social-media.js humrine_site staging
 */

const fs = require('fs');
const path = require('path');

// ----- Load Configuration -----
const appName = process.argv[2];
const envName = process.argv[3];

if (!appName || !envName) {
  console.error('\x1b[31mERROR: Missing arguments. Usage: node Scripts/setup-social-media.js <app_name> <environment>\x1b[0m');
  process.exit(1);
}

const configPath = path.join(__dirname, 'social-media.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

if (!config[appName] || !config[appName][envName]) {
  console.error(`\x1b[31mERROR: Configuration for '${appName}' in '${envName}' not found.\x1b[0m`);
  process.exit(1);
}

const conf = config[appName][envName];

// ----- Validation -----
console.log(`\x1b[32mValidating Social Media Config for ${appName} (${envName})...\x1b[0m
`);

const missing = [];
const validated = {};

for (const [key, value] of Object.entries(conf)) {
    // Extract varName from ${VAR_NAME}
    const match = value.match(/\${(\w+)}/);
    const varName = match ? match[1] : null;

    if (varName && process.env[varName]) {
        validated[key] = process.env[varName];
        console.log(`\x1b[32m✅ ${key} is set\x1b[0m`);
    } else {
        missing.push(key);
        console.error(`\x1b[31m❌ ${key} is MISSING (expected env var: ${varName || 'hardcoded'})\x1b[0m`);
    }
}

console.log('\n-----------------------------------');
if (missing.length === 0) {
    console.log('\x1b[32m✅ All social media configurations are valid!\x1b[0m');
} else {
    console.log(`\x1b[31m❌ Configuration incomplete. Please set the missing variables in .env.\x1b[0m`);
    process.exit(1);
}
