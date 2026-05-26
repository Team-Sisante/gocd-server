// menu/sshToVM.js
// Opens an interactive SSH session to the deployment VM

const { spawn } = require('child_process');

module.exports = async function sshToVM(ctx) {
    ctx.log(`Connecting to ${ctx.SSH_USER}@${ctx.VM_IP} … (type exit to return)`, '\x1b[33m');
    
    return new Promise((resolve, reject) => {
        const ssh = spawn('ssh', [
            '-i', ctx.SSH_KEY_PATH,
            '-o', 'StrictHostKeyChecking=no',
            `${ctx.SSH_USER}@${ctx.VM_IP}`
        ], {
            stdio: 'inherit' // Connects SSH directly to your terminal
        });

        ssh.on('close', async (code) => {
            if (code !== 0) {
                ctx.log(`SSH session closed with error code ${code}`, '\x1b[31m');
                await ctx.pause();
            } else {
                ctx.log(`SSH session closed with code ${code}`, '\x1b[36m');
            }
            resolve();
        });

        ssh.on('error', async (err) => {
            ctx.log(`SSH session error: ${err.message}`, '\x1b[31m');
            await ctx.pause();
            reject(err);
        });
    });
};
