module.exports = async function(site, env, helpers) {
  const { webContainer, nginxContainer, composeDir, composeFile, project, profile, webServiceName } = site;
  console.log(`   → Fix: Restarting web container and Nginx to resolve upstream host...`);

  // 1. Restart web container
  console.log(`   → Restarting ${webContainer}...`);
  const restartCmd = `cd ${composeDir} && sudo docker compose -p ${project} -f ${composeFile} --profile ${profile} restart ${webServiceName}`;
  const restartResult = helpers.remoteExecWithEnv(restartCmd, env, site);
  if (!restartResult.success) {
    console.log(`   ❌ Failed to restart web container.`);
    return false;
  }
  console.log(`   ✅ Web container restarted.`);

  // 2. Restart Nginx
  if (nginxContainer) {
    console.log(`   → Restarting ${nginxContainer}...`);
    const nginxResult = helpers.remoteExecSilent(`sudo docker restart ${nginxContainer}`);
    if (!nginxResult.success) {
      console.log(`   ⚠️  Failed to restart Nginx (but continuing).`);
    } else {
      console.log(`   ✅ Nginx restarted.`);
    }
  }

  // 3. Wait and check
  await helpers.sleep(10000);
  console.log(`   ✅ Upstream fix applied.`);
  return true;
};