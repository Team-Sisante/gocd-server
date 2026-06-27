module.exports = async function (helpers) {
  const { ctx } = helpers;
  const handler = require('../menu/monitorCert');
  if (typeof handler === 'function') {
    await handler(ctx);
  } else if (typeof handler["monitorCert"] === 'function') {
    await handler["monitorCert"](ctx);
  } else {
    console.error('Unknown handler for option 6.34');
  }
};