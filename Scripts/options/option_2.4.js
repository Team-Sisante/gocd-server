module.exports = async function (helpers) {
  const { ctx } = helpers;
  const handler = require('../menu/cancelPipeline');
  if (typeof handler === 'function') {
    await handler(ctx);
  } else if (typeof handler["cancelPipeline"] === 'function') {
    await handler["cancelPipeline"](ctx);
  } else {
    console.error('Unknown handler for option 2.4');
  }
};