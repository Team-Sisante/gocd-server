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
const https = require('https');
const readline = require('readline');
const os = require('os');

// ----- Debug mode (off by default) -----
let SCRIPT_DEBUG = false;

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

// Create write stream for log file
const logStream = fs.createWriteStream(logFilePath, { flags: 'a' });

const originalLog = console.log;
const originalError = console.error;
const originalWarn = console.warn;
const originalInfo = console.info;

function writeToLog(level, args) {
    const timestamp = new Date().toISOString();
    const message = args.map(arg => typeof arg === 'string' ? arg : JSON.stringify(arg)).join(' ');
    const logLine = `[${timestamp}] [${level}] ${message}`;
    logStream.write(logLine + '\n');
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

process.on('exit', () => {
    logStream.end();
});

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

// ----- Configuration -----
const PROJECT_ROOT = path.resolve(__dirname, '..', '..'); // repo root
const VM_IP = process.env.GCP_VM_IP || '35.198.231.9';
const SSH_USER = process.env.VM_SSH_USER || 'xmione';
const SSH_KEY_PATH = path.join(__dirname, '..', 'secrets', 'agent-key');
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GCP_PROJECT_ID = process.env.GCP_PROJECT_ID;

if (!GITHUB_TOKEN) {
    console.warn('⚠️  GITHUB_TOKEN not set – GitHub variables will not be fetched.');
}
if (!GCP_PROJECT_ID) {
    console.warn('⚠️  GCP_PROJECT_ID not set – GCP secrets will not be fetched.');
}

// ----- Sites Configuration -----
const SITES = [
    {
        id: 'humrine-staging',
        appName: 'humrine_site',
        name: 'Humrine Staging',
        backend: 'humrine-staging-backend',
        webContainer: 'humrine-web-staging',
        nginxContainer: 'humrine-nginx-staging',
        composeDir: '/opt/humrine_site',
        composeFile: 'docker-compose.vm.yml',
        project: 'humrine-staging',
        profile: 'staging',
        domain: 'staging.humrine.com',
        url: 'https://staging.humrine.com/',
        gcpHealthCheck: 'staging-health-check',
        webServiceName: 'web-staging',
        target: 'staging',
        templateDir: path.join(PROJECT_ROOT, 'humrine_site'),
    },
    {
        id: 'humrine-production',
        appName: 'humrine_site',
        name: 'Humrine Production',
        backend: 'humrine-backend',
        webContainer: 'humrine-web-production',
        nginxContainer: 'humrine-nginx-production',
        composeDir: '/opt/humrine_site',
        composeFile: 'docker-compose.vm.yml',
        project: 'humrine-production',
        profile: 'production',
        domain: 'humrine.com',
        url: 'https://humrine.com/',
        gcpHealthCheck: 'production-health-check',
        webServiceName: 'web-production',
        target: 'production',
        templateDir: path.join(PROJECT_ROOT, 'humrine_site'),
    },
    {
        id: 'badminton-staging',
        appName: 'badminton_court',
        name: 'Badminton Staging',
        backend: 'court-staging-backend',
        webContainer: 'badminton-staging-web-staging-1',
        nginxContainer: 'badminton_court-nginx-staging',
        composeDir: '/opt/badminton_court',
        composeFile: 'docker-compose.vm.yml',
        project: 'badminton-staging',
        profile: 'staging',
        domain: 'humrine.com/court-staging',
        url: 'https://humrine.com/court-staging/',
        gcpHealthCheck: 'court-staging-health-check',
        webServiceName: 'web-staging',
        target: 'staging',
        templateDir: path.join(PROJECT_ROOT, 'badminton_court'),
    },
    {
        id: 'badminton-production',
        appName: 'badminton_court',
        name: 'Badminton Production',
        backend: 'court-backend',
        webContainer: 'badminton-production-web-production-1',
        nginxContainer: 'badminton_court-nginx-production',
        composeDir: '/opt/badminton_court',
        composeFile: 'docker-compose.vm.yml',
        project: 'badminton-production',
        profile: 'production',
        domain: 'humrine.com/court',
        url: 'https://humrine.com/court/',
        gcpHealthCheck: 'court-health-check',
        webServiceName: 'web-production',
        target: 'production',
        templateDir: path.join(PROJECT_ROOT, 'badminton_court'),
    },
];

// ----- Interactive prompt (using readline) -----
function ask(question) {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });
    return new Promise(resolve => {
        rl.question(question, answer => {
            rl.close();
            resolve(answer.trim());
        });
    });
}

function detectComposeCommand() {
    const testCmd = 'docker compose version 2>&1';
    const result = remoteExec(testCmd);
    if (result.success) return 'docker compose';
    const testCmd2 = 'docker-compose version 2>&1';
    const result2 = remoteExec(testCmd2);
    if (result2.success) return 'docker-compose';
    return null;
}

async function selectSites(args) {
    const allIds = SITES.map(s => s.id);

    if (args.includes('--all')) return SITES;
    const requested = args.filter(arg => allIds.includes(arg));
    if (requested.length > 0) {
        return SITES.filter(s => requested.includes(s.id));
    }

    console.log('\nAvailable sites:');
    SITES.forEach((s, idx) => {
        console.log(`  ${idx + 1}. ${s.name} (${s.id})`);
    });
    console.log('  a. All sites');
    console.log('  q. Quit\n');

    const answer = await ask('Enter numbers (comma-separated, e.g., 1,3) or "a" for all: ');
    if (answer.toLowerCase() === 'q') process.exit(0);
    if (answer.toLowerCase() === 'a') return SITES;

    const indices = answer.split(',').map(n => parseInt(n.trim()));
    const selected = indices.filter(i => i >= 1 && i <= SITES.length).map(i => SITES[i - 1]);
    if (selected.length === 0) {
        console.log('No valid selection. Running all sites.');
        return SITES;
    }
    return selected;
}

// ----- Helper: extract <?secret?> and <?var?> from template files -----
function extractPlaceholders(templatePath, pattern) {
    if (!fs.existsSync(templatePath)) return [];
    const content = fs.readFileSync(templatePath, 'utf8');
    const regex = new RegExp(`^(\\w+)=${pattern}\\s*$`, 'gm');
    const matches = content.matchAll(regex);
    const keys = [];
    for (const m of matches) keys.push(m[1]);
    return keys;
}

function fetchRequiredVars(site) {
    const { appName, target, templateDir } = site;
    const templateFiles = [
        path.join(templateDir, `.env.${target}.template`),
        path.join(templateDir, '.env.common.template')
    ];

    let gcpSecrets = [];
    let requiredVars = [];

    templateFiles.forEach(file => {
        gcpSecrets = gcpSecrets.concat(extractPlaceholders(file, '<\\?secret\\?>'));
        requiredVars = requiredVars.concat(extractPlaceholders(file, '<\\?var\\?>'));
        requiredVars = requiredVars.concat(extractPlaceholders(file, '<\\?secret\\?>'));
    });

    const composePath = path.join(templateDir, site.composeFile);
    if (fs.existsSync(composePath)) {
        const composeContent = fs.readFileSync(composePath, 'utf8');
        const matches = composeContent.match(/\$\{([^:}]+)/g);
        if (matches) {
            const composeVars = matches.map(m => m.slice(2, m.indexOf(':'))).filter(v => v && v.trim());
            requiredVars = requiredVars.concat(composeVars);
        }
    }

    return {
        gcpSecrets: [...new Set(gcpSecrets)],
        requiredVars: [...new Set(requiredVars)]
    };
}

// ----- Helper: fetch secrets from GCP (with app prefix) -----
function fetchGCPSecrets(appName, secretsList) {
    console.log(`  Using GCP credentials from: ${process.env.GOOGLE_APPLICATION_CREDENTIALS || 'not set'}`);
    const env = {};

    if (process.env.GCP_SA_KEY_PATH) {
        const keyPath = path.isAbsolute(process.env.GCP_SA_KEY_PATH)
            ? process.env.GCP_SA_KEY_PATH
            : path.join(PROJECT_ROOT, process.env.GCP_SA_KEY_PATH);
        if (fs.existsSync(keyPath)) {
            process.env.GOOGLE_APPLICATION_CREDENTIALS = keyPath;
            console.log(`  🔑 Using service account: ${keyPath}`);
        } else {
            console.log(`  ⚠️  GCP_SA_KEY_PATH file not found: ${keyPath}`);
        }
    } else {
        console.log(`  ⚠️  GCP_SA_KEY_PATH not set in environment.`);
    }

    const prefix = `${appName}_`;

    for (const secret of secretsList) {
        const fullSecretName = prefix + secret;
        try {
            const value = execSync(
                `gcloud secrets versions access latest --secret="${fullSecretName}" --project=${GCP_PROJECT_ID}`,
                { encoding: 'utf8', stdio: 'pipe' }
            ).trim();
            if (value) {
                env[secret] = value;
                console.log(`  🔐 ${secret} (from ${fullSecretName})`);
            } else {
                if (process.env[secret]) {
                    env[secret] = process.env[secret];
                    console.log(`  ℹ️  ${fullSecretName} returned empty, using process.env.${secret}: ${process.env[secret]}`);
                } else {
                    console.log(`  ⚠️  ${fullSecretName} empty and not in process.env.`);
                }
            }
        } catch (err) {
            console.log(`  ⚠️  ${fullSecretName} fetch failed: ${err.message}`);
            if (err.stderr) console.log(`  stderr: ${err.stderr.toString().trim()}`);
            if (process.env[secret]) {
                env[secret] = process.env[secret];
                console.log(`  ℹ️  using process.env.${secret}: ${process.env[secret]}`);
            } else {
                console.log(`  ⚠️  ${fullSecretName} not in process.env.`);
            }
        }
    }
    return env;
}

// ----- Helper: fetch variables from GitHub Environment -----
function fetchGitHubVars(repo, environment, token) {
    return new Promise((resolve, reject) => {
        const url = `https://api.github.com/repos/${repo}/environments/${environment}/variables`;
        const options = {
            hostname: 'api.github.com',
            path: url,
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Accept': 'application/vnd.github+json',
                'User-Agent': 'Node.js/health-check',
            },
        };
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode === 200) {
                    try {
                        const vars = JSON.parse(data);
                        const env = {};
                        vars.variables.forEach(v => { env[v.name] = v.value; });
                        resolve(env);
                    } catch (e) {
                        reject(e);
                    }
                } else {
                    reject(new Error(`HTTP ${res.statusCode}: ${data}`));
                }
            });
        });
        req.on('error', reject);
        req.end();
    });
}

// ----- Main fetcher: returns a promise with all variables -----
async function fetchAllVars(site) {
    const { appName, target, templateDir } = site;
    const repo = `${process.env.GIT_REPO_USERNAME || 'Team-Sisante'}/${appName}`;

    const env = {};

    console.log(`📦 Fetching variables for ${appName} (${target})...`);

    if (GCP_PROJECT_ID) {
        console.log('  Fetching GCP secrets...');
        const { gcpSecrets } = fetchRequiredVars(site);
        const secrets = fetchGCPSecrets(appName, gcpSecrets);
        Object.assign(env, secrets);
        console.log(`  Added ${Object.keys(secrets).length} secrets from GCP.`);
    }

    if (GITHUB_TOKEN) {
        console.log('  Fetching GitHub Environment variables...');
        try {
            const githubVars = await fetchGitHubVars(repo, target, GITHUB_TOKEN);
            Object.assign(env, githubVars);
            console.log(`  Added ${Object.keys(githubVars).length} variables from GitHub.`);
        } catch (e) {
            console.log(`  ⚠️  Failed to fetch GitHub variables: ${e.message}`);
        }
    }

    for (const [key, value] of Object.entries(process.env)) {
        if (!env[key] && value) {
            env[key] = value;
        }
    }

    console.log('  Reading local .env files as fallback...');
    const localEnvFiles = [
        path.join(templateDir, `.env.${target}`),
        path.join(templateDir, '.env.common')
    ];
    for (const file of localEnvFiles) {
        if (fs.existsSync(file)) {
            const content = fs.readFileSync(file, 'utf8');
            const lines = content.split('\n');
            let loaded = 0;
            for (const line of lines) {
                const trimmed = line.trim();
                if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
                    const eqIndex = trimmed.indexOf('=');
                    const key = trimmed.substring(0, eqIndex).trim();
                    let value = trimmed.substring(eqIndex + 1).trim();
                    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
                        value = value.slice(1, -1);
                    }
                    if (!env[key]) {
                        env[key] = value;
                        loaded++;
                    }
                }
            }
            if (loaded > 0) {
                console.log(`  Loaded ${loaded} variables from local ${path.basename(file)}`);
            }
        }
    }

    if (!env.IMAGE_TAG) {
        env.IMAGE_TAG = 'latest';
        console.log(`  IMAGE_TAG set to: ${env.IMAGE_TAG}`);
    }

    const internalPrefixes = ['npm_', 'TERM_', 'XDG_', 'SSH_', 'LC_', 'LS_COLORS', 'DBUS_', 'DISPLAY', 'LANGUAGE', 'WINDOW', 'COLORTERM', 'PAGER', 'EDITOR', 'VISUAL'];
    const internalKeys = ['PATH', 'HOME', 'PWD', 'SHELL', 'HOSTNAME', '_', 'OLDPWD', 'SHLVL', 'LOGNAME', 'USER', 'TERM', 'LANG', 'MAIL', 'PROMPT_COMMAND', 'PS1', 'PS2', 'PS4', 'TERM_PROGRAM', 'TERM_PROGRAM_VERSION', 'TERM_SESSION_ID', 'WINDOWID'];
    for (const key of Object.keys(env)) {
        if (internalKeys.includes(key) || internalPrefixes.some(p => key.startsWith(p))) {
            delete env[key];
        }
    }

    console.log(`  Final variable count: ${Object.keys(env).length}`);

    const diagnosticKeys = ['DEBUG', 'SECRET_KEY', 'SITE_HEADER', 'SITE_TITLE', 'ALLOWED_HOSTS', 'POSTE_PROTOCOL', 'IMAGE_TAG'];
    console.log('  Diagnostic variables:');
    diagnosticKeys.forEach(key => {
        const val = env[key];
        if (val === undefined) {
            console.log(`    ${key}: MISSING`);
        } else {
            const secretPattern = /(PASSWORD|SECRET|KEY|TOKEN|PASS|ENCRYPT|PRIVATE|SIGNING|AUTHTOKEN)/i;
            if (secretPattern.test(key)) {
                const masked = val.length > 4 ? val.substring(0, 4) + '****' : '****';
                console.log(`    ${key}: ${masked}`);
            } else {
                console.log(`    ${key}: ${val}`);
            }
        }
    });

    return env;
}

// ----- Remote execution -----
function remoteExec(cmd) {
    const args = [
        '-i', SSH_KEY_PATH,
        '-o', 'StrictHostKeyChecking=no',
        '-o', 'UserKnownHostsFile=/dev/null',
        '-o', 'ConnectTimeout=15',
        '-o', 'LogLevel=ERROR',
        '-o', 'KexAlgorithms=+diffie-hellman-group14-sha256',
        `${SSH_USER}@${VM_IP}`,
        cmd,
    ];

    if (SCRIPT_DEBUG) {
        console.log(`   DEBUG SSH: ssh -i [key] ${SSH_USER}@${VM_IP} "${cmd}"`);
    }

    try {
        const output = execFileSync('ssh', args, { encoding: 'utf8', stdio: 'pipe' });
        const out = output.trim();
        if (out) console.log(out);
        return { success: true, stdout: out, stderr: '', output: out, code: 0 };
    } catch (err) {
        const stdout = err.stdout ? err.stdout.toString().trim() : '';
        const stderr = err.stderr ? err.stderr.toString().trim() : '';
        const combined = stdout + (stderr ? '\n' + stderr : '');
        if (combined) console.log(combined);
        if (SCRIPT_DEBUG) {
            console.log(`   DEBUG: err.code = ${err.code}`);
            console.log(`   DEBUG: err.status = ${err.status}`);
            console.log(`   DEBUG: err.signal = ${err.signal}`);
            console.log(`   DEBUG: err.stdout =\n${stdout}`);
            console.log(`   DEBUG: err.stderr =\n${stderr}`);
            console.log(`   DEBUG: err.message = ${err.message}`);
            console.log(`   DEBUG: err.cmd = ${err.cmd}`);
        }
        return { success: false, stdout, stderr, output: combined, code: err.status };
    }
}

function remoteExecWithEnv(cmd, env, site) {
    const { requiredVars } = fetchRequiredVars(site);
    const envPairs = Object.entries(env)
        .filter(([key]) => {
            if (!requiredVars.includes(key)) return false;
            return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key);
        })
        .map(([key, value]) => `${key}=${String(value).replace(/"/g, '\\"')}`);

    if (envPairs.length === 0) {
        console.log('   No required environment variables to write. Running command without env file.');
        return remoteExec(cmd);
    }

    const envContent = envPairs.join('\n');
    const tempFileLocal = path.join(os.tmpdir(), `health_env_${Date.now()}.env`);
    const tempFileRemote = `/tmp/health_env_${Date.now()}.env`;

    fs.writeFileSync(tempFileLocal, envContent, 'utf8');

    const scpArgs = [
        '-i', SSH_KEY_PATH,
        '-o', 'StrictHostKeyChecking=no',
        '-o', 'UserKnownHostsFile=/dev/null',
        '-o', 'ConnectTimeout=15',
        '-o', 'LogLevel=ERROR',
        tempFileLocal,
        `${SSH_USER}@${VM_IP}:${tempFileRemote}`
    ];
    try {
        execFileSync('scp', scpArgs, { stdio: 'pipe' });
        if (SCRIPT_DEBUG) console.log(`   ✅ Copied env file to VM: ${tempFileRemote}`);
    } catch (err) {
        console.error(`   ❌ Failed to copy env file to VM: ${err.message}`);
        try { fs.unlinkSync(tempFileLocal); } catch (_) {}
        return { success: false, output: err.message };
    }

    try { fs.unlinkSync(tempFileLocal); } catch (_) {}

    const fullCmd = cmd.replace(/(docker compose(?:-)?)/, `$1 --env-file ${tempFileRemote}`);
    const result = remoteExec(fullCmd);

    remoteExec(`rm -f ${tempFileRemote}`);

    return result;
}

function remoteExecSilent(cmd, env = null) {
    if (env) {
        return remoteExecWithEnv(cmd, env);
    }
    return remoteExec(cmd);
}

// ----- Site checks -----

function getContainerLogs(container, lines = 20) {
    const cmd = `sudo docker logs ${container} --tail=${lines} 2>&1`;
    const result = remoteExecSilent(cmd);
    if (result.success && result.output) {
        return result.output;
    }
    return null;
}

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

function getContainerStatus(site) {
    const { webContainer } = site;
    const cmd = `sudo docker ps -a --filter name=${webContainer} --format '{{.Status}}'`;
    const result = remoteExecSilent(cmd);
    if (!result.success || !result.output) {
        return { exists: false, running: false, status: null };
    }
    const status = result.output.trim();
    const running = status.includes('Up');
    const unhealthy = status.includes('unhealthy');
    return { exists: true, running, unhealthy, status };
}

function getNginxLogs(nginxContainer, lines = 20) {
    if (!nginxContainer) return null;
    const cmd = `sudo docker logs ${nginxContainer} --tail=${lines} 2>&1`;
    const result = remoteExecSilent(cmd);
    if (result.success && result.output) {
        return result.output;
    }
    return null;
}

function runGcloud(cmd) {
    try {
        const fullCmd = `gcloud compute backend-services get-health ${cmd} --global --project=${GCP_PROJECT_ID}`;
        const output = execSync(fullCmd, { encoding: 'utf8', stdio: 'pipe' });
        return output.trim();
    } catch (error) {
        return null;
    }
}

// ----- Detection -----
function detectCase(siteStatus, logs, nginxLogs) {
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
        if (detect.log_pattern && logs) {
            const regex = new RegExp(detect.log_pattern, 'i');
            if (!regex.test(logs)) matches = false;
        }
        if (detect.nginx_log_pattern && nginxLogs) {
            const regex = new RegExp(detect.nginx_log_pattern, 'i');
            if (!regex.test(nginxLogs)) matches = false;
        }
        if (detect.container_restarting && !siteStatus.containerRestarting) matches = false;
        if (detect.pull_error) {
            if (!siteStatus.pullError || !new RegExp(detect.pull_error, 'i').test(siteStatus.pullError)) matches = false;
        }

        if (matches) return caseDef;
    }
    return null;
}

// ----- Main check (detection only) -----
async function checkSite(site) {
    const { name, backend, webContainer, url } = site;

    const env = await fetchAllVars(site);
    if (Object.keys(env).length === 0) {
        console.log(`❌ No environment variables fetched for ${name}. Aborting.`);
        return null;
    }

    console.log(`\n🔍 Checking ${name} (${backend})...`);

    const gcpHealth = runGcloud(backend);
    const gcpHealthy = gcpHealth && gcpHealth.includes('HEALTHY');
    console.log(`   → GCP backend: ${gcpHealthy ? '✅ HEALTHY' : '❌ UNHEALTHY'}`);

    const containerInfo = getContainerStatus(site);
    console.log(`   → Container ${webContainer}: ${containerInfo.exists ? containerInfo.status : 'MISSING'}`);

    const httpStatus = checkSiteResponse(url, name);
    const siteOK = httpStatus !== null && httpStatus >= 200 && httpStatus < 400;

    const logs = getContainerLogs(webContainer);
    const nginxLogs = site.nginxContainer ? getNginxLogs(site.nginxContainer) : null;

    const siteStatus = {
        containerExists: containerInfo.exists,
        containerRunning: containerInfo.running,
        containerUnhealthy: containerInfo.unhealthy || false,
        containerRestarting: containerInfo.exists && !containerInfo.running && containerInfo.status && containerInfo.status.includes('Restarting'),
        httpStatus,
        gcpHealthy,
        logs,
        nginxLogs,
    };

    const detectedCases = [];
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
            const regex = new RegExp(detect.log_pattern, 'i');
            if (!regex.test(siteStatus.logs)) matches = false;
        }
        if (detect.nginx_log_pattern && siteStatus.nginxLogs) {
            const regex = new RegExp(detect.nginx_log_pattern, 'i');
            if (!regex.test(siteStatus.nginxLogs)) matches = false;
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

    // Build report entry for this site
    const reportEntry = {
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
            log_sample: (c.detect.log_pattern && siteStatus.logs) ? siteStatus.logs.slice(0, 200) : null,
        })),
        treated_at: null,
        treatment_status: 'PENDING'
    };

    return reportEntry;
}

// ----- Write report -----
function writeReport(reportData) {
    // Ensure directory exists
    if (!fs.existsSync(REPORT_DIR)) {
        fs.mkdirSync(REPORT_DIR, { recursive: true });
    }
    fs.writeFileSync(REPORT_FILE, JSON.stringify(reportData, null, 2), 'utf8');
    console.log(`\n📄 Report saved to: ${REPORT_FILE}`);
}

// ----- Main -----
async function main() {
    const args = process.argv.slice(2);
    const selectedSites = await selectSites(args);
    const debug = args.includes('--debug') || args.includes('-d');
    if (debug) {
        SCRIPT_DEBUG = true;
        console.log('🐞 Debug mode enabled – SSH commands will be printed.');
    }

    console.log(`🏥 Running health checks (detection only)...`);
    console.log(`📋 Selected sites: ${selectedSites.map(s => s.name).join(', ')}\n`);

    const report = {
        timestamp: new Date().toISOString(),
        sites: []
    };

    for (const site of selectedSites) {
        const entry = await checkSite(site);
        if (entry) {
            report.sites.push(entry);
        }
    }

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