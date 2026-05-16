// menu/restartService.js
// Interactive container restart for the remote VM

const interactive = require('./interactiveContainerAction');

module.exports = async function restartService(ctx) {
    await interactive(ctx, {
        commandTemplate: 'docker restart {container}',
        message: 'Select a container to restart:',
        successMessage: '{container} restarted.',
        errorMessage: '❌ Failed to list containers or restart service.'
    });
};