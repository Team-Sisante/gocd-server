// Scripts/options/option_4.5.js

module.exports = async function (helpers) {
  const { ctx } = helpers;
  ctx.sh('docker system prune -f');
  await ctx.pause();
};