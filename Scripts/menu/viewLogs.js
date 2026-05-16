// menu/viewLogs.js
// Interactive container log viewer – asks user for follow mode, then delegates

const interactive = require('./interactiveContainerAction');

module.exports = async function viewLogs(ctx) {
    // Ask which mode the user wants
    const inquirer = (await import('inquirer')).default;
    const { mode } = await inquirer.prompt({
        type: 'list',
        name: 'mode',
        message: 'Log viewing mode:',
        choices: [
            { name: 'Continuous (follow mode – press Ctrl+C to stop)', value: 'follow' },
            { name: 'One‑shot (last 50 lines, then return)', value: 'tail' }
        ],
        default: 'follow'
    });

    const commandTemplate = mode === 'follow'
        ? 'docker logs -f --tail 50 {container}'
        : 'docker logs --tail 50 {container}';

    await interactive(ctx, {
        commandTemplate,
        message: `Select a container to view logs (${mode === 'follow' ? 'follow' : 'one‑shot'}):`,
        errorMessage: '❌ Failed to list containers or view logs.'
    });
};