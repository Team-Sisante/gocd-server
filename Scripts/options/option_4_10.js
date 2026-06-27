// Scripts/options/option_4.10.js

module.exports = async function (helpers) {
  const { ctx } = helpers;
  const fs = require('fs');
  const path = require('path');

  // Read the current password from inside the GoCD container
  const rawPass = ctx.sh(
    `docker exec gocd-server cat /godata/config/password.properties`,
    { stdio: 'pipe' }
  );

  // sh returns the output string on success, or an error object on failure
  if (typeof rawPass === 'string' && rawPass.includes(':')) {
    const newPassword = rawPass.trim().split(':')[1]; // admin:password
    const envPath = path.join(__dirname, '..', '..', '.env.docker');
    let envContent = fs.readFileSync(envPath, 'utf8');
    envContent = envContent.replace(
      /^GOCD_ADMIN_PASSWORD=.*/m,
      `GOCD_ADMIN_PASSWORD=${newPassword}`
    );
    fs.writeFileSync(envPath, envContent);
    ctx.log('✅ .env.docker updated with password from container.', '\x1b[32m');
  } else {
    ctx.log('❌ Could not retrieve password from container.', '\x1b[31m');
  }

  await ctx.pause();
};