// menu/triggerPipeline.js
// Handles pipeline trigger (option 2.1)

const fs = require('fs');
const path = require('path');

module.exports = async function triggerPipeline(ctx) {
    const { execSync: exec, log, ask, rl, setErrorDisplayed, GOCD_BASE, PROJECT_ROOT } = ctx;
    const inquirer = (await import('inquirer')).default;
    rl.pause();

    // 1. Read pipeline names from cruise-config.xml
    const configPath = path.join(__dirname, '..', '..', 'config', 'cruise-config.xml');
    let pipelines = [];
    try {
        const xml = fs.readFileSync(configPath, 'utf8');
        const regex = /<pipeline\s+[^>]*name\s*=\s*["']([^"']+)["'][^>]*>/gi;
        let match;
        while ((match = regex.exec(xml)) !== null) pipelines.push(match[1]);
    } catch (e) {
        rl.resume();
        log('❌ Could not read cruise-config.xml.', '\x1b[31m');
        console.error(e.message);
        await ask('Press Enter to continue...');
        return;
    }
    if (pipelines.length === 0) {
        rl.resume();
        log('No pipelines found in cruise-config.xml.', '\x1b[31m');
        await ask('Press Enter to continue...');
        return;
    }

    // 2. Always ask for a fresh cookie
    log('🔐 A GoCD session cookie is required for every trigger.', '\x1b[33m');
    log('   Open http://localhost:8153/go/pipelines, log in, F12 → Application → Cookies.', '\x1b[33m');
    log('   Copy the value of the JSESSIONID cookie.', '\x1b[33m');
    const { cookie } = await inquirer.prompt({
        type: 'input', name: 'cookie', message: 'Paste JSESSIONID:'
    });
    const sessionCookie = (cookie || '').trim();
    if (!sessionCookie) {
        rl.resume();
        log('❌ No cookie – cannot trigger.', '\x1b[31m');
        return;
    }

    // 3. Choose pipeline
    const { selectedPipeline } = await inquirer.prompt({
        type: 'list', name: 'selectedPipeline',
        message: 'Select a pipeline to trigger:', choices: pipelines
    });
    rl.resume();

    // 4. Trigger exactly like the manual command
    const url = GOCD_BASE + '/go/api/pipelines/' + selectedPipeline + '/schedule';
    const curlCmd = `docker exec gocd-server curl -s -H "Accept: application/vnd.go.cd.v1+json" -H "Content-Type: application/json" -H "X-GoCD-Confirm: true" -b "JSESSIONID=${sessionCookie}" -X POST -d "{\\"isTrusted\\":true}" "${url}"`;

    try {
        const result = exec(curlCmd, { encoding: 'utf8', stdio: 'pipe', cwd: PROJECT_ROOT });
        if (result.includes('accepted')) {
            log('✅ Pipeline ' + selectedPipeline + ' triggered.', '\x1b[32m');
        } else {
            log('❌ Trigger may have failed. Server said:', '\x1b[31m');
            console.error(result);
        }
    } catch (err) {
        log('❌ Failed to trigger pipeline.', '\x1b[31m');
        console.error(err.stderr || err.message);
    }
    await ask('Press Enter to continue...');
};