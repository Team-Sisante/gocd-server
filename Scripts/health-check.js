#!/usr/bin/env node
/**
 * health-check.js – Juggernaut-grade health check & repair for all deployed sites.
 *
 * It performs comprehensive diagnostics and can automatically repair common issues.
 * The script runs on the GoCD agent (or locally) and interacts with the target VM
 * via SSH and GCP APIs.
 *
 * Main steps:
 * 1. Fetches required environment variables (secrets from GCP Secret Manager,
 *    configuration from GitHub Environments) for each site.
 * 2. Checks GCP backend health for each site.
 * 3. Checks container status (exists, running, healthy) on the VM.
 * 4. Checks actual site response via HTTPS (curl).
 * 5. If --fix is provided, attempts repairs:
 *    a. Pulls latest images via docker compose pull.
 *    b. Recreates or starts missing/stopped containers.
 *    c. Runs collectstatic inside web containers.
 *    d. Restarts Nginx if needed.
 *    e. Updates GCP health check timeout/interval if needed.
 * 6. Waits for services to settle, then re-checks and reports final status.
 *
 * All actions are logged to a timestamped file (health_check-MMM-dd-yyyy.log)
 * in the same directory.
 *
 * Usage:
 *   node health-check.js [--fix]
 *   --fix   Automatically attempt to repair any issues found.
 */

const { execSync, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const https = require('https');

// ----- Setup logging -----
const LOG_DIR = __dirname; // Scripts/ directory
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

// Override console.log to write to both terminal and log file
const originalLog = console.log;
const originalError = console.error;
const originalWarn = console.warn;
const originalInfo = console.info;

function writeToLog(level, args) {
    const timestamp = new Date().toISOString();
    const message = args.map(arg => typeof arg === 'string' ? arg : JSON.stringify(arg)).join(' ');
    const logLine = `[${timestamp}] [${level}] ${message}`;
    logStream.write(logLine + '\n');
    // Also write to terminal (without timestamp for readability)
    originalLog.apply(console, args);
}

console.log = (...args) => { writeToLog('INFO', args); };
console.error = (...args) => { writeToLog('ERROR', args); };
console.warn = (...args) => { writeToLog('WARN', args); };
console.info = (...args) => { writeToLog('INFO', args); };

// Also capture uncaught exceptions to log them
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

    return { gcpSecrets: [...new Set(gcpSecrets)], requiredVars: [...new Set(requiredVars)] };
}

// ----- Helper: fetch secrets from GCP (with app prefix) -----
function fetchGCPSecrets(appName, secretsList) {
  const env = {};
  const prefix = `${appName}_`;

  // 1. Authenticate gcloud if GCP_SA_KEY_PATH is set (same as deploy.js)
  if (process.env.GCP_SA_KEY_PATH) {
    try {
      const keyPath = path.isAbsolute(process.env.GCP_SA_KEY_PATH)
        ? process.env.GCP_SA_KEY_PATH
        : path.join(PROJECT_ROOT, process.env.GCP_SA_KEY_PATH);
      if (fs.existsSync(keyPath)) {
        console.log('  🔑 Authenticating gcloud with service account...');
        execSync(`gcloud auth activate-service-account --key-file="${keyPath}" --project=${GCP_PROJECT_ID}`, {
          stdio: 'pipe',
          encoding: 'utf8'
        });
      } else {
        console.log(`  ⚠️  Service account key file not found: ${keyPath}`);
      }
    } catch (e) {
      console.log(`  ⚠️  Failed to authenticate gcloud: ${e.message}`);
    }
  } else {
    // Fallback: try to use application default credentials
    try {
      execSync('gcloud auth application-default login --quiet', { stdio: 'pipe', encoding: 'utf8' });
    } catch (e) {
      console.log('  ⚠️  No GCP_SA_KEY_PATH set and application-default login failed.');
    }
  }

  // 2. Fetch secrets
  for (const secret of secretsList) {
    const fullSecretName = prefix + secret;
    try {
      const value = execSync(
        `gcloud secrets versions access latest --secret="${fullSecretName}" --project=${GCP_PROJECT_ID} 2>/dev/null`,
        { encoding: 'utf8', stdio: 'pipe' }
      ).trim();
      if (value) {
        env[secret] = value;
        console.log(`  🔐 ${secret} (from ${fullSecretName})`);
      } else {
        // Fallback to process.env
        if (process.env[secret]) {
          env[secret] = process.env[secret];
          console.log(`  ℹ️  ${fullSecretName} empty, using process.env.${secret}: ${process.env[secret]}`);
        } else {
          console.log(`  ⚠️  ${fullSecretName} empty and not in process.env.`);
        }
      }
    } catch (err) {
      if (process.env[secret]) {
        env[secret] = process.env[secret];
        console.log(`  ℹ️  ${fullSecretName} not found, using process.env.${secret}: ${process.env[secret]}`);
      } else {
        console.log(`  ⚠️  ${fullSecretName} not found (GCP fetch failed) and not in process.env.`);
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
    const { appName, target } = site;
    const repo = `${process.env.GIT_REPO_USERNAME || 'Team-Sisante'}/${appName}`;

    // Start with a copy of process.env (all env vars from the agent)
    const env = { ...process.env };
    console.log(`📦 Fetching variables for ${appName} (${target})...`);
    console.log(`  Starting with ${Object.keys(env).length} variables from process.env.`);

    // 1. Override with GCP secrets (if available)
    if (GCP_PROJECT_ID) {
        console.log('  Fetching GCP secrets...');
        const { gcpSecrets } = fetchRequiredVars(site);
        const secrets = fetchGCPSecrets(appName, gcpSecrets);
        Object.assign(env, secrets);
        console.log(`  Added ${Object.keys(secrets).length} secrets from GCP.`);
    }

    // 2. Override with GitHub Environment variables
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

    // 3. Override with .env file from the VM (if exists)
    console.log('  Reading .env file from VM (if present)...');
    const vmEnv = readEnvFileFromVM(site);
    if (Object.keys(vmEnv).length > 0) {
        Object.assign(env, vmEnv);
        console.log(`  Added ${Object.keys(vmEnv).length} variables from VM .env file.`);
    } else {
        console.log('  No VM .env file found or empty.');
    }

    // 4. Remove internal Node.js variables that are not needed
    const internalPrefixes = ['npm_', 'TERM_', 'XDG_', 'SSH_', 'LC_', 'LS_COLORS', 'DBUS_', 'DISPLAY', 'LANGUAGE', 'WINDOW', 'COLORTERM', 'PAGER', 'EDITOR', 'VISUAL'];
    const internalKeys = ['PATH', 'HOME', 'PWD', 'SHELL', 'HOSTNAME', '_', 'OLDPWD', 'SHLVL', 'LOGNAME', 'USER', 'TERM', 'LANG', 'MAIL', 'PROMPT_COMMAND', 'PS1', 'PS2', 'PS4', 'TERM_PROGRAM', 'TERM_PROGRAM_VERSION', 'TERM_SESSION_ID', 'WINDOWID'];
    for (const key of Object.keys(env)) {
        if (internalKeys.includes(key) || internalPrefixes.some(p => key.startsWith(p))) {
            delete env[key];
        }
    }

    console.log(`  Final variable count: ${Object.keys(env).length}`);

    // Diagnostic: print some key variables (mask secrets)
    const diagnosticKeys = ['DEBUG', 'SECRET_KEY', 'SITE_HEADER', 'ALLOWED_HOSTS', 'POSTE_PROTOCOL'];
    console.log('  Diagnostic variables:');
    diagnosticKeys.forEach(key => {
        const val = env[key];
        if (val === undefined) {
            console.log(`    ${key}: MISSING`);
        } else {
            // Show actual value for debugging (or mask if preferred)
            console.log(`    ${key}: ${val}`);
        }
    });

    return env;
}

// ----- Helper: build export string from env object -----
function buildExportString(env) {
    const lines = [];
    for (const [key, value] of Object.entries(env)) {
        const safeValue = String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        lines.push(`export ${key}="${safeValue}"`);
    }
    return lines.join(' && ');
}

// ----- Remote execution with fetched env -----
function remoteExecWithEnv(cmd, env) {
  const exportStr = buildExportString(env);
  // Log a sample of exported variables
  const sampleKeys = ['DEBUG', 'SECRET_KEY', 'SITE_HEADER', 'ALLOWED_HOSTS', 'POSTE_PROTOCOL'];
  const sample = sampleKeys.filter(k => env[k] !== undefined);
  console.log(`  🔧 Exporting ${Object.keys(env).length} variables (sample: ${sample.join(', ')})`);
  const fullCmd = `${exportStr} && ${cmd}`;
  return remoteExec(fullCmd);
}

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
    try {
        const output = execFileSync('ssh', args, { encoding: 'utf8', stdio: 'pipe' });
        return { success: true, stdout: output.trim(), stderr: '', output: output.trim() };
    } catch (err) {
        const stdout = err.stdout ? err.stdout.toString().trim() : '';
        const stderr = err.stderr ? err.stderr.toString().trim() : '';
        const combined = stdout + (stderr ? '\n' + stderr : '');
        return { success: false, stdout, stderr, output: combined };
    }
}

function readEnvFileFromVM(site) {
    const { composeDir, target } = site;
    const envFilePath = `${composeDir}/.env.${target}`;
    const cmd = `cat ${envFilePath} 2>/dev/null || echo ""`;
    const result = remoteExecSilent(cmd);
    if (result.success && result.output) {
        const env = {};
        const lines = result.output.split('\n');
        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
                const index = trimmed.indexOf('=');
                const key = trimmed.substring(0, index).trim();
                let value = trimmed.substring(index + 1).trim();
                if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
                    value = value.slice(1, -1);
                }
                env[key] = value;
            }
        }
        return env;
    }
    return {};
}

function remoteExecSilent(cmd, env = null) {
    if (env) {
        return remoteExecWithEnv(cmd, env);
    }
    return remoteExec(cmd);
}

// ----- Repair functions (used as helpers) -----

function getContainerLogs(container, lines = 20) {
    const cmd = `sudo docker logs ${container} --tail=${lines} 2>&1`;
    const result = remoteExecSilent(cmd);
    if (result.success && result.output) {
        return result.output;
    }
    return null;
}

function repairCollectStatic(site, env) {
    const { webContainer } = site;
    console.log(`   → Running collectstatic on ${webContainer}...`);
    // Try binary first
    let cmd = `sudo docker exec ${webContainer} /app/humrine_site_linux collectstatic --noinput 2>&1`;
    let result = remoteExecSilent(cmd, env);
    if (result.success && result.output && !result.output.includes('No such file')) {
        console.log(`   ✅ Static files collected.`);
        return true;
    }
    // Fallback to python
    console.log(`   → Binary not found, trying python manage.py...`);
    cmd = `sudo docker exec ${webContainer} python manage.py collectstatic --noinput 2>&1`;
    result = remoteExecSilent(cmd, env);
    if (result.success) {
        console.log(`   ✅ Static files collected (python).`);
        return true;
    }
    console.log(`   ❌ collectstatic failed.`);
    if (result.output) console.log(`   Error:\n${result.output}`);
    return false;
}

function repairNginx(nginxContainer) {
    console.log(`   → Restarting ${nginxContainer}...`);
    const result = remoteExecSilent(`sudo docker restart ${nginxContainer} 2>&1`);
    if (result.success) {
        console.log(`   ✅ ${nginxContainer} restarted.`);
        return true;
    }
    console.log(`   ❌ Failed to restart ${nginxContainer}.`);
    if (result.output) console.log(`   Error:\n${result.output}`);
    return false;
}

function ensureImagesExist(site, env) {
    const { composeDir, composeFile, project, profile, webServiceName } = site;
    console.log(`   → Ensuring images are up-to-date via compose pull...`);
    const pullCmd = `cd ${composeDir} && sudo docker compose -p ${project} -f ${composeFile} --profile ${profile} pull ${webServiceName} 2>&1`;
    const result = remoteExecSilent(pullCmd, env);
    if (result.success) {
        console.log(`   ✅ Images pulled.`);
        return true;
    }
    console.log(`   ❌ Failed to pull images.`);
    if (result.output) console.log(`   Error:\n${result.output}`);
    return false;
}

function recreateContainer(site, env) {
    const { webContainer, composeDir, composeFile, project, profile, webServiceName } = site;
    console.log(`   → Recreating ${webContainer} via compose (service ${webServiceName})...`);
    let cmd = `cd ${composeDir} && sudo docker compose -p ${project} -f ${composeFile} --profile ${profile} up -d ${webServiceName} 2>&1`;
    let result = remoteExecSilent(cmd, env);
    if (result.success) {
        console.log(`   ✅ ${webContainer} recreated and started.`);
        return true;
    }
    console.log(`   → Single service up failed.`);
    if (result.output) console.log(`   Error:\n${result.output}`);
    // If single service fails, try full project up
    console.log(`   → Trying full project up...`);
    cmd = `cd ${composeDir} && sudo docker compose -p ${project} -f ${composeFile} --profile ${profile} up -d 2>&1`;
    result = remoteExecSilent(cmd, env);
    if (result.success) {
        console.log(`   ✅ Full project recreated.`);
        return true;
    }
    console.log(`   ❌ Failed to recreate ${webContainer} (even full project).`);
    if (result.output) console.log(`   Error:\n${result.output}`);
    return false;
}

function startContainer(site, env) {
    const { webContainer } = site;
    console.log(`   → Starting ${webContainer} via docker start...`);
    let cmd = `sudo docker start ${webContainer} 2>&1`;
    let result = remoteExecSilent(cmd, env);
    if (result.success) {
        console.log(`   ✅ ${webContainer} started.`);
        return true;
    }
    console.log(`   → docker start failed.`);
    if (result.output) console.log(`   Error:\n${result.output}`);
    console.log(`   → Trying compose up...`);
    return recreateContainer(site, env);
}

function updateHealthCheckTimeout(healthCheck) {
    try {
        execSync(
            `gcloud compute health-checks update http ${healthCheck} --timeout=30 --check-interval=30 --project=${GCP_PROJECT_ID}`,
            { stdio: 'pipe' }
        );
        return true;
    } catch (e) {
        return false;
    }
}

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

function getContainerStatus(site) {
    const { webContainer } = site;
    const cmd = `sudo docker ps -a --filter name=${webContainer} --format '{{.Status}}'`;
    const result = remoteExecSilent(cmd);
    if (!result.success || !result.output) {
        return { exists: false, running: false, status: null };
    }
    const status = result.output.trim();
    const running = status.includes('Up');
    return { exists: true, running, status };
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

// ----- Case detection -----
function detectCase(siteStatus, logs, nginxLogs, env) {
    // siteStatus: { containerExists, containerRunning, httpStatus, gcpHealthy }
    // logs: container logs (string)
    // nginxLogs: nginx logs (string)
    for (const caseDef of caseSolutions.cases) {
        const detect = caseDef.detect;
        let matches = true;

        if (detect.container_status) {
            const status = detect.container_status;
            if (status === 'missing' && siteStatus.containerExists) matches = false;
            if (status === 'stopped' && (siteStatus.containerRunning || !siteStatus.containerExists)) matches = false;
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
            // check if there was a pull error (we can pass pullError as part of status)
            // For simplicity, we assume if siteStatus.pullError is set.
            if (!siteStatus.pullError || !new RegExp(detect.pull_error, 'i').test(siteStatus.pullError)) matches = false;
        }

        if (matches) return caseDef;
    }
    return null;
}

// ----- Main check and repair -----
async function checkAndRepair(site, fix) {
    const { name, backend, webContainer, nginxContainer, url, gcpHealthCheck } = site;

    // Fetch environment variables once for this site
    const env = await fetchAllVars(site);
    if (Object.keys(env).length === 0) {
        console.log(`❌ No environment variables fetched for ${name}. Aborting repair.`);
        return false;
    }

    console.log(`\n🔍 Checking ${name} (${backend})...`);

    // 1. GCP backend health
    const health = runGcloud(backend);
    const gcpHealthy = health && health.includes('HEALTHY');
    console.log(`   → GCP backend: ${gcpHealthy ? '✅ HEALTHY' : '❌ UNHEALTHY'}`);

    // 2. Container status
    const containerInfo = getContainerStatus(site);
    const containerExists = containerInfo.exists;
    const containerRunning = containerInfo.running;
    console.log(`   → Container ${webContainer}: ${containerExists ? containerInfo.status : 'MISSING'}`);

    // 3. Site response
    const httpStatus = checkSiteResponse(url, name);
    const siteOK = httpStatus !== null && httpStatus >= 200 && httpStatus < 400;

    // 4. Get logs (for detection)
    const logs = getContainerLogs(webContainer);
    const nginxLogs = nginxContainer ? getNginxLogs(nginxContainer) : null;

    // 5. Build status object for case detection
    const siteStatus = {
        containerExists,
        containerRunning,
        containerRestarting: containerExists && !containerRunning && containerInfo.status && containerInfo.status.includes('Restarting'),
        httpStatus,
        gcpHealthy,
        pullError: null, // we don't have this in the current check, but could be extended
    };

    if (siteOK && gcpHealthy && containerRunning) {
        console.log(`   ✅ Site is fully healthy.`);
        return true;
    }

    if (!fix) {
        console.log(`   ℹ️  Use --fix to attempt repairs.`);
        return false;
    }

    // ----- Detect case -----
    const matchedCase = detectCase(siteStatus, logs, nginxLogs, env);
    if (matchedCase) {
        console.log(`   🔍 Detected case: ${matchedCase.description} (${matchedCase.id})`);
        const fixScriptPath = path.join(__dirname, 'fixes', matchedCase.fix_script);
        if (fs.existsSync(fixScriptPath)) {
            try {
                const fixFunction = require(fixScriptPath);
                const helpers = {
                    recreateContainer,
                    startContainer,
                    repairCollectStatic,
                    repairNginx,
                    ensureImagesExist,
                    updateHealthCheckTimeout,
                    getContainerLogs,
                    remoteExecSilent,
                    remoteExecWithEnv,
                    remoteExec,
                    buildExportString,
                };
                const result = await fixFunction(site, env, helpers);
                if (result) {
                    console.log(`   ✅ Fix applied successfully.`);
                } else {
                    console.log(`   ❌ Fix failed.`);
                }
            } catch (err) {
                console.error(`   ❌ Error executing fix script: ${err.message}`);
            }
        } else {
            console.log(`   ⚠️  Fix script not found: ${fixScriptPath}`);
            // Fallback to generic repair (existing logic)
            console.log(`   → Falling back to generic repair...`);
            await genericRepair(site, env);
        }
    } else {
        console.log(`   ⚠️  No matching case found. Falling back to generic repair...`);
        await genericRepair(site, env);
    }

    // ----- Wait and re-check -----
    console.log(`   ⏳ Waiting 30 seconds for services to settle...`);
    execSync('sleep 30', { stdio: 'pipe' });

    // Re-check GCP
    const recheckGCP = runGcloud(backend);
    const gcpOK = recheckGCP && recheckGCP.includes('HEALTHY');
    console.log(`   → GCP after repair: ${gcpOK ? '✅ HEALTHY' : '❌ UNHEALTHY'}`);

    // Re-check site
    const newStatus = checkSiteResponse(url, name);
    const newOK = newStatus !== null && newStatus >= 200 && newStatus < 400;
    console.log(`   → Site after repair: ${newOK ? `✅ HTTP ${newStatus}` : `❌ HTTP ${newStatus}`}`);

    if (gcpOK && newOK) {
        console.log(`   ✅ Site is now HEALTHY.`);
        return true;
    } else {
        console.log(`   ❌ Site is still UNHEALTHY after repairs.`);
        const logsAfter = getContainerLogs(webContainer);
        if (logsAfter) console.log(`   Recent logs:\n${logsAfter}`);
        return false;
    }
}

// ----- Generic repair (fallback) -----
async function genericRepair(site, env) {
    console.log(`   → Running generic repair...`);
    await ensureImagesExist(site, env);
    const status = getContainerStatus(site);
    if (!status.exists) {
        await recreateContainer(site, env);
    } else if (!status.running) {
        await startContainer(site, env);
    }
    await repairCollectStatic(site, env);
    if (site.nginxContainer) await repairNginx(site.nginxContainer);
    updateHealthCheckTimeout(site.gcpHealthCheck);
}

// ----- Main -----
async function main() {
    const args = process.argv.slice(2);
    const fix = args.includes('--fix');

    console.log(`🏥 Running health checks${fix ? ' with auto-repair' : ''}...\n`);

    let allHealthy = true;
    for (const site of SITES) {
        const ok = await checkAndRepair(site, fix);
        if (!ok) allHealthy = false;
    }

    console.log('\n' + '='.repeat(50));
    if (allHealthy) {
        console.log('✅ All sites are HEALTHY.');
        process.exit(0);
    } else {
        console.log('❌ Some sites are UNHEALTHY. Please investigate further.');
        process.exit(1);
    }
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});