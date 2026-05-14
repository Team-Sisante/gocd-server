#!/usr/bin/env node
/**
 * Scripts/menu.js
 *
 * Cross-platform GoCD Management Menu.
 * Requires all necessary variables in .env.docker – no defaults.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const os = require('os');
const dotenv = require('dotenv');

// Load environment variables from .env.docker
const envPath = path.join(__dirname, '..', '.env.docker');
dotenv.config({ path: envPath });

// ----- Validate required environment variables -----
const requiredVars = [
    'GOCD_ADMIN_USERNAME',
    'GOCD_ADMIN_PASSWORD',
    'GOCD_SERVER_URL_PROTOCOL',
    'GOCD_SERVER_URL_HOST',
    'GOCD_SERVER_PORT',
    'GCP_PROJECT_ID',
    'GCP_ZONE',
    'GCP_VM_NAME'
];

const missingVars = requiredVars.filter(v => !process.env[v]);

if (missingVars.length > 0) {
    console.error(
        '\x1b[31mERROR: The following required environment variables are missing in .env.docker:\x1b[0m\n' +
        missingVars.map(v => `  - ${v}`).join('\n') +
        '\n\nPlease define them before running this script.'
    );

    process.exit(1);
}

// ----- Load custom error patterns from errorTrigger.json -----
const errorTriggerPath = path.join(__dirname, 'errorTrigger.json');
let customPatterns = [];
if (fs.existsSync(errorTriggerPath)) {
    try {
        customPatterns = JSON.parse(fs.readFileSync(errorTriggerPath, 'utf8'));
        if (!Array.isArray(customPatterns)) customPatterns = [];
    } catch (e) {
        console.error('\x1b[31mFailed to parse errorTrigger.json:\x1b[0m', e.message);
    }
}

// Always include these base patterns
const basePatterns = [
    'error', 'fail', 'fatal', 'exception', 'denied',
    'caused\\s+by', 'invalid', 'wrapper stopped', 'gosu exited',
    'exited with code', 'there are errors', 'could not connect',
    'permission denied'
];

// Merge and create a single combined regex (case‑insensitive)
const ALL_PATTERNS = [...basePatterns, ...customPatterns];
const errorKeywords = new RegExp(ALL_PATTERNS.join('|'), 'i');
const errorTrigger = new RegExp('^(ERROR|FATAL)\\s|' + ALL_PATTERNS.join('|'), 'i');

// ----- Configuration from environment -----
const GOCD_USER = process.env.GOCD_ADMIN_USERNAME;
const GOCD_PASS = process.env.GOCD_ADMIN_PASSWORD;

// GoCD base URL
const GOCD_PROTO = process.env.GOCD_SERVER_URL_PROTOCOL;
const GOCD_HOST = process.env.GOCD_SERVER_URL_HOST;
const GOCD_PORT = process.env.GOCD_SERVER_PORT;
const GOCD_BASE = `${GOCD_PROTO}://${GOCD_HOST}:${GOCD_PORT}`;
// Ensure the GoCD server's password file matches GOCD_ADMIN_PASSWORD (fire‑and‑forget)
try {
    require('child_process').spawn('docker', [
        'exec', 'gocd-server', 'sh', '-c',
        `echo 'admin:${GOCD_PASS}' > /godata/config/password.properties`
    ], { stdio: 'ignore', detached: true }).unref();
} catch { }
// GCP VM settings
const GCP_PROJECT_ID = process.env.GCP_PROJECT_ID;
const GCP_ZONE = process.env.GCP_ZONE;
const GCP_VM_NAME = process.env.GCP_VM_NAME;

// Optional – not required for menu operation
const SITE_URL = process.env.SITE_URL || '';

const PROJECT_ROOT = path.join(__dirname, '..');
const isWindows = os.platform() === 'win32';

function log(msg, color = '\x1b[36m') {
    console.log(`${color}%s\x1b[0m`, msg);
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function sh(cmd, options = {}) {
    try {
        return execSync(cmd, {
            cwd: PROJECT_ROOT,
            encoding: 'utf8',
            stdio: options.stdio || 'inherit',
            ...options
        });
    } catch (error) {
        if (!options.silent) {
            console.error('\x1b[31m%s\x1b[0m', `Command failed: ${cmd}`);
        }
        return { success: false, error: error.message };
    }
}

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

function ask(question) {
    return new Promise(resolve => {
        rl.question(`\x1b[33m${question}\x1b[0m`, answer => {
            resolve(answer.trim());
        });
    });
}

async function pause() {
    await ask('Press Enter to continue...');
}

function openUrl(url) {
    let cmd = '';
    if (isWindows) cmd = `start ${url}`;
    else if (os.platform() === 'darwin') cmd = `open ${url}`;
    else cmd = `xdg-open ${url}`;

    try {
        sh(cmd, { stdio: 'ignore' });
    } catch (e) {
        log(`Could not open browser. Manually visit: ${url}`, '\x1b[33m');
    }
}

async function triggerPipelineInteractively() {
    const inquirer = (await import('inquirer')).default;

    const pipelines = [
        'badminton_court-artifacts',
        'badminton_court-staging',
        'badminton_court-production'
    ];

    // --- pause global readline before using inquirer ---
    rl.pause();

    let sessionCookie = process.env.GOCD_SESSION_COOKIE;
    if (!sessionCookie) {
        const { cookie } = await inquirer.prompt({
            type: 'input',
            name: 'cookie',
            message: 'Paste JSESSIONID:',
        });
        sessionCookie = (cookie || '').trim();
        if (!sessionCookie) {
            rl.resume();   // resume before returning
            log('❌ No cookie – cannot trigger.', '\x1b[31m');
            return;
        }
        process.env.GOCD_SESSION_COOKIE = sessionCookie;
    }

    const { selectedPipeline } = await inquirer.prompt({
        type: 'list',
        name: 'selectedPipeline',
        message: 'Select a pipeline to trigger:',
        choices: pipelines
    });

    // --- resume global readline now that inquirer is done ---
    rl.resume();

    const url = GOCD_BASE + '/go/api/pipelines/' + selectedPipeline + '/schedule';
    const curlArgs = [
        '-s', '-H', 'Accept: application/vnd.go.cd.v1+json',
        '-H', 'Content-Type: application/json',
        '-H', 'X-GoCD-Confirm: true',
        '-b', 'JSESSIONID=' + sessionCookie,
        '-X', 'POST',
        '-d', '{"isTrusted":true}',
        url
    ];

    // No try/catch – errors bubble up to case '2.1'
    const result = execSync('docker exec gocd-server curl ' + curlArgs.map(a => `"${a}"`).join(' '), {
        encoding: 'utf8', stdio: 'pipe', cwd: PROJECT_ROOT
    });

    if (!result.includes('accepted')) {
        throw new Error(result.trim());
    }

    log('✅ Pipeline ' + selectedPipeline + ' triggered.', '\x1b[32m');
    // Use the global ask for pausing – now safe because rl is resumed
    await ask('Press Enter to continue...');
}

// Interactive container selector for logs/errors
async function selectContainerAndAct() {
  let containers = [];
  try {
    const raw = execSync('docker ps -a --format "{{.Names}}"', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    containers = raw.trim().split('\n').filter(Boolean);
  } catch (e) {
    console.log('\x1b[31mFailed to list containers.\x1b[0m');
    return;
  }

  if (containers.length === 0) {
    console.log('\x1b[33mNo containers found.\x1b[0m');
    return;
  }

  const inquirer = (await import('inquirer')).default;

  const { chosenContainer } = await inquirer.prompt({
    type: 'list',
    name: 'chosenContainer',
    message: 'Select a container:',
    choices: containers,
    pageSize: 15
  });

  const { action } = await inquirer.prompt({
    type: 'list',
    name: 'action',
    message: `What to do with ${chosenContainer}?`,
    choices: [
      { name: 'View logs (last 20 lines)', value: 'logs' },
      { name: 'View errors (static scan of last 500 lines)', value: 'errors' },
      { name: 'View errors (live - follow)', value: 'live-errors' },
      { name: 'Cancel', value: 'cancel' }
    ],
    default: 'logs'
  });

  if (action === 'cancel') return;

  if (action === 'live-errors') {
    // Live follow mode
    console.log(`\x1b[33mLive error follow for ${chosenContainer}. Press Ctrl+C to stop.\x1b[0m`);
    await liveErrorFollow(chosenContainer);
    return;
  }

  console.log(`\x1b[33mFetching ${action === 'logs' ? 'logs' : 'errors'}...\x1b[0m`);
  try {
    const tailArg = action === 'logs' ? '--tail 20' : '--tail 500';
    const rawLogs = execSync(`docker logs ${tailArg} ${chosenContainer}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    const lines = rawLogs.split('\n');

    if (action === 'logs') {
      lines.forEach(line => console.log(line));
    } else {
      // Static error view (your existing deduplicated block logic)
      const keywords = /(error|fail|fatal|exception|denied|caused\s+by|invalid)/i;
      const contextBefore = 5;
      const contextAfter = 15;
      const matches = [];

      lines.forEach((line, idx) => {
        if (keywords.test(line)) matches.push(idx);
      });

      if (matches.length === 0) {
        console.log('\x1b[32mNo error-like lines found.\x1b[0m');
      } else {
        const blocks = [];
        let currentBlock = [Math.max(0, matches[0] - contextBefore), matches[0] + contextAfter];

        for (let i = 1; i < matches.length; i++) {
          const start = Math.max(0, matches[i] - contextBefore);
          const end = matches[i] + contextAfter;
          if (start <= currentBlock[1] + 1) {
            currentBlock[1] = Math.max(currentBlock[1], end);
          } else {
            blocks.push(currentBlock);
            currentBlock = [start, end];
          }
        }
        blocks.push(currentBlock);

        const seen = new Set();
        let first = true;

        blocks.forEach(([start, end]) => {
          const slice = lines.slice(start, end + 1);
          const blockText = slice.join('\n');
          if (seen.has(blockText)) return;
          seen.add(blockText);

          if (!first) {
            console.log('\x1b[90m' + '─'.repeat(60) + '\x1b[0m');
          }
          first = false;

          slice.forEach(line => {
            if (keywords.test(line)) {
              console.log('\x1b[31m' + line + '\x1b[0m');
            } else {
              console.log(line);
            }
          });
          console.log('');
        });
      }
    }
  } catch (e) {
    console.log(`\x1b[31mFailed to get logs: ${e.stderr || e.message}\x1b[0m`);
  }
}

// Helper: live error follow with context
function liveErrorFollow(containerName) {
    return new Promise((resolve) => {
        const seenLines = new Set();

        const logFilePath = path.join(process.cwd(), `error-live-${containerName}.log`);
        try { fs.mkdirSync(process.cwd(), { recursive: true }); } catch (e) { }
        fs.writeFileSync(logFilePath, '', 'utf8');
        console.log(`\x1b[33mErrors will be written to: ${logFilePath}\x1b[0m`);

        let proc = null;
        let rl = null;
        let watching = true;

        // Strip only the ISO timestamp
        function stripTimestamp(line) {
            return line.replace(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2},\d{3}\s*/, '').trim();
        }

        // Ultra‑strict: keep ONLY lines that start with ERROR or FATAL,
        // or are known crash / fatal‑stop indicators
        function isStrictError(line) {
            if (/^(ERROR|FATAL)\s/.test(line)) return true;
            if (/wrapper stopped|gosu exited|exited with code|There are errors|^Caused by:/i.test(line)) return true;
            return false;
        }

        function startFollow() {
            const { spawn } = require('child_process');
            const readline = require('readline');

            proc = spawn('docker', ['logs', '-f', '--tail', '100', containerName], {
                stdio: ['ignore', 'pipe', 'pipe']
            });

            rl = readline.createInterface({ input: proc.stdout });

            rl.on('line', (line) => {
                const cleanLine = stripTimestamp(line);

                if (!isStrictError(cleanLine)) return;   // ← only gate

                if (!seenLines.has(cleanLine)) {
                    seenLines.add(cleanLine);
                    console.log(cleanLine);
                    try {
                        fs.appendFileSync(logFilePath, cleanLine + '\n', 'utf8');
                    } catch (e) {
                        console.error(`\x1b[31mFailed to write to log file: ${e.message}\x1b[0m`);
                    }
                }
            });

            proc.stderr.on('data', (data) => {
                console.error(`\x1b[31mDocker logs error: ${data.toString()}\x1b[0m`);
            });

            proc.on('close', (code) => {
                rl.close();
                if (watching && code !== null) {
                    console.log(`\x1b[33mContainer stopped (exit code ${code}). Reconnecting in 3 seconds...\x1b[0m`);
                    setTimeout(() => { if (watching) startFollow(); }, 3000);
                } else if (!watching) {
                    console.log('\x1b[33mLive follow stopped.\x1b[0m');
                    resolve();
                }
            });

            proc.on('error', (err) => {
                console.error(`\x1b[31mFailed to start log stream: ${err.message}\x1b[0m`);
                if (watching) setTimeout(() => { if (watching) startFollow(); }, 5000);
            });
        }

        const onInterrupt = () => {
            watching = false;
            if (proc) proc.kill('SIGINT');
            if (rl) rl.close();
            console.log('\n\x1b[33mLive follow stopped by user.\x1b[0m');
            resolve();
        };
        process.once('SIGINT', onInterrupt);

        startFollow();
    });
}

// ----- Module-level flag to prevent screen clear after an error -----
let errorDisplayed = false;

async function showMenu() {
    while (true) {
        try {
            if (!errorDisplayed) {
                process.stdout.write('\x1Bc');
            }
            errorDisplayed = false;

            console.log('\x1b[32mGoCD Management Menu (.js)\x1b[0m');
            console.log('\x1b[32m===========================\x1b[0m');
            console.log('');
            console.log('\x1b[36m1. CONTAINER MANAGEMENT\x1b[0m');
            console.log('   1.1. Update/Restart GoCD (Fast Build)');
            console.log('   1.2. Get Docker container errors');
            console.log('   1.3. Validate GoCD environment');
            console.log('   1.4. View container logs');
            console.log('   1.5. Stop all containers');
            console.log('   1.6. SYSTEM HARD RESET (Full Wipe via go.js)');
            console.log('   1.7. Restart Docker Desktop (full restart)');
            console.log('   1.8. Restart Docker Engine only');
            console.log('   1.9. Container selector (logs / errors)');
            console.log('');
            console.log('\x1b[36m2. PIPELINE MANAGEMENT\x1b[0m');
            console.log('   2.1. Trigger badminton_court pipeline');
            console.log('   2.2. View pipeline history');
            console.log('   2.3. Unlock pipeline');
            console.log('   2.4. Convert pipelines to SSH');
            console.log('');
            console.log('\x1b[36m3. AGENT MANAGEMENT\x1b[0m');
            console.log('   3.1. View agent status');
            console.log('   3.2. Enable agent');
            console.log('   3.3. Disable agent');
            console.log('');
            console.log('\x1b[36m4. SYSTEM UTILITIES\x1b[0m');
            console.log('   4.1. Encrypt .env files');
            console.log('   4.2. Decrypt .env files');
            console.log('   4.3. Open GoCD web interface');
            console.log('   4.4. View system resources');
            console.log('   4.5. Clean up Docker resources');
            console.log('   4.6. Print Project Folder Structure');
            console.log('   4.7. Sync Master with Feature Branch');
            console.log('   4.8. Fix NODE_OPTIONS error');
            console.log('   4.9. Reset GoCD admin password (from .env.docker)');
            console.log('   4.10. Update .env.docker password from GoCD container');
            console.log('   4.11. Display & test GoCD admin credentials');
            console.log('');
            console.log('\x1b[36m5. TROUBLE-SHOOT CONTAINERS\x1b[0m');
            console.log('   5.1. Rebuild and Re-start gocd-server container');
            console.log('   5.2. Rebuild and Re-start gocd-agent-1 container');
            console.log('   5.3. Rebuild and Re-start gocd-agent-2 container');
            console.log('   5.4. Rebuild and Re-start gocd-agent-3 container');
            console.log('   5.5. View container logs');
            console.log('');
            console.log('\x1b[36m6. GCP VM SETUP\x1b[0m');
            console.log('   6.1. Create deployment VM');
            console.log('   6.2. Configure firewall rules');
            console.log('   6.3. Setup agent SSH keys');
            console.log('   6.4. Setup GCP Secret Manager access for agent');
            console.log('   6.5. Deploy application');
            console.log('   6.6. Monitor VM status');
            console.log('   6.7. Check VM running & reachable');
            console.log('   6.8. Grant agent VM read access (one‑time setup)');
            console.log('   6.9. Install Tools on VM (one‑time setup)');
            console.log('   6.10. Export VM settings to YAML');
            console.log('   6.11. Delete VM');
            console.log('   6.12. Create VM from saved YAML');
            console.log('   6.13. Recreate fresh VM (export → delete → create)');
            console.log('   6.14. Run full post‑creation setup (firewall, SSH, secrets, tools, check)');
            console.log('   6.15. Show Docker containers on VM (staging/production)');
            console.log('   6.16. View logs of a service on VM');
            console.log('   6.17. Restart a service on VM');
            console.log('   6.18. Open staging app in browser');
            console.log('   6.19. Health check staging app');
            console.log('   6.20. Clear SSH host key for VM');
            console.log('');
            console.log('\x1b[36m0. Exit\x1b[0m');
            console.log('');

            const choice = await ask('Select an option: ');

            switch (choice) {
                case '1.1':
                    sh('docker compose build && docker compose up -d');
                    await pause();
                    break;
                case '1.2':
                    sh('docker ps -a --filter "status=exited"');
                    await pause();
                    break;
                case '1.3':
                    sh('node Scripts/validate.js');
                    await pause();
                    break;
                case '1.4':
                case '1.5':
                    sh('docker compose down');
                    await pause();
                    break;
                case '1.6':
                    const confirmReset = await ask('WARNING: This will wipe ALL Docker data. Are you sure? (y/N): ');
                    if (confirmReset.toLowerCase() === 'y') { sh('node Scripts/go.js'); }
                    await pause();
                    break;
                case '1.7':
                    log('Restarting Docker Desktop (full restart)...', '\x1b[33m');
                    const confirmDesktop = await ask('This will fully restart Docker Desktop. Continue? (y/N): ');
                    if (confirmDesktop.toLowerCase() === 'y') {
                        if (isWindows) {
                        // 1. Stop Docker Desktop process if running
                            log('Stopping Docker Desktop process...', '\x1b[33m');
                            try {
                                execSync('taskkill /F /IM "Docker Desktop.exe"', { stdio: 'pipe', timeout: 10000 });
                            } catch (e) {
                                log('Docker Desktop process was not running.', '\x1b[33m');
                            }

                        // 2. Launch Docker Desktop
                            log('Starting Docker Desktop...', '\x1b[33m');
                            try {
                                execSync('start "" "C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe"', { stdio: 'pipe', timeout: 10000 });
                            } catch (e) {
                                log('❌ Failed to start Docker Desktop. Check the installation path.', '\x1b[31m');
                                await pause();
                                break;
                            }

                        // 3. Wait for Docker Engine to be ready
                            log('Waiting for Docker Engine to be ready...', '\x1b[33m');
                            let engineReady = false;
                            for (let attempt = 1; attempt <= 12; attempt++) {
                                log(`  Attempt ${attempt}...`, '\x1b[36m');
                                try {
                                    execSync('docker ps', { stdio: 'inherit', timeout: 10000 });
                                    engineReady = true;
                                    break;
                                } catch (_) {
                                    if (attempt < 12) await sleep(5000);
                                }
                            }
                            if (engineReady) {
                                log('✅ Docker Desktop restarted and engine is ready.', '\x1b[32m');
                            } else {
                                log('❌ Docker Engine did not become ready within 60 seconds.', '\x1b[31m');
                            }
                        } else if (os.platform() === 'darwin') {
                            sh('pkill -f "Docker Desktop"');
                            sh('open -a Docker Desktop');
                        } else {
                            sh('systemctl restart docker');
                        }
                    } else {
                        log('Restart cancelled.', '\x1b[33m');
                    }
                    await pause();
                    break;

                case '1.8':
                    log('Restarting Docker Engine (admin required)...', '\x1b[33m');
                    const confirmEngine = await ask('This will stop all containers and restart the Docker Engine. Continue? (y/N): ');
                    if (confirmEngine.toLowerCase() === 'y') {
                        if (isWindows) {
                        // ---- 1. Graceful stop of containers (with timeout) ----
                            log('Checking for running containers...', '\x1b[33m');
                            let ids = '';
                            try {
                                ids = execSync('docker ps -q', { encoding: 'utf8', stdio: 'pipe', timeout: 10000 }).trim();
                            } catch (e) {
                                if (e.killed) {
                                    log('⚠ Docker daemon is unresponsive – skipping graceful container stop.', '\x1b[33m');
                                } else {
                                    log('⚠ Could not list containers – proceeding with restart.', '\x1b[33m');
                                }
                            }

                            if (ids) {
                                const idList = ids.split(/\r?\n/).filter(Boolean);
                                log(`Stopping ${idList.length} container(s)...`, '\x1b[33m');
                                for (const id of idList) {
                                    try {
                                        execSync(`docker stop ${id}`, { stdio: 'pipe', timeout: 15000 });
                                    } catch (e) {
                                        log(`⚠ Failed to stop container ${id.substring(0, 12)} (may already be stopping).`, '\x1b[33m');
                                    }
                                }
                                log('Graceful stop completed (or timed out).', '\x1b[32m');
                            }

                        // ---- 2. Force stop Docker Desktop Service + WSL ----
                            log('A UAC prompt will appear. Please click "Yes" to allow the restart.', '\x1b[33m');
                            const psScriptPath = path.join(os.tmpdir(), 'restart_docker_engine.ps1');
                            const resultFilePath = path.join(os.tmpdir(), 'restart_docker_result.txt');

                            const runElevatedAction = (action) => {
                                const psScript = action === 'stop'
                                    ? `$ErrorActionPreference = 'Stop'
try {
    $svc = Get-Service -Name 'Docker Desktop Service' -ErrorAction Stop
    if ($svc.Status -eq 'Running') {
        Stop-Service -Name 'Docker Desktop Service' -Force
    }
    # Terminate WSL2 VM to guarantee engine stops
    wsl --shutdown
    Write-Output 'STOPPED' | Out-File -FilePath '${resultFilePath.replace(/\\/g, '\\\\')}' -Encoding utf8
} catch {
    $_.Exception.Message | Out-File -FilePath '${resultFilePath.replace(/\\/g, '\\\\')}' -Encoding utf8
    exit 1
}`
                                    : `$ErrorActionPreference = 'Stop'
try {
    $svc = Get-Service -Name 'Docker Desktop Service' -ErrorAction Stop
    if ($svc.Status -ne 'Running') {
        Start-Service -Name 'Docker Desktop Service'
    } else {
        Restart-Service -Name 'Docker Desktop Service' -Force
    }
    Write-Output 'STARTED' | Out-File -FilePath '${resultFilePath.replace(/\\/g, '\\\\')}' -Encoding utf8
} catch {
    $_.Exception.Message | Out-File -FilePath '${resultFilePath.replace(/\\/g, '\\\\')}' -Encoding utf8
    exit 1
}`;

                                fs.writeFileSync(psScriptPath, psScript, 'utf8');
                                try { fs.unlinkSync(resultFilePath); } catch (_) { }

                                const elevateCmd = `powershell -Command "Start-Process -Verb RunAs -Wait -FilePath 'powershell' -ArgumentList '-NoProfile -ExecutionPolicy Bypass -File \\"${psScriptPath}\\"' "`;
                                try {
                                    execSync(elevateCmd, { stdio: 'pipe', timeout: 30000 });
                                } catch (e) {
                                // If timed out or failed, return false
                                    return false;
                                }

                                let result = null;
                                if (fs.existsSync(resultFilePath)) {
                                    result = fs.readFileSync(resultFilePath, 'utf8').trim();
                                    fs.unlinkSync(resultFilePath);
                                }
                                return result === 'STOPPED' || result === 'STARTED';
                            };

                        // Stop service + WSL
                            log('Force stopping Docker Engine (service + WSL)...', '\x1b[33m');
                            const stopped = runElevatedAction('stop');
                            if (!stopped) {
                                log('❌ Failed to stop Docker Engine (UAC declined or command failed).', '\x1b[31m');
                                try { fs.unlinkSync(psScriptPath); } catch (_) { }
                                await pause();
                                break;
                            }

                        // Confirm engine is down
                            log('Checking if Docker Engine is stopped...', '\x1b[33m');
                            try {
                                execSync('docker ps', { stdio: 'pipe', timeout: 5000 });
                                log('⚠ Docker Engine still responding unexpectedly.', '\x1b[33m');
                            } catch (_) {
                                log('Docker Engine confirmed stopped.', '\x1b[32m');
                            }

                        // ---- 3. Start the service ----
                            log('Starting Docker Desktop Service...', '\x1b[33m');
                            const started = runElevatedAction('start');
                            try { fs.unlinkSync(psScriptPath); } catch (_) { }
                            if (!started) {
                                log('❌ Failed to start Docker Engine.', '\x1b[31m');
                                await pause();
                                break;
                            }

                        // ---- 4. Wait for engine to become responsive ----
                            log('Waiting for Docker Engine to become responsive...', '\x1b[33m');
                            let engineReady = false;
                            for (let attempt = 1; attempt <= 12; attempt++) {
                                log(`  Attempt ${attempt}...`, '\x1b[36m');
                                try {
                                    execSync('docker ps', { stdio: 'inherit', timeout: 10000 });
                                    engineReady = true;
                                    break;
                                } catch (_) {
                                    if (attempt < 12) {
                                        execSync('timeout /t 5', { stdio: 'pipe' });
                                    }
                                }
                            }

                            if (engineReady) {
                                log('✅ Docker Engine restarted and is ready.', '\x1b[32m');
                            } else {
                                log('❌ Docker Engine did not become ready within 60 seconds.', '\x1b[31m');
                                log('   Try option 1.7 (Restart Docker Desktop) for a full restart.', '\x1b[33m');
                            }
                        } else if (os.platform() === 'darwin') {
                            sh('pkill -f "com.docker.hyperkit"');
                            sh('open -a Docker Desktop');
                        } else {
                            sh('systemctl restart docker');
                        }
                    } else {
                        log('Restart cancelled.', '\x1b[33m');
                    }
                    await pause();
                    break;

                case '1.9':
                    await selectContainerAndAct();
                    await pause();
                    break;

                case '2.1':
                    try {
                        await triggerPipelineInteractively();
                    } catch (err) {
                        rl.resume();   // ensure readline is active
                        errorDisplayed = true;
                        process.stdout.write('\x1Bc');
                        log('❌ Pipeline trigger failed:', '\x1b[31m');
                        console.error(err.stderr || err.message || err);
                        console.log('\x1b[33m');
                        await ask('Press Enter to return to the menu...');
                    }
                    break;

                case '2.2':
                    const pipelineToView = await ask('Enter pipeline name (default: badminton_court-artifacts): ') || 'badminton_court-artifacts';
                    openUrl(`${GOCD_BASE}/go/pipelines/${pipelineToView}`);
                    await pause();
                    break;
                case '2.3':
                    const pipelineToUnlock = await ask('Enter pipeline name (default: badminton_court-artifacts): ') || 'badminton_court-artifacts';
                    sh(`docker exec gocd-server curl -s -u "${GOCD_USER}:${GOCD_PASS}" -H "Confirm: true" -X POST ${GOCD_BASE}/go/api/pipelines/${pipelineToUnlock}/unlock`);
                    log(`Pipeline ${pipelineToUnlock} unlock requested.`, '\x1b[32m');
                    await pause();
                    break;
                case '2.4':
                    sh('node Scripts/update-pipelines-ssh.js');
                    await pause();
                    break;

                case '3.1':
                    sh(`docker exec gocd-server curl -s -u "${GOCD_USER}:${GOCD_PASS}" ${GOCD_BASE}/go/api/agents | jq ".[] | {hostname, status, resources}"`);
                    await pause();
                    break;
                case '3.2':
                    const agentToEnable = await ask('Enter agent UUID: ');
                    if (agentToEnable) {
                        sh(`docker exec gocd-server curl -s -u "${GOCD_USER}:${GOCD_PASS}" -X PATCH -H "Accept: application/vnd.go.cd.v1+json" -H "Content-Type: application/json" -d "{\\"agent_config_state\\": \\"Enabled\\"}" ${GOCD_BASE}/go/api/agents/${agentToEnable}`);
                        log(`Agent ${agentToEnable} enabled.`, '\x1b[32m');
                    }
                    await pause();
                    break;
                case '3.3':
                    const agentToDisable = await ask('Enter agent UUID: ');
                    if (agentToDisable) {
                        sh(`docker exec gocd-server curl -s -u "${GOCD_USER}:${GOCD_PASS}" -X PATCH -H "Accept: application/vnd.go.cd.v1+json" -H "Content-Type: application/json" -d "{\\"agent_config_state\\": \\"Disabled\\"}" ${GOCD_BASE}/go/api/agents/${agentToDisable}`);
                        log(`Agent ${agentToDisable} disabled.`, '\x1b[32m');
                    }
                    await pause();
                    break;

                case '4.1':
                    sh('node Scripts/encryptenvfiles.js');
                    await pause();
                    break;
                case '4.2':
                    sh('node Scripts/decryptenvfiles.js');
                    await pause();
                    break;
                case '4.3':
                    openUrl(`${GOCD_BASE}/go`);
                    await pause();
                    break;
                case '4.4':
                    sh('docker stats --no-stream');
                    await pause();
                    break;
                case '4.5':
                    sh('docker system prune -f');
                    await pause();
                    break;
                case '4.6':
                    sh('node Scripts/pfs.js');
                    await pause();
                    break;
                case '4.7':
                    const featureBranch = await ask('Enter feature branch name: ');
                    if (featureBranch) { sh(`node Scripts/master-feature-git-sync.js ${featureBranch}`); }
                    await pause();
                    break;
                case '4.8':
                    sh('node Scripts/fix-node-options.js');
                    await pause();
                    break;
                case '4.9':
                    log('Resetting GoCD admin password and restarting server...', '\x1b[33m');
                // Write the new password from .env.docker into the container
                    sh(`docker exec gocd-server sh -c "echo 'admin:${GOCD_PASS}' > /godata/config/password.properties"`);
                // Full stop/start to flush GoCD's authentication cache
                    log('Stopping GoCD server...', '\x1b[33m');
                    sh('docker stop gocd-server');
                    log('Starting GoCD server...', '\x1b[33m');
                    sh('docker start gocd-server');
                // Wait for GoCD to be ready (using the homepage to avoid auth issues)
                    log('Waiting for GoCD to be ready...', '\x1b[33m');
                    {
                        let ready = false;
                    for (let i = 0; i < 24; i++) {  // up to 120 seconds
                            try {
                                execSync(`docker exec gocd-server curl -sf -o /dev/null "${GOCD_BASE}/go"`, { stdio: 'pipe' });
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
                            log('✅ GoCD is ready. Password reset applied.', '\x1b[32m');
                        } else {
                            log('❌ GoCD did not become ready in time. Check the container manually.', '\x1b[31m');
                        }
                    }
                    await pause();
                    break;

                case '4.10': {
                // Read the current password from inside the GoCD container
                    const rawPass = sh(
                        `docker exec gocd-server cat /godata/config/password.properties`,
                        { stdio: 'pipe' }
                    );
                // sh returns the output string on success, or an error object on failure
                    if (typeof rawPass === 'string' && rawPass.includes(':')) {
                    const newPassword = rawPass.trim().split(':')[1];   // admin:password
                        const envPath = path.join(__dirname, '..', '.env.docker');
                        let envContent = fs.readFileSync(envPath, 'utf8');
                        envContent = envContent.replace(
                            /^GOCD_ADMIN_PASSWORD=.*/m,
                            `GOCD_ADMIN_PASSWORD=${newPassword}`
                        );
                        fs.writeFileSync(envPath, envContent);
                        log('✅ .env.docker updated with password from container.', '\x1b[32m');
                    } else {
                        log('❌ Could not retrieve password from container.', '\x1b[31m');
                    }
                    await pause();
                    break;
                }

                case '4.11': {
                    log('--- GoCD Admin Credentials ---', '\x1b[36m');
                    log(`Username: ${GOCD_USER}`, '\x1b[36m');
                    log(`Password: ${GOCD_PASS}`, '\x1b[36m');
                    log(`GoCD URL: ${GOCD_BASE}`, '\x1b[36m');

                // ── Test /go/api/agents (basic auth only) ──
                    log('\nTesting /go/api/agents...', '\x1b[33m');
                    const agentsResult = sh(
                        `docker exec gocd-server curl -s -u "${GOCD_USER}:${GOCD_PASS}" "${GOCD_BASE}/go/api/agents"`,
                        { stdio: 'pipe' }
                    );
                    if (typeof agentsResult === 'string') {
                        try {
                            JSON.parse(agentsResult);
                            log('✅ Agents endpoint – authentication OK, JSON returned.', '\x1b[32m');
                        } catch (_) {
                            log('⚠ Agents returned non‑JSON:', '\x1b[33m');
                            console.log(agentsResult.substring(0, 400));
                        }
                    } else {
                        log('❌ Agents command failed (container down?).', '\x1b[31m');
                    }

                // ── Test /go/api/pipelines WITH the correct Accept header ──
                    log('\nTesting /go/api/pipelines (with v3 header)...', '\x1b[33m');
                    const pipelinesResult = sh(
                        `docker exec gocd-server curl -s -u "${GOCD_USER}:${GOCD_PASS}" -H "Accept: application/vnd.go.cd+json" "${GOCD_BASE}/go/api/pipelines"`,
                        { stdio: 'pipe' }
                    );
                    if (typeof pipelinesResult === 'string') {
                        try {
                            const json = JSON.parse(pipelinesResult);
                            const pipelineList = json._embedded?.pipelines || json.pipelines || [];
                            log(`✅ Pipelines endpoint returned ${pipelineList.length} pipelines.`, '\x1b[32m');
                        } catch (_) {
                            log('⚠ Pipelines returned non‑JSON. Full response:', '\x1b[33m');
                            console.log(pipelinesResult);
                        }
                    } else {
                        log('❌ Pipelines command failed.', '\x1b[31m');
                    }
                    await pause();
                    break;
                }

                case '5.1':
                    sh('docker compose build gocd-server && docker compose up -d gocd-server');
                    await pause();
                    break;
                case '5.2':
                    sh('docker compose build --no-cache gocd-agent-1 && docker compose up -d gocd-agent-1');
                    await pause();
                    break;
                case '5.3':
                    sh('docker compose build --no-cache gocd-agent-2 && docker compose up -d gocd-agent-2');
                    await pause();
                    break;
                case '5.4':
                    sh('docker compose build --no-cache gocd-agent-3 && docker compose up -d gocd-agent-3');
                    await pause();
                    break;
                case '5.5':
                    const containerName = await ask('Enter container name (default: gocd-server): ') || 'gocd-server';
                    sh(`docker logs -f --tail 100 ${containerName}`);
                    await pause();
                    break;

                // ---- 6. GCP VM SETUP ----
                case '6.1':
                    sh('node Scripts/create-deploy-vm.js');
                    await pause();
                    break;
                case '6.2':
                    sh('node Scripts/setup-firewall-rules.js');
                    await pause();
                    break;
                case '6.3':
                    sh('node Scripts/setup-agent-ssh.js');
                    await pause();
                    break;
                case '6.4':
                    sh('node Scripts/setup-gcp-secrets-access.js');
                    await pause();
                    break;
                case '6.5':
                    sh(`docker exec gocd-server curl -s -u "${GOCD_USER}:${GOCD_PASS}" -H "Confirm: true" -X POST ${GOCD_BASE}/go/api/pipelines/badminton_court-artifacts/schedule`);
                    log('Pipeline triggered. Staging will start automatically after artifacts succeed.', '\x1b[32m');
                    await pause();
                    break;
                case '6.6':
                    sh(`gcloud compute instances describe ${GCP_VM_NAME} --zone=${GCP_ZONE} --project=${GCP_PROJECT_ID} --format="table[box](name, status, machineType, networkInterfaces[0].accessConfigs[0].natIP)"`);
                    await pause();
                    break;
                case '6.7':
                    sh('node Scripts/check-vm-reachability.js');
                    await pause();
                    break;
                case '6.8':
                // Grant all required roles for gcloud compute ssh
                    const sa = `gocd-agent-secrets@${GCP_PROJECT_ID}.iam.gserviceaccount.com`;
                    sh(`gcloud projects add-iam-policy-binding ${GCP_PROJECT_ID} --member="serviceAccount:${sa}" --role="roles/compute.viewer"`);
                    sh(`gcloud projects add-iam-policy-binding ${GCP_PROJECT_ID} --member="serviceAccount:${sa}" --role="roles/compute.instanceAdmin.v1"`);
                    sh(`gcloud projects add-iam-policy-binding ${GCP_PROJECT_ID} --member="serviceAccount:${sa}" --role="roles/compute.securityAdmin"`);
                    sh(`gcloud iam service-accounts add-iam-policy-binding 575810712323-compute@developer.gserviceaccount.com --member="serviceAccount:${sa}" --role="roles/iam.serviceAccountUser"`);
                    log('Agent granted all required permissions (including project‑level SSH metadata).', '\x1b[32m');
                    await pause();
                    break;
                case '6.9':
                // Install tools on VM (one-time setup)
                    sh('node Scripts/install-tools-on-vm.js');
                    log('Agent granted all required permissions.', '\x1b[32m');
                    await pause();
                    break;
                case '6.10':
                    const exportPath = await ask('Output filename (default: gocd-deploy-target-config.yaml): ') || 'gocd-deploy-target-config.yaml';
                    sh(`gcloud compute instances export ${GCP_VM_NAME} --project=${GCP_PROJECT_ID} --zone=${GCP_ZONE} --destination=${exportPath}`);
                    log(`VM settings saved to ${exportPath}`, '\x1b[32m');
                    await pause();
                    break;
                case '6.11':
                    log('WARNING: This will delete the VM and all its data!', '\x1b[31m');
                    const confirmDelete = await ask('Are you sure? (y/N): ');
                    if (confirmDelete.toLowerCase() === 'y') {
                        sh(`gcloud compute instances delete ${GCP_VM_NAME} --project=${GCP_PROJECT_ID} --zone=${GCP_ZONE} --quiet`);
                        log('VM deleted.', '\x1b[32m');
                    }
                    await pause();
                    break;
                case '6.12': {
                    const yamlFile = await ask('YAML config file (default: gocd-deploy-target-config.yaml): ') || 'gocd-deploy-target-config.yaml';
                    if (!fs.existsSync(yamlFile)) {
                        log(`File not found: ${yamlFile}`, '\x1b[31m');
                    } else {
                    // Check if the VM already exists
                        let vmExists = false;
                        try {
                            execSync(`gcloud compute instances describe ${GCP_VM_NAME} --project=${GCP_PROJECT_ID} --zone=${GCP_ZONE}`, { stdio: 'pipe' });
                            vmExists = true;
                    } catch (_) { /* VM does not exist */ }

                        if (vmExists) {
                            log(`ℹ️  VM "${GCP_VM_NAME}" already exists.`, '\x1b[33m');
                            log('    If it needs configuration, proceed with the setup steps below.', '\x1b[33m');
                            log('    To recreate a fresh VM, delete it first (option 6.11) or use 6.13.', '\x1b[33m');
                        } else {
                        // Read the YAML and build a standard creation command
                            const yaml = fs.readFileSync(yamlFile, 'utf8');

                        // Extract short resource names (last part of the URL after the final slash)
                            const machineType = (yaml.match(/machineType:\s*.*\/([^/\s]+)/) || [])[1] || 'e2-medium';
                            const image = (yaml.match(/sourceImage:\s*(.+)/) || [])[1]?.trim() || 'projects/debian-cloud/global/images/family/debian-11';
                            const bootDiskSize = (yaml.match(/diskSizeGb:\s*(\d+)/) || [])[1] || '20';
                            const network = (yaml.match(/network:\s*.*\/([^/\s]+)/) || [])[1] || 'default';
                            const subnetwork = (yaml.match(/subnetwork:\s*.*\/([^/\s]+)/) || [])[1] || '';
                            const hasExternalIp = yaml.includes('natIP:');
                            const externalIPFlag = hasExternalIp ? '' : '--no-address';

                            let createCmd = `gcloud compute instances create ${GCP_VM_NAME}`;
                            createCmd += ` --project=${GCP_PROJECT_ID}`;
                            createCmd += ` --zone=${GCP_ZONE}`;
                            createCmd += ` --machine-type=${machineType}`;
                            createCmd += ` --image=${image}`;
                            createCmd += ` --boot-disk-size=${bootDiskSize}GB`;
                            createCmd += ` --network=${network}`;
                            if (subnetwork) createCmd += ` --subnet=${subnetwork}`;
                            if (externalIPFlag) createCmd += ` ${externalIPFlag}`;

                            const result = sh(createCmd);
                            if (result && result.success) {
                                log('VM created from saved settings.', '\x1b[32m');
                            } else {
                            // sh() already printed the error; we just add context
                                log('⚠️  VM creation failed. Check the error above.', '\x1b[31m');
                            }
                        }

                    // --- Next steps reminder (shown whether VM existed or was just created) ---
                        log('', '\x1b[36m');
                        log('📋 Recommended next steps for this VM:', '\x1b[33m');
                        log('   6.2  – Configure firewall rules', '\x1b[33m');
                        log('   6.3  – Setup agent SSH keys', '\x1b[33m');
                        log('   6.4  – Setup GCP Secret Manager access', '\x1b[33m');
                        log('   6.9  – Install Tools on VM', '\x1b[33m');
                        log('   6.7  – Check VM reachability', '\x1b[33m');
                        log('', '\x1b[36m');
                        log('💡 Pro tip: Use option 6.14 to run all of them at once.', '\x1b[36m');
                        log('⚠️ Before using option 6.13: The YAML file "gocd-deploy-target-config.yaml" will be overwritten.', '\x1b[33m');
                        log('⚠️ All the existing settings of a fully setup VM will be lost.', '\x1b[33m');
                    }
                    await pause();
                    break;
                }
                case '6.13':
                    log('This will: 1) Export settings, 2) Delete VM, 3) Create fresh VM, 4) Run full setup', '\x1b[33m');
                    log('⚠️  The YAML file "gocd-deploy-target-config.yaml" will be overwritten.', '\x1b[33m');
                    const confirmRecreate = await ask('Proceed? (y/N): ');
                    if (confirmRecreate.toLowerCase() === 'y') {
                        const recreateYaml = 'gocd-deploy-target-config.yaml';

                    // Backup the old YAML if it exists
                        if (fs.existsSync(recreateYaml)) {
                            const backupName = recreateYaml.replace('.yaml', `-backup-${Date.now()}.yaml`);
                            fs.copyFileSync(recreateYaml, backupName);
                            log(`📁 Previous config backed up to: ${backupName}`, '\x1b[36m');
                        }

                    // Step 1: Export (overwrites the original)
                        log('Step 1: Exporting VM settings...', '\x1b[33m');
                        sh(`gcloud compute instances export ${GCP_VM_NAME} --project=${GCP_PROJECT_ID} --zone=${GCP_ZONE} --destination=${recreateYaml}`);
                        log('Step 2: Deleting VM...', '\x1b[33m');
                        sh(`gcloud compute instances delete ${GCP_VM_NAME} --project=${GCP_PROJECT_ID} --zone=${GCP_ZONE} --quiet`);
                        log('Step 3: Creating fresh VM...', '\x1b[33m');
                        {
                            const yaml = fs.readFileSync(recreateYaml, 'utf8');
                            const machineType = (yaml.match(/machineType:\s*(\S+)/) || [])[1] || 'e2-medium';
                            const image = (yaml.match(/sourceImage:\s*["']?([^"'\n\r]+)["']?/) || [])[1] || 'projects/debian-cloud/global/images/family/debian-11';
                            const bootDiskSize = (yaml.match(/diskSizeGb:\s*(\d+)/) || [])[1] || '20';
                            const network = (yaml.match(/network:\s*(\S+)/) || [])[1] || 'default';
                            const subnetwork = (yaml.match(/subnetwork:\s*(\S+)/) || [])[1] || '';
                            const hasExternalIp = yaml.includes('natIP:');
                            const externalIPFlag = hasExternalIp ? '' : '--no-address';

                            let createCmd = `gcloud compute instances create ${GCP_VM_NAME}`;
                            createCmd += ` --project=${GCP_PROJECT_ID}`;
                            createCmd += ` --zone=${GCP_ZONE}`;
                            createCmd += ` --machine-type=${machineType}`;
                            createCmd += ` --image=${image}`;
                            createCmd += ` --boot-disk-size=${bootDiskSize}GB`;
                            createCmd += ` --network=${network}`;
                            if (subnetwork) createCmd += ` --subnet=${subnetwork}`;
                            if (externalIPFlag) createCmd += ` ${externalIPFlag}`;
                            sh(createCmd);
                        }
                        log('Fresh VM created from saved settings.', '\x1b[32m');

                    // Next steps reminder (same as 6.12)
                        log('', '\x1b[36m');
                        log('📋 Recommended next steps for this fresh VM:', '\x1b[33m');
                        log('   6.2  – Configure firewall rules', '\x1b[33m');
                        log('   6.3  – Setup agent SSH keys', '\x1b[33m');
                        log('   6.4  – Setup GCP Secret Manager access', '\x1b[33m');
                        log('   6.9  – Install Tools on VM', '\x1b[33m');
                        log('   6.7  – Check VM reachability', '\x1b[33m');
                        log('', '\x1b[36m');
                        log('💡 Pro tip: Use option 6.14 to run all of them at once.', '\x1b[36m');
                    }
                    await pause();
                    break;
                case '6.14':
                    log('Running full VM post‑creation setup...', '\x1b[33m');
                    sh('node Scripts/setup-firewall-rules.js');
                    sh('node Scripts/setup-agent-ssh.js');
                    sh('node Scripts/setup-gcp-secrets-access.js');
                    sh('node Scripts/install-tools-on-vm.js');
                    sh('node Scripts/check-vm-reachability.js');
                    log('✅ Setup completed.', '\x1b[32m');
                    await pause();
                    break;
                case '6.15': {
                    const keyPath = path.join(__dirname, 'agent-key');
                    const sshUser = process.env.VM_SSH_USER || 'xmnione';
                    const vmIp = process.env.GCP_VM_IP || '136.109.209.69';
                    const sshCmd = `ssh -i "${keyPath}" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null ${sshUser}@${vmIp} "docker ps --format 'table {{.Names}}\\t{{.Status}}\\t{{.Ports}}'"`;
                    sh(sshCmd);
                    await pause();
                    break;
                }
                case '6.16': {
                    const keyPath = path.join(__dirname, 'agent-key');
                    const sshUser = process.env.VM_SSH_USER || 'xmnione';
                    const vmIp = process.env.GCP_VM_IP || '136.109.209.69';
                    const service = await ask('Service name (e.g., badminton_web_1): ');
                    if (service) {
                    // Show logs interactively
                        sh(`ssh -i "${keyPath}" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null ${sshUser}@${vmIp} "docker logs -f --tail 50 ${service}"`);
                    }
                    await pause();
                    break;
                }
                case '6.17': {
                    const keyPath = path.join(__dirname, 'agent-key');
                    const sshUser = process.env.VM_SSH_USER || 'xmnione';
                    const vmIp = process.env.GCP_VM_IP || '136.109.209.69';
                    const service = await ask('Service name to restart: ');
                    if (service) {
                        sh(`ssh -i "${keyPath}" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null ${sshUser}@${vmIp} "docker restart ${service}"`);
                        log(`${service} restarted.`, '\x1b[32m');
                    }
                    await pause();
                    break;
                }
                case '6.18': {
                // Open staging app – uses VM's external IP
                const stagingUrl = `http://${process.env.GCP_VM_IP || '136.109.209.69'}:8001`; // staging port
                    openUrl(stagingUrl);
                    log(`Opening staging app: ${stagingUrl}`, '\x1b[32m');
                    await pause();
                    break;
                }
                case '6.19': {
                // Health check – curl the app from inside the VM (avoids firewall issues)
                    const keyPath = path.join(__dirname, 'agent-key');
                    const sshUser = process.env.VM_SSH_USER || 'xmnione';
                    const vmIp = process.env.GCP_VM_IP || '136.109.209.69';
                    log('Performing health check on staging (port 8001)...', '\x1b[33m');
                    sh(`ssh -i "${keyPath}" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null ${sshUser}@${vmIp} "curl -s -o /dev/null -w '%{http_code}' http://localhost:8001/ || echo 'Failed'"`);
                    await pause();
                    break;
                }
                case '6.20': {
                // Clear cached SSH host key for the VM IP
                    const vmIp = process.env.GCP_VM_IP || '136.109.209.69';
                    log(`Removing cached host key for ${vmIp}...`, '\x1b[33m');
                    if (os.platform() === 'win32') {
                    // Use ssh-keygen from Git Bash or Windows OpenSSH
                        sh(`ssh-keygen -R ${vmIp}`);
                    } else {
                        sh(`ssh-keygen -R ${vmIp}`);
                    }
                    log('Host key cleared. Next connection will accept the new key.', '\x1b[32m');
                    await pause();
                    break;
                }

                case '0':
                    rl.close();
                    process.exit(0);
                default:
                    log('Invalid option.', '\x1b[31m');
                    await pause();
                    break;
            }

        } catch (err) {
            errorDisplayed = true;
            process.stdout.write('\x1Bc');
            console.error('\x1b[31m⚠️  An unexpected error occurred:\x1b[0m');
            console.error(err);
            console.log('\x1b[33m');
            await ask('Press Enter to return to the menu...');
        }
    }
}

(async () => {
    console.log('\x1b[36mGoCD Management Menu is starting...\x1b[0m');
    await new Promise(r => setTimeout(r, 2000));
    await showMenu();
})().catch(async (err) => {
    console.error(err);
    await ask('Press Enter to return to the menu...');
    rl.close();
    process.exit(1);
});