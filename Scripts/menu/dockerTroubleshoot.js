// menu/dockerTroubleshoot.js
// Docker troubleshoot options (5.1 – 5.5)

module.exports = {
    '5.1': async (ctx) => {
        ctx.sh('docker compose --env-file .env.docker build gocd-server && docker compose --env-file .env.docker up -d gocd-server');
        await ctx.pause();
    },
    '5.2': async (ctx) => {
        ctx.sh('docker compose --env-file .env.docker build --no-cache gocd-agent-1 && docker compose --env-file .env.docker up -d gocd-agent-1');
        await ctx.pause();
    },
    '5.3': async (ctx) => {
        ctx.sh('docker compose --env-file .env.docker build --no-cache gocd-agent-2 && docker compose --env-file .env.docker up -d gocd-agent-2');
        await ctx.pause();
    },
    '5.4': async (ctx) => {
        ctx.sh('docker compose --env-file .env.docker build --no-cache gocd-agent-3 && docker compose --env-file .env.docker up -d gocd-agent-3');
        await ctx.pause();
    },
    '5.5': async (ctx) => {
        const containerName = await ctx.ask('Enter container name (default: gocd-server): ') || 'gocd-server';
        ctx.sh(`docker compose --env-file .env.docker logs -f --tail 100 ${containerName}`);
        await ctx.pause();
    }
};