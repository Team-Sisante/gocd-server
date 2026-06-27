module.exports = async function (helpers) {
  const { ctx } = helpers;
  const handler = require('../menu/containerLogs');
  if (typeof handler === 'function') {
    await handler(ctx);
  } else if (typeof handler["selectContainerAndAct"] === 'function') {
    await handler["selectContainerAndAct"](ctx);
  } else {
    console.error('Unknown handler for option 1.10');
  }
};