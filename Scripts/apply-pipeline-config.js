#!/usr/bin/env node
/**
 * Scripts/apply-pipeline-config.js
 * Copies the local cruise-config.xml into the GoCD container and
 * restarts the server so the new configuration takes effect.
 *
 * 🔴 HARD RULE: Every process MUST display real‑time progress.
 *    Never suppress output or leave the screen frozen.
 *    Always show live elapsed time where appropriate.
 *
 * Usage:
 *   node Scripts/apply-pipeline-config.js
 */

const { execSync } = require('child_process');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'config', 'cruise-config.xml');
const CONTAINER_DEST = '/godata/config/cruise-config.xml';

const scriptStart = Date.now();
const elapsed = () => Math.floor((Date.now() - scriptStart) / 1000) + 's';

console.log(`\x1b[33m[${elapsed()}] Copying updated cruise-config.xml into GoCD container…\x1b[0m`);
try {
    execSync(`docker cp "${CONFIG_PATH}" gocd-server:${CONTAINER_DEST}`, { stdio: 'inherit' });
    console.log(`\x1b[32m[${elapsed()}] ✅ XML copied.\x1b[0m`);
} catch (e) {
    console.error(`\x1b[31m[${elapsed()}] Failed to copy XML into container:\x1b[0m`, e.message);
    process.exit(1);
}

console.log(`\x1b[33m[${elapsed()}] Restarting GoCD server…\x1b[0m`);
try {
    execSync('docker restart gocd-server', { stdio: 'inherit' });
    console.log(`\x1b[32m[${elapsed()}] ✅ GoCD server restarted. Pipeline configuration applied.\x1b[0m`);
} catch (e) {
    console.error(`\x1b[31m[${elapsed()}] Failed to restart GoCD:\x1b[0m`, e.message);
    process.exit(1);
}