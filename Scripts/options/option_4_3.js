// Scripts/options/option_4.3.js

module.exports = async function (helpers) {
  const { ctx } = helpers;
  ctx.openUrl(`${ctx.GOCD_BASE}/go`);
};