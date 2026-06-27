// Scripts/fixes/fix_stopped_container.js

module.exports = async function(site, env, helpers) {
  console.log(`   → Fix: Starting stopped container ${site.webContainer}`);
  return await helpers.startContainer(site, env);
};