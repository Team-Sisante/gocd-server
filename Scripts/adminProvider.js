// Scripts/adminProvider.js
const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

class BaseAdminProvider {
    cleanupOldCertificates(hostnamesArray) { throw new Error('Not implemented'); }
    addToHosts(hostnamesArray, hostIp) { throw new Error('Not implemented'); }
    trustCa(certDir) { throw new Error('Not implemented'); }
    clearOsSslCache() { throw new Error('Not implemented'); }
}

class LinuxAdminProvider extends BaseAdminProvider {
    cleanupOldCertificates(hostnamesArray) {
        console.log('=> Linux: No action needed for OS certificate store cleanup.');
    }

    addToHosts(hostnamesArray, hostIp) {
        const hostsPath = '/etc/hosts';
        hostnamesArray.forEach(host => {
            if (host === 'localhost') return;
            const entry = `${hostIp}\t${host}`;
            try {
                const hostsContent = fs.readFileSync(hostsPath, 'utf8');
                if (hostsContent.includes(host)) return;
                fs.appendFileSync(hostsPath, `\n# Added by badminton_court project\n${entry}\n`);
                console.log(`✓ Added '${host}' to /etc/hosts`);
            } catch (error) {
                console.error(`✖ Failed to update /etc/hosts: ${error.message}`);
            }
        });
    }

    trustCa(certDir) {
        const caPath = path.resolve(certDir, 'ca.pem');
        console.log(`=> Trusting the CA certificate at '${caPath}'...`);
        try {
            fs.copyFileSync(caPath, `/usr/local/share/ca-certificates/${path.basename(caPath)}`);
            execSync('update-ca-certificates', { stdio: 'inherit' });
            console.log('✓ Successfully trusted CA certificate on Linux.');
        } catch (error) {
            console.error('✖ Failed to trust the CA certificate:', error);
            process.exit(1);
        }
    }

    clearOsSslCache() {
        console.log('=> Linux: No action needed for SSL cache.');
    }
}

class WindowsAdminProvider extends BaseAdminProvider {
    cleanupOldCertificates(hostnamesArray) {
        const certutilPath = 'C:\\Windows\\System32\\certutil.exe';
        hostnamesArray.forEach(host => {
            try {
                const output = execSync(`"${certutilPath}" -store Root "${host}"`, { encoding: 'utf8', stdio: 'pipe' });
                const serialNumbers = output.split('\n').filter(l => l.includes('Serial Number:')).map(l => l.split('Serial Number:')[1].trim());
                serialNumbers.forEach(serial => execSync(`"${certutilPath}" -delstore Root ${serial}`, { stdio: 'pipe' }));
                console.log(`✓ Cleaned up old '${host}' certificates`);
            } catch (error) {
                console.log(`  No old '${host}' certificates found`);
            }
        });
    }

    addToHosts(hostnamesArray, hostIp) {
        const hostsPath = 'C:\\Windows\\System32\\drivers\\etc\\hosts';
        hostnamesArray.forEach(host => {
            if (host === 'localhost') return;
            const entry = `${hostIp}\t${host}`;
            try {
                const hostsContent = fs.readFileSync(hostsPath, 'utf8');
                if (hostsContent.includes(host)) return;
                fs.appendFileSync(hostsPath, `\n# Added by badminton_court project\n${entry}\n`);
                console.log(`✓ Added '${host}' to hosts file.`);
            } catch (error) {
                console.error(`✖ Failed to update hosts: ${error.message}`);
            }
        });
    }

    trustCa(certDir) {
        const caPath = path.resolve(certDir, 'ca.pem');
        const certutilPath = 'C:\\Windows\\System32\\certutil.exe';
        execSync(`"${certutilPath}" -addstore -f "Root" "${caPath}"`, { stdio: 'inherit' });
        console.log('✓ Successfully trusted CA certificate on Windows.');
    }

    clearOsSslCache() {
        execSync('C:\\Windows\\System32\\certutil.exe -pulse', { stdio: 'inherit' });
        console.log('✓ Successfully cleared the Windows SSL state.');
    }
}

function getAdminProvider() {
    return os.platform() === 'win32' ? new WindowsAdminProvider() : new LinuxAdminProvider();
}

module.exports = { getAdminProvider };
