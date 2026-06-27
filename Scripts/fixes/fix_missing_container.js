// Scripts/fixes/fix_missing_container.js

module.exports = async function(site, env, helpers) {
  console.log(`   → Fix: Recreating missing container ${site.webContainer}`);
  return await helpers.recreateContainer(site, env);
};