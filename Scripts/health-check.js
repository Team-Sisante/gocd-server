#!/usr/bin/env node
/**
 * health-check.js – Check and repair health of all deployed sites.
 *
 * Usage: node health-check.js [--fix]
 *   --fix   Automatically attempt to repair any issues found.
 *
 * If --fix is not provided, it only reports health status.
 */

const { execSync, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

// Load environment variables (for GCP project ID, VM IP, SSH key, etc.)
const dotenv = require('dotenv');
dotenv.config({ path: path.join(__dirname, '..', '.env.docker') });

const PROJECT = process.env.GCP_PROJECT_ID || 'project-39c0ea08-238b-47b5-915';
const VM_IP = process.env.GCP_VM_IP || '35.198.231.9';
const SSH_USER = process.env.VM_SSH_USER || 'xmione';
const SSH_KEY_PATH = path.join(__dirname, '..', 'secrets', 'agent-key');

// Backends to check (also used to determine which projects to fix)
const BACKENDS = [
  { name: 'Humrine Staging', backend: 'humrine-staging-backend', webContainer: 'humrine-web-staging', composeDir: '/opt/humrine_site', composeFile: 'docker-compose.vm.yml', project: 'humrine-staging', domain: 'staging.humrine.com', gcpHealthCheck: 'staging-health-check' },
  { name: 'Humrine Production', backend: 'humrine-backend', webContainer: 'humrine-web-production', composeDir: '/opt/humrine_site', composeFile: 'docker-compose.vm.yml', project: 'humrine-production', domain: 'humrine.com', gcpHealthCheck: 'production-health-check' },
  { name: 'Badminton Staging', backend: 'court-staging-backend', webContainer: 'badminton-staging-web-staging-1', composeDir: '/opt/badminton_court', composeFile: 'docker-compose.vm.yml', project: 'badminton-staging', domain: 'humrine.com', gcpHealthCheck: 'court-staging-health-check' },
  { name: 'Badminton Production', backend: 'court-backend', webContainer: 'badminton-production-web-production-1', composeDir: '/opt/badminton_court', composeFile: 'docker-compose.vm.yml', project: 'badminton-production', domain: 'humrine.com', gcpHealthCheck: 'court-health-check' },
];

// Helper: run gcloud command
function runGcloud(cmd) {
  try {
    const fullCmd = `gcloud compute backend-services get-health ${cmd} --global --project=${PROJECT}`;
    const output = execSync(fullCmd, { encoding: 'utf8', stdio: 'pipe' });
    return output.trim();
  } catch (error) {
    return null;
  }
}

// Helper: remote SSH execution
function remoteExec(cmd) {
  const args = [
    '-i', SSH_KEY_PATH,
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'UserKnownHostsFile=/dev/null',
    '-o', 'ConnectTimeout=15',
    '-o', 'LogLevel=ERROR',
    '-o', 'KexAlgorithms=+diffie-hellman-group14-sha256',
    `${SSH_USER}@${VM_IP}`,
    cmd,
  ];
  try {
    return execFileSync('ssh', args, { encoding: 'utf8', stdio: 'pipe' });
  } catch (err) {
    return null;
  }
}

// Helper: run a remote command and check success
function remoteExecSilent(cmd) {
  const result = remoteExec(cmd);
  if (result === null) return { success: false, output: null };
  return { success: true, output: result.trim() };
}

// Helper: update GCP health check timeout
function updateHealthCheckTimeout(healthCheck) {
  try {
    execSync(
      `gcloud compute health-checks update http ${healthCheck} --timeout=30 --check-interval=30 --project=${PROJECT}`,
      { stdio: 'pipe' }
    );
    return true;
  } catch (e) {
    return false;
  }
}

// ----- Repair functions -----

function repairContainer(webContainer, composeDir, composeFile, project) {
  console.log(`   → Restarting ${webContainer}...`);
  const cmd = `cd ${composeDir} && sudo docker compose -p ${project} -f ${composeFile} up -d --force-recreate ${webContainer}`;
  const result = remoteExecSilent(cmd);
  if (result.success) {
    console.log(`   ✅ ${webContainer} restarted.`);
    return true;
  }
  console.log(`   ❌ Failed to restart ${webContainer}.`);
  return false;
}

function repairCollectStatic(webContainer) {
  console.log(`   → Running collectstatic on ${webContainer}...`);
  // Check if binary or python is used
  const binCheck = remoteExecSilent(`sudo docker exec ${webContainer} ls /app/humrine_site_linux 2>/dev/null`);
  let cmd;
  if (binCheck.success) {
    cmd = `sudo docker exec ${webContainer} /app/humrine_site_linux collectstatic --noinput`;
  } else {
    cmd = `sudo docker exec ${webContainer} python manage.py collectstatic --noinput`;
  }
  const result = remoteExecSilent(cmd);
  if (result.success) {
    console.log(`   ✅ Static files collected.`);
    return true;
  }
  console.log(`   ❌ collectstatic failed.`);
  return false;
}

function repairContainerStart(webContainer, composeDir, composeFile, project) {
  console.log(`   → Starting ${webContainer}...`);
  const cmd = `cd ${composeDir} && sudo docker compose -p ${project} -f ${composeFile} up -d ${webContainer}`;
  const result = remoteExecSilent(cmd);
  if (result.success) {
    console.log(`   ✅ ${webContainer} started.`);
    return true;
  }
  console.log(`   ❌ Failed to start ${webContainer}.`);
  return false;
}

function checkAndRepair(site, fix) {
  const { name, backend, webContainer, composeDir, composeFile, project, gcpHealthCheck } = site;

  console.log(`\n🔍 Checking ${name} (${backend})...`);
  const health = runGcloud(backend);
  const isHealthy = health && health.includes('HEALTHY');

  if (isHealthy) {
    console.log(`   ✅ HEALTHY`);
    return true;
  } else {
    console.log(`   ❌ UNHEALTHY`);
    if (!fix) {
      console.log(`   ℹ️  Use --fix to attempt repairs.`);
      return false;
    }

    console.log(`   🔧 Attempting repairs...`);

    // 1. Check if container is running
    const psResult = remoteExecSilent(`sudo docker ps --filter name=${webContainer} --format '{{.Status}}'`);
    if (!psResult.success || !psResult.output) {
      console.log(`   → Container not running. Attempting to start...`);
      if (!repairContainerStart(webContainer, composeDir, composeFile, project)) {
        console.log(`   ❌ Could not start container. Manual intervention required.`);
        return false;
      }
    }

    // 2. Try collectstatic (common fix for 500 errors)
    console.log(`   → Attempting static file collection...`);
    const collectResult = repairCollectStatic(webContainer);
    if (!collectResult) {
      console.log(`   → collectstatic failed. Attempting full container restart...`);
      if (!repairContainer(webContainer, composeDir, composeFile, project)) {
        console.log(`   ❌ Container restart failed. Manual intervention required.`);
        return false;
      }
      // After restart, try collectstatic again
      console.log(`   → Retrying static collection after restart...`);
      repairCollectStatic(webContainer);
    }

    // 3. Update GCP health check timeout (if not already set)
    console.log(`   → Ensuring health check timeout is adequate...`);
    const timeoutUpdated = updateHealthCheckTimeout(gcpHealthCheck);
    if (timeoutUpdated) {
      console.log(`   ✅ Health check timeout updated to 30s.`);
    } else {
      console.log(`   ℹ️  Health check timeout update skipped (or already correct).`);
    }

    // 4. Wait a moment and re-check health
    console.log(`   ⏳ Waiting 30 seconds for changes to take effect...`);
    execSync('sleep 30', { stdio: 'pipe' });

    const recheck = runGcloud(backend);
    if (recheck && recheck.includes('HEALTHY')) {
      console.log(`   ✅ Now HEALTHY after repairs.`);
      return true;
    } else {
      console.log(`   ❌ Still UNHEALTHY after repairs. Manual investigation needed.`);
      return false;
    }
  }
}

function main() {
  const args = process.argv.slice(2);
  const fix = args.includes('--fix');

  console.log('🏥 Running health checks' + (fix ? ' with auto-repair' : '') + '...\n');

  let allHealthy = true;
  for (const site of BACKENDS) {
    const ok = checkAndRepair(site, fix);
    if (!ok) allHealthy = false;
  }

  console.log('\n' + '='.repeat(50));
  if (allHealthy) {
    console.log('✅ All sites are HEALTHY.');
    process.exit(0);
  } else {
    console.log('❌ Some sites are UNHEALTHY. Please investigate further.');
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}