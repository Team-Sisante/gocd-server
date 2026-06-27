// Scripts/options/option_4.9.js

module.exports = async function (helpers) {
  const { ctx } = helpers;
  const os = require('os');
  const { execSync } = require('child_process');

  ctx.log('Resetting GoCD admin password and restarting server...', '\x1b[33m');

  // Write the new password from .env.docker into the container
  ctx.sh(`docker exec gocd-server sh -c "echo 'admin:${ctx.GOCD_PASS}' > /godata/config/password.properties"`);

  // Full stop/start to flush GoCD's authentication cache
  ctx.log('Stopping GoCD server...', '\x1b[33m');
  ctx.sh('docker stop gocd-server');
  ctx.log('Starting GoCD server...', '\x1b[33m');
  ctx.sh('docker start gocd-server');

  // Wait for GoCD to be ready (using the homepage to avoid auth issues)
  ctx.log('Waiting for GoCD to be ready...', '\x1b[33m');
  let ready = false;
  for (let i = 0; i < 24; i++) { // up to 120 seconds
    try {
      execSync(`docker exec gocd-server curl -sf -o /dev/null "${ctx.GOCD_BASE}/go"`, { stdio: 'pipe' });
      ready = true;
      break;
    } catch (_) {
      if (i < 23) {
        if (os.platform() === 'win32') {
          execSync('ping -n 6 127.0.0.1 >nul', { stdio: 'pipe' });
        } else {
          execSync('sleep 5', { stdio: 'pipe' });
        }
      }
    }
  }

  if (ready) {
    ctx.log('✅ GoCD is ready. Password reset applied.', '\x1b[32m');
  } else {
    ctx.log('❌ GoCD did not become ready in time. Check the container manually.', '\x1b[31m');
  }

  await ctx.pause();
};