// menu/openStagingApp.js

module.exports = async function openStagingApp(ctx) {
    const stagingUrl = `${ctx.STAGING_APP_URL}`;
    ctx.openUrl(stagingUrl);
    ctx.log(`Opening staging app: ${stagingUrl}`, '\x1b[32m');
    await ctx.pause();
};