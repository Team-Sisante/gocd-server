// Scripts/options/option_4.2.js

module.exports = async function (helpers) {
  const { ctx } = helpers;
  ctx.sh('node Scripts/decryptenvfiles.js');
  await ctx.pause();
};