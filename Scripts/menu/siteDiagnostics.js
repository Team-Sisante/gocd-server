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
      mailContainer: null,
      dbContainer: null,
      redisContainer: null,
      label: 'Humrine Production (humrine.com / app.humrine.com)',
      domain: 'humrine.com',
      gcpBackendService: 'humrine-backend',
      gcpHealthCheck: 'production-health-check',
    },
    'humrine-staging': {
      dir: '/opt/humrine_site',
      composeFile: 'docker-compose.vm.yml',
      project: 'humrine-staging',
      webContainer: 'humrine-web-staging',
      nginxContainer: 'humrine-nginx-staging',
      mailContainer: null,
      dbContainer: null,
      redisContainer: null,
      label: 'Humrine Staging (staging.humrine.com)',
      domain: 'staging.humrine.com',
      gcpBackendService: 'humrine-staging-backend',
      gcpHealthCheck: 'staging-health-check',
    },
    'badminton-production': {
      dir: '/opt/badminton_court',
      composeFile: 'docker-compose.vm.yml',
      project: 'badminton-production',
      webContainer: 'badminton-production-web-production-1',
      nginxContainer: 'badminton_court-nginx-production',
      mailContainer: 'badminton-production-mail-production-1',
      dbContainer: 'badminton-production-db-production-1',
      redisContainer: 'badminton-production-redis-1',
      label: 'Badminton Court Production (humrine.com/court)',
      domain: 'humrine.com',
      gcpBackendService: 'court-backend',
      gcpHealthCheck: 'court-health-check',
    },
    'badminton-staging': {
      dir: '/opt/badminton_court',
      composeFile: 'docker-compose.vm.yml',
      project: 'badminton-staging',
      webContainer: 'badminton-staging-web-staging-1',
      nginxContainer: 'badminton_court-nginx-staging',
      mailContainer: 'badminton-staging-mail-staging-1',
      dbContainer: 'badminton-staging-db-staging-1',
      redisContainer: 'badminton-staging-redis-1',
      label: 'Badminton Court Staging (humrine.com/court-staging)',
      domain: 'humrine.com',
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

  // ── Helper: colour shortcuts ───────────────────────────────────
  const red    = (t) => `\x1b[31m${t}\x1b[0m`;
  const green  = (t) => `\x1b[32m${t}\x1b[0m`;
  const yellow = (t) => `\x1b[33m${t}\x1b[0m`;
  const cyan   = (t) => `\x1b[36m${t}\x1b[0m`;

  console.log(`\n${yellow(`=== Diagnostics for ${p.label} ===`)}\n`);

  // 1. Container status
  log('Container status (all services):', cyan(''));
  const psCmd = `sudo docker ps -a --filter "label=com.docker.compose.project=${p.project}" --format "table {{.Names}}\\t{{.Image}}\\t{{.Command}}\\t{{.Status}}\\t{{.Ports}}"`;
  const psOut = remoteExec(psCmd);
  console.log(psOut ? psOut.trim() : 'No containers found for this project.');

  // 2. Web container logs
  log(`\nRecent logs for ${p.webContainer} (last 20 lines):`, cyan(''));
  const logsOut = remoteExec(`sudo docker logs --tail 20 ${p.webContainer} 2>&1`);
  if (logsOut && logsOut.trim()) {
    console.log(logsOut.trim());
  } else {
    log(`No logs available for ${p.webContainer}.`, yellow(''));
  }

  // 3. Container health details
  log(`\nContainer health details for ${p.webContainer}:`, cyan(''));
  const inspectOut = remoteExec(
    `sudo docker inspect --format='State: {{.State.Status}}, ExitCode: {{.State.ExitCode}}, RestartCount: {{.RestartCount}}, StartedAt: {{.State.StartedAt}}, FinishedAt: {{.State.FinishedAt}}' ${p.webContainer}`
  );
  console.log(inspectOut ? inspectOut.trim() : 'Unable to inspect container.');

  // 4. Direct app response
  log(`\nDirect app response from within ${p.webContainer} (localhost:8000):`, cyan(''));
  const appTest = remoteExec(
    `sudo docker exec ${p.webContainer} bash -c '
      if command -v curl >/dev/null 2>&1; then
        curl -s -o /dev/null -w "%{http_code}" http://localhost:8000/ --connect-timeout 5
      elif command -v wget >/dev/null 2>&1; then
        wget -q -O /dev/null --timeout=5 http://localhost:8000/ && echo 200 || echo 000
      else
        python3 -c "import urllib.request; print(urllib.request.urlopen(\\"http://localhost:8000/\\", timeout=5).getcode())" 2>/dev/null || echo "all methods failed"
      fi
    '`
  );
  const appCode = appTest ? appTest.trim() : 'no response';
  if (appCode === '200') {
    console.log(green(`App response: ${appCode}`));
  } else {
    console.log(red(`App response: ${appCode}`));
  }

  // 5. Resource usage
  log(`\nResource usage (CPU / MEM) for project containers:`, cyan(''));
  const statsOut = remoteExec(
    `sudo docker stats --no-stream --format "table {{.Name}}\\t{{.CPUPerc}}\\t{{.MemUsage}}" $(sudo docker ps -q --filter "label=com.docker.compose.project=${p.project}")`
  );
  if (statsOut) {
    console.log(statsOut.trim());
  } else {
    log('Could not retrieve stats.', red(''));
  }

  // ---- Inter-Container Connectivity ----
  console.log(`\n${yellow('--- Inter-Container Connectivity ---')}`);

  // 6a. Database connectivity
  if (p.dbContainer) {
    log('\nDatabase connectivity:', cyan(''));
    const dbTest = remoteExec(
      `sudo docker exec ${p.webContainer} bash -c '
        DB_HOST=$(printenv POSTGRES_HOST || printenv DB_HOST || echo "")
        DB_PORT=$(printenv POSTGRES_PORT || echo "5432")
        DB_NAME=$(printenv POSTGRES_DB || printenv POSTGRES_NAME || echo "")
        if [ -z "$DB_HOST" ]; then
          echo "SKIP: No POSTGRES_HOST/DB_HOST env var found"
        else
          python3 -c "
import psycopg2, os
try:
    conn = psycopg2.connect(
        host=os.environ.get(\\"POSTGRES_HOST\\", os.environ.get(\\"DB_HOST\\", \\"\\")),
        port=os.environ.get(\\"POSTGRES_PORT\\", \\"5432\\"),
        dbname=os.environ.get(\\"POSTGRES_DB\\", \\"\\"),
        user=os.environ.get(\\"POSTGRES_USER\\", \\"\\"),
        password=os.environ.get(\\"POSTGRES_PASSWORD\\", \\"\\"),
        connect_timeout=5,
    )
    cur = conn.cursor()
    cur.execute(\\"SELECT 1\\")
    print(f\\"✅ Database reachable at {os.environ.get(\\"POSTGRES_HOST\\", os.environ.get(\\"DB_HOST\\", \\"?\\"))}:{os.environ.get(\\"POSTGRES_PORT\\", \\"5432\\")}\\")
    conn.close()
except Exception as e:
    print(f\\"❌ Database connection failed: {e}\\")
"
        fi
      '`
    );
    console.log(dbTest ? dbTest.trim() : 'Could not test database connectivity.');
  }

  // 6b. Redis connectivity
  if (p.redisContainer) {
    log('\nRedis connectivity:', cyan(''));
    const redisTest = remoteExec(
      `sudo docker exec ${p.webContainer} bash -c '
        REDIS_URL=$(printenv REDIS_URL || echo "")
        if [ -z "$REDIS_URL" ]; then
          echo "SKIP: No REDIS_URL env var found"
        else
          python3 -c "
import redis, os
try:
    r = redis.from_url(os.environ[\\"REDIS_URL\\"], socket_connect_timeout=5)
    r.ping()
    print(f\\"✅ Redis reachable at {os.environ[\\"REDIS_URL\\"]}\\")
except Exception as e:
    print(f\\"❌ Redis connection failed: {e}\\")
"
        fi
      '`
    );
    console.log(redisTest ? redisTest.trim() : 'Could not test Redis connectivity.');
  }

  // 6c. SMTP connectivity + authentication
  if (p.mailContainer) {
    log('\nSMTP connectivity and authentication:', cyan(''));
    const smtpTest = remoteExec(
      `sudo docker exec ${p.webContainer} bash -c '
        EMAIL_HOST=$(printenv EMAIL_HOST || echo "")
        EMAIL_PORT=$(printenv EMAIL_PORT || echo "")
        EMAIL_USE_SSL=$(printenv EMAIL_USE_SSL || echo "False")
        EMAIL_USE_TLS=$(printenv EMAIL_USE_TLS || echo "False")
        EMAIL_HOST_USER=$(printenv EMAIL_HOST_USER || echo "")
        EMAIL_HOST_PASSWORD=$(printenv EMAIL_HOST_PASSWORD || echo "")

        if [ -z "$EMAIL_HOST" ] || [ -z "$EMAIL_PORT" ]; then
          echo "SKIP: EMAIL_HOST or EMAIL_PORT env var missing"
        else
          python3 -c "
import smtplib, ssl, os, socket

host = os.environ.get(\\"EMAIL_HOST\\", \\"\\")
port = int(os.environ.get(\\"EMAIL_PORT\\", \\"0\\"))
use_ssl = os.environ.get(\\"EMAIL_USE_SSL\\", \\"False\\").lower() == \\"true\\"
use_tls = os.environ.get(\\"EMAIL_USE_TLS\\", \\"False\\").lower() == \\"true\\"
user = os.environ.get(\\"EMAIL_HOST_USER\\", \\"\\")
pw = os.environ.get(\\"EMAIL_HOST_PASSWORD\\", \\"\\")
proto = \\"SSL\\" if use_ssl else (\\"STARTTLS\\" if use_tls else \\"PLAIN\\")

# Step 1: TCP connectivity
try:
    sock = socket.create_connection((host, port), timeout=5)
    sock.close()
    print(f\\"✅ TCP connection to {host}:{port} succeeded\\")
except (socket.timeout, socket.error) as e:
    print(f\\"❌ TCP connection to {host}:{port} failed: {e}\\")
    print(f\\"   → Check that {host} resolves and port {port} is open on the Docker network\\")
    exit(0)

# Step 2: SMTP handshake + auth
try:
    if use_ssl:
        ctx = ssl.create_default_context()
        with smtplib.SMTP_SSL(host, port, context=ctx, timeout=10) as s:
            s.login(user, pw)
            print(f\\"✅ SMTP {proto}:{port} authentication succeeded for {user}\\")
    elif use_tls:
        with smtplib.SMTP(host, port, timeout=10) as s:
            s.starttls(context=ssl.create_default_context())
            s.login(user, pw)
            print(f\\"✅ SMTP {proto}:{port} authentication succeeded for {user}\\")
    else:
        with smtplib.SMTP(host, port, timeout=10) as s:
            s.login(user, pw)
            print(f\\"✅ SMTP {proto}:{port} authentication succeeded for {user}\\")
except smtplib.SMTPAuthenticationError as e:
    print(f\\"❌ SMTP {proto}:{port} authentication FAILED for {user}: {e}\\")
    print(f\\"   → The mail container is running but the password is wrong\\")
    print(f\\"   → Run the Poste.io setup command to reset the admin mailbox password\\")
except smtplib.SMTPConnectError as e:
    print(f\\"❌ SMTP {proto}:{port} connection error: {e}\\")
    print(f\\"   → Poste.io SMTP service may not be ready yet\\")
except Exception as e:
    print(f\\"❌ SMTP {proto}:{port} error: {type(e).__name__}: {e}\\")
"
        fi
      '`
    );
    console.log(smtpTest ? smtpTest.trim() : 'Could not test SMTP connectivity.');
  }

  // ---- Nginx diagnostics ----
  if (p.nginxContainer) {
    console.log(`\n${yellow('--- Nginx Diagnostics ---')}`);

    // 7a. Nginx config
    log('\nNginx configuration:', cyan(''));
    const nginxConf = remoteExec(`sudo docker exec ${p.nginxContainer} cat /etc/nginx/nginx.conf 2>&1`);
    if (nginxConf && nginxConf.trim()) {
      console.log(nginxConf.trim());
    } else {
      log('Could not read nginx configuration.', yellow(''));
    }

    // 7b. Nginx logs
    log(`\nRecent nginx logs for ${p.nginxContainer} (last 20 lines):`, cyan(''));
    const nginxLogs = remoteExec(`sudo docker logs --tail 20 ${p.nginxContainer} 2>&1`);
    if (nginxLogs && nginxLogs.trim()) {
      console.log(nginxLogs.trim());
    } else {
      log('No nginx logs available.', yellow(''));
    }

    // 7c. Extract the proxy_pass target from nginx config
    const proxyPassMatch = nginxConf && nginxConf.match(/proxy_pass\s+http:\/\/([^:\/]+):?(\d+)?/);
    const backendHost = proxyPassMatch ? proxyPassMatch[1] : null;
    const backendPort = proxyPassMatch ? (proxyPassMatch[2] || '8000') : '8000';

    if (backendHost) {
      // 7d. DNS resolution from nginx container
      log(`\nDNS resolution for "${backendHost}" from inside ${p.nginxContainer}:`, cyan(''));
      const dnsTest = remoteExec(
        `sudo docker exec ${p.nginxContainer} sh -c '
          if command -v getent >/dev/null 2>&1; then
            getent hosts ${backendHost} 2>&1 || echo "RESOLVE_FAILED"
          elif command -v nslookup >/dev/null 2>&1; then
            nslookup ${backendHost} 2>&1 || echo "RESOLVE_FAILED"
          else
            cat /etc/hosts | grep ${backendHost} 2>&1 || echo "RESOLVE_FAILED"
          fi
        '`
      );
      if (dnsTest && dnsTest.includes('RESOLVE_FAILED')) {
        console.log(red(`❌ "${backendHost}" does NOT resolve from nginx container`));
        console.log(`   → Nginx cannot reach the backend because DNS fails`);
        console.log(`   → Both containers must be on the same Docker network`);

        // Show which networks each container is on
        log(`\n   Container networks:`, cyan(''));
        const nginxNets = remoteExec(
          `sudo docker inspect --format='{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' ${p.nginxContainer}`
        );
        const webNets = remoteExec(
          `sudo docker inspect --format='{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' ${p.webContainer}`
        );
        console.log(`   Nginx (${p.nginxContainer}): ${nginxNets ? nginxNets.trim() : 'unknown'}`);
        console.log(`   Web   (${p.webContainer}): ${webNets ? webNets.trim() : 'unknown'}`);

        if (nginxNets && webNets) {
          const nginxNetList = nginxNets.trim().split(/\s+/);
          const webNetList = webNets.trim().split(/\s+/);
          const shared = nginxNetList.filter(n => webNetList.includes(n));
          if (shared.length === 0) {
            console.log(red(`   ❌ No shared Docker network! They cannot communicate.`));
            console.log(`   → Fix: Add both containers to the same network in docker-compose.vm.yml`);
          } else {
            console.log(green(`   ✅ Shared network(s): ${shared.join(', ')}`));
            console.log(`   → DNS should work but the service name may differ. Check docker-compose service names.`);
          }
        }
      } else if (dnsTest && dnsTest.trim()) {
        console.log(green(`✅ "${backendHost}" resolves to: ${dnsTest.trim()}`));
      } else {
        console.log(yellow(`⚠️  Could not test DNS resolution for "${backendHost}"`));
      }

      // 7e. TCP connectivity from nginx to backend
      log(`\nTCP connectivity from ${p.nginxContainer} to ${backendHost}:${backendPort}:`, cyan(''));
      const tcpTest = remoteExec(
        `sudo docker exec ${p.nginxContainer} sh -c '
          if command -v nc >/dev/null 2>&1; then
            nc -z -w 5 ${backendHost} ${backendPort} 2>&1 && echo "TCP_OK" || echo "TCP_FAILED"
          elif command -v timeout >/dev/null 2>&1; then
            timeout 5 sh -c "echo > /dev/tcp/${backendHost}/${backendPort}" 2>&1 && echo "TCP_OK" || echo "TCP_FAILED"
          else
            wget -q -O /dev/null --timeout=5 http://${backendHost}:${backendPort}/ 2>&1 && echo "TCP_OK" || echo "TCP_FAILED"
          fi
        '`
      );
      if (tcpTest && tcpTest.includes('TCP_OK')) {
        console.log(green(`✅ ${backendHost}:${backendPort} is reachable from nginx container`));
      } else {
        console.log(red(`❌ ${backendHost}:${backendPort} is NOT reachable from nginx container`));
        console.log(`   → DNS may resolve but the backend is not listening or a firewall blocks it`);
        console.log(`   → Verify the web container is running: sudo docker ps --filter name=${p.webContainer}`);
        console.log(`   → Verify both are on the same Docker network (see above)`);
      }

      // 7f. Full HTTP proxy test (sends the correct Host header)
      log(`\nHTTP proxy test from ${p.nginxContainer} to ${backendHost}:${backendPort}:`, cyan(''));
      const proxyTestOut = remoteExec(
        `sudo docker exec ${p.nginxContainer} sh -c '
          if command -v wget >/dev/null 2>&1; then
            wget -q -O /dev/null --timeout=5 -S http://${backendHost}:${backendPort}/ --header="Host: ${p.domain}" 2>&1 | head -5
          elif command -v curl >/dev/null 2>&1; then
            curl -s -o /dev/null -w "HTTP %{http_code}" --connect-timeout 5 -H "Host: ${p.domain}" http://${backendHost}:${backendPort}/ 2>&1
          else
            echo "NO_HTTP_CLIENT"
          fi
        '`
      );

      if (proxyTestOut && proxyTestOut.includes('NO_HTTP_CLIENT')) {
        console.log(yellow(`⚠️  No curl/wget available in nginx container to test HTTP`));
      } else if (proxyTestOut) {
        // Parse HTTP status code from wget output (e.g. "HTTP/1.1 200 OK") or curl output (e.g. "HTTP 200")
        const wgetMatch = proxyTestOut.match(/HTTP\/[\d.]+\s+(\d+)/);
        const curlMatch = proxyTestOut.match(/HTTP\s+(\d+)/);
        const code = wgetMatch ? parseInt(wgetMatch[1]) : (curlMatch ? parseInt(curlMatch[1]) : null);

        if (code && code >= 200 && code < 400) {
          console.log(green(`✅ Nginx can reach the web backend at http://${backendHost}:${backendPort}/ (HTTP ${code})`));
        } else if (code === 400) {
          console.log(green(`✅ Nginx CAN reach the web backend at http://${backendHost}:${backendPort}/`));
          console.log(`   HTTP 400 is expected — Django rejects requests without a valid Host header.`);
          console.log(`   Through the real proxy, Nginx sends "Host: ${p.domain}" which is in ALLOWED_HOSTS.`);
        } else if (code && code >= 500) {
          console.log(red(`❌ Backend returned HTTP ${code} — server error`));
          console.log(`   Response: ${proxyTestOut.trim()}`);
        } else if (code) {
          console.log(yellow(`⚠️  Backend returned HTTP ${code}`));
          console.log(`   Response: ${proxyTestOut.trim()}`);
        } else {
          console.log(red(`❌ Could not parse HTTP response from backend`));
          console.log(`   Response: ${proxyTestOut.trim()}`);
        }
      } else {
        console.log(red(`❌ No response from web backend at http://${backendHost}:${backendPort}/`));
        console.log(`   → Check the Docker network configuration`);
      }
    } else {
      log('\nCould not extract proxy_pass target from nginx config.', yellow(''));
    }
  }

  // ---- GCP Load Balancer Diagnostics ----
  if (GCP_PROJECT_ID && p.gcpBackendService) {
    console.log(`\n${yellow('--- GCP Load Balancer Diagnostics ---')}`);

    log(`\nBackend health (${p.gcpBackendService}):`, cyan(''));
    const healthResult = gcloudExec(
      `gcloud compute backend-services get-health ${p.gcpBackendService} --global --project=${GCP_PROJECT_ID} --format="value(status.healthStatus[0].healthState, status.healthStatus[0].ipAddress, status.healthStatus[0].port)"`
    );
    if (healthResult) {
      console.log(healthResult.trim());
    } else {
      log('Could not retrieve backend health.', red(''));
    }

    if (p.gcpHealthCheck) {
      log(`\nHealth check details (${p.gcpHealthCheck}):`, cyan(''));
      const hcDetails = gcloudExec(
        `gcloud compute health-checks describe ${p.gcpHealthCheck} --global --project=${GCP_PROJECT_ID} --format="value(httpHealthCheck.port, httpHealthCheck.requestPath)"`
      );
      if (hcDetails) {
        console.log(hcDetails.trim());
      } else {
        log('Could not retrieve health check details.', red(''));
      }
    }

    log(`\nFirewall rule (allow-lb-health-checks) allowed ports:`, cyan(''));
    const fwPorts = gcloudExec(
      `gcloud compute firewall-rules describe allow-lb-health-checks --project=${GCP_PROJECT_ID} --format="value(allowed[0].ports)"`
    );
    if (fwPorts) {
      console.log(fwPorts.trim());
    } else {
      log('Could not retrieve firewall rule.', red(''));
    }
  }

  // ---- Environment Dump (regular first, then secrets masked) ----
  log('\n⚠️  Live environment from container (secrets are masked):', yellow(''));
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
          // FULL masking — never expose any part of a secret.
          // Safe to copy/paste and share.
          secrets.push(`${varName}=***`);
        } else {
          regular.push(line);
        }
      } else {
        regular.push(line);
      }
    }
    if (regular.length > 0) {
      console.log(cyan('--- Regular Environment Variables ---'));
      regular.forEach(l => console.log(l));
    }
    if (secrets.length > 0) {
      console.log('\x1b[35m--- Secrets (masked) ---\x1b[0m');
      secrets.forEach(l => console.log(l));
    }
  } else {
    log(`Could not read environment from ${p.webContainer}.`, red(''));
  }

  console.log(`\n${yellow(`=== End of diagnostics for ${p.label} ===`)}\n`);
  await pause();
};