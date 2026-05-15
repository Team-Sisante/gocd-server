#!/usr/bin/env node
/**
 * Scripts/apply-pipeline-config.js
 * Copies the local cruise-config.xml into the GoCD container and
 * restarts the server so the new configuration takes effect.
 *
 * Usage:
 *   node Scripts/apply-pipeline-config.js
 */

const { execSync } = require('child_process');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'config', 'cruise-config.xml');
const CONTAINER_DEST = '/godata/config/cruise-config.xml';

console.log('Copying updated cruise-config.xml into GoCD container…');
try {
    execSync(`docker cp "${CONFIG_PATH}" gocd-server:${CONTAINER_DEST}`, { stdio: 'inherit' });
    console.log('✅ XML copied.');
} catch (e) {
    console.error('\x1b[31mFailed to copy XML into container:\x1b[0m', e.message);
    process.exit(1);
}

console.log('Restarting GoCD server…');
try {
    execSync('docker restart gocd-server', { stdio: 'inherit' });
    console.log('✅ GoCD server restarted. Pipeline configuration applied.');
} catch (e) {
    console.error('\x1b[31mFailed to restart GoCD:\x1b[0m', e.message);
    process.exit(1);
}