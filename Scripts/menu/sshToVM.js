// menu/sshToVM.js
// Opens an interactive SSH session to the deployment VM

const { spawn } = require('child_process');

module.exports = async function sshToVM(ctx) {
    ctx.log(`Connecting to ${ctx.SSH_USER}@${ctx.VM_IP} … (type exit to return)`, '\x1b[33m');

    // Pause the menu's readline so it stops competing with SSH for stdin
    if (ctx.rl) {
        ctx.rl.pause();
        ctx.rl.terminal = false;
    }
    
    return new Promise((resolve, reject) => {
        const ssh = spawn('ssh', [
            '-tt',
            '-i', ctx.SSH_KEY_PATH,
            '-o', 'StrictHostKeyChecking=no',
            '-o', 'UserKnownHostsFile=/dev/null',
            '-o', 'ServerAliveInterval=15',
            '-o', 'ServerAliveCountMax=3',
            '-o', 'ConnectTimeout=10',
            '-o', 'LogLevel=ERROR',
            `${ctx.SSH_USER}@${ctx.VM_IP}`
        ], {
            stdio: 'inherit',
            env: { ...process.env, TERM: process.env.TERM || 'xterm-256color' }
        });

        ssh.on('close', async (code) => {
            // Re-enable readline for the menu
            if (ctx.rl) {
                ctx.rl.terminal = true;
                ctx.rl.resume();
            }

            if (code !== 0) {
                ctx.log(`SSH session closed with error code ${code}`, '\x1b[31m');
                await ctx.pause();
            } else {
                ctx.log(`SSH session closed with code ${code}`, '\x1b[36m');
            }
            resolve();
        });

        ssh.on('error', async (err) => {
            if (ctx.rl) {
                ctx.rl.terminal = true;
                ctx.rl.resume();
            }
            ctx.log(`SSH session error: ${err.message}`, '\x1b[31m');
            await ctx.pause();
            reject(err);
        });
    });
};
