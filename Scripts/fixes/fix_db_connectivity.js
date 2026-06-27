// Scripts/fixes/fix_db_connectivity.js

module.exports = async function(site, env, helpers) {
  console.log(`   → Fix: Attempting to restart database container (if defined)`);
  // For simplicity, we just restart the web container to retry connection
  console.log(`   → Restarting web container to retry DB connection...`);
  return await helpers.recreateContainer(site, env);
};