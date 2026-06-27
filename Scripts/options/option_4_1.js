// Scripts/options/option_4.1.js

module.exports = async function (helpers) {
  const { ctx } = helpers;
  ctx.sh('node Scripts/encryptenvfiles.js');
  await ctx.pause();
};