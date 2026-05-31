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
 *   setup-load-balancer-YYYY-MMM-DD-hh-mm.log
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

// ------------------------------------------------------------------
// Log file
// ------------------------------------------------------------------
const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const now = new Date();
const yyyy = now.getFullYear();
const mmm = months[now.getMonth()];
const dd = String(now.getDate()).padStart(2,'0');
const hhLog = String(now.getHours()).padStart(2,'0');
const minLog = String(now.getMinutes()).padStart(2,'0');
const logFileName = `setup-load-balancer-${yyyy}-${mmm}-${dd}-${hhLog}-${minLog}.log`;
const logFilePath = path.join(__dirname, logFileName);

const logStream = fs.createWriteStream(logFilePath, { flags: 'a' });

const originalConsoleLog = console.log;
console.log = function(...args) {
  const message = args.map(String).join(' ');
  originalConsoleLog.apply(console, args);
  logStream.write(message + '\n');
};

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

// ----- Certificate helpers -----
function getAttachedCerts(proxyName) {
  const output = run(
    `gcloud compute target-https-proxies describe ${proxyName} --project=${PROJECT_ID} --global --format="value(sslCertificates)"`,
    { silent: true, ignoreError: true }
  );
  if (!output) return [];
  return output.split(';').map(url => url.split('/').pop());
}

function getVersionedCertName() {
  const base = conf.certName;
  const attached = getAttachedCerts(conf.httpsProxyName);
  let maxVersion = 0;
  attached.forEach(certName => {
    if (certName.startsWith(base + '-v')) {
      const ver = parseInt(certName.split('-v')[1], 10);
      if (!isNaN(ver) && ver > maxVersion) maxVersion = ver;
    } else if (certName === base) {
      maxVersion = Math.max(maxVersion, 1);
    }
  });
  return base + '-v' + (maxVersion + 1);
}

function updateProxyCertificates(proxyName, certNames) {
  if (!resourceExists('target-https-proxies', proxyName, '--global')) return;
  const certList = certNames.join(',');
  log(`Updating HTTPS proxy ${proxyName} to use certificates: ${certList}...`);
  run(`gcloud compute target-https-proxies update ${proxyName} --project=${PROJECT_ID} --global --ssl-certificates=${certList}`);
}

function getActiveCertCoveringDomains(requiredDomains) {
  const output = run(
    `gcloud compute ssl-certificates list --global --project=${PROJECT_ID} --format="json" --filter="managed.status:ACTIVE"`,
    { silent: true, ignoreError: true }
  );
  if (!output) return null;
  try {
    const certs = JSON.parse(output);
    for (const cert of certs) {
      if (cert.managed && cert.managed.domains) {
        const certDomains = cert.managed.domains.sort().join(',');
        const neededDomains = [...requiredDomains].sort().join(',');
        if (certDomains === neededDomains) return cert.name;
      }
    }
  } catch (e) {}
  return null;
}

function attachCertToProxy(certName) {
  if (!resourceExists('target-https-proxies', conf.httpsProxyName, '--global')) return;
  if (!certName) {
    log('No valid certificate to attach – keeping current proxy certificate.', '\x1b[33m');
    return;
  }
  updateProxyCertificates(conf.httpsProxyName, [certName]);
}

// ----- Wait for a certificate to become ACTIVE (or fail) -----
function waitForCertActive(certName, maxWaitMinutes = 60) {
  const deadline = Date.now() + maxWaitMinutes * 60 * 1000;
  let lastStatus = null;
  while (Date.now() < deadline) {
    const status = run(
      `gcloud compute ssl-certificates describe ${certName} --global --project=${PROJECT_ID} --format="value(managed.status)"`,
      { silent: true, ignoreError: true }
    );
    if (status === 'ACTIVE') return true;
    if (status && status !== 'PROVISIONING' && status !== lastStatus) {
      log(`Certificate ${certName} status: ${status}`, '\x1b[33m');
      lastStatus = status;
    }
    if (status && status.includes('FAILED')) {
      log(`Certificate ${certName} provisioning failed: ${status}`, '\x1b[31m');
      return false;
    }
    sleep(15000);   // check every 15 seconds
  }
  return false;
}

// ----- Step 5: SSL Certificate (versioned, with automatic waiting) -----
function createVersionedCert() {
  log('Step 5: Ensuring multi-domain SSL certificate exists (versioned)...', '\x1b[33m');

  if (!conf.certDomains || !Array.isArray(conf.certDomains) || conf.certDomains.length === 0) {
    console.error('\x1b[31mERROR: No certDomains defined in loadbalancer.json for ' + appName + '\x1b[0m');
    process.exit(1);
  }
  const domainList = conf.certDomains;

  // If an active certificate already covers all domains, use it (skip provisioning)
  const existingActiveCert = getActiveCertCoveringDomains(domainList);
  if (existingActiveCert) {
    log(`Using existing active certificate: ${existingActiveCert}`, '\x1b[32m');
    return existingActiveCert;
  }

  // Create a new versioned certificate
  const newCertName = getVersionedCertName();
  log(`Will create new certificate: ${newCertName}`);

  if (resourceExists('ssl-certificates', newCertName, '--global')) {
    log(`Certificate ${newCertName} already exists.`, '\x1b[32m');
  } else {
    log(`Creating Google-managed certificate ${newCertName} for domains: ${domainList.join(',')}...`);
    run(`gcloud compute ssl-certificates create ${newCertName} --project=${PROJECT_ID} --domains=${domainList.join(',')} --global`);
    if (!resourceExists('ssl-certificates', newCertName, '--global')) {
      throw new Error(`Failed to create SSL certificate ${newCertName}.`);
    }
    log(`Certificate ${newCertName} created.`, '\x1b[33m');
  }

  // Wait for the certificate to become ACTIVE before returning it
  log(`Waiting for ${newCertName} to become ACTIVE (this may take 30-60 minutes)...`, '\x1b[33m');
  const certReady = waitForCertActive(newCertName);
  if (!certReady) {
    log(`Certificate ${newCertName} did not become ACTIVE within the timeout. You may need to check DNS or recreate it.`, '\x1b[31m');
    // Don't fail – the old certificate is still attached
    return null;
  }

  log(`Certificate ${newCertName} is ACTIVE.`, '\x1b[32m');
  return newCertName;
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

// ----- Helper to read current health check request path -----
function getHealthCheckRequestPath(healthCheckName) {
  const path = run(
    `gcloud compute health-checks describe ${healthCheckName} --global --project=${PROJECT_ID} --format="value(httpHealthCheck.requestPath)"`,
    { silent: true, ignoreError: true }
  );
  return path ? path.trim() : null;
}

// ----- Step 2: Health Checks (HTTP) -----
function ensureHealthChecks() {
  log('Step 2: Ensuring health checks exist with correct request paths...', '\x1b[33m');

  for (const b of conf.backends) {
    const healthPath = b.pathPrefix ? (b.pathPrefix + '/') : '/';

    if (resourceExists('health-checks', b.healthCheck, '--global')) {
      const currentPath = getHealthCheckRequestPath(b.healthCheck);
      if (currentPath !== healthPath) {
        log(`Updating health check ${b.healthCheck} request path from ${currentPath} to ${healthPath}...`);
        run(`gcloud compute health-checks update http ${b.healthCheck} --global --project=${PROJECT_ID} --request-path=${healthPath}`, { stdio: 'inherit' });
      } else {
        log(`Health check ${b.healthCheck} already exists with correct path.`, '\x1b[32m');
      }
    } else {
      log(`Creating health check ${b.healthCheck} (HTTP port ${b.port}, path ${healthPath})...`);
      run(`gcloud compute health-checks create http ${b.healthCheck} --project=${PROJECT_ID} --port=${b.port} --request-path=${healthPath} --global`);
      log(`Health check ${b.healthCheck} created.`, '\x1b[32m');
    }
  }
}

// ----- Step 3: Backend Services (HTTP) -----
function ensureBackendServices() {
  log('Step 3: Ensuring backend services exist with correct protocol and port...', '\x1b[33m');
  for (const b of conf.backends) {
    if (resourceExists('backend-services', b.name, '--global')) {
      const info = run(
        `gcloud compute backend-services describe ${b.name} --global --project=${PROJECT_ID} --format="value(protocol,portName)"`,
        { silent: true, ignoreError: true }
      );
      if (info) {
        const [currentProtocol, currentPort] = info.split('\t');
        let needsUpdate = false;
        const updateArgs = [];
        if (currentProtocol !== 'HTTP') {
          updateArgs.push('--protocol=HTTP');
          needsUpdate = true;
        }
        if (currentPort !== b.namedPort) {
          updateArgs.push(`--port-name=${b.namedPort}`);
          needsUpdate = true;
        }
        if (needsUpdate) {
          log(`Updating backend service ${b.name} (protocol ${currentProtocol}→HTTP, port ${currentPort}→${b.namedPort})...`);
          run(`gcloud compute backend-services update ${b.name} --global --project=${PROJECT_ID} ${updateArgs.join(' ')}`);
        } else {
          log(`Backend service ${b.name} already correct.`, '\x1b[32m');
        }
      }
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

  log('Creating URL map ' + conf.lbName + ' (default → ' + DEFAULT_BACKEND + ')...');
  run('gcloud compute url-maps create ' + conf.lbName + ' --project=' + PROJECT_ID + ' --default-service=' + DEFAULT_BACKEND + ' --global');

  // 1. Add host rules for subdomain‑based backends (without pathPrefix)
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

  // 2. For each unique bare domain used in path‑based backends, create ONE host rule
  const pathBackends = conf.backends.filter(b => b.host && b.pathPrefix);
  const bareHosts = [...new Set(pathBackends.map(b => b.host))];
  for (const bareHost of bareHosts) {
    const matcherName = bareHost.replace(/\./g, '-') + '-default';

    // Build path rules: for each backend, add both exact path and wildcard
    const rules = [];
    pathBackends.filter(b => b.host === bareHost).forEach(b => {
      rules.push(b.pathPrefix + '=' + b.name);
      rules.push(b.pathPrefix + '/*=' + b.name);
    });
    const pathsForThisHost = rules.join(',');

    log(`Creating host rule for ${bareHost} with default → ${DEFAULT_BACKEND} and paths ${pathsForThisHost}...`);
    run('gcloud compute url-maps remove-path-matcher ' + conf.lbName + ' --project=' + PROJECT_ID + ' --path-matcher-name=' + matcherName + ' --global', { silent: true, ignoreError: true });
    run([
      'gcloud compute url-maps add-path-matcher ' + conf.lbName,
      '--project=' + PROJECT_ID,
      '--path-matcher-name=' + matcherName,
      '--default-service=' + DEFAULT_BACKEND,
      '--new-hosts=' + bareHost,
      '--path-rules=' + pathsForThisHost,
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

  // 2. For each unique bare domain, recreate the host rule with the correct default + all path rules
  const pathBackends = conf.backends.filter(b => b.host && b.pathPrefix);
  const bareHosts = [...new Set(pathBackends.map(b => b.host))];
  for (const bareHost of bareHosts) {
    const matcherName = bareHost.replace(/\./g, '-') + '-default';
    const rules = [];
    pathBackends.filter(b => b.host === bareHost).forEach(b => {
      rules.push(b.pathPrefix + '=' + b.name);
      rules.push(b.pathPrefix + '/*=' + b.name);
    });
    const pathsForThisHost = rules.join(',');

    log(`Ensuring host rule for ${bareHost} with default → ${DEFAULT_BACKEND} and paths ${pathsForThisHost}...`);
    run('gcloud compute url-maps remove-path-matcher ' + conf.lbName + ' --project=' + PROJECT_ID + ' --path-matcher-name=' + matcherName + ' --global', { silent: true, ignoreError: true });
    run([
      'gcloud compute url-maps add-path-matcher ' + conf.lbName,
      '--project=' + PROJECT_ID,
      '--path-matcher-name=' + matcherName,
      '--default-service=' + DEFAULT_BACKEND,
      '--new-hosts=' + bareHost,
      '--path-rules=' + pathsForThisHost,
      '--delete-orphaned-path-matcher',
      '--global',
    ].join(' '));
  }
}

// ----- Step 7: Target HTTPS Proxy -----
function ensureHTTPSProxy(certNameToUse) {
  log('Step 7: Ensuring HTTPS proxy exists...', '\x1b[33m');

  // Fallback to base cert name if no valid cert provided (should rarely happen)
  const cert = certNameToUse || conf.certName;

  if (resourceExists('target-https-proxies', conf.httpsProxyName, '--global')) {
    log('HTTPS proxy ' + conf.httpsProxyName + ' already exists.', '\x1b[32m');
    if (certNameToUse) {
      updateProxyCertificates(conf.httpsProxyName, [cert]);
    }
  } else {
    log('Creating HTTPS proxy ' + conf.httpsProxyName + '...');
    run([
      'gcloud compute target-https-proxies create ' + conf.httpsProxyName,
      '--project=' + PROJECT_ID,
      '--url-map=' + conf.lbName,
      '--ssl-certificates=' + cert,
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

// ----- Step 10: Firewall Rules -----
function ensureFirewallRules() {
  log('Step 10: Ensuring firewall rules for LB health checks and traffic...', '\x1b[33m');
  const ports = conf.backends.map(b => b.port);

  // Health check rule (restricted source ranges)
  const hcRule = conf.fwRuleName;
  const rawRules = run(
    'gcloud compute firewall-rules list --project=' + PROJECT_ID + ' --format="value(name)"',
    { silent: true }
  ) || '';
  const existing = new Set(rawRules.split('\n').map(r => r.trim()));
  if (existing.has(hcRule)) {
    log(`Firewall rule ${hcRule} already exists – updating ports if necessary...`);
    const hcPorts = ports.map(p => `tcp:${p}`).join(',');
    run(`gcloud compute firewall-rules update ${hcRule} --project=${PROJECT_ID} --rules=${hcPorts}`, { silent: true, ignoreError: true });
  } else {
    log(`Creating firewall rule ${hcRule}...`);
    const hcPorts = ports.map(p => `tcp:${p}`).join(',');
    run([
      'gcloud compute firewall-rules create ' + hcRule,
      '--project=' + PROJECT_ID,
      '--direction=INGRESS',
      '--priority=1000',
      '--network=default',
      '--action=ALLOW',
      '--rules=' + hcPorts,
      '--source-ranges=35.191.0.0/16,130.211.0.0/22',
      '--target-tags=gocd-deploy-target',
      '--description="Allow GCP LB health check probes"',
    ].join(' '));
    log(`Firewall rule ${hcRule} created.`, '\x1b[32m');
  }

  // Traffic rule for actual load‑balancer forwarding (all sources)
  const trafficRuleName = `${conf.fwRuleName}-traffic`;
  if (existing.has(trafficRuleName)) {
    log(`Firewall rule ${trafficRuleName} already exists – updating ports if necessary...`);
    const trafficPorts = ports.map(p => `tcp:${p}`).join(',');
    run(`gcloud compute firewall-rules update ${trafficRuleName} --project=${PROJECT_ID} --rules=${trafficPorts}`, { silent: true, ignoreError: true });
  } else {
    log(`Creating firewall rule ${trafficRuleName} (allow all sources)...`);
    const trafficPorts = ports.map(p => `tcp:${p}`).join(',');
    run([
      'gcloud compute firewall-rules create ' + trafficRuleName,
      '--project=' + PROJECT_ID,
      '--direction=INGRESS',
      '--priority=1000',
      '--network=default',
      '--action=ALLOW',
      '--rules=' + trafficPorts,
      '--source-ranges=0.0.0.0/0',
      '--target-tags=gocd-deploy-target',
      '--description="Allow load balancer forwarding traffic"',
    ].join(' '));
    log(`Firewall rule ${trafficRuleName} created.`, '\x1b[32m');
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

  const newCertName = createVersionedCert();

  try {
    await confirmRecreateLoadBalancer();
    ensureURLMap();
    ensureHTTPSProxy(newCertName);
    ensureHTTPSForwardingRule();
  } catch (err) {
    if (err.message === 'SKIP_LB_RECREATE') {
      log('Load balancer components (URL map, proxy, forwarding rules) were NOT modified.', '\x1b[33m');
      attachCertToProxy(newCertName);
    } else {
      throw err;
    }
  }

  if (resourceExists('target-https-proxies', conf.httpsProxyName, '--global')) {
    attachCertToProxy(newCertName);
  }

  ensureHTTPRedirect();
  ensureFirewallRules();
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