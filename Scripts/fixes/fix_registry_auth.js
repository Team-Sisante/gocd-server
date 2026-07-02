// Scripts/fixes/fix_registry_auth.js
// Logs the VM into ghcr.io so that docker pulls don't fail with "unauthorized".

module.exports = async function(site, env, helpers) {
  console.log(`   → Fix: Authenticating Docker to ghcr.io...`);

  const username = env.GIT_REPO_USERNAME || process.env.GIT_REPO_USERNAME || 'team-sisante';
  const token = env.GITHUB_TOKEN || process.env.GITHUB_TOKEN;

  if (!token) {
    console.log('   ❌ GITHUB_TOKEN not available – cannot authenticate.');
    return false;
  }

  const cmd = `echo "${token}" | sudo docker login ghcr.io -u ${username} --password-stdin`;
  const result = helpers.remoteExecSilent(cmd);

  if (result.success) {
    console.log(`   ✅ Docker logged in to ghcr.io as ${username}.`);
    return true;
  } else {
    console.log(`   ❌ Docker login failed.`);
    return false;
  }
};