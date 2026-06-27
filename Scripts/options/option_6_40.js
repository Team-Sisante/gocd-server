// Scripts/options/option_6_40.js
module.exports = async function (helpers) {
  const { runCommand, ask, pause, fs, path } = helpers;

  console.log('\x1b[36m🔧 Running treatment based on health report...\x1b[0m');

  const debugAnswer = await ask('Enable debug output (shows all SSH commands)? (yes/no): ');
  const debugFlag = debugAnswer.toLowerCase() === 'yes' ? '--debug' : '';

  const scriptDir = path.join(__dirname, '..');
  const treatmentScript = path.join(scriptDir, 'treatment.js');

  if (!fs.existsSync(treatmentScript)) {
    console.error('\x1b[31m❌ treatment.js not found.\x1b[0m');
    await pause();
    return;
  }

  console.log(`\x1b[36mRunning: node "${treatmentScript}" ${debugFlag}\x1b[0m`);
  const result = runCommand(`node "${treatmentScript}" ${debugFlag}`, { stdio: 'inherit' });

  if (result && result.success === false) {
    console.warn('\x1b[33m⚠️  Treatment completed with errors.\x1b[0m');
  } else {
    console.log('\x1b[32m✅ Treatment completed.\x1b[0m');
  }

  await pause();
};