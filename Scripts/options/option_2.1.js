module.exports = async function (helpers) {
  const { ctx } = helpers;
  const handler = require('../menu/triggerPipeline');
  if (typeof handler === 'function') {
    await handler(ctx);
  } else if (typeof handler["triggerPipeline"] === 'function') {
    await handler["triggerPipeline"](ctx);
  } else {
    console.error('Unknown handler for option 2.1');
  }
};