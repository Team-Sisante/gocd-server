// Scripts/options/option_6_39.js
module.exports = async function (helpers) {
  const { runCommand, ask, pause, fs, path } = helpers;
  const scriptDir = path.join(__dirname, '..');
  const healthScript = path.join(scriptDir, 'health-check.js');
  if (!fs.existsSync(healthScript)) {
    console.error('\x1b[31m❌ health-check.js not found.\x1b[0m');
    await pause();
    return;
  }
  console.log('\x1b[36mRunning health checks with auto‑repair...\x1b[0m');
  const result = runCommand(`node "${healthScript}" --fix`, { stdio: 'inherit' });
  if (result && result.success === false) {
    console.warn('\x1b[33m⚠️  Some health checks failed after repair attempts.\x1b[0m');
  } else {
    console.log('\x1b[32m✅ All sites healthy.\x1b[0m');
  }
  await pause();
};