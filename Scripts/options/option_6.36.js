module.exports = async function (helpers) {
  const { ctx } = helpers;
  const handler = require('../menu/certDomainStatus');
  if (typeof handler === 'function') {
    await handler(ctx);
  } else if (typeof handler["certDomainStatus"] === 'function') {
    await handler["certDomainStatus"](ctx);
  } else {
    console.error('Unknown handler for option 6.36');
  }
};