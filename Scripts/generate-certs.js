// Scripts/generate-certs.js

// Suppress deprecation warnings
process.noDeprecation = true;

const fs = require('fs');
const { execSync } = require('child_process');
const path = require('path');
const os = require('os');
const dotenv = require('dotenv');
const { getAdminProvider } = require('./adminProvider');

// 1. Determine mode
const isElevated = process.argv.includes('--elevated');
const isHeadless = process.argv.includes('--headless');

// Load environment
const envDockerPath = path.resolve(__dirname, '..', '.env.docker');
if (fs.existsSync(envDockerPath)) {
    dotenv.config({ path: envDockerPath });
}
process.env.ENVIRONMENT = process.env.ENVIRONMENT || 'docker';

const certDir = process.env.CERT_DIR || 'certs';
const hostIp = process.env.HOST_IP || '127.0.0.1';

// Collect hostnames
const hostnames = new Set(['localhost']);
if (process.env.POSTE_HOSTNAME) hostnames.add(process.env.POSTE_HOSTNAME);
const hostnamesArray = Array.from(hostnames).filter(Boolean);
const commonName = process.env.POSTE_HOSTNAME || 'localhost';

// 2. Logic
if (isElevated) {
    // PHASE 2: Privileged System Configuration
    console.log('\n--- Running Privileged Host Configuration ---');
    const provider = getAdminProvider();
    
    provider.cleanupOldCertificates(hostnamesArray);
    provider.addToHosts(hostnamesArray, hostIp);
    provider.trustCa(certDir);
    provider.clearOsSslCache();
    console.log('\n--- Host Configuration Finished ---');

} else {
    // PHASE 1: Generate certificates
    console.log('--- Starting Certificate Generation ---');
    
    if (!fs.existsSync(certDir)) {
        fs.mkdirSync(certDir, { recursive: true });
    }

    const filesToRemove = [`server.crt`, `server.key`, 'ca.pem'];
    filesToRemove.forEach(file => {
        const filePath = path.join(certDir, file);
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
    });

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

    try {
        execSync(`openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
          -keyout "${path.join(certDir, `server.key`)}" \
          -out "${path.join(certDir, `server.crt`)}" \
          -config "${configPath}"`, { stdio: 'inherit' });
        
        const certContent = fs.readFileSync(path.join(certDir, `server.crt`));
        fs.writeFileSync(path.join(certDir, 'ca.pem'), certContent);
        
        fs.unlinkSync(configPath);
        console.log('--- Certificate Generation Complete ---');
    } catch (error) {
        console.error('Error generating certificates:', error.message);
        process.exit(1);
    }
    
    // Execute elevation
    console.log("\n=> Phase 2: Escalating to apply system configuration...");
    const nodeBin = process.execPath;
    const cmd = os.platform() === 'win32'
        ? `powershell -Command "Start-Process '${nodeBin}' -ArgumentList '${__filename} --elevated' -Verb RunAs -Wait"`
        : `sudo -E ${nodeBin} "${__filename}" --elevated`;
    
    execSync(cmd, { stdio: 'inherit' });
    console.log("\n✅ All tasks completed successfully!");
}