const { spawn } = require('child_process');
const os = require('os');
const path = require('path');

function runDiagnostic() {
    const isWindows = os.platform() === 'win32';
    const scriptName = isWindows ? 'diagnose-network.ps1' : 'diagnose-network.sh';
    const scriptPath = path.join(__dirname, scriptName);
    const command = isWindows ? 'powershell' : 'bash';
    const args = isWindows ? ['-File', scriptPath] : [scriptPath];

    console.log(`Running network diagnostics on ${os.platform()} using ${scriptName}...`);

    const child = spawn(command, args, { stdio: 'inherit' });

    child.on('close', (code) => {
        if (code !== 0) {
            console.error(`Diagnostic script exited with code ${code}`);
            process.exit(code);
        } else {
            console.log('Diagnostic script completed successfully.');
            process.exit(0);
        }
    });
}

runDiagnostic();
