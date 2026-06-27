// Scripts/options/option_4.6.js

module.exports = async function (helpers) {
  const { ctx } = helpers;
  ctx.sh('node Scripts/pfs.js');
  await ctx.pause();
};