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
        { name: 'humrine.com (production)',         value: 'humrine-production' },
        { name: 'app.humrine.com (production)',      value: 'humrine-production' },   // same project
        { name: 'staging.humrine.com (staging)',     value: 'humrine-staging' },
        { name: 'humrine.com/court (badminton prod)', value: 'badminton-production' },
        { name: 'humrine.com/court-staging (badminton staging)', value: 'badminton-staging' },
      ],
    },
  ]);
  ctx.rl.resume();

  const projects = {
    'humrine-production': {
      dir: '/opt/humrine_site',
      envFile: '.env.production',
      webContainer: 'humrine-web-production',
      nginxContainer: 'humrine-nginx-production',
      label: 'Humrine Production (humrine.com / app.humrine.com)',
    },
    'humrine-staging': {
      dir: '/opt/humrine_site',
      envFile: '.env.staging',
      webContainer: 'humrine-web-staging',
      nginxContainer: 'humrine-nginx-staging',
      label: 'Humrine Staging (staging.humrine.com)',
    },
    'badminton-production': {
      dir: '/opt/badminton_court',
      envFile: '.env.production',
      webContainer: 'badminton-production-web-production-1',   // exact name from your output
      nginxContainer: 'badminton_court-nginx-production',
      label: 'Badminton Court Production (humrine.com/court)',
    },
    'badminton-staging': {
      dir: '/opt/badminton_court',
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

  // 1. Container status
  log('Container status:', '\x1b[36m');
  const psOut = remoteExec(
    `sudo docker ps -a --filter "name=${p.webContainer}" --filter "name=${p.nginxContainer}" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"`
  );
  console.log(psOut ? psOut.trim() : 'No containers found.');

  // 2. Environment file contents
  log('\nEnvironment variables:', '\x1b[36m');
  const envPath = `${p.dir}/${p.envFile}`;
  const envOut = remoteExec(`cat ${envPath}`);
  if (envOut) {
    console.log(envOut.trim());
  } else {
    log(`Could not read ${envPath}.`, '\x1b[31m');
  }

  // 3. Web container logs
  log(`\nRecent logs for ${p.webContainer} (last 20 lines):`, '\x1b[36m');
  const logsOut = remoteExec(`sudo docker logs --tail 20 ${p.webContainer}`);
  if (logsOut) {
    console.log(logsOut.trim());
  } else {
    log(`Could not retrieve logs for ${p.webContainer}.`, '\x1b[31m');
  }

  // 4. (Optional) Nginx logs
  log(`\nRecent nginx logs for ${p.nginxContainer} (last 20 lines):`, '\x1b[36m');
  const nginxLogs = remoteExec(`sudo docker logs --tail 20 ${p.nginxContainer}`);
  if (nginxLogs) {
    console.log(nginxLogs.trim());
  } else {
    log(`Could not retrieve nginx logs.`, '\x1b[31m');
  }

  console.log(`\n\x1b[33m=== End of diagnostics for ${p.label} ===\x1b[0m\n`);
  await pause();
};