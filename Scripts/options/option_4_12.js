// Scripts/options/option_4.12.js

module.exports = async function (helpers) {
  const { ctx } = helpers;
  ctx.sh('node Scripts/generate-certs.js');
  await ctx.pause();
};