// menu/interactiveContainerAction.js
// Generic interactive container action – lists containers, lets user pick one,
// runs any specified command via SSH. Used by viewLogs, quickLogCheck, restartService.

const { listContainers } = require('./containerList');

module.exports = async function interactiveContainerAction(ctx, options = {}) {
    const {
        commandTemplate,      // required – e.g. 'docker logs --tail 20'
        message = 'Select a container:',
        successMessage = '',
        errorMessage = '❌ Action failed.',
        follow = false        // if true, command will be run with stdio 'inherit' for live follow
    } = options;

    if (!commandTemplate) throw new Error('commandTemplate is required');

    try {
        ctx.rl.pause();
        const inquirer = (await import('inquirer')).default;
        const containers = listContainers(ctx);
        if (containers.length === 0) {
            ctx.log('No containers found on VM.', '\x1b[33m');
            ctx.rl.resume();
            await ctx.pause();
            return;
        }
        const { service } = await inquirer.prompt({
            type: 'list',
            name: 'service',
            message,
            choices: containers
        });
        ctx.rl.resume();

        const remoteCmd = commandTemplate.replace(/\{container\}/g, service);
        ctx.sh(`ssh -i "${ctx.SSH_KEY_PATH}" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null ${ctx.SSH_USER}@${ctx.VM_IP} "${remoteCmd}"`);

        if (successMessage) ctx.log(successMessage.replace(/\{container\}/g, service), '\x1b[32m');
        await ctx.pause();
    } catch (e) {
        ctx.rl.resume();
        ctx.setErrorDisplayed(true);
        process.stdout.write('\x1Bc');
        ctx.log(errorMessage, '\x1b[31m');
        console.error(e.stderr || e.message);
        await ctx.ask('Press Enter to return to the menu...');
    }
};