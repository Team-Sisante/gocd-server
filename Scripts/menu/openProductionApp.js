// menu/openStagingApp.js

module.exports = async function openProductionApp(ctx) {
    const productionUrl = `${ctx.PRODUCTION_APP_URL}`;
    ctx.openUrl(productionUrl);
    ctx.log(`Opening production app: ${productionUrl}`, '\x1b[32m');
    await ctx.pause();
};