// Scripts/menu/activeProxyCert.js
module.exports = async function activeProxyCert(ctx) {
  const { execSync, log, pause } = ctx;
  const PROJECT_ID = process.env.GCP_PROJECT_ID;
  const proxyName = process.env.HUMRINE_HTTPS_PROXY_NAME || 'humrine-https-proxy';

  if (!PROJECT_ID) {
    log('ERROR: GCP_PROJECT_ID not set.', '\x1b[31m');
    await pause();
    return;
  }

  try {
    const output = execSync(
      `gcloud compute target-https-proxies describe ${proxyName} --global --project=${PROJECT_ID} --format="value(sslCertificates)"`,
      { encoding: 'utf8', stdio: 'pipe' }
    ).trim();

    if (!output) {
      log(`No certificate attached to ${proxyName}.`, '\x1b[33m');
    } else {
      const certName = output.split('/').pop();
      console.log(`\n\x1b[32mActive certificate: ${certName}\x1b[0m`);
    }
  } catch (e) {
    log(`Failed to describe proxy ${proxyName}. It may not exist.`, '\x1b[31m');
  }

  await pause();
};