// menu/containerManagement.js
// Container management options (1.1 – 1.8)

const { execSync } = require('child_process');
const path = require('path');
const os = require('os');

module.exports = {
    '1.1': async (ctx) => {
        ctx.sh('docker compose --env-file .env.docker build && docker compose --env-file .env.docker up -d');
        await ctx.pause();
    },
    '1.2': async (ctx) => {
        ctx.sh('docker compose --env-file .env.docker ps -a --filter "status=exited"');
        await ctx.pause();
    },
    '1.3': async (ctx) => {
        ctx.sh('docker compose --env-file .env.docker run --rm -v $(pwd)/Scripts:/scripts node:alpine sh -c "cd /scripts && npm install && node validate.js"');
        await ctx.pause();
    },
    '1.4': async (ctx) => {
        ctx.sh('docker compose --env-file .env.docker down');
        await ctx.pause();
    },
    '1.5': async (ctx) => {
        ctx.sh('docker compose --env-file .env.docker down');
        await ctx.pause();
    },
    '1.6': async (ctx) => {
        const confirmReset = await ctx.ask('WARNING: This will wipe ALL Docker data. Are you sure? (y/N): ');
        if (confirmReset.toLowerCase() === 'y') ctx.sh('node Scripts/go.js');
        await ctx.pause();
    },
    '1.7': async (ctx) => {
        ctx.log('Restarting Docker Desktop (full restart)...', '\x1b[33m');
        const confirmDesktop = await ctx.ask('This will fully restart Docker Desktop. Continue? (y/N): ');
        if (confirmDesktop.toLowerCase() === 'y') {
            if (ctx.isWindows) {
                // 1. Stop Docker Desktop process if running
                ctx.log('Stopping Docker Desktop process...', '\x1b[33m');
                try {
                    execSync('taskkill /F /IM "Docker Desktop.exe"', { stdio: 'pipe', timeout: 10000 });
                } catch (e) {
                    ctx.log('Docker Desktop process was not running.', '\x1b[33m');
                }

                // 2. Launch Docker Desktop
                ctx.log('Starting Docker Desktop...', '\x1b[33m');
                try {
                    execSync('start "" "C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe"', { stdio: 'pipe', timeout: 10000 });
                } catch (e) {
                    ctx.log('❌ Failed to start Docker Desktop. Check the installation path.', '\x1b[31m');
                    await ctx.pause();
                    return;
                }

                // 3. Wait for Docker Engine to be ready
                ctx.log('Waiting for Docker Engine to be ready...', '\x1b[33m');
                let engineReady = false;
                for (let attempt = 1; attempt <= 12; attempt++) {
                    ctx.log(`  Attempt ${attempt}...`, '\x1b[36m');
                    try {
                        execSync('docker ps', { stdio: 'inherit', timeout: 10000 });
                        engineReady = true;
                        break;
                    } catch (_) {
                        if (attempt < 12) await ctx.sleep(5000);
                    }
                }
                if (engineReady) {
                    ctx.log('✅ Docker Desktop restarted and engine is ready.', '\x1b[32m');
                } else {
                    ctx.log('❌ Docker Engine did not become ready within 60 seconds.', '\x1b[31m');
                }
            } else if (os.platform() === 'darwin') {
                ctx.sh('pkill -f "Docker Desktop"');
                ctx.sh('open -a Docker Desktop');
            } else {
                ctx.sh('systemctl restart docker');
            }
        } else {
            ctx.log('Restart cancelled.', '\x1b[33m');
        }
        await ctx.pause();
    },
    '1.8': async (ctx) => {
        ctx.log('Restarting Docker Engine (admin required)...', '\x1b[33m');
        const confirmEngine = await ctx.ask('This will stop all containers and restart the Docker Engine. Continue? (y/N): ');
        if (confirmEngine.toLowerCase() === 'y') {
            if (ctx.isWindows) {
                // ---- 1. Graceful stop of containers (with timeout) ----
                ctx.log('Checking for running containers...', '\x1b[33m');
                let ids = '';
                try {
                    ids = execSync('docker ps -q', { encoding: 'utf8', stdio: 'pipe', timeout: 10000 }).trim();
                } catch (e) {
                    if (e.killed) {
                        ctx.log('⚠ Docker daemon is unresponsive – skipping graceful container stop.', '\x1b[33m');
                    } else {
                        ctx.log('⚠ Could not list containers – proceeding with restart.', '\x1b[33m');
                    }
                }

                if (ids) {
                    const idList = ids.split(/\r?\n/).filter(Boolean);
                    ctx.log(`Stopping ${idList.length} container(s)...`, '\x1b[33m');
                    for (const id of idList) {
                        try {
                            execSync(`docker stop ${id}`, { stdio: 'pipe', timeout: 15000 });
                        } catch (e) {
                            ctx.log(`⚠ Failed to stop container ${id.substring(0, 12)} (may already be stopping).`, '\x1b[33m');
                        }
                    }
                    ctx.log('Graceful stop completed (or timed out).', '\x1b[32m');
                }

                // ---- 2. Force stop Docker Desktop Service + WSL ----
                ctx.log('A UAC prompt will appear. Please click "Yes" to allow the restart.', '\x1b[33m');
                const psScriptPath = path.join(os.tmpdir(), 'restart_docker_engine.ps1');
                const resultFilePath = path.join(os.tmpdir(), 'restart_docker_result.txt');

                const runElevatedAction = (action) => {
                    const psScript = action === 'stop'
                        ? `$ErrorActionPreference = 'Stop'
try {
    $svc = Get-Service -Name 'Docker Desktop Service' -ErrorAction Stop
    if ($svc.Status -eq 'Running') { Stop-Service -Name 'Docker Desktop Service' -Force }
    wsl --shutdown
    Write-Output 'STOPPED' | Out-File -FilePath '${resultFilePath.replace(/\\/g, '\\\\')}' -Encoding utf8
} catch {
    $_.Exception.Message | Out-File -FilePath '${resultFilePath.replace(/\\/g, '\\\\')}' -Encoding utf8
    exit 1
}`
                        : `$ErrorActionPreference = 'Stop'
try {
    $svc = Get-Service -Name 'Docker Desktop Service' -ErrorAction Stop
    if ($svc.Status -ne 'Running') { Start-Service -Name 'Docker Desktop Service' }
    else { Restart-Service -Name 'Docker Desktop Service' -Force }
    Write-Output 'STARTED' | Out-File -FilePath '${resultFilePath.replace(/\\/g, '\\\\')}' -Encoding utf8
} catch {
    $_.Exception.Message | Out-File -FilePath '${resultFilePath.replace(/\\/g, '\\\\')}' -Encoding utf8
    exit 1
}`;

                    require('fs').writeFileSync(psScriptPath, psScript, 'utf8');
                    try { require('fs').unlinkSync(resultFilePath); } catch (_) { }
                    const elevateCmd = `powershell -Command "Start-Process -Verb RunAs -Wait -FilePath 'powershell' -ArgumentList '-NoProfile -ExecutionPolicy Bypass -File \\"${psScriptPath}\\"' "`;
                    try {
                        execSync(elevateCmd, { stdio: 'pipe', timeout: 30000 });
                    } catch (e) {
                        return false;
                    }
                    let result = null;
                    if (require('fs').existsSync(resultFilePath)) {
                        result = require('fs').readFileSync(resultFilePath, 'utf8').trim();
                        require('fs').unlinkSync(resultFilePath);
                    }
                    return result === 'STOPPED' || result === 'STARTED';
                };

                // Stop service + WSL
                ctx.log('Force stopping Docker Engine (service + WSL)...', '\x1b[33m');
                const stopped = runElevatedAction('stop');
                if (!stopped) {
                    ctx.log('❌ Failed to stop Docker Engine (UAC declined or command failed).', '\x1b[31m');
                    try { require('fs').unlinkSync(psScriptPath); } catch (_) { }
                    await ctx.pause();
                    return;
                }

                // Confirm engine is down
                ctx.log('Checking if Docker Engine is stopped...', '\x1b[33m');
                try {
                    execSync('docker ps', { stdio: 'pipe', timeout: 5000 });
                    ctx.log('⚠ Docker Engine still responding unexpectedly.', '\x1b[33m');
                } catch (_) {
                    ctx.log('Docker Engine confirmed stopped.', '\x1b[32m');
                }

                // ---- 3. Start the service ----
                ctx.log('Starting Docker Desktop Service...', '\x1b[33m');
                const started = runElevatedAction('start');
                try { require('fs').unlinkSync(psScriptPath); } catch (_) { }
                if (!started) {
                    ctx.log('❌ Failed to start Docker Engine.', '\x1b[31m');
                    await ctx.pause();
                    return;
                }

                // ---- 4. Wait for engine to become responsive ----
                ctx.log('Waiting for Docker Engine to become responsive...', '\x1b[33m');
                let engineReady = false;
                for (let attempt = 1; attempt <= 12; attempt++) {
                    ctx.log(`  Attempt ${attempt}...`, '\x1b[36m');
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
                    ctx.log('✅ Docker Engine restarted and is ready.', '\x1b[32m');
                } else {
                    ctx.log('❌ Docker Engine did not become ready within 60 seconds.', '\x1b[31m');
                    ctx.log('   Try option 1.7 (Restart Docker Desktop) for a full restart.', '\x1b[33m');
                }
            } else if (os.platform() === 'darwin') {
                ctx.sh('pkill -f "com.docker.hyperkit"');
                ctx.sh('open -a Docker Desktop');
            } else {
                ctx.sh('systemctl restart docker');
            }
        } else {
            ctx.log('Restart cancelled.', '\x1b[33m');
        }
        await ctx.pause();
    }
};