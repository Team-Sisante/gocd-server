// menu/sshTunnelGoCD.js
// Creates a reverse SSH tunnel so the local GoCD web interface is accessible
// through the GCP VM at https://<VM_IP>:8153 (or the configured port).

const { spawn } = require('child_process');

module.exports = async function sshTunnelGoCD(ctx) {
    const localPort = ctx.GOCD_PORT || '8153';
    const remotePort = localPort;

    ctx.log(`Creating SSH tunnel: localhost:${localPort} → ${ctx.VM_IP}:${remotePort}`, '\x1b[33m');
    ctx.log(`GoCD will be accessible at http://${ctx.VM_IP}:${remotePort}`, '\x1b[36m');
    ctx.log('Press Ctrl+C to stop the tunnel and return to the menu.\n', '\x1b[33m');

    // Pause readline so it doesn't interfere with the SSH process
    if (ctx.rl) {
        ctx.rl.pause();
        ctx.rl.terminal = false;
    }

    return new Promise((resolve) => {
        const ssh = spawn('ssh', [
            '-i', ctx.SSH_KEY_PATH,
            '-o', 'StrictHostKeyChecking=no',
            '-o', 'UserKnownHostsFile=/dev/null',
            '-o', 'ServerAliveInterval=15',
            '-o', 'ServerAliveCountMax=3',
            '-o', 'ConnectTimeout=10',
            '-o', 'LogLevel=ERROR',
            '-o', 'ExitOnForwardFailure=yes',
            '-N',
            '-R', `0.0.0.0:${remotePort}:localhost:${localPort}`,
            `${ctx.SSH_USER}@${ctx.VM_IP}`
        ], {
            stdio: 'inherit',
            env: { ...process.env, TERM: process.env.TERM || 'xterm-256color' }
        });

        ssh.on('close', async (code) => {
            if (ctx.rl) {
                ctx.rl.terminal = true;
                ctx.rl.resume();
            }

            if (code !== 0 && code !== null) {
                ctx.log(`SSH tunnel closed with error code ${code}`, '\x1b[31m');
                ctx.log('Tip: Ensure GatewayPorts is enabled on the VM\'s sshd_config.', '\x1b[33m');
                ctx.log('Run on the VM: sudo sed -i "s/#GatewayPorts no/GatewayPorts yes/" /etc/ssh/sshd_config && sudo systemctl restart sshd', '\x1b[33m');
            } else {
                ctx.log('SSH tunnel closed.', '\x1b[36m');
            }
            await ctx.pause();
            resolve();
        });

        ssh.on('error', async (err) => {
            if (ctx.rl) {
                ctx.rl.terminal = true;
                ctx.rl.resume();
            }
            ctx.log(`SSH tunnel error: ${err.message}`, '\x1b[31m');
            await ctx.pause();
            resolve();
        });
    });
};
