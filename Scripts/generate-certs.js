// Scripts/generate-certs.js

// Suppress deprecation warnings from sudo-prompt package
process.noDeprecation = true;

const fs = require('fs');
const { execSync } = require('child_process');
const path = require('path');
const os = require('os');
const sudo = require('sudo-prompt');
const dotenv = require('dotenv');

console.log('--- Starting Certificate Generation and Host Configuration (Node.js) ---');

// Load environment variables from BOTH .env.dev and .env.docker
const envDevPath = path.resolve(__dirname, '..', '.env.dev');
const envDockerPath = path.resolve(__dirname, '..', '.env.docker');

console.log('Loading environment variables from both .env files...');

// Load .env.dev first
if (fs.existsSync(envDevPath)) {
  dotenv.config({ path: envDevPath });
  console.log('✓ Loaded .env.dev');
} else {
  console.warn('⚠ Warning: .env.dev not found');
}

// Load .env.docker and collect hostname
const envDockerHostname = (() => {
  if (fs.existsSync(envDockerPath)) {
    const envConfig = dotenv.parse(fs.readFileSync(envDockerPath));
    console.log('✓ Loaded .env.docker');
    return envConfig.POSTE_HOSTNAME;
  } else {
    console.warn('⚠ Warning: .env.docker not found');
    return null;
  }
})();

// Determine which environment we're running in for other settings
const environment = process.env.ENVIRONMENT || 'development';
const primaryEnvFile = environment === 'docker' ? '.env.docker' : '.env.dev';

// Use environment variables with fallback defaults
const certDir = process.env.CERT_DIR || 'certs';
const certName = process.env.CERT_NAME || 'posteio';
const hostIp = process.env.HOST_IP || '127.0.0.1';

// Collect hostnames from both environments
const hostnames = new Set(['localhost']); // Always include localhost

// Add hostname from .env.dev
const envDevHostname = process.env.POSTE_HOSTNAME;
if (envDevHostname) {
  hostnames.add(envDevHostname);
}

// Add hostname from .env.docker
if (envDockerHostname) {
  hostnames.add(envDockerHostname);
}

// Convert Set to Array and filter out any undefined/null values
const hostnamesArray = Array.from(hostnames).filter(Boolean);

// Use the primary environment's hostname as the Common Name
const commonName = environment === 'docker' ? envDockerHostname : envDevHostname;

console.log(`\nConfiguration:`);
console.log(`  Primary environment: ${environment} (using ${primaryEnvFile})`);
console.log(`  Primary hostname (CN): ${commonName}`);
console.log(`  All hostnames (SAN): ${hostnamesArray.join(', ')}`);
console.log(`  IP: ${hostIp}`);
console.log(`  Cert Directory: ${certDir}`);
console.log(`  Cert Name: ${certName}`);

// --- Helper Functions for Privileged Tasks ---

function cleanupOldCertificates() {
  console.log('\n=> Cleaning up old certificates from Windows store...');
  const certutilPath = 'C:\\Windows\\System32\\certutil.exe';
  
  // Clean up certificates for all hostnames
  hostnamesArray.forEach(host => {
    try {
      const output = execSync(`"${certutilPath}" -store Root "${host}"`, { encoding: 'utf8', stdio: 'pipe' });
      
      // Extract serial numbers
      const serialNumbers = [];
      const lines = output.split('\n');
      
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes('Serial Number:')) {
          const serial = lines[i].split('Serial Number:')[1].trim();
          serialNumbers.push(serial);
        }
      }
      
      if (serialNumbers.length > 0) {
        console.log(`  Found ${serialNumbers.length} old '${host}' certificates to remove...`);
        
        serialNumbers.forEach(serial => {
          try {
            execSync(`"${certutilPath}" -delstore Root ${serial}`, { stdio: 'pipe' });
          } catch (err) {
            // Silently ignore errors (certificate might already be deleted)
          }
        });
        
        console.log(`  ✓ Cleaned up old '${host}' certificates`);
      } else {
        console.log(`  No old '${host}' certificates found`);
      }
    } catch (error) {
      // No certificates found, which is fine
      console.log(`  No old '${host}' certificates found`);
    }
  });
}

function addToHosts() {
  const hostsPath = os.platform() === 'win32' ? 'C:\\Windows\\System32\\drivers\\etc\\hosts' : '/etc/hosts';
  
  // Add entries for all hostnames (except localhost which already exists)
  hostnamesArray.forEach(host => {
    if (host === 'localhost') return; // Skip localhost, it's already in hosts file
    
    const entry = `${hostIp}\t${host}`;
    
    try {
      const hostsContent = fs.readFileSync(hostsPath, 'utf8');
      if (hostsContent.includes(host)) {
        console.log(`=> Hosts file already contains an entry for '${host}'. Skipping.`);
        return;
      }
    } catch (error) {
      // Ignore read errors, we'll try to append.
    }
    
    console.log(`=> Adding "${entry}" to your hosts file...`);
    fs.appendFileSync(hostsPath, `\n# Added by badminton_court project\n${entry}\n`);
    console.log(`✓ Successfully added '${host}' to hosts file.`);
  });
}

function trustCa() {
  const caPath = path.resolve(certDir, 'ca.pem');
  console.log(`=> Trusting the CA certificate at '${caPath}'...`);

  try {
    if (os.platform() === 'win32') {
      // Use full path to certutil on Windows
      const certutilPath = 'C:\\Windows\\System32\\certutil.exe';
      execSync(`"${certutilPath}" -addstore -f "Root" "${caPath}"`, { stdio: 'inherit' });
      console.log('✓ Successfully trusted CA certificate on Windows.');
    } else if (os.platform() === 'darwin') {
      execSync(`security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain "${caPath}"`, { stdio: 'inherit' });
      console.log('✓ Successfully trusted CA certificate on macOS.');
    } else {
      // Linux command (Debian/Ubuntu based)
      execSync(`cp "${caPath}" /usr/local/share/ca-certificates/`, { stdio: 'inherit' });
      execSync('update-ca-certificates', { stdio: 'inherit' });
      console.log('✓ Successfully trusted CA certificate on Linux (Debian/Ubuntu).');
    }
  } catch (error) {
    console.error('✖ Failed to trust the CA certificate. This should not happen with elevated privileges.');
    console.error(error);
    process.exit(1);
  }
}

function clearOsSslCache() {
  console.log('=> Clearing the OS SSL cache...');
  try {
    if (os.platform() === 'win32') {
      // Use full path to certutil on Windows
      const certutilPath = 'C:\\Windows\\System32\\certutil.exe';
      execSync(`"${certutilPath}" -pulse`, { stdio: 'inherit' });
      console.log('✓ Successfully cleared the Windows SSL state.');
    }
  } catch (error) {
    console.warn('⚠ Could not clear the OS SSL cache. This is not critical, but may require a browser restart.');
  }
}

// --- Main Script Logic ---

function generateCertificates() {
  console.log('=> Ensuring certificate directory exists...');
  if (!fs.existsSync(certDir)) {
    fs.mkdirSync(certDir, { recursive: true });
  }

  console.log('=> Removing old certificate files...');
  const filesToRemove = [`${certName}-cert.pem`, `${certName}-key.pem`, 'ca.pem'];
  filesToRemove.forEach(file => {
    const filePath = path.join(certDir, file);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  });

  // Create a temporary OpenSSL config file for SAN with multiple hostnames
  const sanEntries = hostnamesArray.map((host, index) => `DNS.${index + 1} = ${host}`).join('\n');
  
  const sslConfig = `
[req]
distinguished_name = req_distinguished_name
x509_extensions = v3_req
prompt = no

[req_distinguished_name]
CN = ${commonName}

[v3_req]
keyUsage = digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = @alt_names

[alt_names]
${sanEntries}
IP.1 = ${hostIp}
`;
  const configPath = path.join(certDir, 'openssl.cnf');
  fs.writeFileSync(configPath, sslConfig);

  console.log('=> Generating new certificates with OpenSSL (including SAN for multiple hosts)...');
  console.log(`   Certificate will be valid for: ${hostnamesArray.join(', ')}`);
  try {
    execSync(`openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
      -keyout "${path.join(certDir, `${certName}-key.pem`)}" \
      -out "${path.join(certDir, `${certName}-cert.pem`)}" \
      -config "${configPath}"`, { stdio: 'inherit' });
    
    const certContent = fs.readFileSync(path.join(certDir, `${certName}-cert.pem`));
    fs.writeFileSync(path.join(certDir, 'ca.pem'), certContent);
    
    // Clean up the temporary config file
    fs.unlinkSync(configPath);

    console.log('--- Certificate Generation Complete ---');
  } catch (error) {
    console.error('Error generating certificates:', error.message);
    process.exit(1);
  }
}

function runPrivilegedTasks() {
  console.log('\n--- Running Privileged Host Configuration ---');
  cleanupOldCertificates();
  addToHosts();
  trustCa();
  clearOsSslCache();
  console.log('\n--- Host Configuration Finished ---');
}

// --- Script Entry Point ---

const isElevatedRun = process.argv.includes('--elevated');

if (isElevatedRun) {
  runPrivilegedTasks();
} else {
  generateCertificates();

  const options = { name: 'Badminton Court Setup' };
  
  // Use the full path to node.exe and pass environment variables to elevated process
  const nodePath = process.execPath;
  const command = `"${nodePath}" "${__filename}" --elevated`;
  
  // Pass environment variables to the elevated process
  options.env = {
    ENVIRONMENT: environment,
    CERT_DIR: certDir,
    CERT_NAME: certName,
    POSTE_HOSTNAME: commonName,
    HOST_IP: hostIp,
    // Pass all hostnames as a comma-separated string
    ALL_HOSTNAMES: hostnamesArray.join(','),
  };

  console.log('\n--- Requesting Administrator Privileges ---');
  console.log('A UAC prompt will appear to configure your system. Please approve it.');

  sudo.exec(command, options, (error, stdout, stderr) => {
    if (error) {
      console.error('✖ Failed to gain administrator privileges or an error occurred.');
      console.error(error.message);
      return;
    }
    console.log(stdout);
    if (stderr) console.error(stderr);
    
    console.log('\n✅ All system configuration tasks completed successfully!');
    console.log('\n🎉 FINAL STEPS:');
    console.log('1. Close ALL Chrome windows and processes');
    console.log('2. Go to chrome://net-internals/#hsts');
    console.log(`3. Delete domain security policies for: ${hostnamesArray.join(', ')}`);
    console.log('4. Restart Chrome');
    console.log('\n5. You can now access your application at:');
    hostnamesArray.forEach(host => {
      console.log(`   - https://${host}:${process.env.POSTE_PORT || '8443'}`);
    });
  });
}