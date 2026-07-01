// Scripts/options/option_6_38.js

module.exports = async function (helpers) {
  const { runCommand, ask, pause, fs, path } = helpers;

  console.log('\x1b[36m🔄 Resetting GCP VM (gocd-deploy-target) and updating configurations...\x1b[0m');
  console.log('\x1b[33m⚠️  This will hard-reboot the VM and may cause a few minutes of downtime.\x1b[0m');

  const scriptDir = path.join(__dirname, '..');
  const resetScript = path.join(scriptDir, 'vm-reset.js');

  if (!fs.existsSync(resetScript)) {
    console.error('\x1b[31m❌ vm-reset.js not found in Scripts/ folder.\x1b[0m');
    await pause();
    return;
  }

  console.log(`\x1b[36mExecuting: node ${resetScript}\x1b[0m`);
  const result = runCommand(`node "${resetScript}"`, { stdio: 'inherit' });

  if (result && result.success === false) {
    console.error('\x1b[31m❌ VM reset failed. Check the output above.\x1b[0m');
    await pause();
    return;
  }

  console.log('\x1b[32m✅ VM reset and configuration update completed successfully.\x1b[0m');

  // ----- Run health checks with auto‑repair -----
  const runHealthCheck = await ask('\nDo you want to run health checks and auto‑repair for all sites now? (yes/no): ');
  if (runHealthCheck.toLowerCase() === 'yes') {
    const healthScript = path.join(scriptDir, 'health-check.js');
    if (!fs.existsSync(healthScript)) {
      console.warn('\x1b[33m⚠️  health-check.js not found. Skipping.\x1b[0m');
    } else {
      console.log('\x1b[36mRunning health checks with auto‑repair...\x1b[0m');
      const healthResult = runCommand(`node "${healthScript}" --fix`, { stdio: 'inherit' });
      if (healthResult && healthResult.success === false) {
        console.warn('\x1b[33m⚠️  Some health checks failed after repair attempts. Please inspect the output.\x1b[0m');
      } else {
        console.log('\x1b[32m✅ Health checks passed.\x1b[0m');
      }
    }
  } else {
    console.log('Skipping health checks. You can run them later via the menu (6.26 or 6.39).');
  }

};