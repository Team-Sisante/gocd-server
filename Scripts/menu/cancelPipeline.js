// menu/cancelPipeline.js
// Handles pipeline stage cancellation by discovering active stages via cctray.xml.

const { XMLParser } = require('fast-xml-parser');
const axios = require('axios');

module.exports = async function cancelPipeline(ctx) {
    const { sh, log, GOCD_BASE, GOCD_USER, GOCD_PASS } = ctx;
    const inquirer = (await import('inquirer')).default;

    ctx.rl.pause();

    const auth = { username: GOCD_USER, password: GOCD_PASS };
    
    // 1. Fetch active projects from CCTray
    let activeProjects = [];
    try {
        const res = await axios.get(`${GOCD_BASE}/go/cctray.xml`, {
            auth, headers: { 'Accept': 'application/xml' }
        });
        
        const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "" });
        const jsonObj = parser.parse(res.data);
        
        const projects = Array.isArray(jsonObj.Projects.Project) 
            ? jsonObj.Projects.Project 
            : [jsonObj.Projects.Project];

        activeProjects = projects.filter(p => p.activity === 'Building');
    } catch (e) {
        ctx.rl.resume();
        log('❌ Could not fetch active pipelines from CCTray: ' + e.message, '\x1b[31m');
        await inquirer.prompt({ type: 'input', name: 'dummy', message: 'Press Enter to continue...' });
        return;
    }

    if (activeProjects.length === 0) {
        ctx.rl.resume();
        log('No active pipelines found.', '\x1b[33m');
        await inquirer.prompt({ type: 'input', name: 'dummy', message: 'Press Enter to continue...' });
        return;
    }

    // 2. Select stage to cancel
    const { selectedProject } = await inquirer.prompt({
        type: 'list', name: 'selectedProject',
        message: 'Select active stage to cancel:',
        choices: activeProjects.map(p => ({
            name: `${p.name} (${p.webUrl})`,
            value: p
        }))
    });

    // 3. Extract details from webUrl
    // Expected structure: .../pipelines/<pipelineName>/<pipelineCounter>/<stageName>/<stageCounter>/...
    const urlParts = selectedProject.webUrl.split('/');
    const pipelineName = urlParts[urlParts.indexOf('pipelines') + 1];
    const pipelineCounter = urlParts[urlParts.indexOf('pipelines') + 2];
    const stageName = urlParts[urlParts.indexOf('pipelines') + 3];
    const stageCounter = urlParts[urlParts.indexOf('pipelines') + 4];

    ctx.rl.resume();

    // 4. Build and execute cancel command
    const url = `${GOCD_BASE}/go/api/stages/${pipelineName}/${pipelineCounter}/${stageName}/${stageCounter}/cancel`;
    
    const cmd = `curl -v -X POST ` +
                `-H "Accept: application/vnd.go.cd.v3+json" ` +
                `-H "X-GoCD-Confirm: true" ` +
                `-u "${GOCD_USER}:${GOCD_PASS}" ` +
                `"${url}"`;

    log(`Executing: ${cmd}`, '\x1b[33m');
    sh(cmd);
    await inquirer.prompt({ type: 'input', name: 'dummy', message: 'Press Enter to continue...' });
};
