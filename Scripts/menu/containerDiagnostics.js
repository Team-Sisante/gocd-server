// menu/containerDiagnostics.js
// Health‑check and diagnostics for staging / production containers on the VM.
// No artificial timeouts – relies on SSH's ConnectTimeout. No hardcoded ports.

module.exports = async function containerDiagnostics(ctx, env) {
  const { execSync } = require('child_process');
  const { log, GCP_VM_IP, SSH_USER, SSH_KEY_PATH } = ctx;

  const projectName = env === 'production' ? 'badminton-production' : 'badminton-staging';
  const envFile = env === 'production' ? '.env.production' : '.env.staging';
  const appUrl = env === 'production' ? ctx.PRODUCTION_APP_URL : ctx.STAGING_APP_URL;

  // Use the same SSH options as your other working helpers, but with a longer ConnectTimeout
  const sshOpts = `-i "${SSH_KEY_PATH}" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=15`;
  const sshTarget = `${SSH_USER}@${GCP_VM_IP}`;
  
  console.log(`\n\x1b[33m=== Diagnostics for ${env.toUpperCase()} (project: ${projectName}) ===\x1b[0m\n`);

  // Run a remote command, capture output, no artificial timeout
  function remoteExec(cmd) {
    // Use single quotes around the entire remote command to avoid shell escaping issues.
    // Inner single quotes are escaped as '\'' (end single-quote, literal ', start single-quote).
    const escapedCmd = cmd.replace(/'/g, "'\\''");
    const fullCmd = `ssh ${sshOpts} ${sshTarget} '${escapedCmd}'`;
    try {
      return execSync(fullCmd, {
        stdio: ['pipe', 'pipe', 'pipe'],
        encoding: 'utf8'
      });
    } catch (err) {
      // SSH failed – print its error output
      if (err.stderr) console.error(err.stderr.trim());
      if (err.stdout) console.error(err.stdout.trim());
      return null;
    }
  }

  // 1. Quick SSH and Docker test
  log('Testing Docker responsiveness...', '\x1b[36m');
  // Use format with escaped double quotes inside the single-quoted remote command
  const dockerInfo = remoteExec('sudo docker info --format "{{.ContainersRunning}} running containers"');
  if (dockerInfo === null) {
    log('Could not reach Docker on VM. Please check connectivity.', '\x1b[31m');
    await ctx.pause();
    return;
  }
  console.log(dockerInfo.trim());

  // 2. Container status
  try {
    log('\nContainer status (docker compose ps):', '\x1b[36m');
    const composePs = remoteExec(
      `cd /opt/badminton_court && sudo docker compose -p ${projectName} -f docker-compose.vm.yml --env-file ${envFile} ps`
    );
    if (composePs === null) {
      // Try fallback
      log('compose ps failed, trying docker ps...', '\x1b[33m');
      const dockerPs = remoteExec(
        `sudo docker ps --filter "name=${projectName}" --format "table {{.Names}}\t{{.Status}}"`
      );
      if (dockerPs) console.log(dockerPs.trim());
    } else {
      console.log(composePs.trim());
    }
  } catch (err) {
    log('Failed to get container status.', '\x1b[31m');
  }

  // 3. Port configuration and actual listeners (dynamic, no hardcoded ports)
  try {
    log('\nPort configuration from env file:', '\x1b[36m');
    const portVars = remoteExec(
      `grep -E '^[A-Z_]+_PORT=|^APP_PORT=|^POSTE_PORT=' /opt/badminton_court/${envFile} | grep -iv password`
    );
    if (portVars) {
      console.log(portVars.trim());
      // Extract port numbers
      const ports = portVars
        .split('\n')
        .map(line => line.match(/=(\d+)/))
        .filter(Boolean)
        .map(m => m[1]);

      if (ports.length > 0) {
        const sportFilters = ports.map(p => `sport = :${p}`).join(' or ');
        log('\nActual listening ports:', '\x1b[36m');
        const ssOut = remoteExec(`sudo ss -tlnp "( ${sportFilters} )"`);
        if (ssOut) {
          console.log(ssOut.trim());
        } else {
          log('No matching ports listening.', '\x1b[33m');
        }
      } else {
        log('Could not extract port numbers.', '\x1b[33m');
      }
    } else {
      log('Could not read port configuration.', '\x1b[31m');
    }
  } catch (err) {
    log('Failed to check ports.', '\x1b[31m');
  }

  // 4. HTTP(S) test
  if (appUrl) {
    try {
      log(`\nTesting app URL: ${appUrl}`, '\x1b[36m');
      const curlRes = remoteExec(
        `curl -sk -o /dev/null -w 'HTTP status: %{http_code}' --connect-timeout 10 ${appUrl}`
      );
      if (curlRes !== null) {
        console.log(curlRes.trim());
      } else {
        log(`Could not reach ${appUrl} (connection failed).`, '\x1b[31m');
      }
    } catch (err) {
      log(`Could not reach ${appUrl}`, '\x1b[31m');
    }
  } else {
    log(`\nNo app URL configured for ${env}.`, '\x1b[33m');
  }

  console.log(`\n\x1b[33m=== End of ${env.toUpperCase()} diagnostics ===\x1b[0m\n`);
  await ctx.pause();
};