// Scripts/options/option_4.7.js

module.exports = async function (helpers) {
  const { ctx } = helpers;
  const featureBranch = await ctx.ask('Enter feature branch name: ');
  if (featureBranch) {
    ctx.sh(`node Scripts/master-feature-git-sync.js ${featureBranch}`);
  }
};