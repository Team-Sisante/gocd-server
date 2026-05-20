#!/usr/bin/env node
/**
 * Scripts/menu.js
 * Cross-platform GoCD Management Menu – slim dispatcher.
 * All large feature blocks live in the menu/ folder.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const os = require('os');
const dotenv = require('dotenv');

// Load environment
dotenv.config({ path: path.join(__dirname, '..', '.env.docker') });
// --- DEBUG START ---
// console.log('DEBUG: GOCD_API_TOKEN =', process.env.GOCD_API_TOKEN ? 'SET' : 'NOT SET');
// console.log('DEBUG: looking in file:', path.join(__dirname, '..', '.env.docker'));
// if (process.env.GOCD_API_TOKEN) {
//     console.log('       token first 8 chars:', process.env.GOCD_API_TOKEN.substring(0, 8) + '...');
// }
// --- DEBUG END ---
// ----- Validate required environment variables -----
const requiredVars = [
    'GOCD_ADMIN_USERNAME', 'GOCD_ADMIN_PASSWORD',
    'GOCD_SERVER_URL_PROTOCOL', 'GOCD_SERVER_URL_HOST', 'GOCD_SERVER_PORT',
    'GCP_PROJECT_ID', 'GCP_ZONE', 'GCP_VM_NAME',
    'GCP_VM_IP', 'VM_SSH_USER'          // ← added, no defaults anymore
];
const missingVars = requiredVars.filter(v => !process.env[v]);
if (missingVars.length > 0) {
    console.error('\x1b[31mERROR: The following required environment variables are missing:\x1b[0m\n' +
        missingVars.map(v => `  - ${v}`).join('\n'));
    console.error('\nPlease define them in your .env.docker file.');
    process.exit(1);
}

// ----- Load custom error patterns from errorTrigger.json -----
const errorTriggerPath = path.join(__dirname, 'errorTrigger.json');
let customPatterns = [];
if (fs.existsSync(errorTriggerPath)) {
    try {
        customPatterns = JSON.parse(fs.readFileSync(errorTriggerPath, 'utf8'));
        if (!Array.isArray(customPatterns)) customPatterns = [];
    } catch (e) {
        console.error('\x1b[31mFailed to parse errorTrigger.json:\x1b[0m', e.message);
    }
}
const basePatterns = [
    'error', 'fail', 'fatal', 'exception', 'denied',
    'caused\\s+by', 'invalid', 'wrapper stopped', 'gosu exited',
    'exited with code', 'there are errors', 'could not connect', 'permission denied'
];
const ALL_PATTERNS = [...basePatterns, ...customPatterns];
const errorKeywords = new RegExp(ALL_PATTERNS.join('|'), 'i');
const errorTrigger = new RegExp('^(ERROR|FATAL)\\s|' + ALL_PATTERNS.join('|'), 'i');

// ----- Derived configuration (no defaults for required vars) -----
const GOCD_USER = process.env.GOCD_ADMIN_USERNAME;
const GOCD_PASS = process.env.GOCD_ADMIN_PASSWORD;
const GOCD_PROTO = process.env.GOCD_SERVER_URL_PROTOCOL;
const GOCD_HOST  = process.env.GOCD_SERVER_URL_HOST;
const GOCD_PORT  = process.env.GOCD_SERVER_PORT;
const GOCD_BASE  = `${GOCD_PROTO}://${GOCD_HOST}:${GOCD_PORT}`;
const GCP_PROJECT_ID = process.env.GCP_PROJECT_ID;
const GCP_ZONE       = process.env.GCP_ZONE;
const GCP_VM_NAME    = process.env.GCP_VM_NAME;
const GCP_VM_IP      = process.env.GCP_VM_IP;          // required now
const VM_SSH_USER    = process.env.VM_SSH_USER;        // required now
const SITE_URL       = process.env.SITE_URL || '';

const PROJECT_ROOT = path.join(__dirname, '..');
const isWindows = os.platform() === 'win32';

// ----- Shared helpers -----
function log(msg, color = '\x1b[36m') { console.log(`${color}%s\x1b[0m`, msg); }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function sh(cmd, options = {}) {
    try {
        return execSync(cmd, {
            cwd: PROJECT_ROOT,
            encoding: 'utf8',
            stdio: options.stdio || 'inherit',
            ...options
        });
    } catch (error) {
        if (!options.silent) {
            console.error('\x1b[31m%s\x1b[0m', `Command failed: ${cmd}`);
        }
        errorDisplayed = true;   // ← ADD THIS LINE
        return { success: false, error: error.message };
    }
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
function ask(question) {
    return new Promise(resolve => rl.question(`\x1b[33m${question}\x1b[0m`, a => resolve(a.trim())));
}
async function pause() { await ask('Press Enter to continue...'); }
function openUrl(url) {
    let cmd = isWindows ? `start ${url}` : (os.platform() === 'darwin' ? `open ${url}` : `xdg-open ${url}`);
    try { sh(cmd, { stdio: 'ignore' }); } catch (e) { log(`Could not open browser. Manually visit: ${url}`, '\x1b[33m'); }
}

// Module-level error flag (prevents screen clear)
let errorDisplayed = false;
function setErrorDisplayed(val) { errorDisplayed = val; }

// ----- Import modular handlers -----
const triggerPipeline     = require('./menu/triggerPipeline');
const containerLogs       = require('./menu/containerLogs');
const containerManagement = require('./menu/containerManagement');
const pipelineManagement  = require('./menu/pipelineManagement');
const systemUtilities     = require('./menu/systemUtilities');
const dockerTroubleshoot  = require('./menu/dockerTroubleshoot');
const vmSetup             = require('./menu/vmSetup');

// ----- Main menu loop -----
async function showMenu() {
    while (true) {
        try {
            if (!errorDisplayed) process.stdout.write('\x1Bc');
            errorDisplayed = false;

            // ---------- Menu display (unchanged) ----------
            console.log('\x1b[32mGoCD Management Menu (.js)\x1b[0m');
            console.log('\x1b[32m===========================\x1b[0m\n');
            console.log('\x1b[36m1. CONTAINER MANAGEMENT\x1b[0m');
            console.log('   1.1. Update/Restart GoCD (Fast Build)');
            console.log('   1.2. Get Docker container errors');
            console.log('   1.3. Validate GoCD environment');
            console.log('   1.4. View container logs');
            console.log('   1.5. Stop all containers');
            console.log('   1.6. SYSTEM HARD RESET (Full Wipe via go.js)');
            console.log('   1.7. Restart Docker Desktop (full restart)');
            console.log('   1.8. Restart Docker Engine only');
            console.log('   1.9. Container selector (logs / errors)');
            console.log('\n\x1b[36m2. PIPELINE MANAGEMENT\x1b[0m');
            console.log('   2.1. Trigger badminton_court pipeline');
            console.log('   2.2. View pipeline history');
            console.log('   2.3. Unlock pipeline');
            console.log('\n\x1b[36m3. AGENT MANAGEMENT\x1b[0m');
            console.log('   3.1. View agent status');
            console.log('   3.2. Enable agent');
            console.log('   3.3. Disable agent');
            console.log('\n\x1b[36m4. SYSTEM UTILITIES\x1b[0m');
            console.log('   4.1. Encrypt .env files');
            console.log('   4.2. Decrypt .env files');
            console.log('   4.3. Open GoCD web interface');
            console.log('   4.4. View system resources');
            console.log('   4.5. Clean up Docker resources');
            console.log('   4.6. Print Project Folder Structure');
            console.log('   4.7. Sync Master with Feature Branch');
            console.log('   4.8. Fix NODE_OPTIONS error');
            console.log('   4.9. Reset GoCD admin password (from .env.docker)');
            console.log('   4.10. Update .env.docker password from GoCD container');
            console.log('   4.11. Display & test GoCD admin credentials');
            console.log('\n\x1b[36m5. TROUBLE-SHOOT CONTAINERS\x1b[0m');
            console.log('   5.1. Rebuild and Re-start gocd-server container');
            console.log('   5.2. Rebuild and Re-start gocd-agent-1 container');
            console.log('   5.3. Rebuild and Re-start gocd-agent-2 container');
            console.log('   5.4. Rebuild and Re-start gocd-agent-3 container');
            console.log('   5.5. View container logs');
            console.log('\x1b[36m6. GCP VM SETUP\x1b[0m');
            console.log('   6.1. Create deployment VM');
            console.log('   6.2. Configure firewall rules');
            console.log('   6.3. Setup agent SSH keys');
            console.log('   6.4. Wait / Verify tools on VM');
            console.log('   6.5. Setup GCP Secret Manager access for agent');
            console.log('   6.6. Check VM running & reachable');
            console.log('   6.7. Apply pipeline configuration to GoCD');
            console.log('   6.8. Deploy application');
            console.log('   6.9. Monitor VM status');
            console.log('   6.10. Grant agent VM read access (one‑time setup)');
            console.log('   6.11. Export VM settings to YAML');
            console.log('   6.12. Delete VM');
            console.log('   6.13. Create VM from saved YAML');
            console.log('   6.14. Recreate fresh VM (export → delete → create)');
            console.log('   6.15. Run full post‑creation setup');
            console.log('   6.16. View logs of a service (interactive)');
            console.log('   6.17. Restart a service (interactive)');
            console.log('   6.18. Open staging app in browser');
            console.log('   6.19. Health check staging app');
            console.log('   6.20. Clear SSH host key for VM');
            console.log('   6.21. Connect to VM via SSH');
            console.log('   6.22. Create new VM & run full setup (one‑step)');
            console.log('   6.23. List all VMs (project-wide)');
            console.log('   6.24. Clean up Docker disk space on staging VM');       
            console.log('   6.25. Open production app in browser');                 
            console.log('\n\x1b[36m0. Exit\x1b[0m\n');

            const choice = await ask('Select an option: ');

            // Build context object – no defaults for environment variables
            const ctx = {
                sh, log, ask, pause, execSync, openUrl, sleep, isWindows, PROJECT_ROOT,
                GOCD_BASE, GOCD_USER, GOCD_PASS, GCP_PROJECT_ID, GCP_ZONE, GCP_VM_NAME,
                GCP_VM_IP, VM_SSH_USER,
                // Aliases used by vmSetup and other SSH‑based options
                SSH_USER: VM_SSH_USER,
                VM_IP:   GCP_VM_IP,
                STAGING_APP_URL: process.env.STAGING_APP_URL,       
                PRODUCTION_APP_URL: process.env.PRODUCTION_APP_URL,  
                rl, setErrorDisplayed, errorDisplayed,
                SSH_KEY_PATH: path.join(__dirname, '..', 'secrets', 'agent-key')
            };

            switch (choice) {
                case '1.1': case '1.2': case '1.3': case '1.4':
                case '1.5': case '1.6': case '1.7': case '1.8':
                    await containerManagement[choice](ctx); break;
                case '1.9':
                    await containerLogs.selectContainerAndAct(ctx); break;
                case '2.1':
                    await triggerPipeline(ctx); break;
                case '2.2': case '2.3':
                    await pipelineManagement[choice](ctx); break;
                case '3.1': case '3.2': case '3.3':
                    await pipelineManagement[choice](ctx); break;
                case '4.1': case '4.2': case '4.3': case '4.4':
                case '4.5': case '4.6': case '4.7': case '4.8':
                case '4.9': case '4.10': case '4.11':
                    await systemUtilities[choice](ctx); break;
                case '5.1': case '5.2': case '5.3': case '5.4': case '5.5':
                    await dockerTroubleshoot[choice](ctx); break;
                case '6.1': case '6.2': case '6.3': case '6.4':
                case '6.5': case '6.6': case '6.7': case '6.8':
                case '6.9': case '6.10': case '6.11': case '6.12':
                case '6.13': case '6.14': case '6.15': case '6.16':
                case '6.17': case '6.18': case '6.19': case '6.20':
                case '6.21': case '6.22': case '6.23': case '6.24': 
                case '6.25':
                    await vmSetup[choice](ctx); break;
                case '0':
                    rl.close();
                    process.exit(0);
                default:
                    log('Invalid option.', '\x1b[31m');
                    await pause();
            }
        } catch (err) {
            errorDisplayed = true;
            process.stdout.write('\x1Bc');
            console.error('\x1b[31m⚠️  An unexpected error occurred:\x1b[0m');
            console.error(err);
            console.log('\x1b[33m');
            await ask('Press Enter to return to the menu...');
        }
    }
}

(async () => {
    console.log('\x1b[36mGoCD Management Menu is starting...\x1b[0m');
    await new Promise(r => setTimeout(r, 2000));
    await showMenu();
})().catch(async (err) => {
    console.error(err);
    await ask('Press Enter to return to the menu...');
    rl.close();
    process.exit(1);
});