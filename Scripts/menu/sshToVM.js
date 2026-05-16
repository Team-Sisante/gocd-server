// menu/sshToVM.js
// Opens an interactive SSH session to the deployment VM

module.exports = async function sshToVM(ctx) {
    ctx.log(`Connecting to ${ctx.SSH_USER}@${ctx.VM_IP} … (type exit to return)`, '\x1b[33m');
    ctx.sh(`ssh -i "${ctx.SSH_KEY_PATH}" -o StrictHostKeyChecking=no ${ctx.SSH_USER}@${ctx.VM_IP}`);
    // No pause needed – the SSH session handles its own exit
};