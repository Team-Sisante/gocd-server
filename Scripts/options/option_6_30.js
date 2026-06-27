module.exports = async function (helpers) {
  const { ctx } = helpers;
  const handler = require('../menu/vmSetup');
  if (typeof handler === 'function') {
    await handler(ctx);
  } else if (typeof handler["6.30"] === 'function') {
    await handler["6.30"](ctx);
  } else {
    console.error('Unknown handler for option 6.30');
  }
};