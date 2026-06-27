// Scripts/fixes/fix_nginx_restart.js

module.exports = async function(site, env, helpers) {
  console.log(`   → Fix: Restarting Nginx ${site.nginxContainer}`);
  if (site.nginxContainer) {
    return await helpers.repairNginx(site.nginxContainer);
  }
  console.log(`   → No Nginx container defined for ${site.name}`);
  return true;
};