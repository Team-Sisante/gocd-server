#!/usr/bin/env node
/**
 * Scripts/setup-load-balancer.js
 * Creates (or verifies) a GCP External Application Load Balancer with
 * subdomain-based routing for humrine.com.
 *
 * Resources created:
 *   - Unmanaged Instance Group:  humrine-apps-group
 *   - Health checks:             staging-health-check, production-health-check
 *   - Backend services:          badminton-staging-backend, badminton-production-backend
 *   - URL map:                   humrine-main-lb
 *   - SSL certificate:           humrine-managed-cert  (Google-managed)
 *   - Target HTTPS proxy:        humrine-https-proxy
 *   - Forwarding rule (HTTPS):   humrine-https-frontend
 *   - HTTP→HTTPS redirect:       humrine-http-redirect, humrine-http-proxy, humrine-http-frontend
 *   - Firewall rule:             allow-lb-health-checks
 *   - Cloud DNS A records:       humrine.com, staging.humrine.com, app.humrine.com
 */

const { execSync } = require('child_process');

// ----- Required environment -----
const PROJECT_ID  = process.env.GCP_PROJECT_ID;
const GCP_ZONE    = process.env.GCP_ZONE;
const GCP_VM_NAME = process.env.GCP_VM_NAME;

if (!PROJECT_ID || !GCP_ZONE || !GCP_VM_NAME) {
  console.error('\x1b[31mERROR: Missing required env vars: GCP_PROJECT_ID, GCP_ZONE, GCP_VM_NAME\x1b[0m');
  process.exit(1);
}

const REGION = GCP_ZONE.replace(/-[a-z]$/, '');  // e.g. asia-southeast1-b → asia-southeast1
const DOMAIN = process.env.HUMRINE_DOMAIN || 'humrine.com';
const DNS_ZONE = process.env.HUMRINE_DNS_ZONE || 'humrine-com';

// ----- Resource names -----
const INSTANCE_GROUP      = 'humrine-apps-group';
const LB_NAME             = 'humrine-main-lb';
const STATIC_IP_NAME      = 'humrine-static-ip';
const CERT_NAME           = 'humrine-managed-cert';
const HTTPS_PROXY_NAME    = 'humrine-https-proxy';
const HTTPS_FWD_RULE      = 'humrine-https-frontend';
const HTTP_REDIRECT_MAP   = 'humrine-http-redirect';
const HTTP_PROXY_NAME     = 'humrine-http-proxy';
const HTTP_FWD_RULE       = 'humrine-http-frontend';
const FW_RULE_NAME        = 'allow-lb-health-checks';

const BACKENDS = [
  {
    name: 'badminton-staging-backend',
    namedPort: 'staging',
    port: 8443,
    healthCheck: 'staging-health-check',
    host: `staging.${DOMAIN}`,
    pathMatcher: 'staging-matcher',
  },
  {
    name: 'badminton-production-backend',
    namedPort: 'production',
    port: 9443,
    healthCheck: 'production-health-check',
    host: `app.${DOMAIN}`,
    pathMatcher: 'production-matcher',
  },
];

// Production is the default backend
const DEFAULT_BACKEND = 'badminton-production-backend';

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

function globalFlag(type) {
  const regional = ['instance-groups'];
  if (regional.includes(type)) return `--zone=${GCP_ZONE}`;
  return '--global';
}

// ----- Step 1: Instance Group -----
function ensureInstanceGroup() {
  log('Step 1: Ensuring unmanaged instance group exists...', '\x1b[33m');

  const exists = run(
    `gcloud compute instance-groups unmanaged describe ${INSTANCE_GROUP} --zone=${GCP_ZONE} --project=${PROJECT_ID} --format="value(name)"`,
    { silent: true, ignoreError: true }
  );

  if (exists) {
    log(`Instance group ${INSTANCE_GROUP} already exists.`, '\x1b[32m');
  } else {
    log(`Creating instance group ${INSTANCE_GROUP}...`);
    run(`gcloud compute instance-groups unmanaged create ${INSTANCE_GROUP} --zone=${GCP_ZONE} --project=${PROJECT_ID}`);
    log(`Adding VM ${GCP_VM_NAME} to instance group...`);
    run(`gcloud compute instance-groups unmanaged add-instances ${INSTANCE_GROUP} --zone=${GCP_ZONE} --project=${PROJECT_ID} --instances=${GCP_VM_NAME}`);
    log(`Instance group ${INSTANCE_GROUP} created.`, '\x1b[32m');
  }

  // Set named ports
  const ports = BACKENDS.map(b => `${b.namedPort}:${b.port}`).join(',');
  log(`Setting named ports: ${ports}`);
  run(`gcloud compute instance-groups unmanaged set-named-ports ${INSTANCE_GROUP} --zone=${GCP_ZONE} --project=${PROJECT_ID} --named-ports=${ports}`);
  log('Named ports configured.', '\x1b[32m');
}

// ----- Step 2: Health Checks -----
function ensureHealthChecks() {
  log('Step 2: Ensuring health checks exist...', '\x1b[33m');

  for (const b of BACKENDS) {
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

  for (const b of BACKENDS) {
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
        `--instance-group=${INSTANCE_GROUP}`,
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

  if (resourceExists('addresses', STATIC_IP_NAME, '--global')) {
    log(`Static IP ${STATIC_IP_NAME} already exists.`, '\x1b[32m');
  } else {
    log(`Reserving static IP ${STATIC_IP_NAME}...`);
    run(`gcloud compute addresses create ${STATIC_IP_NAME} --project=${PROJECT_ID} --global --ip-version=IPV4`);
    log(`Static IP ${STATIC_IP_NAME} reserved.`, '\x1b[32m');
  }

  const ip = run(
    `gcloud compute addresses describe ${STATIC_IP_NAME} --project=${PROJECT_ID} --global --format="value(address)"`,
    { silent: true }
  );
  log(`Load Balancer IP: ${ip}`, '\x1b[32m');
  return ip;
}

// ----- Step 5: SSL Certificate -----
function ensureSSLCert() {
  log('Step 5: Ensuring SSL certificate exists...', '\x1b[33m');

  if (resourceExists('ssl-certificates', CERT_NAME, '--global')) {
    log(`SSL certificate ${CERT_NAME} already exists.`, '\x1b[32m');
  } else {
    log(`Creating Google-managed certificate ${CERT_NAME} for ${DOMAIN}...`);
    run(`gcloud compute ssl-certificates create ${CERT_NAME} --project=${PROJECT_ID} --domains=${DOMAIN} --global`);
    log(`SSL certificate ${CERT_NAME} created (status: PROVISIONING — will activate after DNS is configured).`, '\x1b[33m');
  }
}

// ----- Step 6: URL Map (routing rules) -----
function ensureURLMap() {
  log('Step 6: Ensuring URL map exists...', '\x1b[33m');

  if (resourceExists('url-maps', LB_NAME, '--global')) {
    log(`URL map ${LB_NAME} already exists.`, '\x1b[32m');
  } else {
    log(`Creating URL map ${LB_NAME} (default → ${DEFAULT_BACKEND})...`);
    run(`gcloud compute url-maps create ${LB_NAME} --project=${PROJECT_ID} --default-service=${DEFAULT_BACKEND} --global`);
    log(`URL map ${LB_NAME} created.`, '\x1b[32m');
  }

  // Add path matchers for each subdomain
  for (const b of BACKENDS) {
    if (b.name === DEFAULT_BACKEND && !b.host) continue;
    log(`Adding host rule: ${b.host} → ${b.name}...`);
    // Remove existing path matcher first (idempotent)
    run(
      `gcloud compute url-maps remove-path-matcher ${LB_NAME} --project=${PROJECT_ID} --path-matcher-name=${b.pathMatcher} --global`,
      { silent: true, ignoreError: true }
    );
    run([
      `gcloud compute url-maps add-path-matcher ${LB_NAME}`,
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

  if (resourceExists('target-https-proxies', HTTPS_PROXY_NAME, '--global')) {
    log(`HTTPS proxy ${HTTPS_PROXY_NAME} already exists.`, '\x1b[32m');
  } else {
    log(`Creating HTTPS proxy ${HTTPS_PROXY_NAME}...`);
    run([
      `gcloud compute target-https-proxies create ${HTTPS_PROXY_NAME}`,
      `--project=${PROJECT_ID}`,
      `--url-map=${LB_NAME}`,
      `--ssl-certificates=${CERT_NAME}`,
      `--global`,
    ].join(' '));
    log(`HTTPS proxy ${HTTPS_PROXY_NAME} created.`, '\x1b[32m');
  }
}

// ----- Step 8: Forwarding Rule (HTTPS) -----
function ensureHTTPSForwardingRule() {
  log('Step 8: Ensuring HTTPS forwarding rule exists...', '\x1b[33m');

  if (resourceExists('forwarding-rules', HTTPS_FWD_RULE, '--global')) {
    log(`Forwarding rule ${HTTPS_FWD_RULE} already exists.`, '\x1b[32m');
  } else {
    log(`Creating forwarding rule ${HTTPS_FWD_RULE}...`);
    run([
      `gcloud compute forwarding-rules create ${HTTPS_FWD_RULE}`,
      `--project=${PROJECT_ID}`,
      `--address=${STATIC_IP_NAME}`,
      `--target-https-proxy=${HTTPS_PROXY_NAME}`,
      `--ports=443`,
      `--global`,
    ].join(' '));
    log(`Forwarding rule ${HTTPS_FWD_RULE} created.`, '\x1b[32m');
  }
}

// ----- Step 9: HTTP→HTTPS Redirect -----
function ensureHTTPRedirect() {
  log('Step 9: Ensuring HTTP→HTTPS redirect exists...', '\x1b[33m');

  // URL map for redirect
  if (!resourceExists('url-maps', HTTP_REDIRECT_MAP, '--global')) {
    log(`Creating HTTP redirect URL map ${HTTP_REDIRECT_MAP}...`);
    // gcloud doesn't support --default-url-redirect-https-redirect directly in create,
    // so we import a YAML config via stdin.
    const yaml = [
      `name: ${HTTP_REDIRECT_MAP}`,
      `defaultUrlRedirect:`,
      `  httpsRedirect: true`,
      `  redirectResponseCode: MOVED_PERMANENTLY_DEFAULT`,
    ].join('\n');
    try {
      execSync(
        `gcloud compute url-maps import ${HTTP_REDIRECT_MAP} --project=${PROJECT_ID} --global --source=-`,
        { input: yaml, encoding: 'utf8', stdio: ['pipe', 'inherit', 'inherit'] }
      );
    } catch {
      log(`Warning: HTTP redirect URL map creation may have failed.`, '\x1b[33m');
    }
  } else {
    log(`HTTP redirect URL map ${HTTP_REDIRECT_MAP} already exists.`, '\x1b[32m');
  }

  // HTTP proxy
  if (!resourceExists('target-http-proxies', HTTP_PROXY_NAME, '--global')) {
    log(`Creating HTTP proxy ${HTTP_PROXY_NAME}...`);
    run(`gcloud compute target-http-proxies create ${HTTP_PROXY_NAME} --project=${PROJECT_ID} --url-map=${HTTP_REDIRECT_MAP} --global`);
  } else {
    log(`HTTP proxy ${HTTP_PROXY_NAME} already exists.`, '\x1b[32m');
  }

  // HTTP forwarding rule
  if (!resourceExists('forwarding-rules', HTTP_FWD_RULE, '--global')) {
    log(`Creating HTTP forwarding rule ${HTTP_FWD_RULE}...`);
    run([
      `gcloud compute forwarding-rules create ${HTTP_FWD_RULE}`,
      `--project=${PROJECT_ID}`,
      `--address=${STATIC_IP_NAME}`,
      `--target-http-proxy=${HTTP_PROXY_NAME}`,
      `--ports=80`,
      `--global`,
    ].join(' '));
    log(`HTTP→HTTPS redirect configured.`, '\x1b[32m');
  } else {
    log(`HTTP forwarding rule ${HTTP_FWD_RULE} already exists.`, '\x1b[32m');
  }
}

// ----- Step 10: Firewall Rule for Health Checks -----
function ensureFirewallRule() {
  log('Step 10: Ensuring firewall rule for LB health checks...', '\x1b[33m');

  const rawRules = run(
    `gcloud compute firewall-rules list --project=${PROJECT_ID} --format="value(name)"`,
    { silent: true }
  ) || '';
  const existing = new Set(rawRules.split('\n').map(r => r.trim()));

  if (existing.has(FW_RULE_NAME)) {
    log(`Firewall rule ${FW_RULE_NAME} already exists.`, '\x1b[32m');
  } else {
    log(`Creating firewall rule ${FW_RULE_NAME}...`);
    const ports = BACKENDS.map(b => b.port).join(',');
    run([
      `gcloud compute firewall-rules create ${FW_RULE_NAME}`,
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
    log(`Firewall rule ${FW_RULE_NAME} created.`, '\x1b[32m');
  }
}

// ----- Step 11: DNS Records -----
function ensureDNSRecords(lbIP) {
  log('Step 11: Configuring Cloud DNS records...', '\x1b[33m');

  if (!lbIP) {
    log('WARNING: Could not determine Load Balancer IP. Skipping DNS configuration.', '\x1b[33m');
    log('You must manually add A records in Cloud DNS pointing to the LB IP.', '\x1b[33m');
    return;
  }

  // Check if DNS zone exists
  const zoneCheck = run(
    `gcloud dns managed-zones describe ${DNS_ZONE} --project=${PROJECT_ID} --format="value(name)"`,
    { silent: true, ignoreError: true }
  );
  if (!zoneCheck) {
    log(`WARNING: DNS zone ${DNS_ZONE} not found. Skipping DNS configuration.`, '\x1b[33m');
    log(`Create it via Cloud DNS or domain registration, then re-run this script.`, '\x1b[33m');
    return;
  }

  // Get existing records to avoid duplicates
  const existingRecords = run(
    `gcloud dns record-sets list --zone=${DNS_ZONE} --project=${PROJECT_ID} --format="value(name)"`,
    { silent: true }
  ) || '';

  const records = [
    { name: `${DOMAIN}.`, desc: DOMAIN },
    { name: `staging.${DOMAIN}.`, desc: `staging.${DOMAIN}` },
    { name: `app.${DOMAIN}.`, desc: `app.${DOMAIN}` },
  ];

  for (const rec of records) {
    if (existingRecords.includes(rec.name)) {
      log(`DNS A record for ${rec.desc} already exists. Updating to ${lbIP}...`);
      // Start a transaction to update
      run(`gcloud dns record-sets update ${rec.name} --zone=${DNS_ZONE} --project=${PROJECT_ID} --type=A --ttl=300 --rrdatas=${lbIP}`, { ignoreError: true });
    } else {
      log(`Creating DNS A record: ${rec.desc} → ${lbIP}...`);
      run(`gcloud dns record-sets create ${rec.name} --zone=${DNS_ZONE} --project=${PROJECT_ID} --type=A --ttl=300 --rrdatas=${lbIP}`, { ignoreError: true });
    }
  }

  log('DNS records configured.', '\x1b[32m');
}

// ----- Main -----
function main() {
  console.log('\x1b[32m========================================\x1b[0m');
  console.log('\x1b[32m  GCP Load Balancer Setup Script\x1b[0m');
  console.log('\x1b[32m  Domain: ' + DOMAIN + '\x1b[0m');
  console.log('\x1b[32m  Project: ' + PROJECT_ID + '\x1b[0m');
  console.log('\x1b[32m========================================\x1b[0m\n');

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

  console.log('\n\x1b[32m========================================\x1b[0m');
  console.log('\x1b[32m  Setup Complete!\x1b[0m');
  console.log('\x1b[32m========================================\x1b[0m\n');
  log(`Load Balancer IP: ${lbIP}`, '\x1b[32m');
  log(`SSL certificate status: PROVISIONING (will activate after DNS propagates, 30-60 min)`, '\x1b[33m');
  log(`\nURLs (once DNS + SSL are active):`, '\x1b[36m');
  log(`  Staging:    https://staging.${DOMAIN}`, '\x1b[36m');
  log(`  Production: https://app.${DOMAIN}`, '\x1b[36m');
  log(`  Root:       https://${DOMAIN}`, '\x1b[36m');
  log(`\nNext steps:`, '\x1b[33m');
  log(`  1. Wait for SSL cert to become ACTIVE (check: gcloud compute ssl-certificates describe ${CERT_NAME} --project=${PROJECT_ID} --global)`, '\x1b[33m');
  log(`  2. Update ALLOWED_HOSTS and CSRF_TRUSTED_ORIGINS in your env files`, '\x1b[33m');
  log(`  3. Update OAuth callback URLs at Google/Facebook/Twitter`, '\x1b[33m');
  log(`  4. Re-deploy via staging/production pipelines`, '\x1b[33m');
}

main();
