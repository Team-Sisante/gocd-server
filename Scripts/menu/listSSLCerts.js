// Scripts/menu/listSSLCerts.js
module.exports = async function listSSLCerts(ctx) {
  const { sh, log, ask, pause, PROJECT_ROOT } = ctx;
  const PROJECT_ID = process.env.GCP_PROJECT_ID;
  if (!PROJECT_ID) {
    log('ERROR: GCP_PROJECT_ID not set in environment.', '\x1b[31m');
    await pause();
    return;
  }

  log('Fetching SSL certificates...', '\x1b[36m');

  // Get all SSL certs in the project (global)
  const listCmd = `gcloud compute ssl-certificates list --global --project=${PROJECT_ID} --format="json"`;
  let certs;
  try {
    const raw = sh(listCmd, { stdio: 'pipe', silent: true });
    certs = JSON.parse(raw);
  } catch (e) {
    log('Failed to retrieve certificates. Check gcloud auth and project.', '\x1b[31m');
    await pause();
    return;
  }

  if (!certs || certs.length === 0) {
    log('No SSL certificates found.', '\x1b[33m');
    await pause();
    return;
  }

  // Get current proxy attachment (if any)
  const proxyName = process.env.HUMRINE_HTTPS_PROXY_NAME || 'humrine-https-proxy';
  let attachedCerts = [];
  try {
    const proxyDesc = sh(
      `gcloud compute target-https-proxies describe ${proxyName} --global --project=${PROJECT_ID} --format="value(sslCertificates)"`,
      { stdio: 'pipe', silent: true }
    );
    if (proxyDesc) {
      attachedCerts = proxyDesc.split(';').map(url => {
        const parts = url.split('/');
        return parts[parts.length - 1];
      });
    }
  } catch (e) { /* proxy may not exist */ }

  console.log('\n\x1b[36mSSL Certificates:\x1b[0m');
  certs.forEach(cert => {
    const name = cert.name;
    const type = cert.type; // MANAGED / SELF_MANAGED
    const status = cert.managed?.status || 'N/A';
    const domains = cert.managed?.domains || (cert.subjectAlternativeNames || []).join(', ') || 'N/A';
    const attached = attachedCerts.includes(name) ? '✅ IN USE' : '';

    console.log(`\n\x1b[33mName:\x1b[0m ${name}`);
    console.log(`  \x1b[33mType:\x1b[0m ${type}`);
    console.log(`  \x1b[33mStatus:\x1b[0m ${status}`);
    console.log(`  \x1b[33mDomains:\x1b[0m ${domains}`);
    if (attached) console.log(`  \x1b[32m${attached}\x1b[0m`);
  });

  log('Done.', '\x1b[32m');
  await pause();
};