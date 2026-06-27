module.exports = async function (helpers) {
  const { ctx } = helpers;
  const handler = require('../menu/systemUtilities');
  if (typeof handler === 'function') {
    await handler(ctx);
  } else if (typeof handler["4.9"] === 'function') {
    await handler["4.9"](ctx);
  } else {
    console.error('Unknown handler for option 4.9');
  }
};