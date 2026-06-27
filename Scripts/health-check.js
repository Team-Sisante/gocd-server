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
const readline = require('readline');
const os = require('os');

// ----- Setup logging -----
const LOG_DIR = path.join(__dirname, "health-checks"); // Scripts/health-checks/ directory
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
  // Try 'docker compose' first (newer), fallback to 'docker-compose'
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

    // Check if --all is passed
    if (args.includes('--all')) return SITES;

    // Check for specific site IDs in args
    const requested = args.filter(arg => allIds.includes(arg));
    if (requested.length > 0) {
        return SITES.filter(s => requested.includes(s.id));
    }

    // Interactive selection
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

    return { gcpSecrets: [...new Set(gcpSecrets)], requiredVars: [...new Set(requiredVars)] };
}

// ----- Helper: fetch secrets from GCP (with app prefix) -----
function fetchGCPSecrets(appName, secretsList) {
    console.log(`  Using GCP credentials from: ${process.env.GOOGLE_APPLICATION_CREDENTIALS || 'not set'}`);
    const env = {};

    // ----- Set up GCP credentials -----
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
            // Remove 2>/dev/null to see the actual error
            const value = execSync(
                `gcloud secrets versions access latest --secret="${fullSecretName}" --project=${GCP_PROJECT_ID}`,
                { encoding: 'utf8', stdio: 'pipe' }
            ).trim();
            if (value) {
                env[secret] = value;
                console.log(`  🔐 ${secret} (from ${fullSecretName})`);
            } else {
                // If value is empty (shouldn't happen), fallback
                if (process.env[secret]) {
                    env[secret] = process.env[secret];
                    console.log(`  ℹ️  ${fullSecretName} returned empty, using process.env.${secret}: ${process.env[secret]}`);
                } else {
                    console.log(`  ⚠️  ${fullSecretName} empty and not in process.env.`);
                }
            }
        } catch (err) {
            // Log the full error message for debugging
            console.log(`  ⚠️  ${fullSecretName} fetch failed: ${err.message}`);
            // Also print stderr if available
            if (err.stderr) console.log(`  stderr: ${err.stderr.toString().trim()}`);
            // Fallback to process.env
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

    // 3. Ensure IMAGE_TAG is set (for docker compose)
    if (!env.IMAGE_TAG) {
        // Try to read from artifacts shared file (if running on GoCD agent)
        const depLabelVar = `GO_DEPENDENCY_LABEL_${appName.toUpperCase().replace(/-/g, '_')}_ARTIFACTS`;
        const depLabel = process.env[depLabelVar];
        if (depLabel) {
            const tagFile = `/shared-tags/${appName}-tag-${depLabel}.txt`;
            try {
                const tagContent = fs.readFileSync(tagFile, 'utf8').trim();
                if (tagContent) {
                    env.IMAGE_TAG = `sha-${tagContent}`;
                    console.log(`  Read IMAGE_TAG from artifacts: ${env.IMAGE_TAG}`);
                }
            } catch (e) {
                console.log(`  Could not read tag file: ${e.message}`);
            }
        }
        // If still not set, try to query GHCR
        if (!env.IMAGE_TAG) {
            const token = process.env.GITHUB_TOKEN;
            if (token) {
                try {
                    const tagsOutput = execSync(
                        `curl -s -H "Authorization: Bearer ${token}" https://ghcr.io/v2/Team-Sisante/${appName}-web/tags/list`,
                        { encoding: 'utf8', stdio: 'pipe' }
                    );
                    const tags = JSON.parse(tagsOutput).tags || [];
                    const shaTag = tags.find(t => t.startsWith('sha-'));
                    if (shaTag) {
                        env.IMAGE_TAG = shaTag;
                        console.log(`  Found latest SHA tag from GHCR: ${env.IMAGE_TAG}`);
                    } else {
                        env.IMAGE_TAG = 'latest';
                        console.log(`  No SHA tags found, using 'latest'`);
                    }
                } catch (e) {
                    env.IMAGE_TAG = 'latest';
                    console.log(`  GHCR query failed, using 'latest'`);
                }
            } else {
                env.IMAGE_TAG = 'latest';
                console.log(`  GITHUB_TOKEN not set, using 'latest' for IMAGE_TAG`);
            }
        }
        console.log(`  IMAGE_TAG set to: ${env.IMAGE_TAG}`);
    } else {
        console.log(`  IMAGE_TAG already set: ${env.IMAGE_TAG}`);
    }

    // 4. Override with .env file from the VM (if exists)
    console.log('  Reading .env file from VM (if present)...');
    const vmEnv = readEnvFileFromVM(site);
    if (Object.keys(vmEnv).length > 0) {
        Object.assign(env, vmEnv);
        console.log(`  Added ${Object.keys(vmEnv).length} variables from VM .env file.`);
    } else {
        console.log('  No VM .env file found or empty.');
    }

    // 5. Remove internal Node.js variables that are not needed
    const internalPrefixes = ['npm_', 'TERM_', 'XDG_', 'SSH_', 'LC_', 'LS_COLORS', 'DBUS_', 'DISPLAY', 'LANGUAGE', 'WINDOW', 'COLORTERM', 'PAGER', 'EDITOR', 'VISUAL'];
    const internalKeys = ['PATH', 'HOME', 'PWD', 'SHELL', 'HOSTNAME', '_', 'OLDPWD', 'SHLVL', 'LOGNAME', 'USER', 'TERM', 'LANG', 'MAIL', 'PROMPT_COMMAND', 'PS1', 'PS2', 'PS4', 'TERM_PROGRAM', 'TERM_PROGRAM_VERSION', 'TERM_SESSION_ID', 'WINDOWID'];
    for (const key of Object.keys(env)) {
        if (internalKeys.includes(key) || internalPrefixes.some(p => key.startsWith(p))) {
            delete env[key];
        }
    }

    console.log(`  Final variable count: ${Object.keys(env).length}`);

    // Diagnostic: print some key variables (mask secrets)
    const diagnosticKeys = ['DEBUG', 'SECRET_KEY', 'SITE_HEADER', 'ALLOWED_HOSTS', 'POSTE_PROTOCOL', 'IMAGE_TAG'];
    console.log('  Diagnostic variables:');
    diagnosticKeys.forEach(key => {
        const val = env[key];
        if (val === undefined) {
            console.log(`    ${key}: MISSING`);
        } else {
            // Mask secrets: show only first 4 chars for sensitive values
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

// ----- Helper: build export string from env object -----
function buildExportString(env) {
    const lines = [];
    for (const [key, value] of Object.entries(env)) {
        // Skip keys that are comments or empty
        if (key.startsWith('#') || key.trim() === '') continue;
        // Skip internal Node variables (already filtered, but just in case)
        const safeValue = String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        lines.push(`export ${key}="${safeValue}"`);
    }
    return lines.join(' && ');
}

// ----- Remote execution with fetched env -----
function remoteExecWithEnv(cmd, env, site) {
  // Filter out comment lines and empty keys
  const envPairs = Object.entries(env)
    .filter(([key]) => !key.startsWith('#') && key.trim() !== '')
    .map(([key, value]) => `${key}=${String(value).replace(/"/g, '\\"')}`);

  if (envPairs.length === 0) {
    console.log('   No environment variables to write. Running command without env file.');
    return remoteExec(cmd);
  }

  const envContent = envPairs.join('\n');
  const tempFileLocal = path.join(os.tmpdir(), `health_env_${Date.now()}.env`);
  const tempFileRemote = `/tmp/health_env_${Date.now()}.env`;

  // Write local temp file
  fs.writeFileSync(tempFileLocal, envContent, 'utf8');

  // SCP the file to the VM
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
    console.log(`   ✅ Copied env file to VM: ${tempFileRemote}`);
  } catch (err) {
    console.error(`   ❌ Failed to copy env file to VM: ${err.message}`);
    // Clean up local file
    try { fs.unlinkSync(tempFileLocal); } catch (_) {}
    return { success: false, output: err.message };
  }

  // Clean up local file
  try { fs.unlinkSync(tempFileLocal); } catch (_) {}

  // Inject --env-file into the command
  const fullCmd = cmd.replace(/(docker compose(?:-)?)/, `$1 --env-file ${tempFileRemote}`);
  const result = remoteExec(fullCmd);

  // Clean up the remote temp file
  remoteExec(`rm -f ${tempFileRemote}`);

  return result;
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

  // Debug: print the full SSH command (without exposing the key path)
  console.log(`   DEBUG SSH: ssh -i [key] ${SSH_USER}@${VM_IP} "${cmd}"`);

  try {
    const output = execFileSync('ssh', args, { encoding: 'utf8', stdio: 'pipe' });
    return { success: true, stdout: output.trim(), stderr: '', output: output.trim(), code: 0 };
  } catch (err) {
    // Log everything from the error object
    console.log(`   DEBUG: err.code = ${err.code}`);
    console.log(`   DEBUG: err.status = ${err.status}`);
    console.log(`   DEBUG: err.signal = ${err.signal}`);
    console.log(`   DEBUG: err.stdout = ${err.stdout ? err.stdout.toString().trim() : '(empty)'}`);
    console.log(`   DEBUG: err.stderr = ${err.stderr ? err.stderr.toString().trim() : '(empty)'}`);
    console.log(`   DEBUG: err.message = ${err.message}`);
    console.log(`   DEBUG: err.cmd = ${err.cmd}`);

    const stdout = err.stdout ? err.stdout.toString().trim() : '';
    const stderr = err.stderr ? err.stderr.toString().trim() : '';
    const combined = stdout + (stderr ? '\n' + stderr : '');
    return { success: false, stdout, stderr, output: combined, code: err.status };
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
  const composeCmd = detectComposeCommand();
  if (!composeCmd) {
    console.log(`   ❌ docker compose not available.`);
    return false;
  }
  console.log(`   → Ensuring images are up-to-date via compose pull...`);
  const pullCmd = `cd ${composeDir} && ${composeCmd} -p ${project} -f ${composeFile} --profile ${profile} pull ${webServiceName} 2>&1`;
  const result = remoteExecWithEnv(validateCmd, env, site);
  if (result.output) console.log(`   Output:\n${result.output}`);
  if (result.success) {
    console.log(`   ✅ Images pulled.`);
    return true;
  }
  console.log(`   ❌ Failed to pull images.`);
  return false;
}

function recreateContainer(site, env) {
  const { webContainer, composeDir, composeFile, project, profile, webServiceName } = site;

  // Detect compose command
  const composeCmd = detectComposeCommand();
  if (!composeCmd) {
    console.log(`   ❌ docker compose not available on VM.`);
    return false;
  }

  console.log(`   → Using compose command: ${composeCmd}`);

  // Validate compose file
  console.log(`   → Validating compose file...`);
  const validateCmd = `cd ${composeDir} && ${composeCmd} -p ${project} -f ${composeFile} --profile ${profile} config 2>&1`;
  const validateResult = remoteExecWithEnv(validateCmd, env, site);
  if (!validateResult.success) {
    console.log(`   ❌ Compose file validation failed:\n${validateResult.output}`);
    return false;
  }
  console.log(`   ✅ Compose file is valid.`);

  // Run up
  console.log(`   → Recreating ${webContainer} via compose (service ${webServiceName})...`);
  let cmd = `cd ${composeDir} && ${composeCmd} -p ${project} -f ${composeFile} --profile ${profile} up ${webServiceName} 2>&1`;
  let result = remoteExecWithEnv(cmd, env);

  if (result.output) console.log(`   Output:\n${result.output}`);
  if (result.success) {
    console.log(`   ✅ ${webContainer} started.`);
    const status = getContainerStatus(site);
    if (!status.running) {
      console.log(`   ⚠️  Container not running. Logs:`);
      const logs = getContainerLogs(webContainer);
      if (logs) console.log(logs);
      return false;
    }
    return true;
  }

  console.log(`   → Single service up failed.`);
  console.log(`   → Trying full project up...`);
  cmd = `cd ${composeDir} && ${composeCmd} -p ${project} -f ${composeFile} --profile ${profile} up 2>&1`;
  result = remoteExecWithEnv(cmd, env);
  if (result.output) console.log(`   Output:\n${result.output}`);
  if (result.success) {
    console.log(`   ✅ Full project started.`);
    const status = getContainerStatus(site);
    if (!status.running) {
      console.log(`   ⚠️  Container not running. Logs:`);
      const logs = getContainerLogs(webContainer);
      if (logs) console.log(logs);
      return false;
    }
    return true;
  }

  console.log(`   ❌ Failed to recreate ${webContainer}.`);
  const logs = getContainerLogs(webContainer);
  if (logs) console.log(`   Container logs:\n${logs}`);
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
    const { name, backend, webContainer, url } = site;

    // Fetch env (only once per site)
    const env = await fetchAllVars(site);
    if (Object.keys(env).length === 0) {
        console.log(`❌ No environment variables fetched for ${name}. Aborting.`);
        return false;
    }

    console.log(`\n🔍 Checking ${name} (${backend})...`);

    // 1. Gather status
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
        containerRestarting: containerInfo.exists && !containerInfo.running && containerInfo.status && containerInfo.status.includes('Restarting'),
        httpStatus,
        gcpHealthy,
        logs,
        nginxLogs,
    };

    // 2. Detect all matching cases
    const detectedCases = [];
    for (const caseDef of caseSolutions.cases) {
        const detect = caseDef.detect;
        let matches = true;

        if (detect.container_status) {
            const status = detect.container_status;
            if (status === 'missing' && siteStatus.containerExists) matches = false;
            if (status === 'stopped' && (siteStatus.containerRunning || !siteStatus.containerExists)) matches = false;
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
        return true;
    }

    console.log(`   🔍 Detected ${detectedCases.length} issue(s):`);
    detectedCases.forEach(c => console.log(`     - ${c.description} (${c.id})`));

    // 3. If --fix is not provided, just report
    if (!fix) {
        console.log(`   ℹ️  Use --fix to attempt repairs.`);
        return false;
    }

    // 4. Apply fixes in order (case order as in JSON)
    let allFixed = true;
    for (const caseDef of detectedCases) {
        const fixScriptPath = path.join(__dirname, 'fixes', caseDef.fix_script);
        if (fs.existsSync(fixScriptPath)) {
            console.log(`   🔧 Applying fix for ${caseDef.id}...`);
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
                    getContainerStatus,
                    checkSiteResponse,
                    runGcloud,
                };
                const result = await fixFunction(site, env, helpers);
                if (result) {
                    console.log(`   ✅ Fix applied successfully.`);
                } else {
                    console.log(`   ❌ Fix failed for ${caseDef.id}.`);
                    allFixed = false;
                }
            } catch (err) {
                console.error(`   ❌ Error executing fix script: ${err.message}`);
                allFixed = false;
            }
        } else {
            console.log(`   ⚠️  Fix script not found: ${fixScriptPath}`);
            allFixed = false;
        }
    }

    // 5. Wait and re-check
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

// ----- Main -----
async function main() {
    const args = process.argv.slice(2);
    const fix = args.includes('--fix');
    const selectedSites = await selectSites(args);

    console.log(`🏥 Running health checks${fix ? ' with auto-repair' : ''}...`);
    console.log(`📋 Selected sites: ${selectedSites.map(s => s.name).join(', ')}\n`);

    let allHealthy = true;
    for (const site of selectedSites) {
        const ok = await checkAndRepair(site, fix);
        if (!ok) allHealthy = false;
    }

    console.log('\n' + '='.repeat(50));
    if (allHealthy) {
        console.log('✅ All selected sites are HEALTHY.');
        process.exit(0);
    } else {
        console.log('❌ Some selected sites are UNHEALTHY. Please investigate further.');
        process.exit(1);
    }
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});