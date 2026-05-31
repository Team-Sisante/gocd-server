// Scripts/menu/monitorCert.js
module.exports = async function monitorCert(ctx) {
  const { sh, log, ask, pause, execSync } = ctx;
  const PROJECT_ID = process.env.GCP_PROJECT_ID;
  if (!PROJECT_ID) {
    log('ERROR: GCP_PROJECT_ID not set in environment.', '\x1b[31m');
    await pause();
    return;
  }

  // 1. Fetch all certificates
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
    log('No certificates found.', '\x1b[33m');
    await pause();
    return;
  }

  // 2. Show list and ask user to pick one
  console.log('\n\x1b[36mAvailable certificates:\x1b[0m');
  certs.forEach((cert, i) => {
    console.log(`  [${i + 1}] ${cert.name} (${cert.managed?.status || 'UNKNOWN'})`);
  });

  const choice = await ask('Enter the number of the certificate to monitor: ');
  const idx = parseInt(choice, 10) - 1;
  if (isNaN(idx) || idx < 0 || idx >= certs.length) {
    log('Invalid selection.', '\x1b[31m');
    await pause();
    return;
  }

  const selected = certs[idx];
  const certName = selected.name;

  // 3. Start monitoring
  log(`\nMonitoring certificate "${certName}"…`, '\x1b[33m');
  log('Press Ctrl+C to stop.\n');

  const startTime = Date.now();
  let lastStatus = null;

  while (true) {
    // Fetch current status
    let status;
    try {
      const result = execSync(
        `gcloud compute ssl-certificates describe ${certName} --global --project=${PROJECT_ID} --format="value(managed.status)"`,
        { encoding: 'utf8', stdio: 'pipe' }
      ).trim();
      status = result || 'UNKNOWN';
    } catch (e) {
      log(`\nFailed to fetch status for ${certName}. Maybe it was deleted?`, '\x1b[31m');
      break;
    }

    // Show progress only when status changes or every 10 seconds
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    const mins = Math.floor(elapsed / 60);
    const secs = elapsed % 60;
    const elapsedStr = `${mins}m ${secs}s`;

    if (status !== lastStatus) {
      console.log(`\x1b[36m[${elapsedStr}] Status: ${status}\x1b[0m`);
      lastStatus = status;
    } else if (elapsed % 10 === 0) {
      process.stdout.write(`\r\x1b[36m[${elapsedStr}] Still waiting... (status: ${status})\x1b[0m`);
    }

    if (status === 'ACTIVE') {
      console.log(`\n\x1b[32m[${elapsedStr}] Certificate is ACTIVE!\x1b[0m`);
      break;
    }

    if (status === 'FAILED_NOT_VISIBLE' || status === 'FAILED') {
      console.log(`\n\x1b[31m[${elapsedStr}] Certificate provisioning failed: ${status}\x1b[0m`);
      console.log('You may need to check DNS records or recreate the certificate.');
      break;
    }

    // Wait 5 seconds before next check
    await new Promise(resolve => setTimeout(resolve, 5000));
  }

  console.log('\n\x1b[36mMonitoring complete.\x1b[0m');
  await pause();
};