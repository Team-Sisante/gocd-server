/**
 * health_common.js – Shared utilities for health-check.js and treatment.js
 *
 * Contains:
 *  - Configuration constants (SSH, GCP, site list)
 *  - SSH remote-exec helpers (with keep‑alive & timeout)
 *  - Variable fetching (GCP secrets, GitHub env, local .env) with cache
 *  - Misc helpers (extractPlaceholders, fetchRequiredVars, container status/logs)
 */

const { execSync, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');

// ---------- Debug flag (set by calling script) ----------
let SCRIPT_DEBUG = false;
function setDebug(val) { SCRIPT_DEBUG = val; }

// ---------- Configuration ----------
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const VM_IP = process.env.GCP_VM_IP || '35.198.231.9';
const SSH_USER = process.env.VM_SSH_USER || 'xmione';
const SSH_KEY_PATH = path.join(__dirname, '..', 'secrets', 'agent-key');
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GCP_PROJECT_ID = process.env.GCP_PROJECT_ID;

// ---------- Sites ----------
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

// ---------- Cache helpers ----------
const CACHE_DIR = path.join(__dirname, 'health-checks', 'cache');
const CACHE_TTL = 300; // 5 minutes

function getCacheFilePath(siteId) {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
    return path.join(CACHE_DIR, `vars_${siteId}.json`);
}

function loadFromCache(siteId) {
    const cacheFile = getCacheFilePath(siteId);
    if (!fs.existsSync(cacheFile)) return null;
    const stat = fs.statSync(cacheFile);
    const ageSec = (Date.now() - stat.mtimeMs) / 1000;
    if (ageSec > CACHE_TTL) {
        try { fs.unlinkSync(cacheFile); } catch (_) {}
        return null;
    }
    try {
        const data = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
        console.log(`  ♻️  Loaded variables from cache (${Math.round(ageSec)}s old).`);
        return data;
    } catch (e) { return null; }
}

function saveToCache(siteId, env) {
    const cacheFile = getCacheFilePath(siteId);
    fs.writeFileSync(cacheFile, JSON.stringify(env, null, 2), 'utf8');
    console.log(`  💾 Saved variables to cache (${path.basename(cacheFile)}).`);
}

// ---------- Cache prompt (asks user if they want to use cached vars) ----------
function promptForCache(siteId, rl) {
    if (!rl) return Promise.resolve(true);  // non-interactive -> use cache
    const cacheFile = getCacheFilePath(siteId);
    if (!fs.existsSync(cacheFile)) return Promise.resolve(false);
    const stat = fs.statSync(cacheFile);
    const ageSec = (Date.now() - stat.mtimeMs) / 1000;
    if (ageSec > CACHE_TTL) {
        try { fs.unlinkSync(cacheFile); } catch (_) {}
        return Promise.resolve(false);
    }
    return new Promise(resolve => {
        rl.question(`  ♻️  Found cached variables (${Math.round(ageSec)}s old). Use them? (Y/n): `, answer => {
            resolve(answer.trim().toLowerCase() !== 'n');
        });
    });
}

// ---------- SSH remote exec (with keep‑alive, timing & per‑command timeout) ----------
function remoteExec(cmd, options = {}) {
    const startTime = Date.now();
    const timeout = options.timeout || 120000;   // default 2 minutes
    const sshArgs = [
        '-i', SSH_KEY_PATH,
        '-o', 'StrictHostKeyChecking=no',
        '-o', 'UserKnownHostsFile=/dev/null',
        '-o', 'ConnectTimeout=15',
        '-o', 'LogLevel=ERROR',
        '-o', 'KexAlgorithms=+diffie-hellman-group14-sha256',
        '-o', 'ServerAliveInterval=5',
        '-o', 'ServerAliveCountMax=2',
        `${SSH_USER}@${VM_IP}`,
        cmd,
    ];

    if (SCRIPT_DEBUG) console.log(`   DEBUG SSH: ssh -i [key] ${SSH_USER}@${VM_IP} "${cmd}"`);

    try {
        const output = execFileSync('ssh', sshArgs, { encoding: 'utf8', stdio: 'pipe', timeout });
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`   ⏱️  Command completed in ${elapsed}s`);
        const out = output.trim();
        if (out) console.log(out);
        return { success: true, stdout: out, stderr: '', output: out, code: 0 };
    } catch (err) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`   ⏱️  Command failed after ${elapsed}s`);
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

// ---------- Env-file helpers ----------
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

function remoteExecWithEnv(cmd, env, site) {
    const { requiredVars } = fetchRequiredVars(site);
    const envPairs = Object.entries(env)
        .filter(([key]) => requiredVars.includes(key) && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key))
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
        '-o', 'ServerAliveInterval=5',
        '-o', 'ServerAliveCountMax=2',
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

function remoteExecLive(cmd, env, site) {
    const { requiredVars } = fetchRequiredVars(site);
    const envPairs = Object.entries(env)
        .filter(([key]) => requiredVars.includes(key) && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key))
        .map(([key, value]) => `${key}=${String(value).replace(/"/g, '\\"')}`);

    if (envPairs.length === 0) {
        console.log('   No required env vars. Running command without env file.');
        return remoteExec(cmd);
    }

    const envContent = envPairs.join('\n');
    const tempFileLocal = path.join(os.tmpdir(), `live_env_${Date.now()}.env`);
    const tempFileRemote = `/tmp/live_env_${Date.now()}.env`;

    fs.writeFileSync(tempFileLocal, envContent, 'utf8');

    const scpArgs = [
        '-i', SSH_KEY_PATH,
        '-o', 'StrictHostKeyChecking=no',
        '-o', 'UserKnownHostsFile=/dev/null',
        '-o', 'ConnectTimeout=15',
        '-o', 'LogLevel=ERROR',
        '-o', 'ServerAliveInterval=5',
        '-o', 'ServerAliveCountMax=2',
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
    try {
        const sshArgs = [
            '-i', SSH_KEY_PATH,
            '-o', 'StrictHostKeyChecking=no',
            '-o', 'UserKnownHostsFile=/dev/null',
            '-o', 'ConnectTimeout=15',
            '-o', 'LogLevel=ERROR',
            '-o', 'KexAlgorithms=+diffie-hellman-group14-sha256',
            '-o', 'ServerAliveInterval=5',
            '-o', 'ServerAliveCountMax=2',
            `${SSH_USER}@${VM_IP}`,
            fullCmd,
        ];
        execFileSync('ssh', sshArgs, { stdio: 'inherit', timeout: 120000 });
        remoteExec(`rm -f ${tempFileRemote}`);
        return { success: true };
    } catch (err) {
        console.error(`   ❌ Command failed: ${err.message}`);
        remoteExec(`rm -f ${tempFileRemote}`);
        return { success: false, output: err.message };
    }
}

// Simple wrapper
function remoteExecSilent(cmd, env = null) {
    if (env) return remoteExecWithEnv(cmd, env);
    return remoteExec(cmd);
}

// ---------- Variable fetching (with cache and prompt) ----------
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
                    console.log(`  ℹ️  ${fullSecretName} returned empty, using process.env.${secret}`);
                } else console.log(`  ⚠️  ${fullSecretName} empty and not in process.env.`);
            }
        } catch (err) {
            console.log(`  ⚠️  ${fullSecretName} fetch failed: ${err.message}`);
            if (process.env[secret]) {
                env[secret] = process.env[secret];
                console.log(`  ℹ️  using process.env.${secret}`);
            } else console.log(`  ⚠️  ${fullSecretName} not in process.env.`);
        }
    }
    return env;
}

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
                    } catch (e) { reject(e); }
                } else reject(new Error(`HTTP ${res.statusCode}: ${data}`));
            });
        });
        req.on('error', reject);
        req.end();
    });
}

async function fetchAllVars(site, forceFresh = false, rl = null) {
    const { appName, target, templateDir } = site;
    const repo = `${process.env.GIT_REPO_USERNAME || 'Team-Sisante'}/${appName}`;
    const env = {};

    // Cache check with optional prompt
    if (!forceFresh && !process.argv.includes('--no-cache')) {
        const useCache = await promptForCache(site.id, rl);
        if (useCache) {
            const cached = loadFromCache(site.id);
            if (cached) {
                Object.assign(env, cached);
                // Fall through to filtering/output below
            }
        }
    }

    const cachedAlready = Object.keys(env).length > 0;
    if (!cachedAlready) {
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

        // Fallback local .env files
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
                if (loaded > 0) console.log(`  Loaded ${loaded} variables from local ${path.basename(file)}`);
            }
        }

        if (!env.IMAGE_TAG) {
            env.IMAGE_TAG = 'latest';
            console.log(`  IMAGE_TAG set to: ${env.IMAGE_TAG}`);
        }

        saveToCache(site.id, env);
    }

    // Clean internal variables
    const internalPrefixes = ['npm_', 'TERM_', 'XDG_', 'SSH_', 'LC_', 'LS_COLORS', 'DBUS_', 'DISPLAY', 'LANGUAGE', 'WINDOW', 'COLORTERM', 'PAGER', 'EDITOR', 'VISUAL'];
    const internalKeys = ['PATH', 'HOME', 'PWD', 'SHELL', 'HOSTNAME', '_', 'OLDPWD', 'SHLVL', 'LOGNAME', 'USER', 'TERM', 'LANG', 'MAIL', 'PROMPT_COMMAND', 'PS1', 'PS2', 'PS4', 'TERM_PROGRAM', 'TERM_PROGRAM_VERSION', 'TERM_SESSION_ID', 'WINDOWID'];
    for (const key of Object.keys(env)) {
        if (internalKeys.includes(key) || internalPrefixes.some(p => key.startsWith(p))) {
            delete env[key];
        }
    }

    console.log(`  Final variable count: ${Object.keys(env).length}`);

    // Diagnostic output
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
            } else console.log(`    ${key}: ${val}`);
        }
    });

    return env;
}

// ---------- Container helpers (with short timeouts) ----------
function getContainerLogs(container, lines = 20) {
    const cmd = `sudo docker logs ${container} --tail=${lines} 2>&1`;
    // short timeout – logs should never take more than 30 seconds
    const result = remoteExec(cmd, { timeout: 30000 });
    return (result.success && result.output) ? result.output : null;
}

function getContainerStatus(site) {
    const { webContainer } = site;
    const cmd = `sudo docker ps -a --filter name=${webContainer} --format '{{.Status}}'`;
    // short timeout – docker ps is instant unless SSH is broken
    const result = remoteExec(cmd, { timeout: 30000 });
    if (!result.success || !result.output) {
        return { exists: false, running: false, status: null };
    }
    const status = result.output.trim();
    return {
        exists: true,
        running: status.includes('Up'),
        unhealthy: status.includes('unhealthy'),
        status
    };
}

// ---------- Export ----------
module.exports = {
    setDebug,
    PROJECT_ROOT,
    VM_IP,
    SSH_USER,
    SSH_KEY_PATH,
    GITHUB_TOKEN,
    GCP_PROJECT_ID,
    SITES,
    remoteExec,
    remoteExecSilent,
    remoteExecWithEnv,
    remoteExecLive,
    fetchAllVars,
    fetchRequiredVars,
    extractPlaceholders,
    fetchGCPSecrets,
    fetchGitHubVars,
    getContainerLogs,
    getContainerStatus,
    loadFromCache,
    saveToCache,
};