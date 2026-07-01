// Scripts/options/option_4.4.js

module.exports = async function (helpers) {
  const { ctx } = helpers;
  ctx.sh('docker stats --no-stream');
};