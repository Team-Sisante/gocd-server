#!/usr/bin/env node
/**
 * Scripts/validate.js
 * 
 * Simple cross-platform validation script for GoCD environment.
 */

const { execSync } = require('child_process');

function log(msg, color = '\x1b[36m') {
    console.log(`${color}%s\x1b[0m`, `[validate.js] ${msg}`);
}

function sh(cmd) {
    try {
        return execSync(cmd, { encoding: 'utf8', stdio: 'pipe' }).trim();
    } catch (e) {
        return '';
    }
}

function check() {
    log('Validating GoCD Environment...');

    const containers = [
        'gocd-server',
        'gocd-agent-1',
        'gocd-agent-2',
        'gocd-agent-3'
    ];

    containers.forEach(name => {
        const status = sh(`docker inspect -f "{{.State.Status}}" ${name}`);
        if (status === 'running') {
            console.log(`\x1b[32m✓ ${name} is running.\x1b[0m`);
        } else {
            console.log(`\x1b[31m✗ ${name} is NOT running (Status: ${status || 'not found'}).\x1b[0m`);
        }
    });

    const health = sh('curl -s -o /dev/null -w "%{http_code}" http://localhost:8153/go/api/v1/health');
    if (health === '200') {
        console.log('\x1b[32m✓ GoCD Server API is healthy.\x1b[0m');
    } else {
        console.log(`\x1b[31m✗ GoCD Server API health check failed (HTTP ${health || 'unknown'}).\x1b[0m`);
    }
}

check();
