// Scripts/menu/deleteSSLCert.js
module.exports = async function deleteSSLCert(ctx) {
  const { sh, log, ask, pause, execSync } = ctx;
  const PROJECT_ID = process.env.GCP_PROJECT_ID;
  if (!PROJECT_ID) {
    log('ERROR: GCP_PROJECT_ID not set in environment.', '\x1b[31m');
    await pause();
    return;
  }

  // Fetch all SSL certificates
  let certs = [];
  try {
    const raw = execSync(
      `gcloud compute ssl-certificates list --global --project=${PROJECT_ID} --format="json"`,
      { encoding: 'utf8', stdio: 'pipe' }
    );
    certs = JSON.parse(raw);
  } catch (e) {
    log('Failed to fetch certificates.', '\x1b[31m');
    await pause();
    return;
  }

  if (!certs || certs.length === 0) {
    log('No certificates to delete.', '\x1b[33m');
    await pause();
    return;
  }

  // Show numbered list
  console.log('\n\x1b[36mAvailable certificates:\x1b[0m');
  certs.forEach((cert, i) => {
    console.log(`  [${i + 1}] ${cert.name} (${cert.managed?.status || 'UNKNOWN'})`);
  });

  // ------------------------------------------------------------------
  // Determine which certificates are attached to the HTTPS proxy
  // ------------------------------------------------------------------
  const proxyName = process.env.HUMRINE_HTTPS_PROXY_NAME || 'humrine-https-proxy';
  let attachedCerts = [];
  try {
    const out = execSync(
      `gcloud compute target-https-proxies describe ${proxyName} --global --project=${PROJECT_ID} --format="value(sslCertificates)"`,
      { encoding: 'utf8', stdio: 'pipe' }
    ).trim();
    if (out) {
      attachedCerts = out.split(';').map(url => {
        const parts = url.split('/');
        return parts[parts.length - 1];
      });
    }
  } catch (e) {
    log(`Warning: Could not fetch certificate list from proxy ${proxyName}. It may not exist.`, '\x1b[33m');
  }

  // ------------------------------------------------------------------
  // Helper: detach a certificate from the proxy and then delete it
  // ------------------------------------------------------------------
  async function detachAndDelete(certName) {
    if (!attachedCerts.includes(certName)) {
      // Not attached, just delete
      return deleteCert(certName);
    }

    const remaining = attachedCerts.filter(c => c !== certName);
    if (remaining.length === 0) {
      log(`Cannot detach ${certName}: it is the only certificate on the proxy. Add another certificate first.`, '\x1b[31m');
      return false;
    }

    log(`Detaching ${certName} from proxy ${proxyName}...`);
    const updateCmd = `gcloud compute target-https-proxies update ${proxyName} --global --project=${PROJECT_ID} --ssl-certificates=${remaining.join(',')}`;
    const updateRes = sh(updateCmd, { stdio: 'inherit', ignoreError: true });
    if (updateRes && updateRes.error) {
      log('Failed to detach certificate. Deletion aborted.', '\x1b[31m');
      return false;
    }

    // Update our local cache
    attachedCerts = remaining;
    log('Certificate detached. Now deleting...');
    return deleteCert(certName);
  }

  async function deleteCert(certName) {
    const delRes = sh(`gcloud compute ssl-certificates delete ${certName} --global --project=${PROJECT_ID} --quiet`, { stdio: 'inherit', ignoreError: true });
    if (delRes && delRes.error) {
      log(`Failed to delete ${certName}: ${delRes.error}`, '\x1b[31m');
      return false;
    }
    log(`Certificate ${certName} deleted.`, '\x1b[32m');
    return true;
  }

  // ------------------------------------------------------------------
  // Process user choice
  // ------------------------------------------------------------------
  const choice = await ask('Enter the number of the certificate to delete (or type "all" to delete all unused versioned certs): ');

  // "all" – delete all versioned certs that are not currently in use
  if (choice.toLowerCase() === 'all') {
    const versionedBase = process.env.HUMRINE_CERT_NAME || 'humrine-managed-cert';
    for (const cert of certs) {
      if (cert.name === versionedBase || cert.name.startsWith(versionedBase + '-v')) {
        if (attachedCerts.includes(cert.name)) {
          log(`Skipping ${cert.name} (currently attached to proxy).`, '\x1b[33m');
          continue;
        }
        const confirm = await ask(`Delete ${cert.name}? (y/N): `);
        if (confirm.toLowerCase() === 'y') {
          await deleteCert(cert.name);
        }
      }
    }
    log('Cleanup finished.', '\x1b[32m');
    await pause();
    return;
  }

  // Single certificate
  const idx = parseInt(choice, 10) - 1;
  if (isNaN(idx) || idx < 0 || idx >= certs.length) {
    log('Invalid selection.', '\x1b[31m');
    await pause();
    return;
  }

  const selected = certs[idx];

  // If attached, offer to detach first
  if (attachedCerts.includes(selected.name)) {
    log(`\x1b[31mWARNING: ${selected.name} is attached to proxy ${proxyName}.\x1b[0m`);
    const detachConfirm = await ask('Detach and delete? (y/N): ');
    if (detachConfirm.toLowerCase() !== 'y') {
      log('Deletion cancelled.', '\x1b[33m');
      await pause();
      return;
    }
    await detachAndDelete(selected.name);
  } else {
    const confirm = await ask(`Confirm deletion of ${selected.name}? (y/N): `);
    if (confirm.toLowerCase() !== 'y') {
      log('Deletion cancelled.', '\x1b[33m');
      await pause();
      return;
    }
    await deleteCert(selected.name);
  }

  await pause();
};