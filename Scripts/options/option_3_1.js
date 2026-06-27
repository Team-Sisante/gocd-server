module.exports = async function (helpers) {
  const { ctx } = helpers;
  const handler = require('../menu/pipelineManagement');
  if (typeof handler === 'function') {
    await handler(ctx);
  } else if (typeof handler["3.1"] === 'function') {
    await handler["3.1"](ctx);
  } else {
    console.error('Unknown handler for option 3.1');
  }
};