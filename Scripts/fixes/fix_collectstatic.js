// Scripts/fixes/fix_collectstatic.js

module.exports = async function(site, env, helpers) {
  console.log(`   → Fix: Running collectstatic on ${site.webContainer}`);
  return await helpers.repairCollectStatic(site, env);
};