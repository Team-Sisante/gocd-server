// menu/siteDiagnostics.js
// Interactive diagnostics for each deployed site – VM containers + GCP load balancer
const { execFileSync } = require('child_process');
const { execSync } = require('child_process');

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
      gcpBackendService: 'humrine-backend',
      gcpHealthCheck: 'production-health-check',
    },
    'humrine-staging': {
      dir: '/opt/humrine_site',
      composeFile: 'docker-compose.vm.yml',
      project: 'humrine-staging',
      webContainer: 'humrine-web-staging',
      nginxContainer: 'humrine-nginx-staging',
      label: 'Humrine Staging (staging.humrine.com)',
      gcpBackendService: 'humrine-staging-backend',
      gcpHealthCheck: 'staging-health-check',
    },
    'badminton-production': {
      dir: '/opt/badminton_court',
      composeFile: 'docker-compose.vm.yml',
      project: 'badminton-production',
      webContainer: 'badminton-production-web-production-1',
      nginxContainer: 'badminton_court-nginx-production',
      label: 'Badminton Court Production (humrine.com/court)',
      gcpBackendService: 'court-backend',
      gcpHealthCheck: 'court-health-check',
    },
    'badminton-staging': {
      dir: '/opt/badminton_court',
      composeFile: 'docker-compose.vm.yml',
      project: 'badminton-staging',
      webContainer: 'badminton-staging-web-staging-1',
      nginxContainer: 'badminton_court-nginx-staging',
      label: 'Badminton Court Staging (humrine.com/court-staging)',
      gcpBackendService: 'court-staging-backend',
      gcpHealthCheck: 'court-staging-health-check',
    },
  };

  const p = projects[site];
  const { GCP_VM_IP, SSH_USER, SSH_KEY_PATH, log, pause, GCP_PROJECT_ID } = ctx;
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

  function gcloudExec(cmd) {
    try {
      return execSync(cmd, { encoding: 'utf8', stdio: 'pipe' });
    } catch (err) {
      if (err.stderr) console.error(err.stderr.trim());
      return null;
    }
  }

  console.log(`\n\x1b[33m=== Diagnostics for ${p.label} ===\x1b[0m\n`);

  // 1. Container status
  log('Container status (all services):', '\x1b[36m');
  const psCmd = `sudo docker ps -a --filter "label=com.docker.compose.project=${p.project}" --format "table {{.Names}}\t{{.Image}}\t{{.Command}}\t{{.Status}}\t{{.Ports}}"`;
  const psOut = remoteExec(psCmd);
  console.log(psOut ? psOut.trim() : 'No containers found for this project.');

  // 2. Web container logs
  log(`\nRecent logs for ${p.webContainer} (last 20 lines):`, '\x1b[36m');
  const logsOut = remoteExec(`sudo docker logs --tail 20 ${p.webContainer} 2>&1`);
  if (logsOut && logsOut.trim()) {
    console.log(logsOut.trim());
  } else {
    log(`No logs available for ${p.webContainer}.`, '\x1b[33m');
  }

  // 3. Container health details
  log(`\nContainer health details for ${p.webContainer}:`, '\x1b[36m');
  const inspectOut = remoteExec(
    `sudo docker inspect --format='State: {{.State.Status}}, ExitCode: {{.State.ExitCode}}, RestartCount: {{.RestartCount}}, StartedAt: {{.State.StartedAt}}, FinishedAt: {{.State.FinishedAt}}' ${p.webContainer}`
  );
  console.log(inspectOut ? inspectOut.trim() : 'Unable to inspect container.');

  // 4. Direct app response
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

  // 5. Resource usage
  log(`\nResource usage (CPU / MEM) for project containers:`, '\x1b[36m');
  const statsOut = remoteExec(
    `sudo docker stats --no-stream --format "table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}" $(sudo docker ps -q --filter "label=com.docker.compose.project=${p.project}")`
  );
  if (statsOut) {
    console.log(statsOut.trim());
  } else {
    log('Could not retrieve stats.', '\x1b[31m');
  }

  // ---- Nginx diagnostics ----
  if (p.nginxContainer) {
    log(`\n--- Nginx Diagnostics (${p.nginxContainer}) ---`, '\x1b[36m');

    log('\nNginx configuration:', '\x1b[36m');
    const nginxConf = remoteExec(`sudo docker exec ${p.nginxContainer} cat /etc/nginx/nginx.conf 2>&1`);
    if (nginxConf && nginxConf.trim()) {
      console.log(nginxConf.trim());
    } else {
      log('Could not read nginx configuration.', '\x1b[33m');
    }

    log(`\nRecent nginx logs for ${p.nginxContainer} (last 20 lines):`, '\x1b[36m');
    const nginxLogs = remoteExec(`sudo docker logs --tail 20 ${p.nginxContainer} 2>&1`);
    if (nginxLogs && nginxLogs.trim()) {
      console.log(nginxLogs.trim());
    } else {
      log(`No nginx logs available.`, '\x1b[33m');
    }

    const targetEnv = p.project.includes('production') ? 'production' : 'staging';
    log(`\nTesting nginx proxy to web backend (inside ${p.nginxContainer}):`, '\x1b[36m');
    const proxyTestOut = remoteExec(
      `sudo docker exec ${p.nginxContainer} wget -qO- http://web-${targetEnv}:8000/ --header="Host: ${p.label.split('(')[0].trim().replace('app.','')}" --timeout=5 2>&1 || echo "FAILED"`
    );
    if (proxyTestOut && proxyTestOut.includes('FAILED')) {
      log('Nginx could not reach the web backend.', '\x1b[31m');
    } else if (proxyTestOut) {
      console.log(`Proxy test: ${proxyTestOut.substring(0, 200)}${proxyTestOut.length > 200 ? '...' : ''}`);
    } else {
      log('Could not perform proxy test.', '\x1b[33m');
    }
  }

  // ---- GCP Load Balancer Diagnostics ----
  if (GCP_PROJECT_ID && p.gcpBackendService) {
    console.log(`\n\x1b[33m--- GCP Load Balancer Diagnostics ---\x1b[0m`);

    log(`\nBackend health (${p.gcpBackendService}):`, '\x1b[36m');
    const healthResult = gcloudExec(
      `gcloud compute backend-services get-health ${p.gcpBackendService} --global --project=${GCP_PROJECT_ID} --format="value(status.healthStatus[0].healthState, status.healthStatus[0].ipAddress, status.healthStatus[0].port)"`
    );
    if (healthResult) {
      console.log(healthResult.trim());
    } else {
      log('Could not retrieve backend health.', '\x1b[31m');
    }

    if (p.gcpHealthCheck) {
      log(`\nHealth check details (${p.gcpHealthCheck}):`, '\x1b[36m');
      const hcDetails = gcloudExec(
        `gcloud compute health-checks describe ${p.gcpHealthCheck} --global --project=${GCP_PROJECT_ID} --format="value(httpHealthCheck.port, httpHealthCheck.requestPath)"`
      );
      if (hcDetails) {
        console.log(hcDetails.trim());
      } else {
        log('Could not retrieve health check details.', '\x1b[31m');
      }
    }

    log(`\nFirewall rule (allow-lb-health-checks) allowed ports:`, '\x1b[36m');
    const fwPorts = gcloudExec(
      `gcloud compute firewall-rules describe allow-lb-health-checks --project=${GCP_PROJECT_ID} --format="value(allowed[0].ports)"`
    );
    if (fwPorts) {
      console.log(fwPorts.trim());
    } else {
      log('Could not retrieve firewall rule.', '\x1b[31m');
    }
  }

  // ---- Environment Dump (regular first, then secrets masked) ----
  log('\n⚠️  Live environment from container (secrets are masked):', '\x1b[33m');
  const envOut = remoteExec(`sudo docker exec ${p.webContainer} env 2>/dev/null || echo "Container not running"`);
  if (envOut && !envOut.startsWith('Container not running')) {
    const lines = envOut.split('\n').filter(line => line.trim());
    const secretPattern = /(PASSWORD|SECRET|KEY|TOKEN|PASS|ENCRYPT|PRIVATE|SIGNING|AUTHTOKEN)/i;
    const regular = [];
    const secrets = [];
    for (const line of lines) {
      const eqIndex = line.indexOf('=');
      if (eqIndex > 0) {
        const varName = line.substring(0, eqIndex).trim();
        const value = line.substring(eqIndex + 1).trim();
        if (secretPattern.test(varName)) {
          // Mask the secret: show first 4 chars + '***'
          const masked = value.length > 4 ? value.substring(0, 4) + '***' : '***';
          secrets.push(`${varName}=${masked}`);
        } else {
          regular.push(line);
        }
      } else {
        regular.push(line);
      }
    }
    if (regular.length > 0) {
      console.log('\x1b[36m--- Regular Environment Variables ---\x1b[0m');
      regular.forEach(l => console.log(l));
    }
    if (secrets.length > 0) {
      console.log('\x1b[35m--- Secrets (masked) ---\x1b[0m');
      secrets.forEach(l => console.log(l));
    }
  } else {
    log(`Could not read environment from ${p.webContainer}.`, '\x1b[31m');
  }

  console.log(`\n\x1b[33m=== End of diagnostics for ${p.label} ===\x1b[0m\n`);
  await pause();
};