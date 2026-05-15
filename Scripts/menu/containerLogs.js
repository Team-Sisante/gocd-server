// menu/containerLogs.js
// Interactive container selector (option 1.9)

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

async function selectContainerAndAct(ctx) {
    const { log, ask, pause } = ctx;
    let containers = [];
    try {
        const raw = execSync('docker ps -a --format "{{.Names}}"', { encoding: 'utf8', stdio: ['pipe','pipe','pipe'] });
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
        type: 'list', name: 'chosenContainer', message: 'Select a container:', choices: containers, pageSize: 15
    });
    const { action } = await inquirer.prompt({
        type: 'list', name: 'action', message: `What to do with ${chosenContainer}?`,
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
        console.log(`\x1b[33mLive error follow for ${chosenContainer}. Press Ctrl+C to stop.\x1b[0m`);
        await liveErrorFollow(chosenContainer, ctx);
        return;
    }

    console.log(`\x1b[33mFetching ${action === 'logs' ? 'logs' : 'errors'}...\x1b[0m`);
    try {
        const tailArg = action === 'logs' ? '--tail 20' : '--tail 500';
        const rawLogs = execSync(`docker logs ${tailArg} ${chosenContainer}`, { encoding: 'utf8', stdio: ['pipe','pipe','pipe'] });
        const lines = rawLogs.split('\n');

        if (action === 'logs') {
            lines.forEach(line => console.log(line));
        } else {
            // Static error view (deduplicated block logic)
            const keywords = /(error|fail|fatal|exception|denied|caused\s+by|invalid)/i;
            const contextBefore = 5, contextAfter = 15;
            const matches = [];
            lines.forEach((line, idx) => { if (keywords.test(line)) matches.push(idx); });
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
                    if (!first) console.log('\x1b[90m' + '─'.repeat(60) + '\x1b[0m');
                    first = false;
                    slice.forEach(line => {
                        if (keywords.test(line)) console.log('\x1b[31m' + line + '\x1b[0m');
                        else console.log(line);
                    });
                    console.log('');
                });
            }
        }
    } catch (e) {
        console.log(`\x1b[31mFailed to get logs: ${e.stderr || e.message}\x1b[0m`);
    }
}

// Live error follow
function liveErrorFollow(containerName, ctx) {
    return new Promise((resolve) => {
        const seenLines = new Set();
        const logFilePath = path.join(process.cwd(), `error-live-${containerName}.log`);
        try { fs.mkdirSync(process.cwd(), { recursive: true }); } catch (e) {}
        fs.writeFileSync(logFilePath, '', 'utf8');
        console.log(`\x1b[33mErrors will be written to: ${logFilePath}\x1b[0m`);

        let proc = null, rl = null, watching = true;
        function stripTimestamp(line) { return line.replace(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2},\d{3}\s*/, '').trim(); }
        function isStrictError(line) {
            if (/^(ERROR|FATAL)\s/.test(line)) return true;
            if (/wrapper stopped|gosu exited|exited with code|There are errors|^Caused by:/i.test(line)) return true;
            return false;
        }

        function startFollow() {
            const { spawn } = require('child_process');
            const readline = require('readline');
            proc = spawn('docker', ['logs', '-f', '--tail', '100', containerName], { stdio: ['ignore', 'pipe', 'pipe'] });
            rl = readline.createInterface({ input: proc.stdout });
            rl.on('line', (line) => {
                const cleanLine = stripTimestamp(line);
                if (!isStrictError(cleanLine)) return;
                if (!seenLines.has(cleanLine)) {
                    seenLines.add(cleanLine);
                    console.log(cleanLine);
                    try { fs.appendFileSync(logFilePath, cleanLine + '\n', 'utf8'); } catch (e) {
                        console.error(`\x1b[31mFailed to write to log file: ${e.message}\x1b[0m`);
                    }
                }
            });
            proc.stderr.on('data', (data) => console.error(`\x1b[31mDocker logs error: ${data.toString()}\x1b[0m`));
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

module.exports = { selectContainerAndAct };