module.exports = async function (helpers) {
  const { ctx } = helpers;
  const handler = require('../menu/deleteSSLCert');
  if (typeof handler === 'function') {
    await handler(ctx);
  } else if (typeof handler["deleteSSLCert"] === 'function') {
    await handler["deleteSSLCert"](ctx);
  } else {
    console.error('Unknown handler for option 6.33');
  }
};