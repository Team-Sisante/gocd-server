#!/usr/bin/env node
/**
 * Scripts/setup-load-balancer.js
 * Creates (or verifies) a GCP External Application Load Balancer
 * based on configuration in Scripts/loadbalancer.json.
 *
 * Usage:
 *   node Scripts/setup-load-balancer.js <app_name>
 *   e.g., node Scripts/setup-load-balancer.js humrine
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// ----- Load Configuration -----
const appName = process.argv[2];
if (!appName) {
  console.error('\x1b[31mERROR: Missing app name argument (e.g., humrine, badminton)\x1b[0m');
  process.exit(1);
}

const configPath = path.join(__dirname, 'loadbalancer.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

// Interpolate environment variables in config
function interpolate(obj) {
  for (const key in obj) {
    if (typeof obj[key] === 'string') {
      obj[key] = obj[key].replace(/\${(\w+)}/g, (_, varName) => process.env[varName] || '');
    } else if (typeof obj[key] === 'object' && obj[key] !== null) {
      interpolate(obj[key]);
    }
  }
}

interpolate(config);

if (!config[appName]) {
  console.error(`\x1b[31mERROR: Configuration for '${appName}' not found in loadbalancer.json\x1b[0m`);
  process.exit(1);
}

const conf = config[appName];

// ----- Required environment -----
const PROJECT_ID  = process.env.GCP_PROJECT_ID;
const GCP_ZONE    = process.env.GCP_ZONE;
const GCP_VM_NAME = process.env.GCP_VM_NAME;

if (!PROJECT_ID || !GCP_ZONE || !GCP_VM_NAME) {
  console.error('\x1b[31mERROR: Missing required env vars: GCP_PROJECT_ID, GCP_ZONE, GCP_VM_NAME\x1b[0m');
  process.exit(1);
}

// Production is the default backend (first one in the array for now, or could be specified)
const DEFAULT_BACKEND = conf.backends[conf.backends.length - 1].name;

// ----- Helpers -----
const scriptStart = Date.now();
const elapsed = () => Math.floor((Date.now() - scriptStart) / 1000) + 's';

function log(msg, color = '\x1b[36m') {
  console.log(`${color}[${elapsed()}] ${msg}\x1b[0m`);
}

function run(cmd, opts = {}) {
  const stdio = opts.silent ? 'pipe' : 'inherit';
  try {
    return (execSync(cmd, { encoding: 'utf8', stdio, ...opts }) || '').trim();
  } catch (e) {
    if (opts.ignoreError) return null;
    if (opts.silent) return null;
    console.error(`\x1b[31m[${elapsed()}] Command failed: ${cmd}\x1b[0m`);
    return null;
  }
}

function resourceExists(type, name, extra = '') {
  const cmd = `gcloud compute ${type} describe ${name} --project=${PROJECT_ID} ${extra} --format="value(name)"`;
  const result = run(cmd, { silent: true, ignoreError: true });
  return result && result.length > 0;
}

// ----- Step 1: Instance Group -----
function ensureInstanceGroup() {
  log('Step 1: Ensuring unmanaged instance group exists...', '\x1b[33m');

  const exists = run(
    `gcloud compute instance-groups unmanaged describe ${conf.instanceGroup} --zone=${GCP_ZONE} --project=${PROJECT_ID} --format="value(name)"`,
    { silent: true, ignoreError: true }
  );

  if (exists) {
    log(`Instance group ${conf.instanceGroup} already exists.`, '\x1b[32m');
  } else {
    log(`Creating instance group ${conf.instanceGroup}...`);
    run(`gcloud compute instance-groups unmanaged create ${conf.instanceGroup} --zone=${GCP_ZONE} --project=${PROJECT_ID}`);
    log(`Adding VM ${GCP_VM_NAME} to instance group...`);
    run(`gcloud compute instance-groups unmanaged add-instances ${conf.instanceGroup} --zone=${GCP_ZONE} --project=${PROJECT_ID} --instances=${GCP_VM_NAME}`);
    log(`Instance group ${conf.instanceGroup} created.`, '\x1b[32m');
  }

  // Set named ports
  const ports = conf.backends.map(b => `${b.namedPort}:${b.port}`).join(',');
  log(`Setting named ports: ${ports}`);
  run(`gcloud compute instance-groups unmanaged set-named-ports ${conf.instanceGroup} --zone=${GCP_ZONE} --project=${PROJECT_ID} --named-ports=${ports}`);
  log('Named ports configured.', '\x1b[32m');
}

// ----- Step 2: Health Checks -----
function ensureHealthChecks() {
  log('Step 2: Ensuring health checks exist...', '\x1b[33m');

  for (const b of conf.backends) {
    if (resourceExists('health-checks', b.healthCheck, '--global')) {
      log(`Health check ${b.healthCheck} already exists.`, '\x1b[32m');
    } else {
      log(`Creating health check ${b.healthCheck} (HTTPS port ${b.port})...`);
      run(`gcloud compute health-checks create https ${b.healthCheck} --project=${PROJECT_ID} --port=${b.port} --request-path=/ --global`);
      log(`Health check ${b.healthCheck} created.`, '\x1b[32m');
    }
  }
}

// ----- Step 3: Backend Services -----
function ensureBackendServices() {
  log('Step 3: Ensuring backend services exist...', '\x1b[33m');

  for (const b of conf.backends) {
    if (resourceExists('backend-services', b.name, '--global')) {
      log(`Backend service ${b.name} already exists.`, '\x1b[32m');
    } else {
      log(`Creating backend service ${b.name}...`);
      run([
        `gcloud compute backend-services create ${b.name}`,
        `--project=${PROJECT_ID}`,
        `--protocol=HTTPS`,
        `--port-name=${b.namedPort}`,
        `--health-checks=${b.healthCheck}`,
        `--global`,
        `--enable-logging`,
        `--logging-sample-rate=1.0`,
      ].join(' '));

      log(`Adding instance group to ${b.name}...`);
      run([
        `gcloud compute backend-services add-backend ${b.name}`,
        `--project=${PROJECT_ID}`,
        `--instance-group=${conf.instanceGroup}`,
        `--instance-group-zone=${GCP_ZONE}`,
        `--balancing-mode=UTILIZATION`,
        `--max-utilization=0.8`,
        `--global`,
      ].join(' '));

      log(`Backend service ${b.name} created.`, '\x1b[32m');
    }
  }
}

// ----- Step 4: Static IP -----
function ensureStaticIP() {
  log('Step 4: Ensuring static IP exists...', '\x1b[33m');

  if (resourceExists('addresses', conf.staticIpName, '--global')) {
    log(`Static IP ${conf.staticIpName} already exists.`, '\x1b[32m');
  } else {
    log(`Reserving static IP ${conf.staticIpName}...`);
    run(`gcloud compute addresses create ${conf.staticIpName} --project=${PROJECT_ID} --global --ip-version=IPV4`);
    log(`Static IP ${conf.staticIpName} reserved.`, '\x1b[32m');
  }

  const ip = run(
    `gcloud compute addresses describe ${conf.staticIpName} --project=${PROJECT_ID} --global --format="value(address)"`,
    { silent: true }
  );
  log(`Load Balancer IP: ${ip}`, '\x1b[32m');
  return ip;
}

// ----- Step 5: SSL Certificate -----
function ensureSSLCert() {
  log('Step 5: Ensuring SSL certificate exists...', '\x1b[33m');

  if (resourceExists('ssl-certificates', conf.certName, '--global')) {
    log(`SSL certificate ${conf.certName} already exists.`, '\x1b[32m');
  } else {
    log(`Creating Google-managed certificate ${conf.certName} for ${conf.domain}...`);
    run(`gcloud compute ssl-certificates create ${conf.certName} --project=${PROJECT_ID} --domains=${conf.domain} --global`);
    log(`SSL certificate ${conf.certName} created.`, '\x1b[33m');
  }
}

// ----- Step 6: URL Map (routing rules) -----
function ensureURLMap() {
  log('Step 6: Ensuring URL map exists...', '\x1b[33m');

  if (resourceExists('url-maps', conf.lbName, '--global')) {
    log(`URL map ${conf.lbName} already exists.`, '\x1b[32m');
  } else {
    log(`Creating URL map ${conf.lbName} (default → ${DEFAULT_BACKEND})...`);
    run(`gcloud compute url-maps create ${conf.lbName} --project=${PROJECT_ID} --default-service=${DEFAULT_BACKEND} --global`);
    log(`URL map ${conf.lbName} created.`, '\x1b[32m');
  }

  // Add path matchers for each subdomain
  for (const b of conf.backends) {
    if (b.name === DEFAULT_BACKEND && !b.host) continue;
    log(`Adding host rule: ${b.host} → ${b.name}...`);
    // Remove existing path matcher first (idempotent)
    run(
      `gcloud compute url-maps remove-path-matcher ${conf.lbName} --project=${PROJECT_ID} --path-matcher-name=${b.pathMatcher} --global`,
      { silent: true, ignoreError: true }
    );
    run([
      `gcloud compute url-maps add-path-matcher ${conf.lbName}`,
      `--project=${PROJECT_ID}`,
      `--path-matcher-name=${b.pathMatcher}`,
      `--default-service=${b.name}`,
      `--new-hosts=${b.host}`,
      `--global`,
    ].join(' '));
    log(`Host rule ${b.host} → ${b.name} configured.`, '\x1b[32m');
  }
}

// ----- Step 7: Target HTTPS Proxy -----
function ensureHTTPSProxy() {
  log('Step 7: Ensuring HTTPS proxy exists...', '\x1b[33m');

  if (resourceExists('target-https-proxies', conf.httpsProxyName, '--global')) {
    log(`HTTPS proxy ${conf.httpsProxyName} already exists.`, '\x1b[32m');
  } else {
    log(`Creating HTTPS proxy ${conf.httpsProxyName}...`);
    run([
      `gcloud compute target-https-proxies create ${conf.httpsProxyName}`,
      `--project=${PROJECT_ID}`,
      `--url-map=${conf.lbName}`,
      `--ssl-certificates=${conf.certName}`,
      `--global`,
    ].join(' '));
    log(`HTTPS proxy ${conf.httpsProxyName} created.`, '\x1b[32m');
  }
}

// ----- Step 8: Forwarding Rule (HTTPS) -----
function ensureHTTPSForwardingRule() {
  log('Step 8: Ensuring HTTPS forwarding rule exists...', '\x1b[33m');

  if (resourceExists('forwarding-rules', conf.httpsFwdRule, '--global')) {
    log(`Forwarding rule ${conf.httpsFwdRule} already exists.`, '\x1b[32m');
  } else {
    log(`Creating forwarding rule ${conf.httpsFwdRule}...`);
    run([
      `gcloud compute forwarding-rules create ${conf.httpsFwdRule}`,
      `--project=${PROJECT_ID}`,
      `--address=${conf.staticIpName}`,
      `--target-https-proxy=${conf.httpsProxyName}`,
      `--ports=443`,
      `--global`,
    ].join(' '));
    log(`Forwarding rule ${conf.httpsFwdRule} created.`, '\x1b[32m');
  }
}

// ----- Step 9: HTTP→HTTPS Redirect -----
function ensureHTTPRedirect() {
  log('Step 9: Ensuring HTTP→HTTPS redirect exists...', '\x1b[33m');

  // URL map for redirect
  if (!resourceExists('url-maps', conf.httpRedirectMap, '--global')) {
    log(`Creating HTTP redirect URL map ${conf.httpRedirectMap}...`);
    const yaml = [
      `name: ${conf.httpRedirectMap}`,
      `defaultUrlRedirect:`,
      `  httpsRedirect: true`,
      `  redirectResponseCode: MOVED_PERMANENTLY_DEFAULT`,
    ].join('
');
    try {
      execSync(
        `gcloud compute url-maps import ${conf.httpRedirectMap} --project=${PROJECT_ID} --global --source=-`,
        { input: yaml, encoding: 'utf8', stdio: ['pipe', 'inherit', 'inherit'] }
      );
    } catch {
      log(`Warning: HTTP redirect URL map creation may have failed.`, '\x1b[33m');
    }
  } else {
    log(`HTTP redirect URL map ${conf.httpRedirectMap} already exists.`, '\x1b[32m');
  }

  // HTTP proxy
  if (!resourceExists('target-http-proxies', conf.httpProxyName, '--global')) {
    log(`Creating HTTP proxy ${conf.httpProxyName}...`);
    run(`gcloud compute target-http-proxies create ${conf.httpProxyName} --project=${PROJECT_ID} --url-map=${conf.httpRedirectMap} --global`);
  } else {
    log(`HTTP proxy ${conf.httpProxyName} already exists.`, '\x1b[32m');
  }

  // HTTP forwarding rule
  if (!resourceExists('forwarding-rules', conf.httpFwdRule, '--global')) {
    log(`Creating HTTP forwarding rule ${conf.httpFwdRule}...`);
    run([
      `gcloud compute forwarding-rules create ${conf.httpFwdRule}`,
      `--project=${PROJECT_ID}`,
      `--address=${conf.staticIpName}`,
      `--target-http-proxy=${conf.httpProxyName}`,
      `--ports=80`,
      `--global`,
    ].join(' '));
    log(`HTTP→HTTPS redirect configured.`, '\x1b[32m');
  } else {
    log(`HTTP forwarding rule ${conf.httpFwdRule} already exists.`, '\x1b[32m');
  }
}

// ----- Step 10: Firewall Rule for Health Checks -----
function ensureFirewallRule() {
  log('Step 10: Ensuring firewall rule for LB health checks...', '\x1b[33m');

  const rawRules = run(
    `gcloud compute firewall-rules list --project=${PROJECT_ID} --format="value(name)"`,
    { silent: true }
  ) || '';
  const existing = new Set(rawRules.split('
').map(r => r.trim()));

  if (existing.has(conf.fwRuleName)) {
    log(`Firewall rule ${conf.fwRuleName} already exists.`, '\x1b[32m');
  } else {
    log(`Creating firewall rule ${conf.fwRuleName}...`);
    const ports = conf.backends.map(b => b.port).join(',');
    run([
      `gcloud compute firewall-rules create ${conf.fwRuleName}`,
      `--project=${PROJECT_ID}`,
      `--direction=INGRESS`,
      `--priority=1000`,
      `--network=default`,
      `--action=ALLOW`,
      `--rules=tcp:${ports}`,
      `--source-ranges=35.191.0.0/16,130.211.0.0/22`,
      `--target-tags=gocd-deploy-target`,
      `--description="Allow GCP LB health check probes"`,
    ].join(' '));
    log(`Firewall rule ${conf.fwRuleName} created.`, '\x1b[32m');
  }
}

// ----- Step 11: DNS Records -----
function ensureDNSRecords(lbIP) {
  log('Step 11: Configuring Cloud DNS records...', '\x1b[33m');

  if (!lbIP) {
    log('WARNING: Could not determine Load Balancer IP. Skipping DNS configuration.', '\x1b[33m');
    return;
  }

  // Check if DNS zone exists
  const zoneCheck = run(
    `gcloud dns managed-zones describe ${conf.dnsZone} --project=${PROJECT_ID} --format="value(name)"`,
    { silent: true, ignoreError: true }
  );
  if (!zoneCheck) {
    log(`WARNING: DNS zone ${conf.dnsZone} not found. Skipping DNS configuration.`, '\x1b[33m');
    return;
  }

  // Get existing records to avoid duplicates
  const existingRecords = run(
    `gcloud dns record-sets list --zone=${conf.dnsZone} --project=${PROJECT_ID} --format="value(name)"`,
    { silent: true }
  ) || '';

  const records = [
    { name: `${conf.domain}.`, desc: conf.domain },
    { name: `staging.${conf.domain}.`, desc: `staging.${conf.domain}` },
    { name: `app.${conf.domain}.`, desc: `app.${conf.domain}` },
  ];

  for (const rec of records) {
    if (existingRecords.includes(rec.name)) {
      log(`DNS A record for ${rec.desc} already exists. Updating to ${lbIP}...`);
      run(`gcloud dns record-sets update ${rec.name} --zone=${conf.dnsZone} --project=${PROJECT_ID} --type=A --ttl=300 --rrdatas=${lbIP}`, { ignoreError: true });
    } else {
      log(`Creating DNS A record: ${rec.desc} → ${lbIP}...`);
      run(`gcloud dns record-sets create ${rec.name} --zone=${conf.dnsZone} --project=${PROJECT_ID} --type=A --ttl=300 --rrdatas=${lbIP}`, { ignoreError: true });
    }
  }

  log('DNS records configured.', '\x1b[32m');
}

// ----- Main -----
function main() {
  console.log('\x1b[32m========================================\x1b[0m');
  console.log(`\x1b[32m  GCP Load Balancer Setup (${appName})\x1b[0m`);
  console.log('\x1b[32m  Domain: ' + conf.domain + '\x1b[0m');
  console.log('\x1b[32m  Project: ' + PROJECT_ID + '\x1b[0m');
  console.log('\x1b[32m========================================\x1b[0m
');

  ensureInstanceGroup();
  ensureHealthChecks();
  ensureBackendServices();
  const lbIP = ensureStaticIP();
  ensureSSLCert();
  ensureURLMap();
  ensureHTTPSProxy();
  ensureHTTPSForwardingRule();
  ensureHTTPRedirect();
  ensureFirewallRule();
  ensureDNSRecords(lbIP);

  console.log('
\x1b[32m========================================\x1b[0m');
  console.log('\x1b[32m  Setup Complete!\x1b[0m');
  console.log('\x1b[32m========================================\x1b[0m
');
  log(`Load Balancer IP: ${lbIP}`, '\x1b[32m');
}

main();