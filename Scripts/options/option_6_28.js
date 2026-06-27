module.exports = async function (helpers) {
  const { ctx } = helpers;
  const handler = require('../menu/vmSetup');
  if (typeof handler === 'function') {
    await handler(ctx);
  } else if (typeof handler["6.28"] === 'function') {
    await handler["6.28"](ctx);
  } else {
    console.error('Unknown handler for option 6.28');
  }
};