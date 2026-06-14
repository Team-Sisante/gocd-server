// menu/cancelPipeline.js
// Handles pipeline stage cancellation (option 2.4) by fetching active stages via API.

const fs = require('fs');
const path = require('path');

module.exports = async function cancelPipeline(ctx) {
    const { sh, log, GOCD_BASE, GOCD_USER, GOCD_PASS } = ctx;
    const inquirer = (await import('inquirer')).default;
    const axios = (await import('axios')).default; // Assume axios is available

    ctx.rl.pause();

    // 1. Fetch running pipelines
    const auth = { username: GOCD_USER, password: GOCD_PASS };
    
    let pipelines = [];
    try {
        const res = await axios.get(`${GOCD_BASE}/go/api/pipelines/active`, {
            auth, headers: { 'Accept': 'application/vnd.go.cd.v3+json' }
        });
        pipelines = res.data.map(p => p.name);
    } catch (e) {
        ctx.rl.resume();
        log('❌ Could not fetch active pipelines: ' + e.message, '\x1b[31m');
        await inquirer.prompt({ type: 'input', name: 'dummy', message: 'Press Enter to continue...' });
        return;
    }

    if (pipelines.length === 0) {
        ctx.rl.resume();
        log('No active pipelines found.', '\x1b[33m');
        await inquirer.prompt({ type: 'input', name: 'dummy', message: 'Press Enter to continue...' });
        return;
    }

    // 2. Select pipeline
    const { selectedPipeline } = await inquirer.prompt({
        type: 'list', name: 'selectedPipeline',
        message: 'Select running pipeline to cancel:', choices: pipelines
    });

    // 3. Fetch active stages for the selected pipeline
    let stages = [];
    try {
        const res = await axios.get(`${GOCD_BASE}/go/api/pipelines/${selectedPipeline}/history`, {
            auth, headers: { 'Accept': 'application/vnd.go.cd.v3+json' }
        });
        // Simplification: Get latest pipeline instance that is running
        const latest = res.data.pipelines[0];
        const counter = latest.counter;
        
        stages = latest.stages
            .filter(s => s.state !== 'Passed' && s.state !== 'Failed' && s.state !== 'Cancelled')
            .map(s => ({
                name: s.name,
                counter: s.counter,
                pipelineCounter: counter
            }));
    } catch (e) {
        ctx.rl.resume();
        log('❌ Could not fetch active stages: ' + e.message, '\x1b[31m');
        await inquirer.prompt({ type: 'input', name: 'dummy', message: 'Press Enter to continue...' });
        return;
    }

    if (stages.length === 0) {
        ctx.rl.resume();
        log('No active stages for this pipeline.', '\x1b[33m');
        await inquirer.prompt({ type: 'input', name: 'dummy', message: 'Press Enter to continue...' });
        return;
    }

    // 4. Select stage
    const { selectedStage } = await inquirer.prompt({
        type: 'list', name: 'selectedStage',
        message: 'Select stage to cancel:', 
        choices: stages.map(s => ({ name: `${s.name} (Counter: ${s.counter})`, value: s }))
    });

    ctx.rl.resume();

    // 5. Build and execute cancel command
    const url = `${GOCD_BASE}/go/api/stages/${selectedPipeline}/${selectedStage.pipelineCounter}/${selectedStage.name}/${selectedStage.counter}/cancel`;
    
    const cmd = `curl -v -X POST ` +
                `-H "Accept: application/vnd.go.cd.v3+json" ` +
                `-H "Content-Type: application/json" ` +
                `-H "X-GoCD-Confirm: true" ` +
                `-u "${GOCD_USER}:${GOCD_PASS}" ` +
                `"${url}"`;

    log(`Executing: ${cmd}`, '\x1b[33m');
    sh(cmd);
    await inquirer.prompt({ type: 'input', name: 'dummy', message: 'Press Enter to continue...' });
};
