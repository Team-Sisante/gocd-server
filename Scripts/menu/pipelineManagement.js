// menu/pipelineManagement.js
// Pipeline management (2.2 – 2.3) and Agent management (3.1 – 3.3)

module.exports = {
    '2.2': async (ctx) => {
        const pipelineToView = await ctx.ask('Enter pipeline name (default: badminton_court-artifacts): ') || 'badminton_court-artifacts';
        ctx.openUrl(`${ctx.GOCD_BASE}/go/pipelines/${pipelineToView}`);
        await ctx.pause();
    },
    '2.3': async (ctx) => {
        const pipelineToUnlock = await ctx.ask('Enter pipeline name (default: badminton_court-artifacts): ') || 'badminton_court-artifacts';
        ctx.sh(`docker exec gocd-server curl -s -u "${ctx.GOCD_USER}:${ctx.GOCD_PASS}" -H "Confirm: true" -X POST ${ctx.GOCD_BASE}/go/api/pipelines/${pipelineToUnlock}/unlock`);
        ctx.log(`Pipeline ${pipelineToUnlock} unlock requested.`, '\x1b[32m');
        await ctx.pause();
    },
    '3.1': async (ctx) => {
        ctx.sh(`docker exec gocd-server curl -s -u "${ctx.GOCD_USER}:${ctx.GOCD_PASS}" ${ctx.GOCD_BASE}/go/api/agents | jq ".[] | {hostname, status, resources}"`);
        await ctx.pause();
    },
    '3.2': async (ctx) => {
        const agentToEnable = await ctx.ask('Enter agent UUID: ');
        if (agentToEnable) {
            ctx.sh(`docker exec gocd-server curl -s -u "${ctx.GOCD_USER}:${ctx.GOCD_PASS}" -X PATCH -H "Accept: application/vnd.go.cd.v1+json" -H "Content-Type: application/json" -d "{\\"agent_config_state\\": \\"Enabled\\"}" ${ctx.GOCD_BASE}/go/api/agents/${agentToEnable}`);
            ctx.log(`Agent ${agentToEnable} enabled.`, '\x1b[32m');
        }
        await ctx.pause();
    },
    '3.3': async (ctx) => {
        const agentToDisable = await ctx.ask('Enter agent UUID: ');
        if (agentToDisable) {
            ctx.sh(`docker exec gocd-server curl -s -u "${ctx.GOCD_USER}:${ctx.GOCD_PASS}" -X PATCH -H "Accept: application/vnd.go.cd.v1+json" -H "Content-Type: application/json" -d "{\\"agent_config_state\\": \\"Disabled\\"}" ${ctx.GOCD_BASE}/go/api/agents/${agentToDisable}`);
            ctx.log(`Agent ${agentToDisable} disabled.`, '\x1b[32m');
        }
        await ctx.pause();
    }
};