#!/usr/bin/env node
/**
 * health-check.js – Juggernaut-grade health check & detection for all deployed sites.
 *
 * It performs comprehensive diagnostics and generates a JSON report of detected issues.
 * The script runs on the GoCD agent (or locally) and interacts with the target VM
 * via SSH and GCP APIs.
 *
 * Main steps:
 * 1. Fetches required environment variables (secrets from GCP Secret Manager,
 *    configuration from GitHub Environments) for each site.
 * 2. Checks GCP backend health for each site.
 * 3. Checks container status (exists, running, healthy) on the VM.
 * 4. Checks actual site response via HTTPS (curl).
 * 5. Detects issues based on case_solution.json and stores them in a report.
 * 6. Saves the report to health-checks/health_report.json.
 *
 * Usage:
 *   node health-check.js [--debug] [site-id ...]
 *   --debug   Show SSH commands and detailed debug output.
 *   site-id   Optional list of site IDs to check (e.g., humrine-staging).
 *             If none provided, interactive selection is shown.
 */

const { execSync, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const readline = require('readline');
const os = require('os');

// ----- Debug mode (off by default) -----
let SCRIPT_DEBUG = false;

// ----- Import shared module -----
const common = require('./health_common');

// ----- Configuration -----
const REPORT_DIR = path.join(__dirname, 'health-checks');
const REPORT_FILE = path.join(REPORT_DIR, 'health_report.json');
const LOG_DIR = REPORT_DIR;

// ----- Setup logging (for debug) -----
const now = new Date();
const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthAbbr = months[now.getMonth()];
const day = String(now.getDate()).padStart(2, '0');
const year = now.getFullYear();
const hours = String(now.getHours()).padStart(2, '0');
const minutes = String(now.getMinutes()).padStart(2, '0');
const seconds = String(now.getSeconds()).padStart(2, '0');
const logFileName = `health_check-${monthAbbr}-${day}-${year}-${hours}-${minutes}-${seconds}.log`;
const logFilePath = path.join(LOG_DIR, logFileName);

const logStream = fs.createWriteStream(logFilePath, { flags: 'a' });

const originalLog = console.log;
const originalError = console.error;
const originalWarn = console.warn;
const originalInfo = console.info;

function writeToLog(level, args) {
    const timestamp = new Date().toISOString();
    const message = args.map(arg => typeof arg === 'string' ? arg : JSON.stringify(arg)).join(' ');
    logStream.write(`[${timestamp}] [${level}] ${message}\n`);
    originalLog.apply(console, args);
}

console.log = (...args) => { writeToLog('INFO', args); };
console.error = (...args) => { writeToLog('ERROR', args); };
console.warn = (...args) => { writeToLog('WARN', args); };
console.info = (...args) => { writeToLog('INFO', args); };

process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
    logStream.end();
    process.exit(1);
});

process.on('exit', () => { logStream.end(); });

// ----- Load environment -----
const dotenv = require('dotenv');
dotenv.config({ path: path.join(__dirname, '..', '.env.docker') });

console.log(`📝 Logging to: ${logFilePath}`);
console.log('GCP_SA_KEY_PATH from env:', process.env.GCP_SA_KEY_PATH);

// ----- Load case_solution.json -----
let caseSolutions = { cases: [] };
try {
    caseSolutions = require('./case_solution.json');
    console.log(`✅ Loaded ${caseSolutions.cases.length} case definitions.`);
} catch (e) {
    console.warn('⚠️  case_solution.json not found – proceeding without case-based repair.');
}

// ----- Set debug flag for common module -----
common.setDebug(SCRIPT_DEBUG);

// ----- Interactive prompt (using a shared readline) -----
function ask(rl, question) {
    return new Promise(resolve => rl.question(question, answer => resolve(answer.trim())));
}

async function selectSites(args, rl) {
    const allIds = common.SITES.map(s => s.id);
    if (args.includes('--all')) return common.SITES;
    const requested = args.filter(arg => allIds.includes(arg));
    if (requested.length > 0) return common.SITES.filter(s => requested.includes(s.id));

    console.log('\nAvailable sites:');
    common.SITES.forEach((s, idx) => console.log(`  ${idx + 1}. ${s.name} (${s.id})`));
    console.log('  a. All sites');
    console.log('  q. Quit\n');

    const answer = await ask(rl, 'Enter numbers (comma-separated, e.g., 1,3) or "a" for all: ');
    if (answer.toLowerCase() === 'q') process.exit(0);
    if (answer.toLowerCase() === 'a') return common.SITES;

    const indices = answer.split(',').map(n => parseInt(n.trim()));
    const selected = indices.filter(i => i >= 1 && i <= common.SITES.length).map(i => common.SITES[i - 1]);
    return selected.length > 0 ? selected : common.SITES;
}

// ----- Shortcuts from common -----
const remoteExec = common.remoteExec;
const remoteExecSilent = common.remoteExecSilent;
const remoteExecWithEnv = common.remoteExecWithEnv;
const remoteExecLive = common.remoteExecLive;

// ----- Site checks -----
function checkSiteResponse(url, siteName) {
    console.log(`   🌐 Checking site response for ${siteName} (${url})...`);
    const cmd = `curl -s -o /dev/null -w "%{http_code}" --connect-timeout 10 ${url}`;
    const result = remoteExecSilent(cmd);
    if (!result.success || !result.output) {
        console.log(`   ❌ Site unreachable (no response).`);
        return null;
    }
    const status = parseInt(result.output.trim());
    console.log(`   → HTTP Status: ${status}`);
    return status;
}

function getNginxLogs(nginxContainer, lines = 20) {
    if (!nginxContainer) return null;
    return common.getContainerLogs(nginxContainer, lines);
}

function runGcloud(cmd) {
    try {
        const fullCmd = `gcloud compute backend-services get-health ${cmd} --global --project=${common.GCP_PROJECT_ID}`;
        const output = execSync(fullCmd, { encoding: 'utf8', stdio: 'pipe' });
        return output.trim();
    } catch (error) { return null; }
}

/**
 * Checks if the database container for a site is up.
 * DB container name is always 'db-<target>' (e.g. db-staging, db-production).
 */
function getDBContainerStatus(site) {
    const dbContainer = `db-${site.target}`;
    const cmd = `sudo docker ps -a --filter name=${dbContainer} --format '{{.Status}}'`;
    const result = remoteExecSilent(cmd);
    if (!result.success || !result.output) {
        return { exists: false, running: false };
    }
    const status = result.output.trim();
    return { exists: true, running: status.startsWith('Up') };
}

/**
 * Checks if the VM is authenticated to ghcr.io.
 * Returns false if pull fails with "unauthorized" or "denied", true otherwise.
 */
function checkRegistryAuth(env) {
    const testImage = `ghcr.io/${env.GIT_REPO_USERNAME || 'team-sisante'}/${env.GIT_REPO_REPONAME || 'humrine_site'}-web:latest`;
    const cmd = `sudo docker pull ${testImage} 2>&1`;
    const result = remoteExecSilent(cmd, null);
    if (!result.success || (result.output && (result.output.includes('unauthorized') || result.output.includes('denied')))) {
        return false;
    }
    return true;
}

// ----- Main check (detection only) -----
async function checkSite(site, rl) {
    const { name, backend, webContainer, url, nginxContainer, target } = site;

    // Pass rl so the user is asked about cache
    const env = await common.fetchAllVars(site, false, rl);
    if (Object.keys(env).length === 0) {
        console.log(`❌ No environment variables fetched for ${name}. Aborting.`);
        return null;
    }

    console.log(`\n🔍 Checking ${name} (${backend})...`);

    const gcpHealth = runGcloud(backend);
    const gcpHealthy = gcpHealth && gcpHealth.includes('HEALTHY');
    console.log(`   → GCP backend: ${gcpHealthy ? '✅ HEALTHY' : '❌ UNHEALTHY'}`);

    // ---- NEW: check database container ----
    const dbInfo = getDBContainerStatus(site);
    const dbRunning = dbInfo.exists && dbInfo.running;
    console.log(`   → Database container db-${target}: ${dbRunning ? 'UP' : 'DOWN/MISSING'}`);

    const containerInfo = common.getContainerStatus(site);
    console.log(`   → Container ${webContainer}: ${containerInfo.exists ? containerInfo.status : 'MISSING'}`);

    const httpStatus = checkSiteResponse(url, name);

    const logs = common.getContainerLogs(webContainer);
    const nginxLogs = getNginxLogs(nginxContainer);

    const siteStatus = {
        containerExists: containerInfo.exists,
        containerRunning: containerInfo.running,
        containerUnhealthy: containerInfo.unhealthy || false,
        containerRestarting: containerInfo.exists && !containerInfo.running && containerInfo.status && containerInfo.status.includes('Restarting'),
        httpStatus,
        gcpHealthy,
        logs,
        nginxLogs,
        dbRunning,
    };

    const detectedCases = [];

    // ---- NEW: detect database container issues ----
    if (!dbRunning) {
        detectedCases.push({
            id: 'db_stopped',
            description: 'Database container is missing or stopped',
        });
    }

    // ---- NEW: detect registry authentication issues ----
    if (!checkRegistryAuth(env)) {
        detectedCases.push({
            id: 'registry_auth_missing',
            description: 'Docker registry (ghcr.io) authentication missing on VM',
        });
    }

    // ---- existing case detection from case_solution.json ----
    for (const caseDef of caseSolutions.cases) {
        const detect = caseDef.detect;
        let matches = true;

        if (detect.container_status) {
            const status = detect.container_status;
            if (status === 'missing' && siteStatus.containerExists) matches = false;
            if (status === 'stopped' && (siteStatus.containerRunning || !siteStatus.containerExists)) matches = false;
            if (status === 'running' && !siteStatus.containerRunning) matches = false;
            if (status === 'unhealthy' && !siteStatus.containerUnhealthy) matches = false;
        }
        if (detect.http_status && siteStatus.httpStatus !== detect.http_status) matches = false;
        if (detect.log_pattern && siteStatus.logs) {
            if (!new RegExp(detect.log_pattern, 'i').test(siteStatus.logs)) matches = false;
        }
        if (detect.nginx_log_pattern && siteStatus.nginxLogs) {
            if (!new RegExp(detect.nginx_log_pattern, 'i').test(siteStatus.nginxLogs)) matches = false;
        }
        if (detect.container_restarting && !siteStatus.containerRestarting) matches = false;

        if (matches) detectedCases.push(caseDef);
    }

    if (detectedCases.length === 0) {
        console.log(`   ✅ No issues detected.`);
    } else {
        console.log(`   🔍 Detected ${detectedCases.length} issue(s):`);
        detectedCases.forEach(c => console.log(`     - ${c.description} (${c.id})`));
    }

    return {
        id: site.id,
        name: site.name,
        timestamp: new Date().toISOString(),
        status: detectedCases.length === 0 ? 'HEALTHY' : 'UNHEALTHY',
        http_status: httpStatus,
        container_status: containerInfo.status || 'MISSING',
        gcp_healthy: gcpHealthy,
        detected_cases: detectedCases.map(c => ({
            case_id: c.id,
            description: c.description,
            log_sample: (c.detect && c.detect.log_pattern && siteStatus.logs) ? siteStatus.logs.slice(0, 200) : null,
        })),
        treated_at: null,
        treatment_status: 'PENDING'
    };
}

// ----- Write report -----
function writeReport(reportData) {
    if (!fs.existsSync(REPORT_DIR)) fs.mkdirSync(REPORT_DIR, { recursive: true });
    fs.writeFileSync(REPORT_FILE, JSON.stringify(reportData, null, 2), 'utf8');
    console.log(`\n📄 Report saved to: ${REPORT_FILE}`);
}

// ----- Main -----
async function main() {
    const args = process.argv.slice(2);
    const debug = args.includes('--debug') || args.includes('-d');
    if (debug) {
        SCRIPT_DEBUG = true;
        common.setDebug(true);
        console.log('🐞 Debug mode enabled – SSH commands will be printed.');
    }

    // Single readline for the whole session
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    const selectedSites = await selectSites(args, rl);
    console.log(`🏥 Running health checks (detection only)...`);
    console.log(`📋 Selected sites: ${selectedSites.map(s => s.name).join(', ')}\n`);

    const report = { timestamp: new Date().toISOString(), sites: [] };

    for (const site of selectedSites) {
        const entry = await checkSite(site, rl);
        if (entry) report.sites.push(entry);
    }

    rl.close();

    writeReport(report);

    console.log('\n' + '='.repeat(50));
    const unhealthy = report.sites.filter(s => s.status === 'UNHEALTHY');
    if (unhealthy.length === 0) {
        console.log('✅ All selected sites are HEALTHY.');
    } else {
        console.log(`❌ ${unhealthy.length} site(s) are UNHEALTHY.`);
        console.log('   Run treatment (menu 6.40) to fix issues.');
    }

    process.exit(unhealthy.length === 0 ? 0 : 1);
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});