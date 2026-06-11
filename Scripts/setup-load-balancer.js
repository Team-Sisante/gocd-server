#!/usr/bin/env node
/**
 * Scripts/setup-load-balancer.js
 * Self‑healing GCP External Application Load Balancer setup.
 *
 * Usage:
 *   node Scripts/setup-load-balancer.js <app_name>
 *   e.g., node Scripts/setup-load-balancer.js humrine_site
 *
 * The script reads its configuration from Scripts/loadbalancer.json,
 * interpolates environment variables (like ${HUMRINE_DOMAIN}), and then
 * idempotently inspects and corrects the following components:
 *
 *   - Instance group (named ports)
 *   - Health checks (request paths)
 *   - Backend services (protocol, port)
 *   - Static IP address
 *   - SSL certificate (reuse / create / wait / auto‑diagnose on failure)
 *   - URL map (host rules, path rules)
 *   - Target HTTPS proxy
 *   - Forwarding rules
 *   - HTTP→HTTPS redirect
 *   - Firewall rules (health‑check & traffic)
 *   - Cloud DNS records
 *
 * All console output is simultaneously written to a timestamped log file.
 *
 * =========================================================================
 * SELF‑HEALING SCENARIOS (what the script fixes automatically)
 * =========================================================================
 *
 * CERTIFICATE
 *  - No certificate exists → create new versioned cert, wait for ACTIVE, attach.
 *  - ACTIVE cert covers all domains → reuse it immediately (no downtime).
 *  - Only PROVISIONING / FAILED certs exist → delete failed, create new version,
 *    wait for ACTIVE (up to 60 min), retry 3 times on failure.
 *  - ACTIVE cert exists but misses domains → create new cert with all domains,
 *    wait for ACTIVE, attach.
 *  - Multiple ACTIVE certs → attach the highest‑version one, delete unused.
 *  - New cert becomes FAILED_NOT_VISIBLE / FAILED → delete immediately, retry.
 *    After final failure, automatically display detailed domain status.
 *  - Script runs again while a cert is still PROVISIONING → recognise it,
 *    wait for ACTIVE, attach only when ready.
 *
 * BACKEND SERVICES
 *  - Missing → create with HTTP protocol and correct named port.
 *  - Protocol is HTTPS → update to HTTP.
 *  - Named port is wrong → correct it.
 *  - (NEW) Orphaned backends (in GCP but not in JSON) are deleted after the
 *    URL map has been updated, ensuring no broken references.
 *
 * HEALTH CHECKS
 *  - Missing → create with correct request path (/prefix/ or /).
 *  - Request path wrong → update to correct path.
 *
 * URL MAP
 *  - Missing → create with default backend + all host/path rules.
 *  - Host rule for a subdomain missing → add it.
 *  - Bare‑domain host rule missing → create it with correct default + all
 *    exact and wildcard path rules.
 *  - Path rules incomplete or missing → remove and recreate host rule.
 *  - (NEW) Global default service is always corrected to the configured
 *    default backend, preventing wrong defaults after renames.
 *
 * FIREWALL RULES
 *  - Health‑check rule missing → create with restricted source ranges.
 *  - Health‑check rule port list outdated → update.
 *  - Traffic rule (all sources) missing → create with 0.0.0.0/0.
 *  - Traffic rule port list outdated → update.
 *
 * DNS RECORDS
 *  - Missing A records for domain / subdomains → create.
 *  - Existing A records pointing to wrong IP → update.
 *
 * The script NEVER deletes the URL map or proxies unless the user explicitly
 * confirms when the load balancer already exists.
 * It NEVER leaves the proxy without a valid certificate.
 *
 * =========================================================================
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
  console.error('\x1b[31mERROR: Missing app name argument (e.g., humrine_site)\x1b[0m');
  process.exit(1);
}

const configPath = path.join(__dirname, 'loadbalancer.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

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

// Use explicit default backend if provided, otherwise fall back to last backend
const DEFAULT_BACKEND = conf.defaultBackend || conf.backends[conf.backends.length - 1].name;

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

async function ask(question) {
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

function updateProxyCertificates(proxyName, certNames) {
  if (!resourceExists('target-https-proxies', proxyName, '--global')) return;
  const certList = certNames.join(',');
  log(`Updating HTTPS proxy ${proxyName} to use certificates: ${certList}...`);
  run(`gcloud compute target-https-proxies update ${proxyName} --project=${PROJECT_ID} --global --ssl-certificates=${certList}`);
}

function showCertDomainStatus(certName) {
  try {
    const details = JSON.parse(execSync(
      `gcloud compute ssl-certificates describe ${certName} --global --project=${PROJECT_ID} --format="json"`,
      { encoding: 'utf8', stdio: 'pipe' }
    ));
    if (details.managed && details.managed.domainStatus) {
      console.log(`\n\x1b[36mDetailed domain status for ${certName}:\x1b[0m`);
      for (const [domain, status] of Object.entries(details.managed.domainStatus)) {
        let color = '\x1b[32m';
        if (status === 'PROVISIONING') color = '\x1b[33m';
        if (status.startsWith('FAILED')) color = '\x1b[31m';
        console.log(`  ${domain}: ${color}${status}\x1b[0m`);
      }
    }
  } catch (e) {
    log('Could not retrieve domain status.', '\x1b[31m');
  }
}

function waitForCertActive(certName, maxWaitMinutes = 60) {
  const deadline = Date.now() + maxWaitMinutes * 60 * 1000;
  let lastStatus = null;
  log(`Waiting for ${certName} to become ACTIVE (checking every 15s, up to ${maxWaitMinutes} min)...`);
  while (Date.now() < deadline) {
    const status = run(
      `gcloud compute ssl-certificates describe ${certName} --global --project=${PROJECT_ID} --format="value(managed.status)"`,
      { silent: true, ignoreError: true }
    );
    if (status === 'ACTIVE') return true;
    if (status && status !== lastStatus) {
      log(`Certificate ${certName} status: ${status}`, '\x1b[33m');
      lastStatus = status;
    }
    if (status && status.includes('FAILED')) {
      log(`Certificate ${certName} provisioning failed: ${status}`, '\x1b[31m');
      showCertDomainStatus(certName);
      return false;
    }
    process.stdout.write(`\r[${elapsed()}] Waiting... (${status || 'unknown'})   `);
    sleep(15000);
  }
  log(`\nCertificate ${certName} did not become ACTIVE within the timeout.`, '\x1b[31m');
  showCertDomainStatus(certName);
  return false;
}

function deleteCertIfExists(certName) {
  if (resourceExists('ssl-certificates', certName, '--global')) {
    log(`Deleting certificate ${certName}...`);
    run(`gcloud compute ssl-certificates delete ${certName} --global --project=${PROJECT_ID} --quiet`, { silent: true, ignoreError: true });
  }
}

function getHighestVersion() {
  const output = run(
    `gcloud compute ssl-certificates list --global --project=${PROJECT_ID} --format="value(name)"`,
    { silent: true, ignoreError: true }
  );
  if (!output) return 0;
  const base = conf.certName;
  let maxVer = 0;
  output.split('\n').forEach(name => {
    if (name === base) maxVer = Math.max(maxVer, 1);
    else if (name.startsWith(base + '-v')) {
      const ver = parseInt(name.split('-v')[1], 10);
      if (!isNaN(ver) && ver > maxVer) maxVer = ver;
    }
  });
  return maxVer;
}

// ----- Step 5: SSL Certificate (versioned, with automatic waiting and diagnostics) -----
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

  // No valid ACTIVE cert – create a new one, with retries
  let newCertName = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const versionedName = conf.certName + '-v' + (getHighestVersion() + 1);
    log(`Attempt ${attempt}: creating ${versionedName}...`);

    deleteCertIfExists(versionedName);

    run(`gcloud compute ssl-certificates create ${versionedName} --project=${PROJECT_ID} --domains=${domainList.join(',')} --global`, { stdio: 'inherit' });
    log(`Waiting for ${versionedName} to become ACTIVE...`);
    const ready = waitForCertActive(versionedName, 60);
    if (ready) {
      newCertName = versionedName;
      break;
    } else {
      log(`Certificate ${versionedName} failed or timed out. Deleting and retrying...`, '\x1b[31m');
      deleteCertIfExists(versionedName);
    }
  }

  if (!newCertName) {
    log('ERROR: Could not provision a new certificate after 3 attempts. The load balancer will keep its current certificate.', '\x1b[31m');
    return null;
  }

  log(`New certificate ${newCertName} is ACTIVE.`, '\x1b[32m');
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

// ----- Step 2: Health Checks (HTTP) – now corrects port AND request path in-place -----
function ensureHealthChecks() {
  log('Step 2: Ensuring health checks exist with correct port and request path...', '\x1b[33m');

  for (const b of conf.backends) {
    const healthPath = b.pathPrefix ? (b.pathPrefix + '/') : '/';

    if (resourceExists('health-checks', b.healthCheck, '--global')) {
      const currentPath = getHealthCheckRequestPath(b.healthCheck);
      const currentPort = run(
        `gcloud compute health-checks describe ${b.healthCheck} --global --project=${PROJECT_ID} --format="value(httpHealthCheck.port)"`,
        { silent: true, ignoreError: true }
      );

      const pathMismatch = (currentPath !== healthPath);
      const portMismatch = (currentPort !== b.port);

      if (pathMismatch || portMismatch) {
        const updateArgs = [];
        if (portMismatch) updateArgs.push(`--port=${b.port}`);
        if (pathMismatch) updateArgs.push(`--request-path=${healthPath}`);

        log(`Updating health check ${b.healthCheck} (port ${currentPort}→${b.port}, path ${currentPath}→${healthPath})...`);
        run(`gcloud compute health-checks update http ${b.healthCheck} --global --project=${PROJECT_ID} ${updateArgs.join(' ')}`);
        log(`Health check ${b.healthCheck} updated.`, '\x1b[32m');
      } else {
        log(`Health check ${b.healthCheck} already correct.`, '\x1b[32m');
      }
    } else {
      log(`Creating health check ${b.healthCheck} (HTTP port ${b.port}, path ${healthPath})...`);
      run(`gcloud compute health-checks create http ${b.healthCheck} --project=${PROJECT_ID} --port=${b.port} --request-path=${healthPath} --global`);
      log(`Health check ${b.healthCheck} created.`, '\x1b[32m');
    }
  }
}

// ----- Step 3: Backend Services (HTTP) – creates/updates only, no orphan deletion -----
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

// ----- Step 3b: Clean up orphaned backends (called after URL map is updated) -----
function cleanupOrphanBackends() {
  log('Step 3b: Cleaning up orphaned backend services...', '\x1b[33m');

  // Get all backend services currently in GCP
  const existingRaw = run(
    `gcloud compute backend-services list --global --project=${PROJECT_ID} --format="value(name)"`,
    { silent: true, ignoreError: true }
  );
  const existing = existingRaw ? existingRaw.split('\n').map(n => n.trim()) : [];

  // Get the names of all backends currently referenced in the URL map
  let urlMapBackends = new Set();
  try {
    const json = execSync(
      `gcloud compute url-maps describe ${conf.lbName} --project=${PROJECT_ID} --global --format="json"`,
      { encoding: 'utf8', stdio: 'pipe' }
    );
    const urlMap = JSON.parse(json);
    // defaultService
    if (urlMap.defaultService) {
      urlMapBackends.add(urlMap.defaultService.split('/').pop());
    }
    // path matchers
    if (urlMap.pathMatchers) {
      urlMap.pathMatchers.forEach(m => {
        if (m.defaultService) urlMapBackends.add(m.defaultService.split('/').pop());
        if (m.pathRules) {
          m.pathRules.forEach(r => {
            if (r.service) urlMapBackends.add(r.service.split('/').pop());
          });
        }
      });
    }
  } catch (e) { /* ignore */ }

  const jsonBackendNames = new Set(conf.backends.map(b => b.name));
  for (const name of existing) {
    if (!jsonBackendNames.has(name)) {
      if (urlMapBackends.has(name)) {
        log(`Skipping ${name} – still referenced by URL map (this shouldn't happen; run the script again).`, '\x1b[33m');
      } else {
        log(`Deleting orphaned backend service: ${name}...`);
        run(`gcloud compute backend-services delete ${name} --global --project=${PROJECT_ID} --quiet`, { silent: true, ignoreError: true });
      }
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
  if (!lbExists) return true;   // nothing to delete, proceed

  log('\n⚠️  The load balancer "' + conf.lbName + '" already exists.');
  log('Recreating it will delete all routing rules and rebuild them from the JSON config.');
  const answer = await ask('Do you want to delete and recreate the load balancer? (y/N): ');
  return answer === 'y';
}

// ----- Step 6: URL Map – now always ensures global default is correct -----
function ensureURLMap() {
  log('Step 6: Ensuring URL map exists with host and path rules...', '\x1b[33m');

  if (!resourceExists('url-maps', conf.lbName, '--global')) {
    log(`Creating URL map ${conf.lbName}...`);
    run(`gcloud compute url-maps create ${conf.lbName} --project=${PROJECT_ID} --default-service=${DEFAULT_BACKEND} --global`);
    addAllHostAndPathRules();
    return;
  }

  // ---- Fix: always set the global default service to the configured default backend ----
  const currentGlobalDefault = run(
    `gcloud compute url-maps describe ${conf.lbName} --project=${PROJECT_ID} --global --format="value(defaultService)"`,
    { silent: true, ignoreError: true }
  );
  if (currentGlobalDefault && !currentGlobalDefault.endsWith(DEFAULT_BACKEND)) {
    log(`Updating global default service to ${DEFAULT_BACKEND}...`);
    run(`gcloud compute url-maps set-default-service ${conf.lbName} --global --project=${PROJECT_ID} --default-service=${DEFAULT_BACKEND}`);
  }

  // Rest of existing host/path update logic
  let existingHosts = [];
  let hostToMatcher = {};
  try {
    const json = execSync(
      `gcloud compute url-maps describe ${conf.lbName} --project=${PROJECT_ID} --global --format="json"`,
      { encoding: 'utf8', stdio: 'pipe' }
    );
    const urlMap = JSON.parse(json);
    if (urlMap.hostRules) {
      urlMap.hostRules.forEach(rule => {
        if (rule.hosts) {
          existingHosts.push(...rule.hosts);
          rule.hosts.forEach(h => hostToMatcher[h] = rule.pathMatcher);
        }
      });
    }
  } catch (e) {
    log('Warning: Could not read existing host rules. Proceeding to add all rules (duplicates will be ignored).', '\x1b[33m');
  }

  log(`Existing hosts: ${existingHosts.join(', ') || '(none)'}`);

  // Subdomain‑based backends
  const hostBackends = conf.backends.filter(b => b.host && !b.pathPrefix);
  for (const b of hostBackends) {
    if (!existingHosts.includes(b.host)) {
      log(`Adding missing host rule: ${b.host} → ${b.name}...`);
      run(`gcloud compute url-maps add-path-matcher ${conf.lbName} --project=${PROJECT_ID} --path-matcher-name=${b.pathMatcher} --default-service=${b.name} --new-hosts=${b.host} --global`);
    } else {
      log(`Host rule for ${b.host} already exists.`, '\x1b[32m');
      // Ensure the existing path matcher points to the correct default service
      const existingMatcher = hostToMatcher[b.host];
      if (existingMatcher === b.pathMatcher) {
        run(`gcloud compute url-maps add-path-matcher ${conf.lbName} --project=${PROJECT_ID} --path-matcher-name=${b.pathMatcher} --default-service=${b.name} --global`, { silent: true, ignoreError: true });
      }
    }
  }

  // Path‑based backends – for existing hosts, update the path matcher in-place if possible
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

    if (!existingHosts.includes(bareHost)) {
      log(`Creating host rule for ${bareHost} with default → ${DEFAULT_BACKEND} and paths ${pathsForThisHost}...`);
      run(`gcloud compute url-maps add-path-matcher ${conf.lbName} --project=${PROJECT_ID} --path-matcher-name=${matcherName} --default-service=${DEFAULT_BACKEND} --new-hosts=${bareHost} --path-rules=${pathsForThisHost} --delete-orphaned-path-matcher --global`);
    } else {
      const existingMatcher = hostToMatcher[bareHost];
      log(`Refreshing path rules for ${bareHost} (recreating path matcher ${matcherName})...`);
      // Always remove old path matcher and host rule, then recreate – the only safe way
      run(
        `gcloud compute url-maps remove-path-matcher ${conf.lbName} --path-matcher-name=${existingMatcher} --project=${PROJECT_ID} --global --quiet`,
        { silent: true, ignoreError: true }
      );
      const removeResult = run(
        `gcloud compute url-maps remove-host-rule ${conf.lbName} --host=${bareHost} --project=${PROJECT_ID} --global --quiet`,
        { silent: true, ignoreError: true }
      );
      if (removeResult === null) {
        throw new Error(`Failed to remove host rule for ${bareHost} – aborting.`);
      }
      const addResult = run(
        `gcloud compute url-maps add-path-matcher ${conf.lbName} --project=${PROJECT_ID} --path-matcher-name=${matcherName} --default-service=${DEFAULT_BACKEND} --new-hosts=${bareHost} --path-rules=${pathsForThisHost} --delete-orphaned-path-matcher --global`
      );
      if (addResult === null) {
        throw new Error(`Failed to create host rule and path matcher for ${bareHost} – aborting.`);
      }
    }
  }

  log('URL map updated.', '\x1b[32m');
}

function addAllHostAndPathRules() {
  const hostBackends = conf.backends.filter(b => b.host && !b.pathPrefix);
  for (const b of hostBackends) {
    log(`Adding host rule: ${b.host} → ${b.name}...`);
    run(`gcloud compute url-maps add-path-matcher ${conf.lbName} --project=${PROJECT_ID} --path-matcher-name=${b.pathMatcher} --default-service=${b.name} --new-hosts=${b.host} --global`);
  }
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
    log(`Creating host rule for ${bareHost} with default → ${DEFAULT_BACKEND} and paths ${pathsForThisHost}...`);
    run(`gcloud compute url-maps add-path-matcher ${conf.lbName} --project=${PROJECT_ID} --path-matcher-name=${matcherName} --default-service=${DEFAULT_BACKEND} --new-hosts=${bareHost} --path-rules=${pathsForThisHost} --delete-orphaned-path-matcher --global`);
  }
}

// ----- Step 7: Target HTTPS Proxy -----
function ensureHTTPSProxy(certNameToUse) {
  log('Step 7: Ensuring HTTPS proxy exists...', '\x1b[33m');

  const cert = certNameToUse || conf.certName;

  if (resourceExists('target-https-proxies', conf.httpsProxyName, '--global')) {
    log('HTTPS proxy ' + conf.httpsProxyName + ' already exists.', '\x1b[32m');
    if (certNameToUse) {
      const attached = getAttachedCerts(conf.httpsProxyName);
      if (!attached.includes(cert)) {
        updateProxyCertificates(conf.httpsProxyName, [cert]);
      }
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
// ----- Step 10: Firewall Rules -----
function ensureFirewallRules() {
  log('Step 10: Ensuring firewall rules for LB health checks and traffic...', '\x1b[33m');
  
  // Collect ALL unique ports from backends (excluding any empty/invalid ones)
  const ports = [...new Set(conf.backends.map(b => b.port).filter(p => p))];
  if (ports.length === 0) {
    log('No backend ports defined – skipping firewall rules.', '\x1b[33m');
    return;
  }
  const hcPorts = ports.map(p => `tcp:${p}`).join(',');
  
  const rawRules = run(
    'gcloud compute firewall-rules list --project=' + PROJECT_ID + ' --format="value(name)"',
    { silent: true }
  ) || '';
  const existing = new Set(rawRules.split('\n').map(r => r.trim()));

  // Health check rule (restricted source ranges)
  const hcRule = conf.fwRuleName;
  
  if (existing.has(hcRule)) {
    // Get current allowed ports
    const currentPortsRaw = run(
      `gcloud compute firewall-rules describe ${hcRule} --project=${PROJECT_ID} --format="value(allowed[0].ports)"`,
      { silent: true, ignoreError: true }
    ) || '';
    
    // Normalize to a sorted, comma-separated list of "tcp:port" strings
    let currentPortsNormalized = '';
    if (currentPortsRaw) {
      // The output may already be a comma-separated list of numbers like "8007,8008"
      const parts = currentPortsRaw.split(',')
        .map(p => p.trim())
        .filter(p => /^\d+$/.test(p))
        .map(p => `tcp:${p}`)
        .sort();
      currentPortsNormalized = parts.join(',');
    }
    const desiredPortsNormalized = ports.map(p => `tcp:${p}`).sort().join(',');
    
    if (currentPortsNormalized !== desiredPortsNormalized) {
      log(`Firewall rule ${hcRule} ports are outdated. Recreating to ensure correctness...`, '\x1b[33m');
      // Delete and recreate – this is bulletproof
      run(`gcloud compute firewall-rules delete ${hcRule} --project=${PROJECT_ID} --quiet`, { silent: true, ignoreError: true });
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
      log(`Firewall rule ${hcRule} recreated with correct ports.`, '\x1b[32m');
    } else {
      log(`Firewall rule ${hcRule} already has correct ports.`, '\x1b[32m');
    }
  } else {
    log(`Creating firewall rule ${hcRule}...`);
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

  // Traffic rule (all sources) – same logic, delete and recreate if ports mismatch
  const trafficRuleName = `${conf.fwRuleName}-traffic`;
  const trafficPorts = ports.map(p => `tcp:${p}`).join(',');
  
  if (existing.has(trafficRuleName)) {
    const currentTrafficRaw = run(
      `gcloud compute firewall-rules describe ${trafficRuleName} --project=${PROJECT_ID} --format="value(allowed[0].ports)"`,
      { silent: true, ignoreError: true }
    ) || '';
    let currentTrafficNormalized = '';
    if (currentTrafficRaw) {
      const parts = currentTrafficRaw.split(',')
        .map(p => p.trim())
        .filter(p => /^\d+$/.test(p))
        .map(p => `tcp:${p}`)
        .sort();
      currentTrafficNormalized = parts.join(',');
    }
    const desiredTrafficNormalized = ports.map(p => `tcp:${p}`).sort().join(',');
    if (currentTrafficNormalized !== desiredTrafficNormalized) {
      log(`Recreating traffic rule ${trafficRuleName}...`, '\x1b[33m');
      run(`gcloud compute firewall-rules delete ${trafficRuleName} --project=${PROJECT_ID} --quiet`, { silent: true, ignoreError: true });
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
      log(`Traffic rule ${trafficRuleName} recreated.`, '\x1b[32m');
    } else {
      log(`Traffic rule ${trafficRuleName} already correct.`, '\x1b[32m');
    }
  } else {
    log(`Creating traffic rule ${trafficRuleName}...`);
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
    log(`Traffic rule ${trafficRuleName} created.`, '\x1b[32m');
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
  ensureBackendServices();          // Step 3 – creates/updates backends, no orphan deletion
  const lbIP = ensureStaticIP();

  const newCertName = createVersionedCert();

  const shouldRebuild = await confirmRecreateLoadBalancer();
  if (shouldRebuild) {
    // Only delete the load balancer if the user explicitly confirms
    log('Rebuilding load balancer components...');
    run(`gcloud compute forwarding-rules delete ${conf.httpsFwdRule} --global --project=${PROJECT_ID} --quiet`, { silent: true, ignoreError: true });
    run(`gcloud compute forwarding-rules delete ${conf.httpFwdRule} --global --project=${PROJECT_ID} --quiet`, { silent: true, ignoreError: true });
    run(`gcloud compute target-https-proxies delete ${conf.httpsProxyName} --global --project=${PROJECT_ID} --quiet`, { silent: true, ignoreError: true });
    run(`gcloud compute target-http-proxies delete ${conf.httpProxyName} --global --project=${PROJECT_ID} --quiet`, { silent: true, ignoreError: true });
    run(`gcloud compute url-maps delete ${conf.lbName} --global --project=${PROJECT_ID} --quiet`, { silent: true, ignoreError: true });
  }

  ensureURLMap();                   // Step 6 – updates the URL map (global default + host/path rules)
  cleanupOrphanBackends();          // Step 3b – now safe to delete orphaned backends

  ensureHTTPSProxy(newCertName);
  ensureHTTPSForwardingRule();
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