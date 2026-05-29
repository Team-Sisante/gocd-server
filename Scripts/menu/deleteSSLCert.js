// Scripts/menu/deleteSSLCert.js
module.exports = async function deleteSSLCert(ctx) {
  const { sh, log, ask, pause } = ctx;
  const PROJECT_ID = process.env.GCP_PROJECT_ID;
  if (!PROJECT_ID) {
    log('ERROR: GCP_PROJECT_ID not set in environment.', '\x1b[31m');
    await pause();
    return;
  }

  // Fetch all certs
  const listCmd = `gcloud compute ssl-certificates list --global --project=${PROJECT_ID} --format="json"`;
  let certs;
  try {
    const raw = sh(listCmd, { stdio: 'pipe', silent: true });
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

  // Find which certs are attached to the active HTTPS proxy
  const proxyName = process.env.HUMRINE_HTTPS_PROXY_NAME || 'humrine-https-proxy';
  let attachedCerts = [];
  try {
    const proxyDesc = sh(
      `gcloud compute target-https-proxies describe ${proxyName} --global --project=${PROJECT_ID} --format="value(sslCertificates)"`,
      { stdio: 'pipe', silent: true }
    );
    if (proxyDesc) {
      attachedCerts = proxyDesc.split(';').map(url => url.split('/').pop());
    }
  } catch (e) { /* ignore */ }

  const choice = await ask('Enter the number of the certificate to delete (or type "all" to delete all unused versioned certs): ');

  if (choice.toLowerCase() === 'all') {
    // Delete all versioned certs except the one currently attached
    const versionedBase = process.env.HUMRINE_CERT_NAME || 'humrine-managed-cert';
    for (const cert of certs) {
      if (cert.name === versionedBase || cert.name.startsWith(versionedBase + '-v')) {
        if (attachedCerts.includes(cert.name)) {
          log(`Skipping ${cert.name} (currently attached to proxy).`, '\x1b[33m');
          continue;
        }
        const confirm = await ask(`Delete ${cert.name}? (y/N): `);
        if (confirm.toLowerCase() === 'y') {
          log(`Deleting ${cert.name}...`);
          sh(`gcloud compute ssl-certificates delete ${cert.name} --global --project=${PROJECT_ID} --quiet`, { stdio: 'inherit' });
        }
      }
    }
    log('Cleanup finished.', '\x1b[32m');
    await pause();
    return;
  }

  const idx = parseInt(choice, 10) - 1;
  if (isNaN(idx) || idx < 0 || idx >= certs.length) {
    log('Invalid selection.', '\x1b[31m');
    await pause();
    return;
  }

  const selected = certs[idx];
  if (attachedCerts.includes(selected.name)) {
    log(`\x1b[31mWARNING: Certificate ${selected.name} is currently attached to the HTTPS proxy.\x1b[0m`);
    const force = await ask('Are you absolutely sure you want to delete it? This will break your load balancer. (yes/N): ');
    if (force.toLowerCase() !== 'yes') {
      log('Deletion cancelled.', '\x1b[33m');
      await pause();
      return;
    }
  }

  const confirm = await ask(`Confirm deletion of ${selected.name}? (y/N): `);
  if (confirm.toLowerCase() !== 'y') {
    log('Deletion cancelled.');
    await pause();
    return;
  }

  log(`Deleting ${selected.name}...`);
  sh(`gcloud compute ssl-certificates delete ${selected.name} --global --project=${PROJECT_ID} --quiet`, { stdio: 'inherit' });
  log('Certificate deleted.', '\x1b[32m');
  await pause();
};