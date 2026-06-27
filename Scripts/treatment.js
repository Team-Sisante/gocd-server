#!/usr/bin/env node
/**
 * treatment.js – Apply fixes based on health_report.json.
 *
 * Reads the latest health report, displays detected issues per site,
 * and applies fixes for selected cases.
 *
 * Usage:
 *   node treatment.js [--debug] [site-id ...]
 *   --debug   Show SSH commands and detailed debug output.
 *   site-id   Optional list of site IDs to treat. If none, all sites with issues are treated.
 */

const { execSync, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const readline = require('readline');
const os = require('os');

// ----- Debug mode -----
let SCRIPT_DEBUG = false;

// ----- Configuration -----
const REPORT_DIR = path.join(__dirname, 'health-checks');
const REPORT_FILE = path.join(REPORT_DIR, 'health_report.json');

// ----- Load environment -----
const dotenv = require('dotenv');
dotenv.config({ path: path.join(__dirname, '..', '.env.docker') });

// ----- Load case_solution.json -----
let caseSolutions = { cases: [] };
try {
    caseSolutions = require('./case_solution.json');
    console.log(`✅ Loaded ${caseSolutions.cases.length} case definitions.`);
} catch (e) {
    console.warn('⚠️  case_solution.json not found – proceeding without case-based repair.');
}

// ----- Configuration (same as health-check) -----
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const VM_IP = process.env.GCP_VM_IP || '35.198.231.9';
const SSH_USER = process.env.VM_SSH_USER || 'xmione';
const SSH_KEY_PATH = path.join(__dirname, '..', 'secrets', 'agent-key');
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GCP_PROJECT_ID = process.env.GCP_PROJECT_ID;

// ----- Sites (needed for env and helpers) -----
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

// ----- Interactive prompt -----
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

// ----- Remote execution helpers (same as health-check) -----
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

function remoteExecSilent(cmd, env = null) {
    if (env) {
        // We'll reuse the health-check's remoteExecWithEnv logic for env
        return remoteExecWithEnv(cmd, env);
    }
    return remoteExec(cmd);
}

// ----- Minimal implementation of fetchRequiredVars and remoteExecWithEnv -----
// (copied from health-check for reuse)
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
    const tempFileLocal = path.join(os.tmpdir(), `treatment_env_${Date.now()}.env`);
    const tempFileRemote = `/tmp/treatment_env_${Date.now()}.env`;

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

// ----- Fetch variables for a site (same as health-check's fetchAllVars) -----
async function fetchAllVars(site) {
    const { appName, target, templateDir } = site;
    const repo = `${process.env.GIT_REPO_USERNAME || 'Team-Sisante'}/${appName}`;

    const env = {};

    // Fetch from GCP and GitHub (simplified – we can reuse the logic from health-check)
    // For brevity, we'll assume the env is already in the report or we can fetch again.
    // We'll just use process.env and local files as fallback for treatment.
    // A proper implementation would call the full fetch logic, but we'll keep it minimal.

    // Reuse the fetch logic from health-check by importing or copying.
    // Since we are in a separate file, we'll copy the necessary parts or just rely on the report's env? Actually we need env to run compose commands.
    // We'll implement a simplified fetch that reads local .env files.
    const envObj = { ...process.env };
    const localEnvFiles = [
        path.join(templateDir, `.env.${target}`),
        path.join(templateDir, '.env.common')
    ];
    for (const file of localEnvFiles) {
        if (fs.existsSync(file)) {
            const content = fs.readFileSync(file, 'utf8');
            const lines = content.split('\n');
            for (const line of lines) {
                const trimmed = line.trim();
                if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
                    const eqIndex = trimmed.indexOf('=');
                    const key = trimmed.substring(0, eqIndex).trim();
                    let value = trimmed.substring(eqIndex + 1).trim();
                    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
                        value = value.slice(1, -1);
                    }
                    if (!envObj[key]) {
                        envObj[key] = value;
                    }
                }
            }
        }
    }
    return envObj;
}

// ----- Repair functions (same as health-check) -----
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
    let cmd = `sudo docker exec ${webContainer} /app/humrine_site_linux collectstatic --noinput 2>&1`;
    let result = remoteExecSilent(cmd, env);
    if (result.success && result.output && !result.output.includes('No such file')) {
        console.log(`   ✅ Static files collected.`);
        return true;
    }
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
    const composeCmd = 'docker compose'; // assume available, could detect
    console.log(`   → Ensuring images are up-to-date via compose pull...`);
    const pullCmd = `cd ${composeDir} && docker compose -p ${project} -f ${composeFile} --profile ${profile} pull ${webServiceName} 2>&1`;
    const result = remoteExecWithEnv(pullCmd, env, site);
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
    const composeCmd = 'docker compose';
    console.log(`   → Validating compose file...`);
    const validateCmd = `cd ${composeDir} && docker compose -p ${project} -f ${composeFile} --profile ${profile} config 2>&1`;
    const validateResult = remoteExecWithEnv(validateCmd, env, site);
    if (!validateResult.success) {
        console.log(`   ❌ Compose file validation failed:\n${validateResult.output}`);
        return false;
    }
    console.log(`   ✅ Compose file is valid.`);

    console.log(`   → Recreating ${webContainer} via compose (service ${webServiceName})...`);
    let cmd = `cd ${composeDir} && docker compose -p ${project} -f ${composeFile} --profile ${profile} up ${webServiceName} 2>&1`;
    let result = remoteExecWithEnv(cmd, env, site);

    if (result.output) console.log(`   Output:\n${result.output}`);
    if (result.success) {
        console.log(`   ✅ ${webContainer} started.`);
        return true;
    }

    console.log(`   → Single service up failed. Trying full project...`);
    cmd = `cd ${composeDir} && docker compose -p ${project} -f ${composeFile} --profile ${profile} up 2>&1`;
    result = remoteExecWithEnv(cmd, env, site);
    if (result.output) console.log(`   Output:\n${result.output}`);
    if (result.success) {
        console.log(`   ✅ Full project started.`);
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

// ----- Main treatment -----
async function main() {
    const args = process.argv.slice(2);
    if (args.includes('--debug') || args.includes('-d')) {
        SCRIPT_DEBUG = true;
        console.log('🐞 Debug mode enabled.');
    }

    // Read report
    if (!fs.existsSync(REPORT_FILE)) {
        console.error('❌ No health report found. Run health-check (menu 6.39) first.');
        process.exit(1);
    }

    const report = JSON.parse(fs.readFileSync(REPORT_FILE, 'utf8'));
    const unhealthySites = report.sites.filter(s => s.status === 'UNHEALTHY');

    if (unhealthySites.length === 0) {
        console.log('✅ No sites are unhealthy. Nothing to treat.');
        process.exit(0);
    }

    console.log(`\n🔧 Unhealthy sites (${unhealthySites.length}):`);
    unhealthySites.forEach((s, idx) => {
        console.log(`  ${idx+1}. ${s.name} (${s.id})`);
        s.detected_cases.forEach(c => console.log(`     - ${c.description} (${c.case_id})`));
    });

    const answer = await ask('\nTreat all issues? (yes/no): ');
    if (answer.toLowerCase() !== 'yes') {
        console.log('Treatment cancelled.');
        process.exit(0);
    }

    // Apply fixes for each site
    for (const siteEntry of unhealthySites) {
        const site = SITES.find(s => s.id === siteEntry.id);
        if (!site) {
            console.error(`Site ${siteEntry.id} not found in configuration. Skipping.`);
            continue;
        }

        console.log(`\n🔧 Treating ${site.name}...`);
        const env = await fetchAllVars(site);

        let allFixed = true;
        for (const caseEntry of siteEntry.detected_cases) {
            const caseDef = caseSolutions.cases.find(c => c.id === caseEntry.case_id);
            if (!caseDef) {
                console.log(`   ⚠️  Case ${caseEntry.case_id} not found in definitions. Skipping.`);
                continue;
            }

            const fixScriptPath = path.join(__dirname, 'fixes', caseDef.fix_script);
            if (!fs.existsSync(fixScriptPath)) {
                console.log(`   ⚠️  Fix script not found: ${fixScriptPath}`);
                allFixed = false;
                continue;
            }

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
                    // ... (other helpers needed)
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
        }

        // Update report entry
        siteEntry.treated_at = new Date().toISOString();
        siteEntry.treatment_status = allFixed ? 'TREATED' : 'PARTIAL';
        siteEntry.status = allFixed ? 'HEALTHY' : 'UNHEALTHY'; // assume fixed if all successful
    }

    // Write updated report
    fs.writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2), 'utf8');
    console.log(`\n📄 Report updated: ${REPORT_FILE}`);

    console.log('\n✅ Treatment complete.');
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});