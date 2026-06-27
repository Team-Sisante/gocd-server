module.exports = async function (helpers) {
  const { ctx } = helpers;
  const handler = require('../menu/activeProxyCert');
  if (typeof handler === 'function') {
    await handler(ctx);
  } else if (typeof handler["activeProxyCert"] === 'function') {
    await handler["activeProxyCert"](ctx);
  } else {
    console.error('Unknown handler for option 6.35');
  }
};