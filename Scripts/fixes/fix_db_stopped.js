// Scripts/fixes/fix_db_stopped.js

module.exports = async function(site, env, helpers) {
  const dbContainer = `db-${site.target}`;
  console.log(`   → Fix: Starting database container ${dbContainer}`);
  // Try to start existing container first
  const startCmd = `sudo docker start ${dbContainer} 2>&1`;
  let result = helpers.remoteExecSilent(startCmd);
  if (!result.success) {
    // Container doesn't exist, recreate via compose
    const upCmd = `cd ${site.composeDir} && docker compose -p ${site.project} -f ${site.composeFile} --profile ${site.profile} up -d ${dbContainer} 2>&1`;
    result = helpers.remoteExecWithEnv(upCmd, env, site);
  }
  if (result.success) {
    console.log(`   ✅ Database container ${dbContainer} started.`);
    return true;
  }
  console.log(`   ❌ Failed to start database container.`);
  return false;
};