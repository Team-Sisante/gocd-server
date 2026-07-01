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

// ----- Import shared module -----
const common = require('./health_common');

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

// ----- Set debug flag for common module -----
common.setDebug(SCRIPT_DEBUG);

// ----- Shortcuts from common -----
const remoteExec = common.remoteExec;
const remoteExecSilent = common.remoteExecSilent;
const remoteExecWithEnv = common.remoteExecWithEnv;
const remoteExecLive = common.remoteExecLive;

// ----- Repair functions (using common helpers) -----
function getContainerLogs(container, lines = 20) {
    return common.getContainerLogs(container, lines);
}

function getContainerStatus(site) {
    return common.getContainerStatus(site);
}

function repairCollectStatic(site, env) {
    const { webContainer } = site;
    console.log(`   → Running collectstatic on ${webContainer}...`);
    let cmd = `sudo docker exec ${webContainer} /app/humrine_site_linux collectstatic --noinput 2>&1`;
    let result = remoteExecSilent(cmd, env, site);
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
    console.log(`   → Ensuring images are up-to-date via compose pull...`);
    const pullCmd = `cd ${composeDir} && docker compose -p ${project} -f ${composeFile} --profile ${profile} pull ${webServiceName} 2>&1`;
    const result = remoteExecLive(pullCmd, env, site);
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
    console.log(`   → Validating compose file...`);
    const validateCmd = `cd ${composeDir} && docker compose -p ${project} -f ${composeFile} --profile ${profile} config 2>&1`;
    const validateResult = remoteExecWithEnv(validateCmd, env, site);
    if (!validateResult.success) {
        console.log(`   ❌ Compose file validation failed:\n${validateResult.output}`);
        return false;
    }
    console.log(`   ✅ Compose file is valid.`);

    console.log(`   → Recreating ${webContainer} via compose (service ${webServiceName})...`);
    let cmd = `cd ${composeDir} && docker compose -p ${project} -f ${composeFile} --profile ${profile} up -d ${webServiceName} 2>&1`;
    let result = remoteExecLive(cmd, env, site);

    if (result.output) console.log(`   Output:\n${result.output}`);
    if (result.success) {
        console.log(`   ✅ ${webContainer} started (detached).`);
        execSync('sleep 5', { stdio: 'pipe' });
        const status = getContainerStatus(site);
        if (!status.running) {
            console.log(`   ⚠️  Container not running after start. Logs:`);
            const logs = getContainerLogs(webContainer);
            if (logs) console.log(logs);
            return false;
        }
        console.log(`   ✅ ${webContainer} is running.`);
        return true;
    }

    console.log(`   → Single service up failed. Trying full project...`);
    cmd = `cd ${composeDir} && docker compose -p ${project} -f ${composeFile} --profile ${profile} up -d 2>&1`;
    result = remoteExecWithEnv(cmd, env, site);
    if (result.output) console.log(`   Output:\n${result.output}`);
    if (result.success) {
        console.log(`   ✅ Full project started.`);
        execSync('sleep 5', { stdio: 'pipe' });
        const status = getContainerStatus(site);
        if (!status.running) {
            console.log(`   ⚠️  Container not running after full start. Logs:`);
            const logs = getContainerLogs(webContainer);
            if (logs) console.log(logs);
            return false;
        }
        console.log(`   ✅ ${webContainer} is running.`);
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
    let result = remoteExecSilent(cmd, env, site);
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
            `gcloud compute health-checks update http ${healthCheck} --timeout=30 --check-interval=30 --project=${common.GCP_PROJECT_ID}`,
            { stdio: 'pipe' }
        );
        return true;
    } catch (e) { return false; }
}

// ----- Main treatment -----
async function main() {
    const args = process.argv.slice(2);
    if (args.includes('--debug') || args.includes('-d')) {
        SCRIPT_DEBUG = true;
        common.setDebug(true);
        console.log('🐞 Debug mode enabled.');
    }

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

    // Use a single readline for the cache prompts and final question
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    const answer = await new Promise(resolve => rl.question('\nTreat all issues? (yes/no): ', resolve));
    if (answer.toLowerCase() !== 'yes') {
        console.log('Treatment cancelled.');
        rl.close();
        process.exit(0);
    }

    for (const siteEntry of unhealthySites) {
        const site = common.SITES.find(s => s.id === siteEntry.id);
        if (!site) {
            console.error(`Site ${siteEntry.id} not found in configuration. Skipping.`);
            continue;
        }

        console.log(`\n🔧 Treating ${site.name}...`);
        // Pass rl to ask about cache
        const env = await common.fetchAllVars(site, false, rl);

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
                    remoteExecLive,
                    fetchAllVars: common.fetchAllVars,
                    getContainerStatus,
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

        siteEntry.treated_at = new Date().toISOString();
        siteEntry.treatment_status = allFixed ? 'TREATED' : 'PARTIAL';
        siteEntry.status = allFixed ? 'HEALTHY' : 'UNHEALTHY';
    }

    rl.close();

    fs.writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2), 'utf8');
    console.log(`\n📄 Report updated: ${REPORT_FILE}`);
    console.log('\n✅ Treatment complete.');
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});