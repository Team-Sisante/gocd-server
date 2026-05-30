#!/usr/bin/env node
/**
 * Scripts/setup-load-balancer.js
 * Creates (or verifies) a GCP External Application Load Balancer
 * based on configuration in Scripts/loadbalancer.json.
 *
 * Usage:
 *   node Scripts/setup-load-balancer.js <app_name>
 *   e.g., node Scripts/setup-load-balancer.js humrine
 * 
 * All console output is simultaneously written to a log file:
 *   setup-load-balancer-YYYY-MMM-DD.log
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

// ------------------------------------------------------------------
// Log file: setup-load-balancer-YYYY-MMM-DD.log in the Scripts folder
// ------------------------------------------------------------------
const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const now = new Date();
const yyyy = now.getFullYear();
const mmm = months[now.getMonth()];
const dd = String(now.getDate()).padStart(2,'0');
const hh = String(now.getHours()).padStart(2,'0');
const min = String(now.getMinutes()).padStart(2,'0');
const logFileName = `setup-load-balancer-${yyyy}-${mmm}-${dd}-${hh}-${min}.log`;
const logFilePath = path.join(__dirname, logFileName);

// Open log stream (append mode)
const logStream = fs.createWriteStream(logFilePath, { flags: 'a' });

// Override console.log to also write to log file
const originalConsoleLog = console.log;
console.log = function(...args) {
  const message = args.map(String).join(' ');
  originalConsoleLog.apply(console, args);
  logStream.write(message + '\n');
};

// Also capture console.error (for command failures, etc.)
const originalConsoleError = console.error;
console.error = function(...args) {
  const message = args.map(String).join(' ');
  originalConsoleError.apply(console, args);
  logStream.write(message + '\n');
};

// ------------------------------------------------------------------
// ----- Load Configuration -----
const appName = process.argv[2];
if (!appName) {
  console.error('\x1b[31mERROR: Missing app name argument (e.g., humrine, badminton)\x1b[0m');
  process.exit(1);
}

const configPath = path.join(__dirname, 'loadbalancer.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

// Interpolate environment variables in config (recursively)
function interpolate(obj) {
  for (const key in obj) {
    const val = obj[key];
    if (typeof val === 'string') {
      obj[key] = val.replace(/\${(\w+)}/g, (_, varName) => process.env[varName] || '');
    } else if (Array.isArray(val)) {
      val.forEach((item, idx) => {
        if (typeof item === 'object' && item !== null) interpolate(item);
        else if (typeof item === 'string') {
          val[idx] = item.replace(/\${(\w+)}/g, (_, varName) => process.env[varName] || '');
        }
      });
    } else if (typeof val === 'object' && val !== null) {
      interpolate(val);
    }
  }
}

interpolate(config);

if (!config[appName]) {
  console.error('\x1b[31mERROR: Configuration for \'' + appName + '\' not found in loadbalancer.json\x1b[0m');
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

// Default backend (last one in the array)
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
  const cmd = 'gcloud compute ' + type + ' describe ' + name + ' --project=' + PROJECT_ID + ' ' + extra + ' --format="value(name)"';
  const result = run(cmd, { silent: true, ignoreError: true });
  return result && result.length > 0;
}

function sleep(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end);
}

// Interactive prompt
function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(`\x1b[33m${question}\x1b[0m`, answer => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}

// ----- Certificate versioning (unchanged) -----
function getAttachedCerts(proxyName) {
  const output = run(
    `gcloud compute target-https-proxies describe ${proxyName} --project=${PROJECT_ID} --global --format="value(sslCertificates)"`,
    { silent: true, ignoreError: true }
  );
  if (!output) return [];
  return output.split(';').map(url => {
    const parts = url.split('/');
    return parts[parts.length - 1];
  });
}

// ----- New certificate versioning -----
// We'll use a versioned certificate name to avoid deletion conflicts.
// The actual certificate name is stored in conf.certName. We'll create
// a new one with "-v<N>" appended. The proxy will be updated to use that.
function getVersionedCertName() {
  const base = conf.certName; // e.g., humrine-managed-cert
  // Check what's currently attached to the proxy
  const attached = getAttachedCerts(conf.httpsProxyName);
  // Find the highest version number already in use
  let maxVersion = 0;
  attached.forEach(certName => {
    if (certName.startsWith(base + '-v')) {
      const ver = parseInt(certName.split('-v')[1], 10);
      if (!isNaN(ver) && ver > maxVersion) maxVersion = ver;
    } else if (certName === base) {
      // treat the base name as version 1
      maxVersion = Math.max(maxVersion, 1);
    }
  });
  // New version = max + 1
  const newVersion = maxVersion + 1;
  return base + '-v' + newVersion;
}

function updateProxyCertificates(proxyName, certNames) {
  if (!resourceExists('target-https-proxies', proxyName, '--global')) return;
  const certList = certNames.join(',');
  log(`Updating HTTPS proxy ${proxyName} to use certificates: ${certList}...`);
  run(`gcloud compute target-https-proxies update ${proxyName} --project=${PROJECT_ID} --global --ssl-certificates=${certList}`);
}

// ----- Step 5: Create a new versioned SSL certificate (returns its name) -----
function createVersionedCert() {
  log('Step 5: Ensuring multi-domain SSL certificate exists (versioned)...', '\x1b[33m');

  if (!conf.certDomains || !Array.isArray(conf.certDomains) || conf.certDomains.length === 0) {
    console.error('\x1b[31mERROR: No certDomains defined in loadbalancer.json for ' + appName + '\x1b[0m');
    process.exit(1);
  }
  const domainList = conf.certDomains.join(',');

  // Determine the new versioned certificate name
  const newCertName = getVersionedCertName();
  log(`Will create new certificate: ${newCertName}`);

  // Check if the exact certificate already exists (unlikely but safe)
  if (resourceExists('ssl-certificates', newCertName, '--global')) {
    log(`Certificate ${newCertName} already exists.`, '\x1b[32m');
  } else {
    log(`Creating Google-managed certificate ${newCertName} for domains: ${domainList}...`);
    run(`gcloud compute ssl-certificates create ${newCertName} --project=${PROJECT_ID} --domains=${domainList} --global`);
    if (!resourceExists('ssl-certificates', newCertName, '--global')) {
      throw new Error(`Failed to create SSL certificate ${newCertName}.`);
    }
    log(`Certificate ${newCertName} created.`, '\x1b[33m');
    log('Note: It may take 30-60 minutes for the certificate to become ACTIVE. Check status with:\n' +
        '  gcloud compute ssl-certificates describe ' + newCertName + ' --global --project=' + PROJECT_ID, '\x1b[33m');
  }

  log(`You can later delete old certificates (e.g., ${conf.certName}) after the new one is ACTIVE.`, '\x1b[33m');
  return newCertName;
}

// ----- Attach a certificate to the HTTPS proxy (or update if already attached) -----
function attachCertToProxy(certName) {
  if (!resourceExists('target-https-proxies', conf.httpsProxyName, '--global')) {
    return;   // proxy not created yet; will be attached during creation
  }
  updateProxyCertificates(conf.httpsProxyName, [certName]);
}

// ----- Step 1: Instance Group -----
function ensureInstanceGroup() {
  log('Step 1: Ensuring unmanaged instance group exists...', '\x1b[33m');
  const exists = run(
    'gcloud compute instance-groups unmanaged describe ' + conf.instanceGroup + ' --zone=' + GCP_ZONE + ' --project=' + PROJECT_ID + ' --format="value(name)"',
    { silent: true, ignoreError: true }
  );
  if (exists) {
    log('Instance group ' + conf.instanceGroup + ' already exists.', '\x1b[32m');
  } else {
    log('Creating instance group ' + conf.instanceGroup + '...');
    run('gcloud compute instance-groups unmanaged create ' + conf.instanceGroup + ' --zone=' + GCP_ZONE + ' --project=' + PROJECT_ID);
    log('Adding VM ' + GCP_VM_NAME + ' to instance group...');
    run('gcloud compute instance-groups unmanaged add-instances ' + conf.instanceGroup + ' --zone=' + GCP_ZONE + ' --project=' + PROJECT_ID + ' --instances=' + GCP_VM_NAME);
    log('Instance group ' + conf.instanceGroup + ' created.', '\x1b[32m');
  }
  const ports = conf.backends.map(b => b.namedPort + ':' + b.port).join(',');
  log('Setting named ports: ' + ports);
  run('gcloud compute instance-groups unmanaged set-named-ports ' + conf.instanceGroup + ' --zone=' + GCP_ZONE + ' --project=' + PROJECT_ID + ' --named-ports=' + ports);
  log('Named ports configured.', '\x1b[32m');
}

// ----- Step 2: Health Checks (HTTP) -----
function ensureHealthChecks() {
  log('Step 2: Ensuring health checks exist...', '\x1b[33m');
  for (const b of conf.backends) {
    if (resourceExists('health-checks', b.healthCheck, '--global')) {
      log('Health check ' + b.healthCheck + ' already exists.', '\x1b[32m');
    } else {
      log('Creating health check ' + b.healthCheck + ' (HTTP port ' + b.port + ')...');
      run('gcloud compute health-checks create http ' + b.healthCheck + ' --project=' + PROJECT_ID + ' --port=' + b.port + ' --request-path=/ --global');
      log('Health check ' + b.healthCheck + ' created.', '\x1b[32m');
    }
  }
}

// ----- Step 3: Backend Services (HTTP) -----
function ensureBackendServices() {
  log('Step 3: Ensuring backend services exist...', '\x1b[33m');
  for (const b of conf.backends) {
    if (resourceExists('backend-services', b.name, '--global')) {
      log('Backend service ' + b.name + ' already exists.', '\x1b[32m');
    } else {
      log('Creating backend service ' + b.name + '...');
      run([
        'gcloud compute backend-services create ' + b.name,
        '--project=' + PROJECT_ID,
        '--protocol=HTTP',
        '--port-name=' + b.namedPort,
        '--health-checks=' + b.healthCheck,
        '--global',
        '--enable-logging',
        '--logging-sample-rate=1.0',
      ].join(' '));
      log('Adding instance group to ' + b.name + '...');
      run([
        'gcloud compute backend-services add-backend ' + b.name,
        '--project=' + PROJECT_ID,
        '--instance-group=' + conf.instanceGroup,
        '--instance-group-zone=' + GCP_ZONE,
        '--balancing-mode=UTILIZATION',
        '--max-utilization=0.8',
        '--global',
      ].join(' '));
      log('Backend service ' + b.name + ' created.', '\x1b[32m');
    }
  }
}

// ----- Step 4: Static IP -----
function ensureStaticIP() {
  log('Step 4: Ensuring static IP exists...', '\x1b[33m');
  if (resourceExists('addresses', conf.staticIpName, '--global')) {
    log('Static IP ' + conf.staticIpName + ' already exists.', '\x1b[32m');
  } else {
    log('Reserving static IP ' + conf.staticIpName + '...');
    run('gcloud compute addresses create ' + conf.staticIpName + ' --project=' + PROJECT_ID + ' --global --ip-version=IPV4');
    log('Static IP ' + conf.staticIpName + ' reserved.', '\x1b[32m');
  }
  const ip = run(
    'gcloud compute addresses describe ' + conf.staticIpName + ' --project=' + PROJECT_ID + ' --global --format="value(address)"',
    { silent: true }
  );
  log('Load Balancer IP: ' + ip, '\x1b[32m');
  return ip;
}

// ----- Recreate confirmation -----
async function confirmRecreateLoadBalancer() {
  const lbExists = resourceExists('url-maps', conf.lbName, '--global');
  if (!lbExists) return;

  log('\n⚠️  The load balancer "' + conf.lbName + '" already exists.');
  log('Recreating it will delete all routing rules and rebuild them from the JSON config.');
  log('Any manually added rules will be lost.');
  const answer = await ask('Do you want to delete and recreate the load balancer? (y/N): ');

  if (answer !== 'y') {
    log('Skipping load balancer recreation. Existing configuration preserved.', '\x1b[33m');
    throw new Error('SKIP_LB_RECREATE');
  }

  log('Deleting existing forwarding rules...');
  run(`gcloud compute forwarding-rules delete ${conf.httpsFwdRule} --global --project=${PROJECT_ID} --quiet`, { silent: true, ignoreError: true });
  run(`gcloud compute forwarding-rules delete ${conf.httpFwdRule} --global --project=${PROJECT_ID} --quiet`, { silent: true, ignoreError: true });

  log('Deleting HTTPS and HTTP proxies...');
  run(`gcloud compute target-https-proxies delete ${conf.httpsProxyName} --global --project=${PROJECT_ID} --quiet`, { silent: true, ignoreError: true });
  run(`gcloud compute target-http-proxies delete ${conf.httpProxyName} --global --project=${PROJECT_ID} --quiet`, { silent: true, ignoreError: true });

  log('Deleting URL map...');
  run(`gcloud compute url-maps delete ${conf.lbName} --global --project=${PROJECT_ID} --quiet`, { silent: true, ignoreError: true });
}

// ----- Step 6: URL Map (host & path rules) -----
function ensureURLMap() {
  log('Step 6: Ensuring URL map exists with host and path rules...', '\x1b[33m');

  if (resourceExists('url-maps', conf.lbName, '--global')) {
    log('URL map ' + conf.lbName + ' already exists. Updating rules...');
    updateURLMapRules();
    return;
  }

  // Create new URL map with default backend (last backend in JSON)
  log('Creating URL map ' + conf.lbName + ' (default → ' + DEFAULT_BACKEND + ')...');
  run('gcloud compute url-maps create ' + conf.lbName + ' --project=' + PROJECT_ID + ' --default-service=' + DEFAULT_BACKEND + ' --global');

  // 1. Add host rules for backends without pathPrefix (subdomain‑based)
  const hostBackends = conf.backends.filter(b => b.host && !b.pathPrefix);
  for (const b of hostBackends) {
    log('Adding host rule: ' + b.host + ' → ' + b.name + '...');
    run([
      'gcloud compute url-maps add-path-matcher ' + conf.lbName,
      '--project=' + PROJECT_ID,
      '--path-matcher-name=' + b.pathMatcher,
      '--default-service=' + b.name,
      '--new-hosts=' + b.host,
      '--global',
    ].join(' '));
  }

  // 2. Ensure a host rule for the bare domain (for path‑based backends) exists FIRST
  const pathBackends = conf.backends.filter(b => b.host && b.pathPrefix);
  const bareHosts = [...new Set(pathBackends.map(b => b.host))];
  for (const bareHost of bareHosts) {
    log('Creating host rule for bare domain: ' + bareHost + ' → ' + DEFAULT_BACKEND + '...');
    // We use a unique matcher name for the bare host (e.g., "humrine-com-default")
    const bareHostMatcher = bareHost.replace(/\./g, '-') + '-default';
    run('gcloud compute url-maps remove-path-matcher ' + conf.lbName + ' --project=' + PROJECT_ID + ' --path-matcher-name=' + bareHostMatcher + ' --global', { silent: true, ignoreError: true });
    run([
      'gcloud compute url-maps add-path-matcher ' + conf.lbName,
      '--project=' + PROJECT_ID,
      '--path-matcher-name=' + bareHostMatcher,
      '--default-service=' + DEFAULT_BACKEND,
      '--new-hosts=' + bareHost,
      '--global',
    ].join(' '));
  }

  // 3. Now add path rules for the path‑based backends, attaching them to the existing host rule
  for (const b of pathBackends) {
    log(`Adding path rule: ${b.host}${b.pathPrefix} → ${b.name}...`);
    run('gcloud compute url-maps remove-path-matcher ' + conf.lbName + ' --project=' + PROJECT_ID + ' --path-matcher-name=' + b.pathMatcher + ' --global', { silent: true, ignoreError: true });
    run([
      'gcloud compute url-maps add-path-matcher ' + conf.lbName,
      '--project=' + PROJECT_ID,
      '--path-matcher-name=' + b.pathMatcher,
      '--default-service=' + b.name,
      '--existing-host=' + b.host,
      '--path-rules=' + b.pathPrefix + '/*=' + b.name,
      '--delete-orphaned-path-matcher',
      '--global',
    ].join(' '));
  }

  log('URL map configured.', '\x1b[32m');
}

function updateURLMapRules() {
  // 1. Ensure host rules for subdomain‑based backends
  for (const b of conf.backends) {
    if (b.host && !b.pathPrefix) {
      log(`Ensuring host rule: ${b.host} → ${b.name}...`);
      run('gcloud compute url-maps remove-path-matcher ' + conf.lbName + ' --project=' + PROJECT_ID + ' --path-matcher-name=' + b.pathMatcher + ' --global', { silent: true, ignoreError: true });
      run([
        'gcloud compute url-maps add-path-matcher ' + conf.lbName,
        '--project=' + PROJECT_ID,
        '--path-matcher-name=' + b.pathMatcher,
        '--default-service=' + b.name,
        '--new-hosts=' + b.host,
        '--global',
      ].join(' '));
    }
  }

  // 2. Ensure bare‑domain host rules exist for each unique host used by path‑based backends
  const pathBackends = conf.backends.filter(b => b.host && b.pathPrefix);
  const bareHosts = [...new Set(pathBackends.map(b => b.host))];
  for (const bareHost of bareHosts) {
    const bareHostMatcher = bareHost.replace(/\./g, '-') + '-default';
    // Check if host rule already exists
    const existingHostsOutput = run(
      `gcloud compute url-maps describe ${conf.lbName} --project=${PROJECT_ID} --global --format="value(hostRules.hosts)"`,
      { silent: true, ignoreError: true }
    ) || '';
    const hostList = existingHostsOutput.split(';').map(h => h.trim());
    if (!hostList.includes(bareHost)) {
      log(`Creating host rule for bare domain: ${bareHost} → ${DEFAULT_BACKEND}...`);
      run([
        'gcloud compute url-maps add-path-matcher ' + conf.lbName,
        '--project=' + PROJECT_ID,
        '--path-matcher-name=' + bareHostMatcher,
        '--default-service=' + DEFAULT_BACKEND,
        '--new-hosts=' + bareHost,
        '--global',
      ].join(' '));
    }
  }

  // 3. Add/update path rules for path‑based backends (attach to existing host)
  for (const b of pathBackends) {
    log(`Ensuring path rule: ${b.host}${b.pathPrefix} → ${b.name}...`);
    run('gcloud compute url-maps remove-path-matcher ' + conf.lbName + ' --project=' + PROJECT_ID + ' --path-matcher-name=' + b.pathMatcher + ' --global', { silent: true, ignoreError: true });
    run([
      'gcloud compute url-maps add-path-matcher ' + conf.lbName,
      '--project=' + PROJECT_ID,
      '--path-matcher-name=' + b.pathMatcher,
      '--default-service=' + b.name,
      '--existing-host=' + b.host,
      '--path-rules=' + b.pathPrefix + '/*=' + b.name,
      '--delete-orphaned-path-matcher',
      '--global',
    ].join(' '));
  }
}

// ----- Step 7: Target HTTPS Proxy -----
function ensureHTTPSProxy(certNameToUse) {
  log('Step 7: Ensuring HTTPS proxy exists...', '\x1b[33m');

  if (resourceExists('target-https-proxies', conf.httpsProxyName, '--global')) {
    log('HTTPS proxy ' + conf.httpsProxyName + ' already exists.', '\x1b[32m');
    // Update it to use the given certificate
    updateProxyCertificates(conf.httpsProxyName, [certNameToUse]);
  } else {
    log('Creating HTTPS proxy ' + conf.httpsProxyName + '...');
    run([
      'gcloud compute target-https-proxies create ' + conf.httpsProxyName,
      '--project=' + PROJECT_ID,
      '--url-map=' + conf.lbName,
      '--ssl-certificates=' + certNameToUse,   // <-- use the versioned cert
      '--global',
    ].join(' '));
    log('HTTPS proxy ' + conf.httpsProxyName + ' created.', '\x1b[32m');
  }
}

// ----- Step 8: Forwarding Rule (HTTPS) -----
function ensureHTTPSForwardingRule() {
  log('Step 8: Ensuring HTTPS forwarding rule exists...', '\x1b[33m');
  if (resourceExists('forwarding-rules', conf.httpsFwdRule, '--global')) {
    log('Forwarding rule ' + conf.httpsFwdRule + ' already exists.', '\x1b[32m');
  } else {
    log('Creating forwarding rule ' + conf.httpsFwdRule + '...');
    run([
      'gcloud compute forwarding-rules create ' + conf.httpsFwdRule,
      '--project=' + PROJECT_ID,
      '--address=' + conf.staticIpName,
      '--target-https-proxy=' + conf.httpsProxyName,
      '--ports=443',
      '--global',
    ].join(' '));
    log('Forwarding rule ' + conf.httpsFwdRule + ' created.', '\x1b[32m');
  }
}

// ----- Step 9: HTTP→HTTPS Redirect -----
function ensureHTTPRedirect() {
  log('Step 9: Ensuring HTTP→HTTPS redirect exists...', '\x1b[33m');
  if (!resourceExists('url-maps', conf.httpRedirectMap, '--global')) {
    log('Creating HTTP redirect URL map ' + conf.httpRedirectMap + '...');
    const yaml = [
      'name: ' + conf.httpRedirectMap,
      'defaultUrlRedirect:',
      '  httpsRedirect: true',
      '  redirectResponseCode: MOVED_PERMANENTLY_DEFAULT',
    ].join('\n');
    try {
      execSync(
        'gcloud compute url-maps import ' + conf.httpRedirectMap + ' --project=' + PROJECT_ID + ' --global --source=-',
        { input: yaml, encoding: 'utf8', stdio: ['pipe', 'inherit', 'inherit'] }
      );
    } catch {
      log('Warning: HTTP redirect URL map creation may have failed.', '\x1b[33m');
    }
  } else {
    log('HTTP redirect URL map ' + conf.httpRedirectMap + ' already exists.', '\x1b[32m');
  }
  if (!resourceExists('target-http-proxies', conf.httpProxyName, '--global')) {
    log('Creating HTTP proxy ' + conf.httpProxyName + '...');
    run('gcloud compute target-http-proxies create ' + conf.httpProxyName + ' --project=' + PROJECT_ID + ' --url-map=' + conf.httpRedirectMap + ' --global');
  } else {
    log('HTTP proxy ' + conf.httpProxyName + ' already exists.', '\x1b[32m');
  }
  if (!resourceExists('forwarding-rules', conf.httpFwdRule, '--global')) {
    log('Creating HTTP forwarding rule ' + conf.httpFwdRule + '...');
    run([
      'gcloud compute forwarding-rules create ' + conf.httpFwdRule,
      '--project=' + PROJECT_ID,
      '--address=' + conf.staticIpName,
      '--target-http-proxy=' + conf.httpProxyName,
      '--ports=80',
      '--global',
    ].join(' '));
    log('HTTP→HTTPS redirect configured.', '\x1b[32m');
  } else {
    log('HTTP forwarding rule ' + conf.httpFwdRule + ' already exists.', '\x1b[32m');
  }
}

// ----- Step 10: Firewall Rule for Health Checks -----
function ensureFirewallRule() {
  log('Step 10: Ensuring firewall rule for LB health checks...', '\x1b[33m');
  const rawRules = run(
    'gcloud compute firewall-rules list --project=' + PROJECT_ID + ' --format="value(name)"',
    { silent: true }
  ) || '';
  const existing = new Set(rawRules.split('\n').map(r => r.trim()));
  if (existing.has(conf.fwRuleName)) {
    log('Firewall rule ' + conf.fwRuleName + ' already exists.', '\x1b[32m');
  } else {
    log('Creating firewall rule ' + conf.fwRuleName + '...');
    const ports = conf.backends.map(b => b.port).join(',');
    run([
      'gcloud compute firewall-rules create ' + conf.fwRuleName,
      '--project=' + PROJECT_ID,
      '--direction=INGRESS',
      '--priority=1000',
      '--network=default',
      '--action=ALLOW',
      '--rules=tcp:' + ports,
      '--source-ranges=35.191.0.0/16,130.211.0.0/22',
      '--target-tags=gocd-deploy-target',
      '--description="Allow GCP LB health check probes"',
    ].join(' '));
    log('Firewall rule ' + conf.fwRuleName + ' created.', '\x1b[32m');
  }
}

// ----- Step 11: DNS Records -----
function ensureDNSRecords(lbIP) {
  log('Step 11: Configuring Cloud DNS records...', '\x1b[33m');
  if (!lbIP) {
    log('WARNING: Could not determine Load Balancer IP. Skipping DNS configuration.', '\x1b[33m');
    return;
  }
  const zoneCheck = run(
    'gcloud dns managed-zones describe ' + conf.dnsZone + ' --project=' + PROJECT_ID + ' --format="value(name)"',
    { silent: true, ignoreError: true }
  );
  if (!zoneCheck) {
    log('WARNING: DNS zone ' + conf.dnsZone + ' not found. Skipping DNS configuration.', '\x1b[33m');
    return;
  }
  const existingRecords = run(
    'gcloud dns record-sets list --zone=' + conf.dnsZone + ' --project=' + PROJECT_ID + ' --format="value(name)"',
    { silent: true }
  ) || '';
  const records = [
    { name: conf.domain + '.', desc: conf.domain },
    { name: 'staging.' + conf.domain + '.', desc: 'staging.' + conf.domain },
    { name: 'app.' + conf.domain + '.', desc: 'app.' + conf.domain },
  ];
  for (const rec of records) {
    if (existingRecords.includes(rec.name)) {
      log('DNS A record for ' + rec.desc + ' already exists. Updating to ' + lbIP + '...');
      run('gcloud dns record-sets update ' + rec.name + ' --zone=' + conf.dnsZone + ' --project=' + PROJECT_ID + ' --type=A --ttl=300 --rrdatas=' + lbIP, { ignoreError: true });
    } else {
      log('Creating DNS A record: ' + rec.desc + ' → ' + lbIP + '...');
      run('gcloud dns record-sets create ' + rec.name + ' --zone=' + conf.dnsZone + ' --project=' + PROJECT_ID + ' --type=A --ttl=300 --rrdatas=' + lbIP, { ignoreError: true });
    }
  }
  log('DNS records configured.', '\x1b[32m');
}

// ----- Main -----
async function main() {
  console.log('\x1b[32m========================================\x1b[0m');
  console.log('\x1b[32m  GCP Load Balancer Setup (' + appName + ')\x1b[0m');
  console.log('\x1b[32m  Domain: ' + conf.domain + '\x1b[0m');
  console.log('\x1b[32m  Project: ' + PROJECT_ID + '\x1b[0m');
  console.log('\x1b[32m========================================\x1b[0m\n');

  ensureInstanceGroup();
  ensureHealthChecks();
  ensureBackendServices();
  const lbIP = ensureStaticIP();

  // Create the new versioned certificate (does NOT attach to proxy yet)
  const newCertName = createVersionedCert();   // <-- returns the cert name

  try {
    await confirmRecreateLoadBalancer();
    ensureURLMap();
    ensureHTTPSProxy(newCertName);             // <-- pass the versioned cert name
    ensureHTTPSForwardingRule();
  } catch (err) {
    if (err.message === 'SKIP_LB_RECREATE') {
      log('Load balancer components (URL map, proxy, forwarding rules) were NOT modified.', '\x1b[33m');
      // Even if LB not recreated, still update the proxy to the latest cert
      attachCertToProxy(newCertName);
    } else {
      throw err;
    }
  }

  // If the proxy already existed and wasn't recreated, attach the new cert now
  if (resourceExists('target-https-proxies', conf.httpsProxyName, '--global')) {
    attachCertToProxy(newCertName);
  }

  ensureHTTPRedirect();
  ensureFirewallRule();
  ensureDNSRecords(lbIP);

  console.log('\n\x1b[32m========================================\x1b[0m');
  console.log('\x1b[32m  Setup Complete!\x1b[0m');
  console.log('\x1b[32m========================================\x1b[0m\n');
  log('Load Balancer IP: ' + lbIP, '\x1b[32m');
}

main().catch(err => {
  console.error('\x1b[31mFATAL ERROR: ' + err.message + '\x1b[0m');
  process.exit(1);
}).finally(() => {
  logStream.end();
  originalConsoleLog('Log saved to: ' + logFilePath);
});