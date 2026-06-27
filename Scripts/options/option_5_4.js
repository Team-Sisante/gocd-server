module.exports = async function (helpers) {
  const { ctx } = helpers;
  const handler = require('../menu/dockerTroubleshoot');
  if (typeof handler === 'function') {
    await handler(ctx);
  } else if (typeof handler["5.4"] === 'function') {
    await handler["5.4"](ctx);
  } else {
    console.error('Unknown handler for option 5.4');
  }
};