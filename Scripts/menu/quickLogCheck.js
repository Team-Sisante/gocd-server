// menu/quickLogCheck.js
// Lightweight container log check – shows a short tail, never hangs

const interactive = require('./interactiveContainerAction');

module.exports = async function quickLogCheck(ctx) {
    await interactive(ctx, {
        commandTemplate: 'docker logs --tail 20 {container}',
        message: 'Select a container for quick log check:',
        errorMessage: '❌ Could not view logs.'
    });
};