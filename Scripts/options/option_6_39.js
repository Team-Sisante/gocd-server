// Scripts/options/option_6_39.js

module.exports = async function (helpers) {
  const { runCommand, ask, pause, fs, path } = helpers;

  console.log('\x1b[36m🔍 Running health checks (detection only)...\x1b[0m');

  const debugAnswer = await ask('Enable debug output (shows all SSH commands)? (yes/no): ');
  const debugFlag = debugAnswer.toLowerCase() === 'yes' ? '--debug' : '';

  const scriptDir = path.join(__dirname, '..');
  const healthScript = path.join(scriptDir, 'health-check.js');

  if (!fs.existsSync(healthScript)) {
    console.error('\x1b[31m❌ health-check.js not found.\x1b[0m');
    await pause();
    return;
  }

  console.log(`\x1b[36mRunning: node "${healthScript}" ${debugFlag}\x1b[0m`);
  const result = runCommand(`node "${healthScript}" ${debugFlag}`, { stdio: 'inherit' });

  if (result && result.success === false) {
    console.warn('\x1b[33m⚠️  Health checks completed with issues.\x1b[0m');
  } else {
    console.log('\x1b[32m✅ Health checks completed.\x1b[0m');
  }

  await pause();
};