module.exports = async function(site, env, helpers) {
  const { webContainer, composeDir, composeFile, project, profile, webServiceName } = site;
  console.log(`   → Fix: Container is unhealthy – recreating...`);

  // Recreate the container to clear the unhealthy state
  const result = await helpers.recreateContainer(site, env);
  if (result) {
    console.log(`   ✅ Container recreated.`);
  } else {
    console.log(`   ❌ Failed to recreate container.`);
  }
  return result;
};