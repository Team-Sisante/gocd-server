module.exports = async function (helpers) {
  const { ctx } = helpers;
  const handler = require('../menu/containerManagement');
  if (typeof handler === 'function') {
    await handler(ctx);
  } else if (typeof handler["1.7"] === 'function') {
    await handler["1.7"](ctx);
  } else {
    console.error('Unknown handler for option 1.7');
  }
};