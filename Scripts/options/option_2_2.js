module.exports = async function (helpers) {
  const { ctx } = helpers;
  const handler = require('../menu/pipelineManagement');
  if (typeof handler === 'function') {
    await handler(ctx);
  } else if (typeof handler["2.2"] === 'function') {
    await handler["2.2"](ctx);
  } else {
    console.error('Unknown handler for option 2.2');
  }
};