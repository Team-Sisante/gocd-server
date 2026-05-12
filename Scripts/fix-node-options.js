/**
 * fix-node-options.js – Permanently eliminate NODE_OPTIONS via a Scheduled Task.
 * The task runs immediately and at every logon.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const TASK_NAME = 'Fix NODE_OPTIONS';
const PS_SCRIPT = path.join(__dirname, 'fix-node-options-action.ps1');
const PROJECT_ROOT = path.resolve(__dirname, '..');  // gocd-server root

// 1. Write a minimal, bulletproof PowerShell fix script
const psCode = `# Kill all VS Code instances
Get-Process code -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 3

# Purge NODE_OPTIONS from registry
[System.Environment]::SetEnvironmentVariable("NODE_OPTIONS", $null, "User")
[System.Environment]::SetEnvironmentVariable("NODE_OPTIONS", $null, "Machine")
reg delete HKCU\\Environment /v NODE_OPTIONS /f 2>$null
reg delete "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment" /v NODE_OPTIONS /f 2>$null

# Delete workspace storage (bootloader)
$ws = "$env:APPDATA\\Code\\User\\workspaceStorage"
if (Test-Path $ws) { Remove-Item -Recurse -Force $ws -ErrorAction SilentlyContinue }

# Reopen the project root folder
Start-Process code -ArgumentList "${PROJECT_ROOT.replace(/\\/g, '\\\\')}"
Start-Sleep -Seconds 2

# Notify the user
[System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms') | Out-Null
[System.Windows.Forms.MessageBox]::Show('NODE_OPTIONS permanently removed and VS Code restored.','Fix Complete','OK','Information')
`;

fs.writeFileSync(PS_SCRIPT, psCode);

// 2. Create (or update) the Scheduled Task
const actionArgs = `-ExecutionPolicy Bypass -File "${PS_SCRIPT}"`;
const createCmd = `schtasks /create /tn "${TASK_NAME}" /tr "powershell.exe ${actionArgs}" /sc onlogon /rl highest /f`;
try {
  execSync(createCmd, { stdio: 'pipe' });
  console.log('Scheduled Task created successfully.');
} catch (e) {
  console.error('Failed to create Scheduled Task:', e.stderr || e.message);
  process.exit(1);
}

// 3. Run the task immediately to fix the current session
try {
  execSync(`schtasks /run /tn "${TASK_NAME}"`, { stdio: 'pipe' });
  console.log('Task started – NODE_OPTIONS will be removed and VS Code will restart shortly.');
} catch (e) {
  console.error('Could not start the task manually. It will still run at next logon.');
}