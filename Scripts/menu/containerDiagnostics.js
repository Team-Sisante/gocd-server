// menu/containerDiagnostics.js
// Health-check and diagnostics for staging / production containers on the VM.

const path = require('path');

module.exports = async function containerDiagnostics(ctx, env) {
  const { execSync } = require('child_process');
  const { log, GCP_VM_IP, SSH_USER, SSH_KEY_PATH } = ctx;

  const projectName = env === 'production' ? 'badminton-production' : 'badminton-staging';
  const envFile = env === 'production' ? '.env.production' : '.env.staging';
  const appUrl = env === 'production' ? ctx.PRODUCTION_APP_URL : ctx.STAGING_APP_URL;

  const sshBase = `ssh -i "${SSH_KEY_PATH}" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null ${SSH_USER}@${GCP_VM_IP}`;

  console.log(`\n\x1b[33m=== Diagnostics for ${env.toUpperCase()} (project: ${projectName}) ===\x1b[0m\n`);

  // 1. Container status
  try {
    log('Container status (docker compose ps):', '\x1b[36m');
    execSync(`${sshBase} "cd /opt/badminton_court && sudo docker compose -p ${projectName} -f docker-compose.vm.yml --env-file ${envFile} ps"`, { stdio: 'inherit' });
  } catch (err) {
    log('Failed to get container status.', '\x1b[31m');
  }

  // 2. Port bindings
  try {
    log('\nListening ports on the VM:', '\x1b[36m');
    execSync(`${sshBase} "sudo ss -tlnp"`, { stdio: 'inherit' });
  } catch (err) {
    log('Failed to check ports.', '\x1b[31m');
  }

  // 3. Attempt HTTP(S) request to the app
  if (appUrl) {
    try {
      log(`\nTesting app URL: ${appUrl}`, '\x1b[36m');
      execSync(`${sshBase} "curl -sk -o /dev/null -w 'HTTP status: %{http_code}' ${appUrl}"`, { stdio: 'inherit' });
    } catch (err) {
      log(`Could not reach ${appUrl}`, '\x1b[31m');
    }
  } else {
    log(`\nNo app URL configured for ${env}.`, '\x1b[33m');
  }

  console.log(`\n\x1b[33m=== End of ${env.toUpperCase()} diagnostics ===\x1b[0m\n`);
};