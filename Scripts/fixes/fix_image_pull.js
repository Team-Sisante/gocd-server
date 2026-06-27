//Scripts/fixes/fix_image_pull.js

module.exports = async function(site, env, helpers) {
  console.log(`   → Fix: Pulling images for ${site.name}`);
  return await helpers.ensureImagesExist(site, env);
};