// menu/siteDiagnostics.js
// Interactive diagnostics for each deployed site (humrine / badminton / staging / production)
const { execFileSync } = require('child_process');

module.exports = async function siteDiagnostics(ctx) {
  const { default: inquirer } = await import('inquirer');

  ctx.rl.pause();
  const { site } = await inquirer.prompt([
    {
      type: 'list',
      name: 'site',
      message: 'Select the site to diagnose:',
      choices: [
        { name: 'humrine.com (production)',           value: 'humrine-production' },
        { name: 'app.humrine.com (production)',        value: 'humrine-production' },
        { name: 'staging.humrine.com (staging)',       value: 'humrine-staging' },
        { name: 'humrine.com/court (badminton prod)',  value: 'badminton-production' },
        { name: 'humrine.com/court-staging (badminton staging)', value: 'badminton-staging' },
      ],
    },
  ]);
  ctx.rl.resume();

  const projects = {
    'humrine-production': {
      dir: '/opt/humrine_site',
      composeFile: 'docker-compose.vm.yml',
      project: 'humrine-production',
      envFile: '.env.production',
      webContainer: 'humrine-web-production',
      nginxContainer: 'humrine-nginx-production',
      label: 'Humrine Production (humrine.com / app.humrine.com)',
    },
    'humrine-staging': {
      dir: '/opt/humrine_site',
      composeFile: 'docker-compose.vm.yml',
      project: 'humrine-staging',
      envFile: '.env.staging',
      webContainer: 'humrine-web-staging',
      nginxContainer: 'humrine-nginx-staging',
      label: 'Humrine Staging (staging.humrine.com)',
    },
    'badminton-production': {
      dir: '/opt/badminton_court',
      composeFile: 'docker-compose.vm.yml',
      project: 'badminton-production',
      envFile: '.env.production',
      webContainer: 'badminton-production-web-production-1',
      nginxContainer: 'badminton_court-nginx-production',
      label: 'Badminton Court Production (humrine.com/court)',
    },
    'badminton-staging': {
      dir: '/opt/badminton_court',
      composeFile: 'docker-compose.vm.yml',
      project: 'badminton-staging',
      envFile: '.env.staging',
      webContainer: 'badminton-staging-web-staging-1',
      nginxContainer: 'badminton_court-nginx-staging',
      label: 'Badminton Court Staging (humrine.com/court-staging)',
    },
  };

  const p = projects[site];
  const { GCP_VM_IP, SSH_USER, SSH_KEY_PATH, log, pause } = ctx;
  const sshTarget = `${SSH_USER}@${GCP_VM_IP}`;

  function remoteExec(cmd) {
    const args = [
      '-i', SSH_KEY_PATH,
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'UserKnownHostsFile=/dev/null',
      '-o', 'ConnectTimeout=15',
      '-o', 'LogLevel=ERROR',
      '-o', 'KexAlgorithms=+diffie-hellman-group14-sha256',
      sshTarget,
      cmd,
    ];
    try {
      return execFileSync('ssh', args, { encoding: 'utf8', stdio: 'pipe' });
    } catch (err) {
      if (err.stderr) console.error(err.stderr.trim());
      return null;
    }
  }

  console.log(`\n\x1b[33m=== Diagnostics for ${p.label} ===\x1b[0m\n`);

  // 1. Full project container status (all services)
  log('Container status (all services):', '\x1b[36m');
  const psCmd = `cd ${p.dir} && sudo docker compose -p ${p.project} -f ${p.composeFile} --env-file ${p.envFile} ps -a`;
  const psOut = remoteExec(psCmd);
  console.log(psOut ? psOut.trim() : 'No containers found or compose command failed.');

  // 2. Environment file contents (with sensitive data warning)
  log('\n⚠️  Environment variables (passwords/tokens/secrets are visible):', '\x1b[33m');
  const envPath = `${p.dir}/${p.envFile}`;
  const envOut = remoteExec(`cat ${envPath}`);
  if (envOut) {
    console.log(envOut.trim());
  } else {
    log(`Could not read ${envPath}.`, '\x1b[31m');
  }

  // 3. Web container logs (merge stdout and stderr)
  log(`\nRecent logs for ${p.webContainer} (last 20 lines):`, '\x1b[36m');
  const logsOut = remoteExec(`sudo docker logs --tail 20 ${p.webContainer} 2>&1`);
  if (logsOut && logsOut.trim()) {
    console.log(logsOut.trim());
  } else {
    log(`No logs available for ${p.webContainer}. (The binary may not output to console.)`, '\x1b[33m');
  }

  // 4. Container health details (restart count, exit code, timestamps)
  log(`\nContainer health details for ${p.webContainer}:`, '\x1b[36m');
  const inspectOut = remoteExec(
    `sudo docker inspect --format='State: {{.State.Status}}, ExitCode: {{.State.ExitCode}}, RestartCount: {{.RestartCount}}, StartedAt: {{.State.StartedAt}}, FinishedAt: {{.State.FinishedAt}}' ${p.webContainer}`
  );
  console.log(inspectOut ? inspectOut.trim() : 'Unable to inspect container.');

  // 5. Direct app connectivity test (from within the web container)
  log(`\nDirect app response from within ${p.webContainer} (localhost:8000):`, '\x1b[36m');
  const appTest = remoteExec(
    `sudo docker exec ${p.webContainer} curl -s -o /dev/null -w "%{http_code}" http://localhost:8000/ --connect-timeout 5 || echo "curl failed"`
  );
  console.log(`App response: ${appTest ? appTest.trim() : 'no response'}`);

  // 6. Resource usage (CPU and memory) for all project containers
  log(`\nResource usage (CPU / MEM) for project containers:`, '\x1b[36m');
  const statsOut = remoteExec(
    `sudo docker stats --no-stream --format "table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}" $(sudo docker ps -q --filter "name=${p.project}")`
  );
  if (statsOut) {
    console.log(statsOut.trim());
  } else {
    log('Could not retrieve stats.', '\x1b[31m');
  }

  // 7. Nginx logs (last 20 lines)
  log(`\nRecent nginx logs for ${p.nginxContainer} (last 20 lines):`, '\x1b[36m');
  const nginxLogs = remoteExec(`sudo docker logs --tail 20 ${p.nginxContainer} 2>&1`);
  if (nginxLogs && nginxLogs.trim()) {
    console.log(nginxLogs.trim());
  } else {
    log(`No nginx logs available.`, '\x1b[33m');
  }

  console.log(`\n\x1b[33m=== End of diagnostics for ${p.label} ===\x1b[0m\n`);
  await pause();
};