const fs = require('fs');
const path = require('path');

const handlers = require('./option_handlers.json');
const optionsDir = path.join(__dirname, 'options');
if (!fs.existsSync(optionsDir)) fs.mkdirSync(optionsDir, { recursive: true });

for (const [id, handler] of Object.entries(handlers)) {
  const moduleName = handler.module;
  const funcName = handler.func;
  const content = `
module.exports = async function (helpers) {
  const { ctx } = helpers;
  const handler = require('../menu/${moduleName}');
  if (typeof handler === 'function') {
    await handler(ctx);
  } else if (typeof handler[${JSON.stringify(funcName)}] === 'function') {
    await handler[${JSON.stringify(funcName)}](ctx);
  } else {
    console.error('Unknown handler for option ${id}');
  }
};
`;
  const filePath = path.join(optionsDir, `option_${id}.js`);
  fs.writeFileSync(filePath, content.trim());
  console.log(`Generated: ${filePath}`);
}