// Scripts/menu/showHostRules.js
module.exports = async function showHostRules(ctx) {
  const { execSync, log, pause } = ctx;
  const PROJECT_ID = process.env.GCP_PROJECT_ID;
  const lbName = process.env.HUMRINE_LB_NAME || 'humrine-main-lb';
  try {
    const output = execSync(
      `gcloud compute url-maps describe ${lbName} --global --project=${PROJECT_ID} --format="yaml(hostRules)"`,
      { encoding: 'utf8', stdio: 'pipe' }
    );
    console.log('\x1b[36mCurrent host rules for ' + lbName + ':\x1b[0m\n' + output);
  } catch (e) {
    log('Failed to fetch host rules.', '\x1b[31m');
  }
  await pause();
};