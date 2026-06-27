#!/usr/bin/env node
/**
 * Scripts/menu.js
 * Modular menu engine driven by JSON configuration.
 * Each option is a separate script in options/.
 * Uses a single readline interface to prevent double-character input.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const os = require('os');
const dotenv = require('dotenv');

// ----- Load environment -----
dotenv.config({ path: path.join(__dirname, '..', '.env.docker') });

const isWindows = os.platform() === "win32";
global.isWindows = isWindows;

// ----- SINGLE readline interface (reused throughout) -----
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

// ----- Shared helpers (must use the same rl) -----
function ask(question) {
  return new Promise(resolve => {
    rl.question(`\x1b[33m${question}\x1b[0m`, answer => {
      resolve(answer.trim());
    });
  });
}

async function pause() {
  await ask('Press Enter to continue...');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function runCommand(cmd, options = {}) {
  try {
    return execSync(cmd, {
      cwd: path.join(__dirname, '..'),
      encoding: 'utf8',
      stdio: options.stdio || 'inherit',
      ...options
    });
  } catch (error) {
    console.error(`\x1b[31mCommand failed: ${cmd}\x1b[0m`);
    return { success: false, error: error.message };
  }
}

function openUrl(url) {
  let cmd = isWindows ? `start ${url}` : (os.platform() === 'darwin' ? `open ${url}` : `xdg-open ${url}`);
  runCommand(cmd, { stdio: 'ignore' });
}

// ----- Load menu configuration JSON files -----
let sections = [];
let options = [];
let requirements = {};
let basePatterns = [];

try {
  sections = require('./menu_sections.json');
  options = require('./menu_options.json');
  requirements = require('./menu_requirements.json');
  basePatterns = require('./base_patterns.json');
} catch (e) {
  console.error('\x1b[31mFailed to load one or more menu configuration JSON files.\x1b[0m');
  console.error(e.message);
  process.exit(1);
}

// ----- Build context object for old handler modules (if needed) -----
const PROJECT_ROOT = path.join(__dirname, '..');
const GOCD_USER = process.env.GOCD_ADMIN_USERNAME;
const GOCD_PASS = process.env.GOCD_ADMIN_PASSWORD;
const GOCD_PROTO = process.env.GOCD_SERVER_URL_PROTOCOL;
const GOCD_HOST = process.env.GOCD_SERVER_URL_HOST;
const GOCD_PORT = process.env.GOCD_SERVER_PORT;
const GOCD_BASE = (GOCD_PROTO && GOCD_HOST && GOCD_PORT)
  ? `${GOCD_PROTO}://${GOCD_HOST}:${GOCD_PORT}`
  : '';
const GCP_PROJECT_ID = process.env.GCP_PROJECT_ID;
const GCP_ZONE = process.env.GCP_ZONE;
const GCP_VM_NAME = process.env.GCP_VM_NAME;
const GCP_VM_IP = process.env.GCP_VM_IP;
const VM_SSH_USER = process.env.VM_SSH_USER;

const ctx = {
  sh: runCommand,
  log: console.log,
  ask,
  pause,
  execSync,
  openUrl,
  sleep,
  isWindows,
  PROJECT_ROOT,
  GOCD_BASE,
  GOCD_USER,
  GOCD_PASS,
  GOCD_PORT,
  GCP_PROJECT_ID,
  GCP_ZONE,
  GCP_VM_NAME,
  GCP_VM_IP,
  VM_SSH_USER,
  SSH_USER: VM_SSH_USER,
  VM_IP: GCP_VM_IP,
  STAGING_APP_URL: GCP_VM_IP
    ? `https://${GCP_VM_IP}:8443`
    : (process.env.STAGING_APP_URL || ''),
  PRODUCTION_APP_URL: GCP_VM_IP
    ? `https://${GCP_VM_IP}:9443`
    : (process.env.PRODUCTION_APP_URL || ''),
  SSH_KEY_PATH: path.join(__dirname, '..', 'secrets', 'agent-key'),
  setErrorDisplayed: () => {},
  errorDisplayed: false,
  rl  // pass the same rl for consistency
};

// ----- Menu display (driven by JSON) -----
async function showMenu() {
  while (true) {
    // Optional: clear screen
    // process.stdout.write('\x1Bc');
    console.log('\x1b[32mGoCD Management Menu (.js)\x1b[0m');
    console.log('\x1b[32m===========================\x1b[0m\n');

    sections.forEach(section => {
      console.log(`\x1b[36m${section.id}. ${section.name}\x1b[0m`);
      options.filter(o => o.section === section.id).forEach(o => {
        console.log(`   ${o.id}. ${o.name}`);
      });
      console.log('');
    });

    console.log('\x1b[30m0. Exit\x1b[0m\n');
    console.log('\x1b[32m===============================\x1b[0m');
    console.log('\x1b[32mGoCD Management Menu (.js)\x1b[0m');
    console.log('\x1b[32m===============================\x1b[0m\n');

    const choice = await ask('Select an option: ');
    if (choice === '0') {
      rl.close();
      process.exit(0);
    }

    // Validate environment variables
    const required = requirements[choice];
    if (required) {
      const missing = required.filter(v => !process.env[v]);
      if (missing.length > 0) {
        console.error('\x1b[31mERROR: Missing required environment variables:\x1b[0m\n' +
          missing.map(v => `  - ${v}`).join('\n'));
        console.error('\nPlease define them in your .env.docker file.');
        await pause();
        continue;
      }
    }

    // Execute the option script
    const option = options.find(o => o.id === choice);
    if (!option) {
      console.log('\x1b[31mInvalid option.\x1b[0m');
      await pause();
      continue;
    }

    const scriptPath = path.join(__dirname, 'options', `option_${choice}.js`);
    if (!fs.existsSync(scriptPath)) {
      console.log(`\x1b[31mOption script not found: option_${choice}.js\x1b[0m`);
      await pause();
      continue;
    }

    try {
      const scriptFunc = require(scriptPath);
      // Provide helpers to the option script
      const helpers = {
        runCommand,
        ask,
        pause,
        execSync,
        fs,
        path,
        isWindows,
        sleep,
        os,
        ctx  // pass the full context for old handlers
      };
      await scriptFunc(helpers);
    } catch (err) {
      console.error('\x1b[31mUnexpected error:\x1b[0m', err.message);
    }
    await pause();
  }
}

// ----- Main entry -----
async function main() {
  if (process.env.GCP_SA_KEY_PATH) {
    const keyPath = path.isAbsolute(process.env.GCP_SA_KEY_PATH)
      ? process.env.GCP_SA_KEY_PATH
      : path.join(__dirname, '..', process.env.GCP_SA_KEY_PATH);
    if (fs.existsSync(keyPath)) {
      process.env.GOOGLE_APPLICATION_CREDENTIALS = keyPath;
    }
  }
  await showMenu();
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});