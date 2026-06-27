// Scripts/options/option_4.8.js

module.exports = async function (helpers) {
  const { ctx } = helpers;
  ctx.sh('node Scripts/fix-node-options.js');
  await ctx.pause();
};