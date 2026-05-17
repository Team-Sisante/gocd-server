// menu/triggerPipeline.js
// Handles pipeline trigger (option 2.1) with optional VM container check
// Supports automatic authentication via admin credentials (preferred),
// GOCD_API_TOKEN (fallback), or manual JSESSIONID cookie.

const fs = require('fs');
const path = require('path');
const viewLogs = require('./viewLogs');   // reusable 6.16

module.exports = async function triggerPipeline(ctx) {
    const { execSync: exec, log, setErrorDisplayed, GOCD_BASE, PROJECT_ROOT, GOCD_USER, GOCD_PASS } = ctx;
    const inquirer = (await import('inquirer')).default;
    ctx.rl.pause();

    // 1. Read pipeline names from cruise-config.xml
    const configPath = path.join(__dirname, '..', '..', 'config', 'cruise-config.xml');
    let pipelines = [];
    try {
        const xml = fs.readFileSync(configPath, 'utf8');
        const regex = /<pipeline\s+[^>]*name\s*=\s*["']([^"']+)["'][^>]*>/gi;
        let match;
        while ((match = regex.exec(xml)) !== null) pipelines.push(match[1]);
    } catch (e) {
        ctx.rl.resume();
        setErrorDisplayed(true);
        process.stdout.write('\x1Bc');
        log('❌ Could not read cruise-config.xml.', '\x1b[31m');
        console.error(e.message);
        await inquirer.prompt({ type: 'input', name: 'dummy', message: 'Press Enter to return to the menu...' });
        return;
    }
    if (pipelines.length === 0) {
        ctx.rl.resume();
        setErrorDisplayed(true);
        process.stdout.write('\x1Bc');
        log('No pipelines found in cruise-config.xml.', '\x1b[31m');
        await inquirer.prompt({ type: 'input', name: 'dummy', message: 'Press Enter to return to the menu...' });
        return;
    }

    // ----- Authentication mode selection -----
    let authHeader = '';
    let sessionCookie = '';
    const apiToken = process.env.GOCD_API_TOKEN;

    if (GOCD_USER && GOCD_PASS) {
        // 1st choice: admin credentials (always available from .env.docker)
        const basicAuth = Buffer.from(`${GOCD_USER}:${GOCD_PASS}`).toString('base64');
        authHeader = `-H "Authorization: Basic ${basicAuth}"`;
        log('🔑 Using admin credentials for authentication.', '\x1b[32m');
    } else if (apiToken) {
        // 2nd choice: personal access token
        const basicAuth = Buffer.from(`admin:${apiToken}`).toString('base64');
        authHeader = `-H "Authorization: Basic ${basicAuth}"`;
        log('🔑 Using GOCD_API_TOKEN for authentication.', '\x1b[32m');
    } else {
        // Last resort: manual cookie
        log('🔐 No admin credentials or token found – a session cookie is required.', '\x1b[33m');
        log('   Open http://localhost:8153/go/pipelines, log in, F12 → Application → Cookies.', '\x1b[33m');
        log('   Copy the value of the JSESSIONID cookie.', '\x1b[33m');
        const { cookie } = await inquirer.prompt({
            type: 'input', name: 'cookie', message: 'Paste JSESSIONID:'
        });
        sessionCookie = (cookie || '').trim();
        if (!sessionCookie) {
            ctx.rl.resume();
            setErrorDisplayed(true);
            process.stdout.write('\x1Bc');
            log('❌ No cookie – cannot trigger.', '\x1b[31m');
            await inquirer.prompt({ type: 'input', name: 'dummy', message: 'Press Enter to return to the menu...' });
            return;
        }
    }

    // ----- Optional: interactive container check (same as 6.16, but without follow) -----
    const { doCheck } = await inquirer.prompt({
        type: 'confirm',
        name: 'doCheck',
        message: 'Check VM containers before triggering?',
        default: true
    });
    if (doCheck) {
        await viewLogs(ctx, { follow: false });   // no follow mode for pre‑check
    }

    // Re‑pause readline – viewLogs will have resumed it
    ctx.rl.pause();

    // 3. Choose pipeline
    const { selectedPipeline } = await inquirer.prompt({
        type: 'list', name: 'selectedPipeline',
        message: 'Select a pipeline to trigger:', choices: pipelines
    });
    ctx.rl.resume();

    // 4. Build trigger command
    const url = GOCD_BASE + '/go/api/pipelines/' + selectedPipeline + '/schedule';
    let curlCmd;
    if (authHeader) {
        // Using token – no cookie needed
        curlCmd = `docker exec gocd-server curl -s ${authHeader} -H "Accept: application/vnd.go.cd.v1+json" -H "Content-Type: application/json" -H "X-GoCD-Confirm: true" -X POST -d "{\\"isTrusted\\":true}" "${url}"`;
    } else {
        // Using session cookie
        curlCmd = `docker exec gocd-server curl -s -H "Accept: application/vnd.go.cd.v1+json" -H "Content-Type: application/json" -H "X-GoCD-Confirm: true" -b "JSESSIONID=${sessionCookie}" -X POST -d "{\\"isTrusted\\":true}" "${url}"`;
    }

    try {
        const result = exec(curlCmd, { encoding: 'utf8', stdio: 'pipe', cwd: PROJECT_ROOT });
        if (result.includes('accepted')) {
            log('✅ Pipeline ' + selectedPipeline + ' triggered.', '\x1b[32m');
            await inquirer.prompt({ type: 'input', name: 'dummy', message: 'Press Enter to continue...' });
        } else {
            throw new Error(result.trim());
        }
    } catch (err) {
        // Ensure readline is active before showing error pause
        ctx.rl.resume();
        setErrorDisplayed(true);
        process.stdout.write('\x1Bc');
        log('❌ Failed to trigger pipeline.', '\x1b[31m');
        console.error(err.stderr || err.message || err.toString());
        await inquirer.prompt({ type: 'input', name: 'dummy', message: 'Press Enter to return to the menu...' });
    }
};