// menu/siteDiagnostics.js
// Interactive diagnostics for each deployed site – no .env files required
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
      webContainer: 'humrine-web-production',
      nginxContainer: 'humrine-nginx-production',
      label: 'Humrine Production (humrine.com / app.humrine.com)',
    },
    'humrine-staging': {
      dir: '/opt/humrine_site',
      composeFile: 'docker-compose.vm.yml',
      project: 'humrine-staging',
      webContainer: 'humrine-web-staging',
      nginxContainer: 'humrine-nginx-staging',
      label: 'Humrine Staging (staging.humrine.com)',
    },
    'badminton-production': {
      dir: '/opt/badminton_court',
      composeFile: 'docker-compose.vm.yml',
      project: 'badminton-production',
      webContainer: 'badminton-production-web-production-1',
      nginxContainer: 'badminton_court-nginx-production',
      label: 'Badminton Court Production (humrine.com/court)',
    },
    'badminton-staging': {
      dir: '/opt/badminton_court',
      composeFile: 'docker-compose.vm.yml',
      project: 'badminton-staging',
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

  // 1. Container status – use docker compose ps (always accurate)
  log('Container status (all services):', '\x1b[36m');
  const psCmd = `sudo docker compose -p ${p.project} ps --all --format "table {{.Name}}\t{{.Image}}\t{{.Command}}\t{{.Status}}\t{{.Ports}}"`;
  const psOut = remoteExec(psCmd);
  console.log(psOut ? psOut.trim() : 'No containers found for this project.');

  // 2. Live environment from the running web container
  log('\n⚠️  Live environment from container (secrets may be visible):', '\x1b[33m');
  const envOut = remoteExec(`sudo docker exec ${p.webContainer} env 2>/dev/null || echo "Container not running"`);
  if (envOut && !envOut.startsWith('Container not running')) {
    console.log(envOut.trim());
  } else {
    log(`Could not read environment from ${p.webContainer}.`, '\x1b[31m');
  }

  // 3. Web container logs
  log(`\nRecent logs for ${p.webContainer} (last 20 lines):`, '\x1b[36m');
  const logsOut = remoteExec(`sudo docker logs --tail 20 ${p.webContainer} 2>&1`);
  if (logsOut && logsOut.trim()) {
    console.log(logsOut.trim());
  } else {
    log(`No logs available for ${p.webContainer}.`, '\x1b[33m');
  }

  // 4. Container health details
  log(`\nContainer health details for ${p.webContainer}:`, '\x1b[36m');
  const inspectOut = remoteExec(
    `sudo docker inspect --format='State: {{.State.Status}}, ExitCode: {{.State.ExitCode}}, RestartCount: {{.RestartCount}}, StartedAt: {{.State.StartedAt}}, FinishedAt: {{.State.FinishedAt}}' ${p.webContainer}`
  );
  console.log(inspectOut ? inspectOut.trim() : 'Unable to inspect container.');

  // 5. Direct app response from inside the web container
  log(`\nDirect app response from within ${p.webContainer} (localhost:8000):`, '\x1b[36m');

  const appTest = remoteExec(
    `sudo docker exec ${p.webContainer} bash -c '
      if command -v curl >/dev/null 2>&1; then
        curl -s -o /dev/null -w "%{http_code}" http://localhost:8000/ --connect-timeout 5
      elif command -v wget >/dev/null 2>&1; then
        wget -q -O /dev/null --timeout=5 http://localhost:8000/ && echo 200 || echo 000
      else
        python -c "import urllib.request; print(urllib.request.urlopen(\\"http://localhost:8000/\\", timeout=5).getcode())" 2>/dev/null || echo "all methods failed"
      fi
    '`
  );
  console.log(`App response: ${appTest ? appTest.trim() : 'no response'}`);

  // 6. Resource usage – use compose project to get container IDs
  log(`\nResource usage (CPU / MEM) for project containers:`, '\x1b[36m');
  const statsOut = remoteExec(
    `sudo docker stats --no-stream --format "table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}" $(sudo docker compose -p ${p.project} ps -q)`
  );
  if (statsOut) {
    console.log(statsOut.trim());
  } else {
    log('Could not retrieve stats.', '\x1b[31m');
  }

  // 7. Nginx logs
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